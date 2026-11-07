// model-prices.json (model-price-store.js): current prices + scheduled future prices, revisioned.
use crate::metrics::Price;
use crate::util::*;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::Mutex;

static RE_DIGITS: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d+$").unwrap());
static RE_MODEL: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$").unwrap());

#[derive(Clone)]
struct Sched {
    at: i64,
    price: Price,
}
#[derive(Clone)]
struct Inner {
    revision: i64,
    prices: Vec<(String, Price)>,
    scheduled: Vec<(String, Vec<Sched>)>,
    blocked: bool,
}

pub struct PriceStore {
    file: String,
    inner: Mutex<Inner>,
}

fn clean(o: &Value, revision: &str) -> R<Price> {
    let mut x = Map::new();
    x.insert("currency".into(), o.g("currency").clone());
    x.insert("revision".into(), json!(revision));
    x.insert("reasoningMode".into(), o.g("reasoningMode").clone());
    for k in ["inputPerMillion", "outputPerMillion", "cachedPerMillion", "reasoningPerMillion"] {
        let v = o.get(k).cloned().unwrap_or(Value::Bool(false)); // undefined -> invalid
        if as_num(&v).map(|f| f > 1_000_000.0).unwrap_or(false) {
            return herr(400, "Price rate too large");
        }
        x.insert(k.into(), v);
    }
    Price::from_value(&Value::Object(x)).map_err(|_| HttpErr::new(400, "Invalid model price"))
}

impl Inner {
    fn effective(&self, m: &str, at: i64) -> Option<Price> {
        let mut p = self.prices.iter().find(|(k, _)| k == m).map(|(_, p)| p.clone());
        if let Some((_, l)) = self.scheduled.iter().find(|(k, _)| k == m) {
            for e in l {
                if e.at <= at {
                    p = Some(e.price.clone());
                }
            }
        }
        p
    }
}
fn sched_json(l: &[Sched]) -> Value {
    Value::Array(l.iter().map(|e| json!({"effectiveAt":e.at,"price":e.price.file_json()})).collect())
}

