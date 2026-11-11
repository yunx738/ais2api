// Build channel runtime (build_channel.go): settings, token ledger, admission, upstream calls
// (callBuild / readFile) and per-request / nightly project rotation.
use crate::app::App;
use crate::build_ctx::{btokens, build_models, parse_build_model, BPart, BASES, INLINE_BUDGET, MAX_BYTES};
use crate::build_presets::PresetStore;
use crate::build_resp::DocumentSwitch;
use crate::resp::Cancel;
use crate::sched::{Plan, RE_SIGNATURE};
use crate::state::READ_ONLY;
use crate::backend::Backend;
use crate::svc::{raw_s, raw_t, rpc_body};
use crate::util::*;
use base64::Engine;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub static RE_APP: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap());
static RE_DIGITS: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d+$").unwrap());
static RE_BUILD_FAILED: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\[null,null,null,null,null,\["[^"]{1,300}",\["#).unwrap());

fn ro() -> bool {
    READ_ONLY.load(Ordering::Relaxed)
}
fn save(file: &str, data: &[u8], mode: u32) {
    if !ro() {
        let _ = write_simple(file, data, mode);
    }
}
fn n64(v: &Value) -> i64 {
    as_num(v).map(|f| f as i64).unwrap_or(0)
}

// ---------------- token ledger (build-tokens.json) ----------------
pub struct TokenLedger {
    file: String,
    data: Map<String, Value>,
    reserved: HashMap<i64, i64>,
}
impl TokenLedger {
    fn open(file: &str) -> Self {
        let mut data = json!({"version":1,"accounts":{}}).as_object().unwrap().clone();
        if let Ok(Value::Object(o)) = read_json(file) {
            if n64(o.g("version")) == 1 && o.g("accounts").is_object() {
                data = o;
            }
        }
        TokenLedger { file: file.into(), data, reserved: HashMap::new() }
    }
    fn entry(&self, id: i64, now: i64) -> Map<String, Value> {
        let a = self.data.g("accounts").g(&id.to_string());
        if !a.is_object() || n64(a.g("windowStart")) < period_start(now) {
            let cd = n64(a.g("cooldownUntil"));
            return json!({"used":0,"windowStart":period_start(now),"cooldownUntil":cd,"requests":0,"input":0,"output":0,"cached":0,"failed":0,"models":{}})
                .as_object().unwrap().clone();
        }
        a.as_object().unwrap().clone()
    }
    fn put(&mut self, id: i64, e: Map<String, Value>) {
        if let Some(Value::Object(acc)) = self.data.get_mut("accounts") {
            acc.insert(id.to_string(), Value::Object(e));
        }
        save(&self.file, &js_bytes(&Value::Object(self.data.clone())), 0o600);
    }
    fn view(&self, id: i64, tier: String) -> Value {
        let now = now_ms();
        let e = self.entry(id, now);
        let cd = n64(e.g("cooldownUntil"));
        let models = if e.g("models").is_object() { e.g("models").clone() } else { json!({}) };
        json!({"account":id,"tier":tier,"limit":null,"used":n64(e.g("used")),"reserved":self.reserved.get(&id).copied().unwrap_or(0),"remaining":null,
            "requests":n64(e.g("requests")),"input":n64(e.g("input")),"output":n64(e.g("output")),"cached":n64(e.g("cached")),"failed":n64(e.g("failed")),
            "models":models,"windowStart":period_start(now),"windowEnd":period_start(now)+DAY,"cooldownUntil":cd,"unlimited":true,"allowed":cd <= now})
    }
    fn allowed(&self, id: i64) -> bool {
        n64(self.entry(id, now_ms()).g("cooldownUntil")) <= now_ms()
    }
    fn reserve(&mut self, id: i64, n: i64) -> i64 {
        let n = n.max(0);
        *self.reserved.entry(id).or_insert(0) += n;
        n
    }
    fn release(&mut self, id: i64, n: i64) {
        let left = self.reserved.get(&id).copied().unwrap_or(0) - n;
        if left > 0 {
            self.reserved.insert(id, left);
        } else {
            self.reserved.remove(&id);
        }
    }
    fn charge(&mut self, id: i64, tokens: i64, model: &str, inp: Option<i64>, out: Option<i64>, cached: Option<i64>) {
        let tokens = tokens.max(0);
        let e = self.entry(id, now_ms());
        let mut models = e.o("models").cloned().unwrap_or_default();
        if !model.is_empty() {
            let m = models.get(model).cloned().unwrap_or(Value::Null);
            models.insert(model.into(), json!({"requests":n64(m.g("requests"))+1,"tokens":n64(m.g("tokens"))+tokens}));
        }
        let p = |v: Option<i64>| v.filter(|x| *x > 0).unwrap_or(0);
        let ne = json!({"used":n64(e.g("used"))+tokens,"windowStart":n64(e.g("windowStart")),"cooldownUntil":n64(e.g("cooldownUntil")),
            "requests":n64(e.g("requests"))+1,"input":n64(e.g("input"))+p(inp),"output":n64(e.g("output"))+p(out),"cached":n64(e.g("cached"))+p(cached),
            "failed":n64(e.g("failed")),"models":models});
        self.put(id, ne.as_object().unwrap().clone());
    }
    fn fail(&mut self, id: i64) {
        let mut e = self.entry(id, now_ms());
        let f = n64(e.g("failed")) + 1;
        e.insert("failed".into(), json!(f));
        self.put(id, e);
    }
    fn defer(&mut self, id: i64, until: i64) {
        let mut e = self.entry(id, now_ms());
        if until > n64(e.g("cooldownUntil")) {
            e.insert("cooldownUntil".into(), json!(until));
        }
        self.put(id, e);
    }
    fn log(&mut self, item: Value) {
        let mut r = self.data.a("recent").to_vec();
        r.push(item);
        if r.len() > 50 {
            r.drain(..r.len() - 50);
        }
        self.data.insert("recent".into(), Value::Array(r));
        save(&self.file, &js_bytes(&Value::Object(self.data.clone())), 0o600);
    }
    fn recent(&self) -> Vec<Value> {
        self.data.a("recent").iter().rev().cloned().collect()
    }
}

// ---------------- channel ----------------
struct BState {
    premium_only: bool,
    enabled: bool,
    ledger: TokenLedger,
    reservations: HashMap<String, (i64, i64)>,
    inflight: HashMap<i64, HashMap<String, i64>>,
    denied: HashMap<String, i64>,
    stats: Map<String, Value>,
}
pub struct Build {
    root: String,
    pub apps_file: String,
    settings_file: String,
    pub doc: DocumentSwitch,
    pub presets: PresetStore,
    st: Mutex<BState>,
    max_inflight: usize,
    max_premium: usize,
}
fn env_cap(name: &str, def: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).filter(|n| (1..=10).contains(n)).unwrap_or(def)
}
impl Build {
    pub fn new(root: &str) -> Self {
        let settings_file = format!("{}/build-settings.json", root);
        let premium_only = read_json(&settings_file).ok().and_then(|v| v.get("premiumOnly").and_then(|b| b.as_bool())).unwrap_or(true);
        let enabled = read_json(&settings_file).ok().and_then(|v| v.get("enabled").and_then(|b| b.as_bool())).unwrap_or(true);
        let stats = json!({"requests":0,"charged":0,"missingUsage":0,"rejected":0}).as_object().unwrap().clone();
        Build {
            root: root.into(),
            apps_file: format!("{}/build-apps.json", root),
            settings_file,
            doc: DocumentSwitch::open(&format!("{}/build-document.json", root)),
            presets: PresetStore::new(&format!("{}/build-presets.json", root)),
            st: Mutex::new(BState { premium_only, enabled, ledger: TokenLedger::open(&format!("{}/build-tokens.json", root)), reservations: HashMap::new(),
                inflight: HashMap::new(), denied: HashMap::new(), stats }),
            max_inflight: env_cap("BUILD_MAX_INFLIGHT_PER_ACCOUNT", 1),
            max_premium: env_cap("BUILD_MAX_INFLIGHT_PREMIUM", 2),
        }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, BState> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn inc(&self, k: &str, n: i64) {
        let mut s = self.lock();
        let v = n64(s.stats.g(k)) + n;
        s.stats.insert(k.into(), json!(v));
    }
    pub fn premium_only(&self) -> bool {
        self.lock().premium_only
    }
    /// channel switch: when off, Build models are rejected at once and no project is created or rotated
    pub fn enabled(&self) -> bool {
        self.lock().enabled
    }
    pub fn settings_status(&self) -> Value {
        let s = self.lock();
        json!({"premiumOnly":s.premium_only,"enabled":s.enabled})
    }
    pub fn set_settings(&self, b: &Value) -> R<Value> {
        let mut s = self.lock();
        let mut next = s.premium_only;
        if let Some(v) = b.get("premiumOnly").filter(|v| !v.is_null()) {
            next = v.as_bool().ok_or_else(|| HttpErr::new(400, "premiumOnly 必须是 true/false"))?;
        }
        let mut on = s.enabled;
        if let Some(v) = b.get("enabled").filter(|v| !v.is_null()) {
            on = v.as_bool().ok_or_else(|| HttpErr::new(400, "enabled 必须是 true/false"))?;
        }
        if !ro() {
            write_simple(&self.settings_file, js_indent(&json!({"premiumOnly":next,"enabled":on}), " ").as_bytes(), 0o644).map_err(|e| HttpErr::plain(e.to_string()))?;
        }
        if on != s.enabled {
            log(format!("[Build] channel {}", if on { "enabled" } else { "disabled" }));
        }
        s.premium_only = next;
        s.enabled = on;
        Ok(json!({"premiumOnly":next,"enabled":on}))
    }
    /// build-apps.json -> account -> applet id (key order as in the file)
    pub fn apps(&self) -> Vec<(i64, String)> {
        let Ok(Value::Object(o)) = read_json(&self.apps_file) else { return vec![] };
        o.iter().filter_map(|(k, v)| {
            let v = js_str(v).to_lowercase();
            (RE_DIGITS.is_match(k) && RE_APP.is_match(&v)).then(|| (k.parse().unwrap_or(0), v))
        }).collect()
    }
    pub fn app_for(&self, id: i64) -> String {
        self.apps().into_iter().find(|(k, _)| *k == id).map(|(_, v)| v).unwrap_or_default()
    }
    fn busy_l(s: &mut BState, id: i64) -> usize {
        let stale = now_ms() - 15 * 60000;
        match s.inflight.get_mut(&id) {
            Some(m) => {
                m.retain(|_, t| *t >= stale);
                m.len()
            }
            None => 0,
        }
    }
    pub fn busy(&self, id: i64) -> usize {
        Self::busy_l(&mut self.lock(), id)
    }
    fn can_use(&self, app: &App, id: i64, model: &str) -> bool {
        if crate::model_access::ultra_only(model) && !app.acc.is_ultra(id) {
            return false;
        }
        app.acc.tier(id) != "standard" || (!self.premium_only() && model.contains("flash"))
    }
    fn blocked(&self, app: &App, id: i64, model: &str) -> bool {
        let d = self.lock().denied.get(&format!("{}|{}", id, model)).copied().unwrap_or(0);
        !self.can_use(app, id, model) || d > now_ms()
    }
    pub fn ready(&self, app: &App, id: i64, model: &str) -> bool {
        !self.app_for(id).is_empty() && self.lock().ledger.allowed(id) && !self.blocked(app, id, model)
    }
    /// None for non-Build models
    pub fn resolve(&self, app: &App, route: &str, parsed: &Map<String, Value>, allow_unavailable: bool) -> R<Option<Plan>> {
        let Some(spec) = parse_build_model(parsed.s("model"))? else { return Ok(None) };
        if !self.enabled() {
            return herr(503, "Build 通道已关闭，请在管理后台开启后再使用");
        }
        if route != "/v1/chat/completions" {
            return herr(400, "Build 通道只支持 /v1/chat/completions");
        }
        let apps = self.apps();
        if apps.is_empty() {
            return herr(503, "没有已开通 Build 项目的账号");
        }
        if !allow_unavailable {
            let all = apps.iter().all(|(id, _)| self.blocked(app, *id, &spec.model));
            let some = apps.iter().any(|(id, _)| self.can_use(app, *id, &spec.model));
            if all {
                let msg = if some {
                    format!("没有账号能使用 {}（Google 拒绝），请换模型", spec.model)
                } else if self.premium_only() {
                    "Build 通道已设为只用 Pro/Ultra 账号，当前没有可用的 Pro/Ultra 账号".to_string()
                } else {
                    format!("{} 需要 Pro/Ultra 账号，当前只有 Free 账号可用，请改用 flash 模型", spec.model)
                };
                return herr(403, msg);
            }
            let (mut any, mut soon) = (false, i64::MAX);
            for (id, _) in &apps {
                let v = self.lock().ledger.view(*id, String::new());
                any |= v.b("allowed");
                soon = soon.min(n64(v.g("cooldownUntil")));
            }
            if !any {
                let mut e = HttpErr::new(429, format!("Build 通道暂不可用（冷却或额度），约 {}（北京时间）恢复", bj_time(soon)));
                e.retry_after = ((soon - now_ms() + 999) / 1000).max(1);
                return Err(e);
            }
        }
        let est: i64 = parsed.a("messages").iter().map(|m| match m.g("content") {
            Value::String(s) => btokens(s) as i64,
            Value::Null => 0,
            c => btokens(&js(c)) as i64,
        }).sum();
        Ok(Some(Plan { model: format!("build-{}", spec.model), family: "ultra".into(), build: Some(spec), estimate: est }))
    }
    pub fn admit(&self, app: &App, plan: &Plan, a: i64, id: &str) -> bool {
        let model = &plan.build.as_ref().unwrap().model;
        if !self.ready(app, a, model) {
            return false;
        }
        let cap = if app.acc.is_premium(a) { self.max_premium } else { self.max_inflight };
        let mut s = self.lock();
        if Self::busy_l(&mut s, a) >= cap {
            let v = n64(s.stats.g("waitedInflight")) + 1;
            s.stats.insert("waitedInflight".into(), json!(v));
            return false;
        }
        s.inflight.entry(a).or_default().insert(id.into(), now_ms());
        let n = s.ledger.reserve(a, plan.estimate);
        s.reservations.insert(id.into(), (a, n));
        true
    }
    /// reservation held for this ticket (taken once)
    pub fn take_reservation(&self, id: &str, account: i64) -> i64 {
        match self.lock().reservations.remove(id) {
            Some((a, n)) if a == account => n,
            _ => 0,
        }
    }
    /// end of a Build execution: release slot + reservation, charge the ledger, log
    pub fn settle(&self, id: &str, account: i64, reserved: i64, requested: &str, model: &str, status: u16, usage: Option<&crate::metrics::Usage>, ms: i64) {
        let mut s = self.lock();
        for m in s.inflight.values_mut() {
            m.remove(id);
        }
        s.ledger.release(account, reserved);
        let total = usage.and_then(|u| u.total.or_else(|| match (u.input, u.output) {
            (Some(i), Some(o)) => Some(i + o),
            _ => None,
        }));
        let mut charged = 0;
        if let Some(t) = total {
            let u = usage.unwrap();
            s.ledger.charge(account, t, requested, u.input, u.output, u.cached);
            charged = t;
            let v = n64(s.stats.g("charged")) + t;
            s.stats.insert("charged".into(), json!(v));
        } else if status == 200 {
            let v = n64(s.stats.g("missingUsage")) + 1;
            s.stats.insert("missingUsage".into(), json!(v));
            s.ledger.charge(account, reserved, requested, None, None, None);
            charged = reserved;
        } else {
            s.ledger.fail(account);
        }
        let (i, o, c) = usage.map(|u| (json!(u.input), json!(u.output), json!(u.cached))).unwrap_or((Value::Null, Value::Null, Value::Null));
        s.ledger.log(json!({"at":now_ms(),"account":account,"model":requested,"status":status,"ms":ms,"input":i,"output":o,"cached":c,
            "charged":charged,"estimated":total.is_none()}));
        if status == 429 {
            s.ledger.defer(account, now_ms() + 60000);
        }
        if status == 403 {
            s.denied.insert(format!("{}|{}", account, model), now_ms() + 6 * 3_600_000);
            elog(format!("[Build] #{} refused {}; skipped for 6h", account, model));
        }
        if status >= 400 {
            let v = n64(s.stats.g("rejected")) + 1;
            s.stats.insert("rejected".into(), json!(v));
        }
    }
    pub fn status(&self, app: &App) -> Value {
        let apps = self.apps();
        let mut sorted: BTreeMap<i64, String> = BTreeMap::new();
        for (k, v) in &apps {
            sorted.insert(*k, v.clone());
        }
        let now = now_ms();
        let mut ao = Map::new();
        let mut accs = vec![];
        let s = self.lock();
        for (id, app_id) in &sorted {
            ao.insert(id.to_string(), json!(app_id));
            let mut v = s.ledger.view(*id, app.acc.tier(*id));
            v["premium"] = json!(app.acc.is_premium(*id));
            v["app"] = json!(app_id);
            let pre = format!("{}|", id);
            let dm: Vec<Value> = s.denied.iter().filter(|(k, t)| **t > now && k.starts_with(&pre)).map(|(k, _)| json!(k[pre.len()..])).collect();
            v["deniedModels"] = Value::Array(dm);
            accs.push(v);
        }
        let stats = s.stats.clone();
        let recent = s.ledger.recent();
        drop(s);
        json!({"apps":ao,"stats":stats,"settings":self.settings_status(),"document":self.doc.status(),"presets":self.presets.list(),
            "limits":{"standard":null,"pro":null,"ultra":null,"ultra20":null},"maxContextBytes":MAX_BYTES,"inlineBudget":INLINE_BUDGET,
            "windowStart":period_start(now),"windowEnd":period_start(now)+DAY,"models":build_models(),"accounts":accs,"recent":recent})
    }
    pub fn root(&self) -> &str {
        &self.root
    }
    /// account deleted: drop it from build-apps.json and the channel state
    pub fn forget(&self, id: i64) {
        if let Ok(Value::Object(mut o)) = read_json(&self.apps_file) {
            if o.shift_remove(&id.to_string()).is_some() {
                save(&self.apps_file, &js_bytes(&Value::Object(o)), 0o600);
            }
        }
        let mut s = self.lock();
        s.inflight.remove(&id);
        let pre = format!("{}|", id);
        s.denied.retain(|k, _| !k.starts_with(&pre));
    }
}

// ---------------- headless Build calls ----------------
pub struct BuildResult {
    pub s: u16,
    pub stage: String,
    pub t: String,
    pub tries: i64,
    pub polls: i64,
    pub resent: i64,
}
fn br(s: u16, stage: &str, t: String) -> BuildResult {
    BuildResult { s, stage: stage.into(), t, tries: 0, polls: 0, resent: 0 }
}
pub async fn call_build(svc: &'static dyn Backend, parent: &Arc<Cancel>, account: &str, parts: &[BPart], model: &str, thinking: i64, app: &str, hard: Duration) -> BuildResult {
    if !RE_APP.is_match(app) {
        return br(400, "args", "invalid applet".into());
    }
    let cancel = parent.child();
    let t0 = std::time::Instant::now();
    let deadline = tokio::time::Instant::now() + hard;
    let mut gid = String::new();
    let fail = |status: u16, msg: &str| -> BuildResult {
        if parent.is() {
            return br(499, "cancel", "cancelled".into());
        }
        if tokio::time::Instant::now() >= deadline {
            return br(504, "fetch", format!("timeout after {}s", hard.as_secs()));
        }
        let st = if status == 0 || status == 499 { 502 } else { status };
        br(st, "fetch", clip_runes(msg, 200))
    };
    // the whole call is bounded by `hard`
    let watchdog = {
        let c = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            c.cancel();
        })
    };
    let res = async {
        let mut wire: Vec<Value> = Vec::with_capacity(parts.len());
        for p in parts {
            match p {
                BPart::Wire(v) => wire.push(v.clone()),
                BPart::Upload(m) => {
                    let r = match svc.raw(&cancel, &json!({"op":"upload","account":account,"mime":m.mime,"data":m.data}), Duration::from_secs(120)).await {
                        Ok(r) => r,
                        Err(e) => return fail(e.status, &e.msg),
                    };
                    if raw_s(&r) != 200 || !truthy(r.g("path")) {
                        return br(502, "upload", format!("upload {} {}", raw_s(&r), clip_runes(&raw_t(&r), 300)));
                    }
                    let n = base64::engine::general_purpose::STANDARD.decode(&m.data).map(|d| d.len()).unwrap_or(0);
                    let mut w = vec![Value::Null; 18];
                    w[17] = json!([m.mime, r.g("path"), m.name, n.to_string()]);
                    wire.push(Value::Array(w));
                }
            }
        }
        let binding: Vec<String> = wire.iter().map(|w| {
            let a = w.as_array().map(|a| a.as_slice()).unwrap_or(&[]);
            if a.len() > 1 && !a[1].is_null() {
                js_str(&a[1])
            } else if a.len() > 2 {
                a[2].as_array().filter(|x| x.len() > 1).map(|x| js_str(&x[1])).unwrap_or_default()
            } else {
                String::new()
            }
        }).collect();
        let binding = binding.join(" ");
        let mut res = br(0, "", String::new());
        let mut r2 = Value::Null;
        let mut t2 = String::new();
        let mut g = 0;
        loop {
            let mut r1;
            let mut tg = 1;
            loop {
                res.tries += 1;
                let think = if thinking > 0 { json!([1, null, null, thinking]) } else { Value::Null };
                let body = json!([[[wire, "user"]], null, null, null, null, 2, null, format!("models/{}", model), null, null, null, app, null, [2], null, 1, null, null, think,
                    null, null, null, true, null, null, null, null, null, uuid4().to_uppercase()]);
                r1 = match svc.raw(&cancel, &json!({"op":"submit","account":account,"body":body,"binding":binding}), Duration::from_secs(120)).await {
                    Ok(r) => r,
                    Err(e) => return fail(e.status, &e.msg),
                };
                if raw_s(&r1) == 403 && RE_SIGNATURE.is_match(&raw_t(&r1)) && tg < 8 {
                    tg += 1;
                    tokio::select! {
                        _ = cancel.wait() => return fail(0, "cancelled"),
                        _ = tokio::time::sleep(Duration::from_millis(1500 * res.tries as u64)) => {}
                    }
                    continue;
                }
                break;
            }
            if raw_s(&r1) != 200 {
                let mut x = br(raw_s(&r1), "create", clip_runes(&raw_t(&r1), 2000));
                x.tries = res.tries;
                return x;
            }
            gid = serde_json::from_str::<Value>(&raw_t(&r1)).ok().and_then(|v| v.get(0).and_then(|x| x.as_str()).map(String::from)).unwrap_or_default();
            if gid.is_empty() {
                let mut x = br(502, "create", format!("no generation id: {}", clip_runes(&raw_t(&r1), 300)));
                x.tries = res.tries;
                return x;
            }
            let done = Regex::new(&format!(r#"\["\d+","\d+"(?:,"\d+")?\],"{}"\]"#, regex::escape(&gid))).unwrap();
            res.polls = 0;
            let mut first_model = 0;
            loop {
                res.polls += 1;
                let left = hard.saturating_sub(t0.elapsed()).max(Duration::from_secs(5));
                r2 = match svc.raw(&cancel, &rpc_body(account, "StreamCodeAssistantOfflineGeneration", json!([gid, null, null, app])), left).await {
                    Ok(r) => r,
                    Err(e) => return fail(e.status, &e.msg),
                };
                if raw_s(&r2) != 200 {
                    if t2.is_empty() {
                        t2 = raw_t(&r2);
                    }
                    break;
                }
                t2 = raw_t(&r2);
                if first_model == 0 && t2.contains(r#""model"]"#) {
                    first_model = res.polls;
                }
                if RE_BUILD_FAILED.is_match(&t2) || done.is_match(&t2) || res.polls >= 20 {
                    break;
                }
                if first_model == 0 && res.polls >= 12 && g < 1 {
                    break;
                }
                tokio::select! {
                    _ = cancel.wait() => return fail(0, "cancelled"),
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                }
            }
            if raw_s(&r2) == 200 && first_model == 0 && !done.is_match(&t2) && g < 1 && !RE_BUILD_FAILED.is_match(&t2) {
                res.resent += 1;
                g += 1;
                continue;
            }
            break;
        }
        gid.clear();
        res.s = raw_s(&r2);
        res.stage = "stream".into();
        res.t = t2;
        res
    }.await;
    watchdog.abort();
    if !gid.is_empty() {
        // a generation is still running on Google's side: cancel it (best effort, detached)
        let (acc, app) = (account.to_string(), app.to_string());
        let body = rpc_body(&acc, "CancelCodeAssistantOfflineGeneration", json!([gid, app]));
        tokio::spawn(async move {
            let _ = svc.raw(&Cancel::new(), &body, Duration::from_secs(30)).await;
        });
    }
    res
}
pub async fn read_file(svc: &dyn Backend, cancel: &Arc<Cancel>, account: &str, app: &str, hash: &str) -> (String, usize, String) {
    let r = match svc.raw(cancel, &json!({"op":"file","account":account,"applet":app,"hash":hash}), Duration::from_secs(60)).await {
        Ok(r) => r,
        Err(e) => return (String::new(), 0, format!("status_{}", e.status)),
    };
    let d = r.g("data").as_str();
    if raw_s(&r) != 200 || d.is_none() {
        return (String::new(), 0, match raw_s(&r) {
            409 => "hash_mismatch".into(),
            413 => "too_large".into(),
            s => format!("status_{}", s),
        });
    }
    let b = base64::engine::general_purpose::STANDARD.decode(d.unwrap()).unwrap_or_default();
    let n = b.len();
    match String::from_utf8(b) {
        Ok(s) => (s.strip_prefix('\u{feff}').map(String::from).unwrap_or(s), n, String::new()),
        Err(_) => (String::new(), n, "not_utf8".into()),
    }
}

// ---------------- applet rotation ----------------
pub struct Rotation {
    state_file: String,
    inner: Mutex<(bool, HashSet<i64>, HashMap<i64, i64>, Value)>, // running, ensuring, ensureAfter, last
}
/// New Build project. Since 2026-11-07 Google installs and builds every project before a generation runs, so the
/// project must be a buildable Vite app (a bare metadata.json + index.html fails with "Dependency installation failed").
pub fn create_applet_request() -> Value {
    let (name, desc) = ("GW Text Bridge", "Minimal private project for text-chat context files.");
    let md = js_indent(&json!({"name":name,"description":desc,"requestFramePermissions":[]}), "  ");
    let pkg = js_indent(&json!({"name":"gw-text-bridge","private":true,"version":"0.0.0","type":"module",
        "scripts":{"dev":"vite","build":"vite build","preview":"vite preview"},"dependencies":{},"devDependencies":{"vite":"^6.2.0"}}), "  ");
    let html = "<!doctype html>\n<html lang=\"en\">\n<head><meta charset=\"UTF-8\" /><title>Ready</title></head>\n<body><div id=\"root\">Ready</div><script type=\"module\" src=\"/index.js\"></script></body>\n</html>\n";
    let js_src = "document.getElementById(\"root\").textContent = \"Ready\";\n";
    let e = &base64::engine::general_purpose::STANDARD;
    json!([null, [name, desc], null, [[name, desc], [["metadata.json", e.encode(md)], ["index.html", e.encode(html)], ["index.js", e.encode(js_src)], ["package.json", e.encode(pkg)]]]])
}
fn parse_created(status: u16, text: &str) -> String {
    if status != 200 {
        return String::new();
    }
    serde_json::from_str::<Value>(text).ok().and_then(|v| v.get(0).map(js_str)).map(|s| s.to_lowercase()).filter(|s| RE_APP.is_match(s)).unwrap_or_default()
}
fn deleted_ok(s: u16) -> bool {
    s == 200 || s == 404
}
pub fn bj_hour(t: i64) -> i64 {
    ((t + 8 * 3_600_000).div_euclid(3_600_000)).rem_euclid(24)
}
impl Rotation {
    pub fn new(state_file: &str) -> Self {
        Rotation { state_file: state_file.into(), inner: Mutex::new((false, HashSet::new(), HashMap::new(), Value::Null)) }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, (bool, HashSet<i64>, HashMap<i64, i64>, Value)> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
    async fn rpc(app: &App, email: &str, method: &str, body: Value) -> Result<(u16, String), String> {
        match app.svc.raw(&Cancel::new(), &rpc_body(email, method, body), Duration::from_secs(90)).await {
            Err(e) => Err(e.msg),
            Ok(r) if raw_s(&r) == 0 => Err("headless rpc failed".into()),
            Ok(r) => Ok((raw_s(&r), raw_t(&r))),
        }
    }
    fn read_apps(app: &App) -> Option<Map<String, Value>> {
        read_json(&app.build.apps_file).ok().and_then(|v| v.as_object().cloned())
    }
    fn write_apps(app: &App, o: &Map<String, Value>) {
        save(&app.build.apps_file, &js_bytes(&Value::Object(o.clone())), 0o600);
    }
    fn read_state(&self) -> Map<String, Value> {
        match read_json(&self.state_file) {
            Ok(Value::Object(s)) if s.g("accounts").is_object() => s,
            _ => json!({"accounts":{}}).as_object().unwrap().clone(),
        }
    }
    fn write_state(&self, s: &Map<String, Value>) {
        save(&self.state_file, js_indent(&Value::Object(s.clone()), " ").as_bytes(), 0o644);
    }
    fn st_entry<'a>(state: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
        let accs = state.get_mut("accounts").unwrap().as_object_mut().unwrap();
        let e = accs.entry(key.to_string()).or_insert_with(|| json!({"lastAt":0,"pendingDelete":[]}));
        if !e.is_object() {
            *e = json!({"lastAt":0,"pendingDelete":[]});
        }
        let m = e.as_object_mut().unwrap();
        if !m.g("pendingDelete").is_array() {
            m.insert("pendingDelete".into(), json!([]));
        }
        m
    }
    fn cur_of(apps: &Map<String, Value>, key: &str) -> String {
        js_str(apps.g(key)).to_lowercase()
    }
    pub async fn ensure(&self, app: &App, id: i64, email: &str) -> String {
        if id < 1 || email.is_empty() {
            return "invalid".into();
        }
        let apps = Self::read_apps(app);
        if apps.is_none() && file_exists(&app.build.apps_file) {
            return "apps_unreadable".into();
        }
        if RE_APP.is_match(&Self::cur_of(&apps.unwrap_or_default(), &id.to_string())) {
            return "present".into();
        }
        {
            let mut i = self.lock();
            if i.0 || i.1.contains(&id) {
                return "busy".into();
            }
            if i.2.get(&id).copied().unwrap_or(0) > now_ms() {
                return "backoff".into();
            }
            i.1.insert(id);
        }
        let r = async {
            let backoff = || {
                self.lock().2.insert(id, now_ms() + 120_000);
            };
            let created = match Self::rpc(app, email, "CreateApplet", create_applet_request()).await {
                Err(e) => {
                    backoff();
                    return format!("create_failed:{}", clip_runes(&e, 60));
                }
                Ok((s, t)) => parse_created(s, &t),
            };
            if created.is_empty() {
                backoff();
                return "create_failed".into();
            }
            let mut fresh = Self::read_apps(app).unwrap_or_default();
            if RE_APP.is_match(&Self::cur_of(&fresh, &id.to_string())) {
                let _ = Self::rpc(app, email, "DeleteApplet", json!([created])).await;
                return "present".into();
            }
            fresh.insert(id.to_string(), json!(created));
            Self::write_apps(app, &fresh);
            let mut state = self.read_state();
            let st = Self::st_entry(&mut state, &id.to_string());
            st.insert("lastAt".into(), json!(now_ms()));
            st.insert("app".into(), json!(created));
            st.insert("provisionedAt".into(), json!(now_ms()));
            self.write_state(&state);
            self.lock().2.remove(&id);
            log(format!("[BuildProvision] #{} on {} -> new Build project {}", id, email, &created[..8]));
            "created".to_string()
        }.await;
        self.lock().1.remove(&id);
        r
    }
    pub async fn renew(&self, app: &App, id: i64, email: &str) -> String {
        if id < 1 || email.is_empty() {
            return "invalid".into();
        }
        {
            let i = self.lock();
            if i.0 || i.1.contains(&id) {
                return "busy".into();
            }
        }
        let Some(apps) = Self::read_apps(app) else { return "apps_unreadable".into() };
        let key = id.to_string();
        let cur = Self::cur_of(&apps, &key);
        if !RE_APP.is_match(&cur) {
            return "no_project".into();
        }
        self.lock().1.insert(id);
        let r = async {
            let created = match Self::rpc(app, email, "CreateApplet", create_applet_request()).await {
                Err(e) => return format!("create_failed:{}", clip_runes(&e, 40)),
                Ok((s, t)) => parse_created(s, &t),
            };
            if created.is_empty() {
                return "create_failed".into();
            }
            let Some(mut fresh) = Self::read_apps(app) else {
                let _ = Self::rpc(app, email, "DeleteApplet", json!([created])).await;
                return "apps_unreadable".into();
            };
            if Self::cur_of(&fresh, &key) != cur {
                let _ = Self::rpc(app, email, "DeleteApplet", json!([created])).await;
                return "changed".into();
            }
            fresh.insert(key.clone(), json!(created));
            Self::write_apps(app, &fresh);
            let mut state = self.read_state();
            let mut queue: Vec<String> = vec![];
            {
                let st = Self::st_entry(&mut state, &key);
                st.insert("lastAt".into(), json!(now_ms()));
                st.insert("app".into(), json!(created));
                st.shift_remove("lastError");
                for x in st.a("pendingDelete").iter().map(js_str).chain(std::iter::once(cur.clone())) {
                    if !queue.contains(&x) {
                        queue.push(x);
                    }
                }
            }
            let mut left = vec![];
            let mut pending_cur = false;
            for old in queue {
                let ok = matches!(Self::rpc(app, email, "DeleteApplet", json!([old])).await, Ok((s, _)) if deleted_ok(s));
                if !ok {
                    if old == cur {
                        pending_cur = true;
                    }
                    left.push(json!(old));
                }
            }
            Self::st_entry(&mut state, &key).insert("pendingDelete".into(), Value::Array(left));
            self.write_state(&state);
            let r = if pending_cur { "renewed_delete_pending" } else { "renewed" };
            log(format!("[BuildRenew] #{} {} -> {} {}", key, &cur[..8], &created[..8], r));
            r.to_string()
        }.await;
        self.lock().1.remove(&id);
        r
    }
    pub async fn tick(&self, app: &App, force: bool, only: i64) -> Value {
        {
            let mut i = self.lock();
            if i.0 || !i.1.is_empty() {
                return json!({"skipped":"running"});
            }
            let h = bj_hour(now_ms());
            if !force && !(3..6).contains(&h) {
                return json!({"skipped":"window"});
            }
            i.0 = true;
        }
        let out = async {
            let Some(apps) = Self::read_apps(app) else { return json!({"skipped":"apps_unreadable"}) };
            let mut state = self.read_state();
            let mut results = Map::new();
            for (key, v) in &apps {
                let cur = js_str(v).to_lowercase();
                if !RE_DIGITS.is_match(key) || !RE_APP.is_match(&cur) {
                    continue;
                }
                let id: i64 = key.parse().unwrap_or(0);
                if only > 0 && id != only {
                    continue;
                }
                let email = if app.importer.has(&app.acc, id) { app.acc.email(id) } else { String::new() };
                Self::st_entry(&mut state, key);
                if email.is_empty() {
                    results.insert(key.clone(), json!("offline"));
                    continue;
                }
                let pend: Vec<Value> = Self::st_entry(&mut state, key).a("pendingDelete").to_vec();
                let mut keep = vec![];
                for old in pend {
                    let o = js_str(&old);
                    if o == cur {
                        keep.push(old);
                        continue;
                    }
                    if !matches!(Self::rpc(app, &email, "DeleteApplet", json!([o])).await, Ok((s, _)) if deleted_ok(s)) {
                        keep.push(old);
                    }
                }
                Self::st_entry(&mut state, key).insert("pendingDelete".into(), Value::Array(keep));
                if !force && now_ms() - n64(Self::st_entry(&mut state, key).g("lastAt")) < 20 * 3_600_000 {
                    results.insert(key.clone(), json!("recent"));
                    continue;
                }
                let created = match Self::rpc(app, &email, "CreateApplet", create_applet_request()).await {
                    Ok((s, t)) => parse_created(s, &t),
                    Err(_) => String::new(),
                };
                if created.is_empty() {
                    results.insert(key.clone(), json!("create_failed"));
                    Self::st_entry(&mut state, key).insert("lastError".into(), json!("create_failed"));
                    continue;
                }
                let Some(mut fresh) = Self::read_apps(app) else {
                    results.insert(key.clone(), json!("error"));
                    Self::st_entry(&mut state, key).insert("lastError".into(), json!("apps_unreadable"));
                    continue;
                };
                fresh.insert(key.clone(), json!(created));
                Self::write_apps(app, &fresh);
                {
                    let st = Self::st_entry(&mut state, key);
                    st.insert("lastAt".into(), json!(now_ms()));
                    st.insert("app".into(), json!(created));
                    st.shift_remove("lastError");
                }
                let r = if matches!(Self::rpc(app, &email, "DeleteApplet", json!([cur])).await, Ok((s, _)) if deleted_ok(s)) {
                    "rotated"
                } else {
                    let st = Self::st_entry(&mut state, key);
                    let mut p = st.a("pendingDelete").to_vec();
                    p.push(json!(cur));
                    st.insert("pendingDelete".into(), Value::Array(p));
                    "rotated_delete_pending"
                };
                results.insert(key.clone(), json!(r));
                log(format!("[BuildRotation] #{} {} -> {} {}", key, &cur[..8], &created[..8], r));
            }
            self.write_state(&state);
            let v = Value::Object(results);
            self.lock().3 = json!({"at":now_ms(),"results":v});
            v
        }.await;
        self.lock().0 = false;
        out
    }
    /// projects recorded for an account (current + pending deletes)
    pub fn projects_of(&self, app: &App, id: i64) -> Vec<String> {
        let mut v = vec![];
        let cur = app.build.app_for(id);
        if !cur.is_empty() {
            v.push(cur);
        }
        for x in self.read_state().g("accounts").g(&id.to_string()).a("pendingDelete") {
            let x = js_str(x).to_lowercase();
            if RE_APP.is_match(&x) && !v.contains(&x) {
                v.push(x);
            }
        }
        v
    }
    pub fn forget(&self, id: i64) {
        let mut st = self.read_state();
        if let Some(Value::Object(a)) = st.get_mut("accounts") {
            if a.shift_remove(&id.to_string()).is_some() {
                self.write_state(&st);
            }
        }
        self.lock().2.remove(&id);
    }
    /// best effort: delete the account's Google projects while its login still works
    pub async fn delete_projects(app: &App, email: &str, ids: &[String]) -> usize {
        let mut n = 0;
        for p in ids {
            if let Ok((s, _)) = Self::rpc(app, email, "DeleteApplet", json!([p])).await {
                if deleted_ok(s) {
                    n += 1;
                }
            }
        }
        n
    }
    pub fn status(&self) -> Value {
        let last = self.lock().3.clone();
        json!({"window":[3,6],"last":last,"accounts":self.read_state().g("accounts")})
    }
}
pub fn valid_base(m: &str) -> bool {
    BASES.contains(&m)
}