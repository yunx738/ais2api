// state.json: account pool, flags, per-account/per-model quota ledger (version 2).
// Format identical to the Node/Go coordinators so any of them can run on the same file.
use crate::policy::PolicyStore;
use crate::util::*;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

pub static READ_ONLY: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug)]
pub struct QModel {
    pub family: String,
    pub used: i64,
    pub cooldown_until: i64,
}
#[derive(Clone, Debug, Default)]
pub struct QAcc {
    pub window_start: i64,
    pub morder: Vec<String>,
    pub models: HashMap<String, QModel>,
    pub legacy: Option<Value>,
}
impl QAcc {
    fn model_mut(&mut self, m: &str, family: &str) -> &mut QModel {
        if !self.models.contains_key(m) {
            self.morder.push(m.to_string());
            self.models.insert(m.to_string(), QModel { family: family.to_string(), used: 0, cooldown_until: 0 });
        }
        self.models.get_mut(m).unwrap()
    }
}

pub fn tier_limit(tier: &str, family: &str) -> i64 {
    match (tier, family) {
        ("pro", "flash") => 100,
        ("pro", _) => 50,
        ("ultra", _) | ("ultra20", _) => 200,
        (_, "flash") => 100,
        _ => 10,
    }
}
pub fn tier_limits_json() -> Value {
    let mut o = Map::new();
    for t in ["standard", "pro", "ultra", "ultra20"] {
        let mut x = Map::new();
        for f in ["flash", "pro", "ultra"] {
            x.insert(f.into(), json!(tier_limit(t, f)));
        }
        o.insert(t.into(), Value::Object(x));
    }
    Value::Object(o)
}

pub struct QView {
    pub model: String,
    pub family: String,
    pub limit: Option<i64>,
    pub used: i64,
    pub remaining: Option<i64>,
    pub window_start: i64,
    pub window_end: i64,
    pub cooldown_until: i64,
    pub legacy_blocked: bool,
    pub legacy_until: i64,
    pub allowed: bool,
}
impl QView {
    pub fn json(&self) -> Value {
        json!({"model":self.model,"family":self.family,"limit":self.limit,"unlimited":self.limit.is_none(),"used":self.used,
            "remaining":self.remaining,"windowStart":self.window_start,"windowEnd":self.window_end,"cooldownUntil":self.cooldown_until,
            "legacyBlocked":self.legacy_blocked,"legacyUntil":self.legacy_until,"allowed":self.allowed})
    }
}

pub struct Core {
    pub file: String,
    pub ids: Vec<i64>,
    pub cursor: i64,
    pub sequence: i64,
    pool_slots: Value,
    cd_order: Vec<i64>,
    pub cooldowns: HashMap<i64, i64>,
    pub flags: Map<String, Value>,
    pub auth_saves: Map<String, Value>,
    throttle: Value,
    qorder: Vec<String>,
    quotas: HashMap<String, QAcc>,
    dispatch: Map<String, Value>,
    pub halted: bool,
    pub tier_of: Box<dyn Fn(i64) -> String + Send + Sync>,
}

fn n64(v: &Value) -> i64 {
    as_num(v).map(|f| f as i64).unwrap_or(0)
}

impl Core {
    pub fn load(file: &str) -> Result<(Core, Vec<i64>), String> {
        let d = read_json(file).map_err(|e| e.to_string())?;
        let d = d.as_object().ok_or("Invalid checkpoint")?;
        if as_safe_int(d.g("version")) != Some(2) {
            return Err("Explicit per-model quota migration required".into());
        }
        let p = d.o("pool").ok_or("Invalid checkpoint")?;
        let disp = d.o("dispatch").ok_or("Invalid checkpoint")?.clone();
        let mut c = Core {
            file: file.into(),
            ids: vec![],
            cursor: n64(p.g("cursor")),
            sequence: n64(p.g("sequence")),
            pool_slots: p.g("slots").clone(),
            cd_order: vec![],
            cooldowns: HashMap::new(),
            flags: d.o("accountFlags").cloned().unwrap_or_default(),
            auth_saves: d.o("authSaves").cloned().unwrap_or_default(),
            throttle: d.get("rotationThrottle").cloned().filter(|v| !v.is_null()).unwrap_or(json!({"lastAt":0})),
            qorder: vec![],
            quotas: HashMap::new(),
            halted: disp.get("halted") == Some(&Value::Bool(true)),
            dispatch: disp,
            tier_of: Box::new(|_| "standard".into()),
        };
        let mut seen = std::collections::HashSet::new();
        for x in p.a("ids") {
            let n = as_safe_int(x).ok_or("Invalid account pool")?;
            if n < 1 || !seen.insert(n) {
                return Err("Invalid account pool".into());
            }
            c.ids.push(n);
        }
        if c.ids.is_empty() {
            return Err("Invalid account pool".into());
        }
        for e in p.a("cooldowns") {
            let a = e.as_array().filter(|a| a.len() == 2).ok_or("Invalid cooldown")?;
            let id = n64(&a[0]);
            if !seen.contains(&id) {
                return Err("Invalid cooldown".into());
            }
            if !c.cooldowns.contains_key(&id) {
                c.cd_order.push(id);
            }
            c.cooldowns.insert(id, n64(&a[1]));
        }
        let ql = d.o("quotaLedger").ok_or("Invalid model quota ledger")?;
        let accs = ql.o("accounts").filter(|_| n64(ql.g("version")) == 1).ok_or("Invalid model quota ledger")?;
        for (k, a) in accs {
            let id: i64 = k.parse().map_err(|_| "Unknown quota account")?;
            let a = a.as_object().ok_or("Unknown quota account")?;
            if !seen.contains(&id) {
                return Err("Unknown quota account".into());
            }
            let mut qa = QAcc { window_start: n64(a.g("windowStart")), legacy: a.get("legacy").cloned().filter(|v| v.is_object()), ..Default::default() };
            if let Some(ms) = a.o("models") {
                for (m, q) in ms {
                    qa.morder.push(m.clone());
                    qa.models.insert(m.clone(), QModel { family: q.s("family").into(), used: n64(q.g("used")), cooldown_until: n64(q.g("cooldownUntil")) });
                }
            }
            c.qorder.push(k.clone());
            c.quotas.insert(k.clone(), qa);
        }
        let mut missing = vec![];
        for id in c.ids.clone() {
            if !c.quotas.contains_key(&id.to_string()) {
                c.account_mut(id);
                missing.push(id);
            }
        }
        Ok((c, missing))
    }