impl PriceStore {
    pub fn open(file: &str) -> Result<Self, String> {
        let bad = "Price configuration invalid; file preserved".to_string();
        let mut inner = Inner { revision: 0, prices: vec![], scheduled: vec![], blocked: false };
        match std::fs::symlink_metadata(file) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(bad),
            Ok(st) => {
                if !st.is_file() || st.len() > 2_097_152 {
                    return Err(bad);
                }
                let d = read_json(file).map_err(|_| bad.clone())?;
                let rev = as_safe_int(d.g("revision")).filter(|r| *r >= 0).ok_or(bad.clone())?;
                if as_safe_int(d.g("version")) != Some(1) {
                    return Err(bad);
                }
                for (m, p) in d.o("prices").ok_or(bad.clone())? {
                    let pr = p.s("revision");
                    if !RE_MODEL.is_match(m) || !RE_DIGITS.is_match(pr) || pr.parse::<i64>().unwrap_or(i64::MAX) > rev {
                        return Err(bad);
                    }
                    inner.prices.push((m.clone(), clean(p, pr).map_err(|_| bad.clone())?));
                }
                if d.has("scheduled") {
                    for (m, l) in d.o("scheduled").ok_or(bad.clone())? {
                        let l = l.as_array().filter(|l| l.len() <= 20).ok_or(bad.clone())?;
                        if !RE_MODEL.is_match(m) {
                            return Err(bad);
                        }
                        let mut out = vec![];
                        for e in l {
                            let at = as_safe_int(e.g("effectiveAt")).filter(|a| *a >= 0).ok_or(bad.clone())?;
                            let pr = e.g("price").s("revision");
                            if !RE_DIGITS.is_match(pr) || pr.parse::<i64>().unwrap_or(i64::MAX) > rev {
                                return Err(bad);
                            }
                            out.push(Sched { at, price: clean(e.g("price"), pr).map_err(|_| bad.clone())? });
                        }
                        out.sort_by_key(|e| e.at);
                        inner.scheduled.push((m.clone(), out));
                    }
                }
                inner.revision = rev;
            }
        }
        Ok(PriceStore { file: file.into(), inner: Mutex::new(inner) })
    }

    pub fn get(&self, m: &str) -> Option<Price> {
        let i = self.inner.lock().unwrap();
        if i.blocked {
            return None;
        }
        i.effective(m, now_ms())
    }

    fn snapshot_of(i: &Inner) -> Value {
        let now = now_ms();
        let (mut prices, mut scheduled) = (Map::new(), Map::new());
        let mut seen = std::collections::HashSet::new();
        for m in i.prices.iter().map(|(k, _)| k).chain(i.scheduled.iter().map(|(k, _)| k)) {
            if !seen.insert(m.clone()) {
                continue;
            }
            if let Some(p) = i.effective(m, now) {
                prices.insert(m.clone(), p.file_json());
            }
            if let Some((_, l)) = i.scheduled.iter().find(|(k, _)| k == m) {
                let fut: Vec<Sched> = l.iter().filter(|e| e.at > now).cloned().collect();
                if !fut.is_empty() {
                    scheduled.insert(m.clone(), sched_json(&fut));
                }
            }
        }
        json!({"version":1,"revision":i.revision,"prices":prices,"scheduled":scheduled,"blocked":i.blocked,"currency":"USD","estimated":true})
    }
    pub fn snapshot(&self) -> Value {
        Self::snapshot_of(&self.inner.lock().unwrap())
    }

    pub fn set(&self, input: &Value) -> R<Value> {
        let mut i = self.inner.lock().unwrap();
        if i.blocked {
            return herr(503, "Price storage blocked; reconcile before retry");
        }
        let model = input.s("model").to_string();
        if !RE_MODEL.is_match(&model) {
            return herr(400, "Canonical model ID required");
        }
        let rv = as_safe_int(input.g("revision")).filter(|r| *r >= 0).ok_or_else(|| HttpErr::new(400, "Invalid price revision"))?;
        if rv != i.revision {
            return herr(409, "Price revision changed; refresh first");
        }
        let revision = i.revision + 1;
        let rs = revision.to_string();
        let now = now_ms();
        let mut next = i.clone();
        let future = |l: Option<&Vec<Sched>>| -> Vec<Sched> { l.map(|l| l.iter().filter(|e| e.at > now).cloned().collect()).unwrap_or_default() };
        let cur_sched = i.scheduled.iter().find(|(k, _)| *k == model).map(|(_, l)| l.clone());
        let set_p = |n: &mut Inner, p: Price| match n.prices.iter_mut().find(|(k, _)| *k == model) {
            Some(e) => e.1 = p,
            None => n.prices.push((model.clone(), p)),
        };
        let set_s = |n: &mut Inner, l: Vec<Sched>| {
            if l.is_empty() {
                n.scheduled.retain(|(k, _)| *k != model);
            } else {
                match n.scheduled.iter_mut().find(|(k, _)| *k == model) {
                    Some(e) => e.1 = l,
                    None => n.scheduled.push((model.clone(), l)),
                }
            }
        };
        if input.g("clearScheduled") == &Value::Bool(true) {
            if let Some(b) = i.effective(&model, now) {
                set_p(&mut next, b);
            }
            set_s(&mut next, vec![]);
        } else if !input.g("effectiveAt").is_null() {
            let at = as_safe_int(input.g("effectiveAt")).filter(|a| *a > now && *a <= now + 5 * 366 * DAY)
                .ok_or_else(|| HttpErr::new(400, "Effective time must be in the future"))?;
            let p = clean(input.g("price"), &rs)?;
            let mut list: Vec<Sched> = future(cur_sched.as_ref()).into_iter().filter(|e| e.at != at).collect();
            if list.len() >= 20 {
                return herr(400, "Too many scheduled prices");
            }
            if let Some(b) = i.effective(&model, now) {
                set_p(&mut next, b);
            }
            list.push(Sched { at, price: p });
            list.sort_by_key(|e| e.at);
            set_s(&mut next, list);
        } else {
            let p = clean(input.g("price"), &rs)?;
            if !i.prices.iter().any(|(k, _)| *k == model) && i.prices.len() >= 1000 {
                return herr(400, "Price catalog capacity reached");
            }
            set_p(&mut next, p);
            set_s(&mut next, future(cur_sched.as_ref()));
        }
        let mut po = Map::new();
        for (m, p) in &next.prices {
            po.insert(m.clone(), p.file_json());
        }
        let mut file = Map::new();
        file.insert("version".into(), json!(1));
        file.insert("revision".into(), json!(revision));
        file.insert("prices".into(), Value::Object(po));
        if !next.scheduled.is_empty() {
            let mut so = Map::new();
            for (m, l) in &next.scheduled {
                so.insert(m.clone(), sched_json(l));
            }
            file.insert("scheduled".into(), Value::Object(so));
        }
        let mut data = js_bytes(&Value::Object(file));
        data.push(b'\n');
        if write_atomic(&self.file, &data, 0o600, true).is_err() {
            i.blocked = true;
            return herr(503, "Price save not confirmed; reconcile before retry");
        }
        next.revision = revision;
        *i = next;
        Ok(Self::snapshot_of(&i))
    }
}