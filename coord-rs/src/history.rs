// request-history.js + recorded-forward.js health + analytics-query.js.
// One JSON file per request (request-history/<uuid>.json). Memory holds a compact index only;
// full records are read from disk when listed or updated.
use crate::metrics::*;
use crate::state::READ_ONLY;
use crate::util::*;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Mutex;

pub static RE_UUID: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$").unwrap());
static RE_MODEL: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-zA-Z0-9._/-]{1,200}$").unwrap());

#[derive(Clone)]
struct Row {
    created: i64,
    finished: Option<i64>,
    pending: bool,
    outcome: String,
    model: String,
    account: Option<i64>,
    http: Option<i64>,
    known_total: Option<i64>,
    cost: Option<f64>,
    dur: Option<f64>,
}
fn index(v: &Value) -> Row {
    let m = v.g("metrics");
    let known = if m.b("usageComplete") { as_safe_int(m.g("usage").g("total")) } else { None };
    Row {
        created: as_safe_int(v.g("createdAt")).unwrap_or(0),
        finished: as_safe_int(v.g("finishedAt")),
        pending: v.s("phase") == "pending",
        outcome: v.s("outcome").into(),
        model: v.s("model").into(),
        account: as_safe_int(v.g("account")),
        http: as_safe_int(v.g("httpStatus")),
        known_total: known,
        cost: as_num(v.g("cost").g("amount")),
        dur: as_num(m.g("durationMs")),
    }
}

struct Inner {
    rows: HashMap<String, Row>,
    ready: bool,
    degraded: bool,
    init_err: String,
    attempts: i64,
}

pub struct History {
    dir: String,
    max: usize,
    inner: Mutex<Inner>,
    wlock: Mutex<()>,
}

pub struct Begin<'a> {
    pub id: &'a str,
    pub model: &'a str,
    pub requested: &'a str,
    pub account: i64,
    pub epoch: &'a str,
    pub stream: bool,
    pub price: Option<Price>,
}