    pub fn account(&self, id: i64) -> Option<&QAcc> {
        self.quotas.get(&id.to_string())
    }
    pub fn account_mut(&mut self, id: i64) -> &mut QAcc {
        let k = id.to_string();
        if !self.quotas.contains_key(&k) {
            self.qorder.push(k.clone());
            self.quotas.insert(k.clone(), QAcc::default());
        }
        self.quotas.get_mut(&k).unwrap()
    }

    pub fn snapshot(&self) -> Vec<u8> {
        let mut keys = self.qorder.clone();
        keys.sort_by_key(|k| k.parse::<i64>().unwrap_or(i64::MAX));
        let mut ql = Map::new();
        for k in keys {
            let a = &self.quotas[&k];
            let mut ms = Map::new();
            for m in &a.morder {
                let q = &a.models[m];
                ms.insert(m.clone(), json!({"family":q.family,"used":q.used,"cooldownUntil":q.cooldown_until}));
            }
            ql.insert(k, json!({"windowStart":a.window_start,"models":ms,"legacy":a.legacy.clone().unwrap_or(Value::Null)}));
        }
        let cds: Vec<Value> = self.cd_order.iter().map(|id| json!([id, self.cooldowns[id]])).collect();
        let mut disp = self.dispatch.clone();
        disp.insert("halted".into(), Value::Bool(self.halted));
        let mut o = Map::new();
        o.insert("version".into(), json!(2));
        o.insert("rotationThrottle".into(), self.throttle.clone());
        o.insert("authSaves".into(), Value::Object(self.auth_saves.clone()));
        o.insert("accountFlags".into(), Value::Object(self.flags.clone()));
        o.insert("quotaLedger".into(), json!({"version":1,"accounts":ql}));
        let mut pool = Map::new();
        pool.insert("ids".into(), json!(self.ids));
        pool.insert("cursor".into(), json!(self.cursor));
        pool.insert("sequence".into(), json!(self.sequence));
        pool.insert("slots".into(), self.pool_slots.clone());
        pool.insert("cooldowns".into(), Value::Array(cds));
        o.insert("pool".into(), Value::Object(pool));
        o.insert("dispatch".into(), Value::Object(disp));
        js_bytes(&Value::Object(o))
    }

    /// Write state.json; a failed write halts dispatch (same as Node).
    pub fn checkpoint(&mut self) -> bool {
        if READ_ONLY.load(Ordering::Relaxed) {
            return true;
        }
        if write_atomic(&self.file, &self.snapshot(), 0o600, true).is_err() {
            self.halted = true;
            return false;
        }
        true
    }
    pub fn try_resume(&mut self) -> bool {
        if !self.halted {
            return false;
        }
        self.halted = false;
        if !self.checkpoint() {
            self.halted = true;
            return false;
        }
        true
    }

    // ---- pool ----
    pub fn in_pool(&self, id: i64) -> bool {
        self.ids.contains(&id)
    }
    pub fn cooldown(&mut self, id: i64, until: i64) {
        match self.cooldowns.get(&id) {
            None => {
                self.cd_order.push(id);
                self.cooldowns.insert(id, until);
            }
            Some(&cur) if until > cur => {
                self.cooldowns.insert(id, until);
            }
            _ => {}
        }
    }
    pub fn clear_cooldown(&mut self, id: i64) {
        if self.cooldowns.remove(&id).is_some() {
            self.cd_order.retain(|x| *x != id);
        }
    }
    pub fn cooldown_of(&self, id: i64) -> i64 {
        *self.cooldowns.get(&id).unwrap_or(&0)
    }
    pub fn add_account(&mut self, id: i64) {
        self.account_mut(id);
        self.ids.push(id);
        self.ids.sort();
    }