impl History {
    pub fn open(dir: &str) -> std::sync::Arc<History> {
        let h = std::sync::Arc::new(History {
            dir: dir.into(),
            max: 100_000,
            inner: Mutex::new(Inner { rows: HashMap::new(), ready: false, degraded: false, init_err: String::new(), attempts: 0 }),
            wlock: Mutex::new(()),
        });
        match h.load() {
            Ok(rows) => {
                let mut i = h.inner.lock().unwrap();
                i.rows = rows;
                i.ready = true;
            }
            Err(e) => {
                {
                    let mut i = h.inner.lock().unwrap();
                    i.init_err = clip_runes(&e, 120);
                    i.attempts = 1;
                }
                elog(format!("[Analytics] history unavailable: {}", e));
                let h2 = h.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(60));
                    let r = h2.load();
                    let mut i = h2.inner.lock().unwrap();
                    i.attempts += 1;
                    match r {
                        Ok(rows) => {
                            i.rows = rows;
                            i.ready = true;
                            log(format!("[Analytics] history recovered after {} attempt(s)", i.attempts));
                            return;
                        }
                        Err(e) => i.init_err = clip_runes(&e, 120),
                    }
                });
            }
        }
        h
    }

    fn load(&self) -> Result<HashMap<String, Row>, String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let names: Vec<String> = std::fs::read_dir(&self.dir).map_err(|e| e.to_string())?
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().to_string()))
            .filter(|n| n.ends_with(".json"))
            .collect();
        if names.len() > self.max {
            return Err("History capacity exceeded; archive required".into());
        }
        let mut rows = HashMap::with_capacity(names.len());
        for n in names {
            let id = &n[..n.len() - 5];
            if !RE_UUID.is_match(id) {
                return Err("Invalid history filename".into());
            }
            let f = format!("{}/{}", self.dir, n);
            let st = std::fs::symlink_metadata(&f).map_err(|_| "Invalid history file")?;
            if !st.is_file() || st.len() > 32768 {
                return Err("Invalid history file".into());
            }
            let v = read_json(&f).map_err(|e| e.to_string())?;
            if as_safe_int(v.g("version")) != Some(1) || v.s("id") != id || as_safe_int(v.g("createdAt")).is_none()
                || !["pending", "finished"].contains(&v.s("phase"))
            {
                return Err("History record invalid".into());
            }
            rows.insert(id.to_string(), index(&v));
        }
        Ok(rows)
    }

    pub fn status(&self) -> Value {
        let i = self.inner.lock().unwrap();
        if !i.ready {
            return json!({"ready":false,"degraded":true,"error":"history_initialization_failed","records":null,"capacity":null,
                "attempts":i.attempts,"lastError":i.init_err});
        }
        json!({"ready":true,"degraded":i.degraded,"error":if i.degraded {json!("history_write_failed")} else {Value::Null},
            "records":i.rows.len(),"capacity":self.max})
    }
    fn usable(&self) -> R<()> {
        let i = self.inner.lock().unwrap();
        if !i.ready {
            return herr(503, "Request history unavailable");
        }
        if i.degraded {
            return Err(HttpErr::plain("History unavailable"));
        }
        Ok(())
    }
    fn persist(&self, v: &Value) -> R<()> {
        let id = v.s("id").to_string();
        let mut data = js_bytes(v);
        data.push(b'\n');
        let ok = READ_ONLY.load(Ordering::Relaxed) || write_atomic(&format!("{}/{}.json", self.dir, id), &data, 0o600, true).is_ok();
        let mut i = self.inner.lock().unwrap();
        if !ok {
            i.degraded = true;
            return Err(HttpErr::plain("History persistence failed"));
        }
        i.rows.insert(id, index(v));
        Ok(())
    }
    fn read_row(&self, id: &str) -> Option<Value> {
        let f = format!("{}/{}.json", self.dir, id);
        read_json(&f).ok()
    }

    pub fn begin(&self, b: Begin) -> R<()> {
        let _w = self.wlock.lock().unwrap();
        self.usable()?;
        if !RE_UUID.is_match(b.id) || !RE_MODEL.is_match(b.model) {
            return Err(HttpErr::plain("Invalid request identity"));
        }
        {
            let i = self.inner.lock().unwrap();
            if let Some(old) = i.rows.get(b.id) {
                if old.model != b.model || old.account != Some(b.account) {
                    return Err(HttpErr::plain("History identity conflict"));
                }
                return Ok(());
            }
            if i.rows.len() >= self.max {
                return Err(HttpErr::plain("History capacity reached"));
            }
        }
        let price = match &b.price {
            Some(p) => {
                if p.validate().is_err() || p.revision.len() > 100 {
                    return Err(HttpErr::plain("Invalid price metadata"));
                }
                p.json()
            }
            None => Value::Null,
        };
        let rm = if RE_MODEL.is_match(b.requested) { b.requested } else { b.model };
        let epoch = if RE_UUID.is_match(b.epoch) { json!(b.epoch) } else { Value::Null };
        let v = json!({"version":1,"id":b.id,"createdAt":now_ms(),"phase":"pending","outcome":"pending","model":b.model,"requestedModel":rm,
            "account":if b.account >= 0 {json!(b.account)} else {Value::Null},"slot":null,"workerEpoch":epoch,"stream":b.stream,"queueMs":null,
            "price":price,"metrics":null,"cost":null,"httpStatus":null,"finishedAt":null});
        self.persist(&v)
    }

    pub fn finish(&self, id: &str, outcome: &str, status: u16, m: Option<&MetricsOut>) -> R<()> {
        let _w = self.wlock.lock().unwrap();
        self.usable()?;
        let pending = self.inner.lock().unwrap().rows.get(id).map(|r| r.pending);
        match pending {
            None => return Err(HttpErr::plain("History request missing")),
            Some(false) => return Ok(()),
            _ => {}
        }
        if !["success", "http_error", "application_error", "cancelled", "uncertain", "rejected"].contains(&outcome) {
            return Err(HttpErr::plain("Invalid outcome"));
        }
        let mut v = self.read_row(id).ok_or_else(|| HttpErr::plain("History request missing"))?;
        let mj = metrics_json(m);
        let cost = if mj.g("usageComplete") == &Value::Bool(true) {
            let price = if v.g("price").is_object() { Some(Price::from_value(v.g("price"))) } else { None };
            let mut u = m.and_then(|m| m.usage.clone()).unwrap();
            u.reasoning_included = u.format == "openai";
            estimate_cost(Some(&u), price)
        } else {
            unknown_cost("usage_incomplete")
        };
        let o = v.as_object_mut().unwrap();
        o.insert("phase".into(), json!("finished"));
        o.insert("outcome".into(), json!(outcome));
        o.insert("finishedAt".into(), json!(now_ms()));
        o.insert("httpStatus".into(), if (100..=599).contains(&status) { json!(status) } else { Value::Null });
        o.insert("metrics".into(), mj);
        o.insert("cost".into(), cost);
        self.persist(&v)
    }

    pub fn expire_stale(&self, max_age: i64) -> usize {
        let _w = self.wlock.lock().unwrap();
        if self.usable().is_err() {
            return 0;
        }
        let now = now_ms();
        let stale: Vec<String> = self.inner.lock().unwrap().rows.iter()
            .filter(|(_, r)| r.pending && now - r.created >= max_age).map(|(k, _)| k.clone()).collect();
        let mut n = 0;
        for id in stale {
            let Some(mut v) = self.read_row(&id) else { continue };
            let mo = MetricsOut { error_kind: "stale_pending".into(), ..Default::default() };
            let mut mj = metrics_json(Some(&mo));
            mj.as_object_mut().unwrap().insert("durationMs".into(), Value::Null);
            let o = v.as_object_mut().unwrap();
            o.insert("phase".into(), json!("finished"));
            o.insert("outcome".into(), json!("uncertain"));
            o.insert("finishedAt".into(), json!(now));
            o.insert("httpStatus".into(), Value::Null);
            o.insert("metrics".into(), mj);
            o.insert("cost".into(), unknown_cost("usage_incomplete"));
            if self.persist(&v).is_err() {
                break;
            }
            n += 1;
        }
        n
    }

    fn ready(&self) -> R<()> {
        if !self.inner.lock().unwrap().ready {
            return herr(503, "Request history unavailable");
        }
        Ok(())
    }
    fn select(&self, q: &HistQuery) -> Vec<(String, Row)> {
        let i = self.inner.lock().unwrap();
        i.rows.iter().filter(|(_, r)| {
            r.created >= q.from && r.created < q.to && q.model.as_ref().map(|m| &r.model == m).unwrap_or(true)
                && q.account.map(|a| r.account == Some(a)).unwrap_or(true) && q.outcome.as_ref().map(|o| &r.outcome == o).unwrap_or(true)
        }).map(|(k, r)| (k.clone(), r.clone())).collect()
    }

    pub fn list(&self, q: &HistQuery) -> R<Value> {
        self.ready()?;
        let mut rows = self.select(q);
        rows.sort_by(|a, b| b.1.created.cmp(&a.1.created).then_with(|| b.0.cmp(&a.0)));
        let start = ((q.page - 1) * q.page_size) as usize;
        let items: Vec<Value> = rows.iter().skip(start).take(q.page_size as usize).filter_map(|(id, _)| self.read_row(id)).collect();
        Ok(json!({"items":items,"total":rows.len(),"page":q.page,"pageSize":q.page_size,"health":self.status()}))
    }

    pub fn summary(&self, q: &HistQuery) -> R<Value> {
        self.ready()?;
        let mut rows = self.select(q);
        rows.sort_by_key(|(_, r)| r.created);
        let now = now_ms();
        let (mut success, mut errors, mut cancelled, mut uncertain, mut pending) = (0i64, 0i64, 0i64, 0i64, 0i64);
        let (mut known, mut tk, mut tu, mut priced, mut unpriced, mut rpm, mut tpmk, mut tpmu) = (0i64, 0i64, 0i64, 0i64, 0i64, 0i64, 0i64, 0i64);
        let (mut cost, mut dur, mut timed) = (0f64, 0f64, 0i64);
        let mut groups: Vec<(String, i64, i64, i64)> = vec![];
        for (_, r) in &rows {
            match r.outcome.as_str() {
                "success" => success += 1,
                "http_error" | "application_error" | "rejected" => errors += 1,
                "cancelled" => cancelled += 1,
                "uncertain" => uncertain += 1,
                "pending" => pending += 1,
                _ => {}
            }
            match r.known_total {
                Some(t) => {
                    known += t;
                    tk += 1
                }
                None => tu += 1,
            }
            match r.cost {
                Some(c) => {
                    cost += c;
                    priced += 1
                }
                None => unpriced += 1,
            }
            if !r.pending {
                if let Some(d) = r.dur {
                    dur += d;
                    timed += 1;
                }
            }
            if r.created >= now - 60000 && r.created <= now {
                rpm += 1;
            }
            if let Some(f) = r.finished {
                if f >= now - 60000 && f <= now {
                    match r.known_total {
                        Some(t) => tpmk += t,
                        None => tpmu += 1,
                    }
                }
            }
            let g = match groups.iter_mut().position(|g| g.0 == r.model) {
                Some(i) => &mut groups[i],
                None => {
                    groups.push((r.model.clone(), 0, 0, 0));
                    groups.last_mut().unwrap()
                }
            };
            g.1 += 1;
            match r.known_total {
                Some(t) => g.2 += t,
                None => g.3 += 1,
            }
        }
        groups.sort_by(|a, b| b.1.cmp(&a.1));
        let models: Vec<Value> = groups.iter().map(|g| json!({"model":g.0,"requests":g.1,"knownTokenTotal":g.2,"tokenUnknownRequests":g.3})).collect();
        Ok(json!({"requests":rows.len(),"success":success,"errors":errors,"cancelled":cancelled,"uncertain":uncertain,"pending":pending,
            "knownTokenTotal":known,"tokenKnownRequests":tk,"tokenUnknownRequests":tu,"estimatedCostKnownSubtotal":num(cost),
            "pricedRequests":priced,"unpricedRequests":unpriced,"currency":"USD","rpm":rpm,"tpmKnown":tpmk,"tpmUnknownRequests":tpmu,
            "averageDurationMs":if timed > 0 {num(dur / timed as f64)} else {Value::Null},
            "errorRate":if success + errors > 0 {num(errors as f64 / (success + errors) as f64)} else {Value::Null},
            "models":models,"health":self.status(),"scope":"recorded-requests-only"}))
    }

    pub fn counts(&self, tier_of: &dyn Fn(i64) -> String) -> R<Value> {
        self.ready()?;
        let now = now_ms();
        let off = 8 * 3_600_000;
        let today = (now + off).div_euclid(DAY) * DAY - off;
        let ranges = [("today", today), ("week", today - 6 * DAY), ("month", today - 29 * DAY)];
        struct G {
            acct: Option<i64>,
            model: String,
            c: [[i64; 4]; 3],
            last: i64,
            last429: i64,
        }
        let mut rows: Vec<Row> = self.inner.lock().unwrap().rows.values().cloned().collect();
        rows.sort_by_key(|r| r.created);
        let mut groups: Vec<G> = vec![];
        let mut idx: HashMap<(Option<i64>, String), usize> = HashMap::new();
        for r in rows {
            if r.created < ranges[2].1 || r.created > now {
                continue;
            }
            let key = (r.account, r.model.clone());
            let gi = *idx.entry(key).or_insert_with(|| {
                groups.push(G { acct: r.account, model: r.model.clone(), c: [[0; 4]; 3], last: 0, last429: 0 });
                groups.len() - 1
            });
            let g = &mut groups[gi];
            for (i, (_, from)) in ranges.iter().enumerate() {
                if r.created < *from {
                    continue;
                }
                let c = &mut g.c[i];
                c[0] += 1;
                if r.outcome == "success" {
                    c[1] += 1;
                } else if r.http == Some(429) {
                    c[2] += 1;
                } else if ["http_error", "application_error", "rejected"].contains(&r.outcome.as_str()) {
                    c[3] += 1;
                }
            }
            g.last = g.last.max(r.created);
            if r.http == Some(429) {
                g.last429 = g.last429.max(r.created);
            }
        }
        groups.sort_by(|a, b| b.c[2][0].cmp(&a.c[2][0]));
        let items: Vec<Value> = groups.iter().map(|g| {
            let mut o = Map::new();
            o.insert("account".into(), json!(g.acct));
            o.insert("model".into(), json!(g.model));
            for (i, (n, _)) in ranges.iter().enumerate() {
                let c = g.c[i];
                o.insert((*n).into(), json!({"requests":c[0],"success":c[1],"rateLimited":c[2],"errors":c[3]}));
            }
            o.insert("lastAt".into(), json!(g.last));
            o.insert("last429At".into(), json!(g.last429));
            o.insert("tier".into(), g.acct.map(|a| json!(tier_of(a))).unwrap_or(Value::Null));
            Value::Object(o)
        }).collect();
        Ok(json!({"timezone":"Asia/Shanghai","ranges":{"today":ranges[0].1,"week":ranges[1].1,"month":ranges[2].1},"items":items,"health":self.status()}))
    }
}

/// metrics() of request-history.js
pub fn metrics_json(m: Option<&MetricsOut>) -> Value {
    let Some(m) = m else { return Value::Null };
    let nn = |x: Option<i64>| x.filter(|v| *v >= 0).map(|v| json!(v)).unwrap_or(Value::Null);
    let mut o = Map::new();
    o.insert("firstByteMs".into(), nn(m.first_byte_ms));
    o.insert("firstContentMs".into(), nn(m.first_content_ms));
    o.insert("durationMs".into(), nn(m.duration_ms));
    o.insert("usageComplete".into(), json!(m.usage_complete));
    o.insert("transportComplete".into(), json!(m.transport_complete));
    o.insert("streamDoneSeen".into(), json!(m.stream_done_seen));
    o.insert("applicationError".into(), json!(m.application_error));
    o.insert("captureLimited".into(), json!(m.capture_limited));
    o.insert("malformed".into(), json!(m.malformed));
    o.insert("timingSource".into(), json!("coordinator-response-observer"));
    if RE_KIND.is_match(&m.error_kind) {
        o.insert("errorKind".into(), json!(m.error_kind));
    }
    let u = m.usage.as_ref().map(|u| {
        let mut x = u.clone();
        x.reasoning_included = x.format == "openai";
        x.valid_cache = match (x.cached, x.input) {
            (Some(c), Some(i)) => c <= i,
            _ => true,
        };
        if !["upstream-reported", "local-estimate", "response-reported-unverified"].contains(&x.source.as_str()) {
            x.source = "response-reported-unverified".into();
        }
        x.json()
    });
    let uc = m.usage_complete && (m.transport_complete || m.stream_done_seen) && u.is_some() && !m.application_error && !m.capture_limited && !m.malformed;
    o.insert("usage".into(), u.unwrap_or(Value::Null));
    o.insert("usageComplete".into(), json!(uc));
    Value::Object(o)
}