    // ---- flags ----
    pub fn flag(&self, id: i64) -> Option<&Map<String, Value>> {
        self.flags.get(&id.to_string()).and_then(|v| v.as_object())
    }
    pub fn flag_status(&self, id: i64) -> &str {
        self.flag(id).map(|f| f.s("status")).unwrap_or("")
    }
    pub fn deleted(&self, id: i64) -> bool {
        self.flag_status(id) == "deleted"
    }
    pub fn set_flag(&mut self, id: i64, f: Option<Value>) {
        let k = id.to_string();
        match f {
            None => {
                self.flags.shift_remove(&k);
            }
            Some(v) => {
                self.flags.insert(k, v);
                let mut entries: Vec<(String, Value)> = std::mem::take(&mut self.flags).into_iter().collect();
                entries.sort_by_key(|(k, _)| k.parse::<i64>().unwrap_or(i64::MAX));
                self.flags = entries.into_iter().collect();
            }
        }
    }

    // ---- quota ledger ----
    fn limit_for(&self, id: i64, family: &str) -> Option<i64> {
        Some(tier_limit(&(self.tier_of)(id), family))
    }
    fn window_active(a: Option<&QAcc>, now: i64) -> bool {
        a.map(|a| a.window_start > 0 && a.window_start <= now && a.window_start >= period_start(now)).unwrap_or(false)
    }
    pub fn view(&self, id: i64, model: &str, family: &str, now: i64) -> QView {
        let a = self.account(id);
        let q = a.and_then(|a| a.models.get(model));
        let active = Self::window_active(a, now);
        let used = if active { q.map(|q| q.used).unwrap_or(0) } else { 0 };
        let (mut lb, mut lu) = (false, 0);
        if let Some(l) = a.and_then(|a| a.legacy.as_ref()) {
            let until = n64(l.g("until"));
            if now < until && l.a("blockedFamilies").iter().any(|f| f.as_str() == Some(family)) {
                lb = true;
                lu = until;
            }
        }
        let cd = q.map(|q| q.cooldown_until).unwrap_or(0);
        let limit = self.limit_for(id, family);
        let (ws, we) = if active {
            let w = a.unwrap().window_start;
            (w, period_start(w) + DAY)
        } else {
            (0, 0)
        };
        QView {
            model: model.into(),
            family: family.into(),
            limit,
            used,
            remaining: limit.map(|l| (l - used).max(0)),
            window_start: ws,
            window_end: we,
            cooldown_until: cd,
            legacy_blocked: lb,
            legacy_until: lu,
            allowed: !lb && cd <= now && limit.map(|l| used < l).unwrap_or(true),
        }
    }
    pub fn charge(&mut self, id: i64, model: &str, family: &str) -> bool {
        let now = now_ms();
        if !self.view(id, model, family, now).allowed {
            return false;
        }
        let active = Self::window_active(self.account(id), now);
        let a = self.account_mut(id);
        if !active {
            for q in a.models.values_mut() {
                q.used = 0;
            }
            a.window_start = now;
        }
        let q = a.model_mut(model, family);
        q.family = family.into();
        q.used += 1;
        true
    }
    pub fn defer(&mut self, id: i64, model: &str, family: &str, until: i64) {
        let q = self.account_mut(id).model_mut(model, family);
        if until > q.cooldown_until {
            q.cooldown_until = until;
        }
    }
    pub fn clear_model_cooldowns(&mut self, id: i64) -> usize {
        let mut n = 0;
        if let Some(a) = self.quotas.get_mut(&id.to_string()) {
            for q in a.models.values_mut() {
                if q.cooldown_until != 0 {
                    q.cooldown_until = 0;
                    n += 1;
                }
            }
        }
        n
    }
    pub fn reset_used(&mut self, id: i64) -> usize {
        let mut n = 0;
        if let Some(a) = self.quotas.get_mut(&id.to_string()) {
            for q in a.models.values_mut() {
                if q.used != 0 {
                    q.used = 0;
                    n += 1;
                }
            }
        }
        n
    }
    pub fn model_cooldowns(&self, id: i64) -> Vec<Value> {
        let now = now_ms();
        let Some(a) = self.account(id) else { return vec![] };
        a.morder.iter().filter_map(|m| {
            let q = &a.models[m];
            (q.cooldown_until > now).then(|| json!({"model":m,"until":q.cooldown_until}))
        }).collect()
    }
    pub fn summary(&self, id: i64, policies: &PolicyStore) -> Value {
        let now = now_ms();
        let mut models = Map::new();
        for (m, p) in policies.ordered() {
            models.insert(m.clone(), self.view(id, &m, &p.family, now).json());
        }
        let legacy = self.account(id).and_then(|a| a.legacy.clone()).unwrap_or(Value::Null);
        json!({"account":id,"models":models,"legacy":legacy})
    }
}