pub fn outcome_of(r: Option<&ExecResult>) -> &'static str {
    let Some(r) = r else { return "uncertain" };
    if r.cancelled {
        return "cancelled";
    }
    if r.uncertain {
        return "uncertain";
    }
    if r.status >= 400 {
        return "http_error";
    }
    let m = r.metrics.as_ref();
    if m.map(|m| m.application_error).unwrap_or(false) {
        return "application_error";
    }
    if (200..300).contains(&r.status) && m.map(|m| m.transport_complete || m.stream_done_seen).unwrap_or(false) {
        return "success";
    }
    "uncertain"
}

// ---------------- analytics query ----------------
pub struct HistQuery {
    pub from: i64,
    pub to: i64,
    pub model: Option<String>,
    pub account: Option<i64>,
    pub outcome: Option<String>,
    pub page: i64,
    pub page_size: i64,
}
static RE_NUM: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d{1,16}$").unwrap());

pub fn parse_query(pairs: &[(String, String)], summary: bool) -> Result<HistQuery, String> {
    let mut q = HistQuery { from: 0, to: 9_007_199_254_740_991, model: None, account: None, outcome: None, page: 1, page_size: 20 };
    let allowed: &[&str] = if summary { &["from", "to", "model", "account", "outcome"] } else { &["from", "to", "model", "account", "outcome", "page", "pageSize"] };
    let mut seen = std::collections::HashSet::new();
    for (k, v) in pairs {
        if !allowed.contains(&k.as_str()) || !seen.insert(k.clone()) {
            return Err("Invalid analytics query".into());
        }
        match k.as_str() {
            "from" | "to" | "account" | "page" | "pageSize" => {
                if !RE_NUM.is_match(v) {
                    return Err("Invalid numeric filter".into());
                }
                let n: i64 = v.parse().map_err(|_| "Invalid numeric filter")?;
                if n > 9_007_199_254_740_991 {
                    return Err("Invalid numeric filter".into());
                }
                match k.as_str() {
                    "from" => q.from = n,
                    "to" => q.to = n,
                    "account" => q.account = Some(n),
                    "page" => q.page = n,
                    _ => q.page_size = n,
                }
            }
            "model" => {
                if !RE_MODEL.is_match(v) {
                    return Err("Invalid model filter".into());
                }
                q.model = Some(v.clone());
            }
            _ => {
                if !["success", "http_error", "application_error", "cancelled", "uncertain", "rejected", "pending"].contains(&v.as_str()) {
                    return Err("Invalid outcome filter".into());
                }
                q.outcome = Some(v.clone());
            }
        }
    }
    if q.page < 1 {
        return Err("Invalid page".into());
    }
    if q.page_size < 1 || q.page_size > 100 {
        return Err("Invalid page size".into());
    }
    if q.to < q.from {
        return Err("Invalid time range".into());
    }
    Ok(q)
}

// ---------------- recording health ----------------
pub struct RecordHealth {
    miss_log: String,
    pub inner: Mutex<(i64, i64, Value, i64, i64, Value)>, // begin, finish, lastFailureAt, missing, missingTotal, lastMissing
}
impl RecordHealth {
    pub fn new(miss_log: &str) -> Self {
        let (mut total, mut last) = (0i64, Value::Null);
        if let Ok(s) = std::fs::read_to_string(miss_log) {
            let lines: Vec<&str> = s.split('\n').filter(|l| !l.is_empty()).collect();
            total = lines.len() as i64;
            if let Some(l) = lines.last() {
                last = serde_json::from_str(l).unwrap_or(Value::Null);
            }
        }
        RecordHealth { miss_log: miss_log.into(), inner: Mutex::new((0, 0, Value::Null, 0, total, last)) }
    }
    pub fn fail(&self, begin: bool) {
        let mut i = self.inner.lock().unwrap();
        if begin {
            i.0 += 1
        } else {
            i.1 += 1
        }
        i.2 = json!(now_ms());
    }
    pub fn missing(&self, row: Value) {
        {
            let mut i = self.inner.lock().unwrap();
            i.3 += 1;
            i.4 += 1;
            i.5 = row.clone();
        }
        elog(format!("[Usage] success without complete usage {}", js(&row)));
        if READ_ONLY.load(Ordering::Relaxed) {
            return;
        }
        if std::fs::metadata(&self.miss_log).map(|m| m.len() > 1_048_576).unwrap_or(false) {
            let _ = std::fs::rename(&self.miss_log, format!("{}.1", self.miss_log));
        }
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).mode(0o600).open(&self.miss_log) {
            let _ = writeln!(f, "{}", js(&row));
        }
    }
    pub fn json(&self, h: &History) -> Value {
        let i = self.inner.lock().unwrap();
        json!({"beginFailures":i.0,"finishFailures":i.1,"lastFailureAt":i.2,"recordingPaused":false,"usageMissing":i.3,
            "lastUsageMissing":i.5,"usageMissingTotal":i.4,"history":h.status()})
    }
}