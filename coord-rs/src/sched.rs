// Dispatch + scheduler + rejection policy + model routing (sched.go, routing.go).
// All dispatch state lives in App.st (one mutex); forwarding runs outside the lock.
// Additions over the Node version: pinned account / account group per request, per-account priority.
use crate::app::{App, St};
use crate::build_ctx::{parse_build_model, BuildSpec};
use crate::metrics::{ExecResult, Rejection};
use crate::resp::Resp;
use crate::util::*;
use bytes::Bytes;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Arc, RwLock};

pub const SLOT: &str = "H";
pub const AT_PREFIX: &str = "anti-truncation/";
const QUEUE_LIMIT: usize = 10;
const QUEUE_TIMEOUT_MS: i64 = 120_000;
const MAX_ATTEMPTS: i64 = 3;
const EXECUTION_TIMEOUT_MS: u64 = 610_000;

#[derive(Clone, Debug)]
pub struct Plan {
    pub model: String,
    pub family: String,
    pub build: Option<BuildSpec>,
    pub estimate: i64,
}
impl Plan {
    pub fn metered(&self) -> bool {
        self.build.is_some()
    }
}
#[derive(Clone, Debug)]
pub struct Ticket {
    pub id: String,
    pub account: i64,
    pub kind: String,
    pub model: String,
    pub phase: String,
    pub created_at: i64,
}
/// immutable part of a client request
pub struct Req {
    pub route: String,
    pub body: Bytes,
    pub res: Arc<Resp>,
    pub pin: i64,
    pub group: String,
    pub soft: String,
    pub model: String,
    pub parsed: Map<String, Value>,
    pub query: String,
    pub native: bool,
    pub stream: bool,
}
pub struct Item {
    pub req: Arc<Req>,
    pub id: String,
    pub plan: Option<Plan>,
    pub attempts: i64,
    pub attempted: HashSet<i64>,
    pub deadline: i64,
    pub rejection: Option<Rejection>,
}

#[derive(Default)]
pub struct Counts {
    pub retried: i64,
    pub queue_expired: i64,
    pub queue_rejected: i64,
    pub execution_timeouts: i64,
}

// ---------------- dispatch ----------------
pub struct Dispatch {
    pub epoch: String,
    pub active: i64,
    requests: HashSet<String>,
    pub executions: HashMap<String, Ticket>,
    inflight: HashMap<i64, i64>,
    settled: HashSet<String>,
    cursor: usize,
    pub paused: bool,
    pub disabled: BTreeSet<i64>,
    pub live: HashMap<String, (Ticket, Arc<Resp>)>,
    pub egress: Value,
}
impl Dispatch {
    pub fn new() -> Self {
        Dispatch { epoch: uuid4(), active: 0, requests: HashSet::new(), executions: HashMap::new(), inflight: HashMap::new(), settled: HashSet::new(),
            cursor: 0, paused: false, disabled: BTreeSet::new(), live: HashMap::new(), egress: Value::Null }
    }
    pub fn busy(&self, a: i64) -> i64 {
        *self.inflight.get(&a).unwrap_or(&0)
    }
    pub fn settle(&mut self, t: &Ticket) {
        if !self.settled.insert(t.id.clone()) {
            return;
        }
        if let Some(n) = self.inflight.get_mut(&t.account) {
            if *n > 0 {
                *n -= 1;
            }
        }
    }
    fn mark_uncertain(&mut self, t: &Ticket) {
        if let Some(r) = self.executions.get_mut(&t.id) {
            r.phase = "reconciling".into();
        }
    }
    fn finish_if_settled(&mut self, id: &str) -> bool {
        if !self.executions.contains_key(id) || !self.settled.contains(id) {
            return false;
        }
        self.executions.remove(id);
        self.requests.remove(id);
        self.active -= 1;
        self.settled.remove(id);
        true
    }
}

impl App {
    pub fn candidates(&self, st: &St) -> Vec<i64> {
        let now = now_ms();
        st.core.ids.iter().copied().filter(|&id| st.core.flag(id).is_none() && !st.disp.disabled.contains(&id) && st.core.cooldown_of(id) <= now && self.importer.has(&self.acc, id)).collect()
    }
    fn pin_ok(&self, req: &Req, acct: i64) -> bool {
        if req.pin > 0 {
            return acct == req.pin;
        }
        if !req.group.is_empty() {
            return self.sched.in_group(acct, &req.group);
        }
        true
    }
    /// account may serve this plan (Eligible of the Go version)
    pub fn eligible(&self, req: &Req, plan: &Plan, acct: i64) -> bool {
        if !self.pin_ok(req, acct) {
            return false;
        }
        match &plan.build {
            Some(b) => self.build.ready(self, acct, &b.model),
            None => plan.family != "ultra" || self.premium_for(&plan.model, acct),
        }
    }
    /// premium model on this account? Ultra-only models (model-access.json) skip Pro accounts.
    pub fn premium_for(&self, model: &str, acct: i64) -> bool {
        if crate::model_access::ultra_only(model) { self.acc.is_ultra(acct) } else { self.acc.is_premium(acct) }
    }
    fn rank(&self, plan: &Plan, a: i64) -> f64 {
        if let Some(b) = &plan.build {
            if b.model.contains("flash") && !self.build.premium_only() {
                return if self.acc.is_premium(a) { 1.0 } else { 0.0 };
            }
        }
        if plan.family != "ultra" && self.acc.is_premium(a) { 1.0 } else { 0.0 }
    }

    fn acquire(&self, st: &mut St, id: &str, plan: &Plan, it: &Item) -> R<Option<Ticket>> {
        if !crate::history::RE_UUID.is_match(id) {
            return herr(500, "Invalid request ID");
        }
        if plan.model.is_empty() || !["flash", "pro", "ultra"].contains(&plan.family.as_str()) {
            return herr(500, "Explicit model quota required");
        }
        if st.disp.requests.contains(id) {
            return herr(500, "Duplicate request");
        }
        if st.core.halted || st.disp.paused {
            return Ok(None);
        }
        let now = now_ms();
        let metered = plan.metered();
        let ids = self.candidates(st);
        if ids.is_empty() {
            return Ok(None);
        }
        let n = ids.len() as i64;
        let cursor = st.disp.cursor as i64;
        let mut order: Vec<(i64, i64, i64, f64)> = ids.iter().enumerate()
            .map(|(i, &a)| (a, ((i as i64 - cursor) % n + n) % n, self.sched.priority(a), self.rank(plan, a))).collect();
        order.sort_by(|x, y| y.2.cmp(&x.2).then(x.3.partial_cmp(&y.3).unwrap_or(std::cmp::Ordering::Equal)).then(x.1.cmp(&y.1)));
        let per = self.per_account();
        for (a, _, _, _) in order {
            if it.attempted.contains(&a) || !self.eligible(&it.req, plan, a) {
                continue;
            }
            if !metered && st.disp.busy(a) >= per {
                continue;
            }
            if !metered && !st.core.view(a, &plan.model, &plan.family, now).allowed {
                continue;
            }
            if metered {
                if !self.build.admit(self, plan, a, id) {
                    continue;
                }
            } else if !st.core.charge(a, &plan.model, &plan.family) {
                continue;
            }
            let t = Ticket { id: id.into(), account: a, kind: plan.family.clone(), model: plan.model.clone(), phase: "running".into(), created_at: now };
            st.disp.executions.insert(id.into(), t.clone());
            st.disp.requests.insert(id.into());
            st.disp.active += 1;
            *st.disp.inflight.entry(a).or_insert(0) += 1;
            if let Some(i) = ids.iter().position(|&x| x == a) {
                st.disp.cursor = (i + 1) % ids.len();
            }
            if !metered {
                st.core.checkpoint();
            }
            return Ok(Some(t));
        }
        Ok(None)
    }

    // ---------------- model resolution ----------------
    /// called under st lock. first=true at admission (allow unavailable Build).
    pub fn resolve_model(&self, st: &St, req: &Req, first: bool) -> R<Plan> {
        let mut plan = None;
        if !req.native {
            plan = self.build.resolve(self, &req.route, &req.parsed, first)?;
        }
        let plan = match plan {
            Some(p) => p,
            None => {
                let requested = req.model.as_str();
                let at = requested.starts_with(AT_PREFIX);
                let up = if at { &requested[AT_PREFIX.len()..] } else { requested };
                if !RE_MODEL_ID.is_match(up) {
                    return herr(400, "Invalid request model");
                }
                let Some(pol) = self.policies.get(up) else { return herr(422, "Explicit quota policy required for this model") };
                if at && !pol.anti_truncation {
                    return herr(422, "Anti-truncation unsupported for this model");
                }
                if self.routing.size() > 0 && !self.routing.has(up) {
                    return herr(404, "Model not available on the no-browser service");
                }
                let c = &st.core;
                if pol.family == "ultra" {
                    let prem: Vec<i64> = c.ids.iter().copied().filter(|&id| self.premium_for(up, id) && c.flag(id).is_none() && self.pin_ok(req, id)).collect();
                    if prem.is_empty() {
                        return herr(503, "This model needs a Pro or Ultra account; none is available in the account pool");
                    }
                    let now = now_ms();
                    let mut soonest = i64::MAX;
                    for id in prem {
                        let w = c.view(id, up, "ultra", now).cooldown_until.max(c.cooldown_of(id));
                        soonest = soonest.min(w);
                    }
                    if soonest > now + 120_000 {
                        let mut e = HttpErr::new(429, format!("All Pro/Ultra accounts are rate limited for {} by Google; quota resets around {} (Beijing time)", up, bj_time(soonest)));
                        e.retry_after = (soonest - now + 999) / 1000;
                        return Err(e);
                    }
                }
                Plan { model: up.into(), family: pol.family.clone(), build: None, estimate: 0 }
            }
        };
        if req.pin > 0 || !req.group.is_empty() {
            self.check_pin(st, req, &plan)?;
        }
        Ok(plan)
    }
    /// clear error instead of a 2-minute queue wait when the pin can never be served
    fn check_pin(&self, st: &St, req: &Req, plan: &Plan) -> R<()> {
        let c = &st.core;
        let ids = if req.pin > 0 {
            if !c.in_pool(req.pin) || c.deleted(req.pin) {
                return herr(404, format!("指定的账号 #{} 不在账号池", req.pin));
            }
            vec![req.pin]
        } else {
            let m = self.sched.members(&req.group, &c.ids);
            if m.is_empty() {
                return herr(404, format!("分组 {} 里没有账号", req.group));
            }
            m
        };
        let now = now_ms();
        let mut reasons = vec![];
        let mut soonest = i64::MAX;
        for id in ids {
            if c.flag(id).is_some() {
                reasons.push(format!("#{} 登录失效", id));
            } else if !self.importer.has(&self.acc, id) {
                reasons.push(format!("#{} 未导入无浏览器服务", id));
            } else if st.disp.disabled.contains(&id) {
                reasons.push(format!("#{} 已停用", id));
            } else if plan.build.is_none() && plan.family == "ultra" && !self.premium_for(&plan.model, id) {
                reasons.push(format!("#{} 不是 Pro/Ultra 账号", id));
            } else if plan.build.as_ref().map(|b| !self.build.ready(self, id, &b.model)).unwrap_or(false) {
                reasons.push(format!("#{} 不能使用 Build {}", id, plan.build.as_ref().unwrap().model));
            } else {
                let mut w = c.cooldown_of(id);
                if plan.build.is_none() {
                    let q = c.view(id, &plan.model, &plan.family, now);
                    w = w.max(q.cooldown_until);
                    if q.limit.is_some() && q.remaining.unwrap_or(0) <= 0 && q.window_end > w {
                        w = q.window_end;
                    }
                }
                if w <= now + 120_000 {
                    return Ok(());
                }
                soonest = soonest.min(w);
                reasons.push(format!("#{} 冷却或额度用完", id));
            }
        }
        if soonest != i64::MAX {
            let mut e = HttpErr::new(429, format!("指定的账号暂时不可用（{}），约 {}（北京时间）恢复", reasons.join("；"), bj_time(soonest)));
            e.retry_after = (soonest - now + 999) / 1000;
            return Err(e);
        }
        herr(409, format!("指定的账号不可用：{}", reasons.join("；")))
    }

    // ---------------- scheduler ----------------
    pub fn sched_status(&self, st: &St) -> Value {
        json!({"queueLimit":QUEUE_LIMIT,"queueTimeoutMs":QUEUE_TIMEOUT_MS,"maxAttempts":MAX_ATTEMPTS,"executionTimeoutMs":EXECUTION_TIMEOUT_MS,
            "controlTimeoutMs":5500,"confirmationTimeoutMs":5500,"retried":st.counts.retried,"queueExpired":st.counts.queue_expired,
            "queueRejected":st.counts.queue_rejected,"executionTimeouts":st.counts.execution_timeouts,"queued":st.queue.len(),"executing":st.executing.len()})
    }
    fn reject_item(it: &Item, status: u16, msg: &str) {
        match &it.rejection {
            Some(rj) => it.req.res.respond_rejection(rj),
            None => it.req.res.fail(status, msg),
        }
    }
    /// false when the item was answered instead of queued
    fn enqueue(st: &mut St, it: Item) -> bool {
        if st.closed || st.core.halted {
            it.req.res.fail(503, if st.closed { "Coordinator stopping" } else { "Dispatch admission unavailable" });
            return false;
        }
        if it.req.res.gone() {
            return false;
        }
        if it.deadline - now_ms() <= 0 {
            st.counts.queue_expired += 1;
            Self::reject_item(&it, 503, "Queue wait deadline exceeded");
            return false;
        }
        if st.queue.len() >= QUEUE_LIMIT {
            st.counts.queue_rejected += 1;
            Self::reject_item(&it, 503, "Request queue full");
            return false;
        }
        st.queue.push(it);
        true
    }
    /// called by the HTTP layer with the final upstream body
    pub fn submit(self: &Arc<Self>, req: Req) {
        let mut st = self.lock();
        if st.closed || st.core.halted {
            drop(st);
            req.res.fail(503, "Coordinator unavailable");
            return;
        }
        let plan = match self.resolve_model(&st, &req, true) {
            Ok(p) => p,
            Err(e) => {
                drop(st);
                if e.retry_after > 0 {
                    req.res.set_header("Retry-After", &e.retry_after.to_string());
                }
                req.res.fail(if e.status == 0 { 503 } else { e.status }, &e.msg);
                return;
            }
        };
        let req = Arc::new(req);
        let it = Item { req: req.clone(), id: uuid4(), plan: Some(plan), attempts: 0, attempted: HashSet::new(), deadline: now_ms() + QUEUE_TIMEOUT_MS, rejection: None };
        if !Self::enqueue(&mut st, it) {
            return;
        }
        if !req.soft.is_empty() {
            req.res.open_sse(&req.soft, &req.model);
        }
        self.pump_l(&mut st);
    }
    pub fn pump(self: &Arc<Self>) {
        let mut st = self.lock();
        self.pump_l(&mut st);
    }
    pub fn pump_l(self: &Arc<Self>, st: &mut St) {
        if st.closed || st.pumping {
            return;
        }
        if st.core.halted {
            for it in std::mem::take(&mut st.queue) {
                it.req.res.fail(503, "Dispatch admission unavailable");
            }
            return;
        }
        st.pumping = true;
        let items = std::mem::take(&mut st.queue);
        let mut keep = vec![];
        for mut it in items {
            if it.req.res.gone() {
                continue;
            }
            if now_ms() >= it.deadline {
                st.counts.queue_expired += 1;
                Self::reject_item(&it, 503, "Queue wait deadline exceeded");
                continue;
            }
            let plan = match self.resolve_model(st, &it.req, false) {
                Ok(p) => p,
                Err(e) => {
                    if [400, 404, 409, 422, 429].contains(&e.status) {
                        if e.retry_after > 0 && !it.req.res.headers_sent() {
                            it.req.res.set_header("Retry-After", &e.retry_after.to_string());
                        }
                        match (&it.rejection, e.status) {
                            (Some(rj), 429) => it.req.res.respond_rejection(rj),
                            _ => it.req.res.fail(e.status, &e.msg),
                        }
                    } else {
                        keep.push(it);
                    }
                    continue;
                }
            };
            let id = it.id.clone();
            let t = match self.acquire(st, &id, &plan, &it) {
                Err(_) => {
                    it.req.res.fail(503, "Dispatch admission unavailable");
                    continue;
                }
                Ok(None) => {
                    it.plan = Some(plan);
                    keep.push(it);
                    continue;
                }
                Ok(Some(t)) => t,
            };
            it.plan = Some(plan);
            it.attempts += 1;
            it.attempted.insert(t.account);
            st.executing.insert(t.id.clone(), t.clone());
            let app = self.clone();
            tokio::spawn(async move { app.execute(t, it).await });
        }
        // items queued meanwhile (none: we hold the lock) + the ones still waiting, in order
        keep.extend(std::mem::take(&mut st.queue));
        st.queue = keep;
        st.pumping = false;
    }
    fn has_retry_candidate(&self, st: &St, it: &Item) -> bool {
        let c = &st.core;
        let plan = it.plan.as_ref().unwrap();
        for &a in &c.ids {
            if it.attempted.contains(&a) || c.cooldown_of(a) >= it.deadline || c.flag(a).is_some() || st.disp.disabled.contains(&a) {
                continue;
            }
            if !plan.metered() && !self.eligible(&it.req, plan, a) {
                continue;
            }
            let q = c.view(a, &plan.model, &plan.family, now_ms());
            if q.cooldown_until < it.deadline && (!q.legacy_blocked || q.legacy_until < it.deadline)
                && (q.limit.is_none() || q.remaining.unwrap_or(0) > 0 || (q.window_end > 0 && q.window_end < it.deadline)) {
                return true;
            }
        }
        false
    }
    fn apply_rejection(st: &mut St, t: &Ticket, r: Option<&ExecResult>) {
        let Some(r) = r else { return };
        if r.worker_rejection || t.model.starts_with("build-") {
            return;
        }
        let Some((scope, until)) = rejection_cooldown(r, now_ms()) else { return };
        if scope == "egress" {
            st.disp.egress = json!({"slot":SLOT,"account":t.account,"at":now_ms()});
            log("[Egress] slot H region rejected; account not cooled");
            return;
        }
        if scope == "account" {
            st.core.cooldown(t.account, until);
        } else {
            st.core.defer(t.account, &t.model, &t.kind, until);
        }
        st.core.checkpoint();
    }
    async fn execute(self: Arc<Self>, t: Ticket, mut it: Item) {
        let cancel = it.req.res.cancel.child();
        let app = self.clone();
        let (t2, req, plan, c2) = (t.clone(), it.req.clone(), it.plan.clone().unwrap(), cancel.clone());
        let h = tokio::spawn(async move { app.forward(t2, req, plan, c2).await });
        let r: Option<ExecResult> = tokio::select! {
            j = h => match j {
                Ok(r) => Some(r),
                Err(e) => {
                    elog(format!("[Execution] forward panic: {}", e));
                    it.req.res.fail(502, "Worker forwarding failed");
                    None
                }
            },
            _ = tokio::time::sleep(std::time::Duration::from_millis(EXECUTION_TIMEOUT_MS)) => {
                cancel.cancel();
                self.lock().counts.execution_timeouts += 1;
                it.req.res.fail(504, "Worker request timeout");
                None
            }
        };
        cancel.cancel();
        let expired = r.as_ref().map_or(false, |r| r.auth_expired && !r.uncertain && !r.cancelled);
        let mut st = self.lock();
        Self::apply_rejection(&mut st, &t, r.as_ref());
        if expired && st.core.flag(t.account).is_none() && !crate::app::ro() {
            // take the account out of dispatch now (the 60 s sync would do the same) and retry elsewhere;
            // the nightly queue re-logs it in (never Gmail accounts)
            st.core.set_flag(t.account, Some(json!({"status":"invalid","reason":"login_required","at":now_ms(),"source":"headless",
                "message":"no-browser service: sign-in session expired"})));
            st.core.checkpoint();
            log(format!("[Auth] #{} marked invalid (login_required): sign-in expired during a request", t.account));
        }
        st.disp.mark_uncertain(&t);
        let res = &it.req.res;
        let retryable = r.as_ref().map(|r| {
            r.rejection.is_some() && !r.worker_rejection && !r.uncertain && !r.cancelled
                && ([401, 403, 429].contains(&r.status) || r.auth_expired || (r.status == 400 && r.rejection.as_ref().unwrap().header("x-ais-build-retry") == Some("upstream_failed")))
        }).unwrap_or(false) && !res.started() && !res.gone();
        st.disp.finish_if_settled(&t.id);
        st.executing.remove(&t.id);
        if let Some(rj) = r.and_then(|r| r.rejection) {
            it.rejection = Some(rj.clone());
            if retryable && it.attempts < MAX_ATTEMPTS && !st.closed && !st.core.halted && self.has_retry_candidate(&st, &it) {
                it.id = uuid4();
                let status = rj.status;
                if Self::enqueue(&mut st, it) {
                    st.counts.retried += 1;
                    log(format!("[Scheduler] #{} {} rejected {}; retrying on another account", t.account, t.model, status));
                }
            } else {
                it.req.res.respond_rejection(&rj);
            }
        }
        self.pump_l(&mut st);
    }
    /// executions whose forward settled after a timeout are released here (1 s tick)
    pub fn tick(self: &Arc<Self>) {
        let mut st = self.lock();
        let ids: Vec<String> = st.disp.executions.keys().filter(|id| !st.executing.contains_key(*id)).cloned().collect();
        for id in ids {
            st.disp.finish_if_settled(&id);
        }
        self.pump_l(&mut st);
    }
    pub fn close_scheduler(&self) {
        let mut st = self.lock();
        st.closed = true;
        for it in std::mem::take(&mut st.queue) {
            it.req.res.fail(503, "Coordinator stopping");
        }
    }
}

// ---------------- rejection policy ----------------
static RE_REGION: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)region not supported|not available in your (?:country|region)|unsupported[_\s-]*(?:country|region|location)|user location is not supported|available-regions").unwrap());
pub static RE_SIGNATURE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)caller does not have permission").unwrap());
static RE_RETRY_IN: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)retry in\s+((?:\d+h)?(?:\d+m(?:[^s]|$))?(?:[\d.]+s)?(?:[\d.]+ms)?)").unwrap());
static RE_RETRY_DELAY: Lazy<Regex> = Lazy::new(|| Regex::new(r#""retryDelay"\s*:\s*"([\d.]+)s""#).unwrap());
static RE_EXHAUSTED: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)insufficient[_\s-]*quota|daily[^\n]{0,80}(?:quota|limit)|(?:quota|limit)[^\n]{0,80}daily|per[\s_-]*day|requests?\s*/\s*day|\brpd\b|额度不足|余额不足|每日|每天").unwrap());
static RE_NUM_ONLY: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d+(?:\.\d+)?$").unwrap());
static RE_H: Lazy<Regex> = Lazy::new(|| Regex::new(r"(\d+)h").unwrap());
static RE_M: Lazy<Regex> = Lazy::new(|| Regex::new(r"(\d+)m(?:[^s]|$)").unwrap());
static RE_S: Lazy<Regex> = Lazy::new(|| Regex::new(r"([\d.]+)s").unwrap());
static RE_MS: Lazy<Regex> = Lazy::new(|| Regex::new(r"([\d.]+)ms").unwrap());
static RE_MODEL_ID: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$").unwrap());

fn body_text(b: &[u8], n: usize) -> String {
    String::from_utf8_lossy(&b[..b.len().min(n)]).into_owned()
}
fn parse_retry_in(spec: &str) -> f64 {
    let num = |re: &Regex| re.captures(spec).and_then(|c| c[1].parse::<f64>().ok()).unwrap_or(0.0);
    let h = num(&RE_H);
    let mm = num(&RE_M);
    let mut sec = 0.0;
    for c in RE_S.captures_iter(spec) {
        let m = c.get(0).unwrap();
        if m.end() >= 2 && &spec[m.end() - 2..m.end() - 1] == "m" {
            continue;
        }
        sec = c[1].parse().unwrap_or(0.0);
    }
    let ms = num(&RE_MS);
    h * 3_600_000.0 + mm * 60_000.0 + sec * 1000.0 + ms
}
/// (scope, until): scope = egress | account | model
pub fn rejection_cooldown(r: &ExecResult, now: i64) -> Option<(&'static str, i64)> {
    let body: &[u8] = r.rejection.as_ref().map(|x| &x.body[..]).unwrap_or(&[]);
    if (r.status == 403 || r.status == 400) && RE_REGION.is_match(&body_text(body, 8192)) {
        return Some(("egress", 0));
    }
    if r.status == 403 && RE_SIGNATURE.is_match(&body_text(body, 16384)) {
        return None;
    }
    match r.status {
        401 => return Some(("account", now + DAY)),
        403 => return Some(("model", now + DAY)),
        429 => {}
        _ => return None,
    }
    let mut delay = -1.0f64;
    let ra = r.retry_after.trim();
    if RE_NUM_ONLY.is_match(ra) {
        delay = ra.parse::<f64>().unwrap_or(0.0) * 1000.0;
    } else if !ra.is_empty() {
        if let Ok(t) = chrono::DateTime::parse_from_rfc2822(ra) {
            delay = (t.timestamp_millis() - now) as f64;
        }
    }
    if delay < 0.0 {
        let text = body_text(body, 16384);
        if let Some(c) = RE_RETRY_IN.captures(&text) {
            if !c[1].is_empty() {
                let ms = parse_retry_in(&c[1]);
                if ms > 0.0 {
                    delay = ms;
                }
            }
        }
        if delay < 0.0 {
            if let Some(c) = RE_RETRY_DELAY.captures(&text) {
                delay = c[1].parse::<f64>().unwrap_or(0.0) * 1000.0;
            }
        }
    }
    if delay < 0.0 {
        delay = if RE_EXHAUSTED.is_match(&String::from_utf8_lossy(body)) { until_next_reset(now) as f64 } else { 60_000.0 };
    }
    let delay = delay.clamp(1000.0, DAY as f64);
    Some(("model", now + (delay + 0.999999) as i64))
}

// ---------------- model routing ----------------
pub struct Routing {
    models: RwLock<(HashSet<String>, i64)>,
}
static RE_PIN: Lazy<Regex> = Lazy::new(|| Regex::new(r"@(?:(\d{1,6})|g:([\p{L}\p{N}_-]{1,20}))$").unwrap());
/// "gemini-x@31" -> ("gemini-x", 31, ""); "gemini-x@g:主力" -> ("gemini-x", 0, "主力")
pub fn split_pin(model: &str) -> (String, i64, String) {
    let Some(c) = RE_PIN.captures(model) else { return (model.into(), 0, String::new()) };
    let base = model[..c.get(0).unwrap().start()].to_string();
    if let Some(n) = c.get(1) {
        return (base, n.as_str().parse().unwrap_or(0), String::new());
    }
    (base, 0, c[2].to_string())
}
impl Routing {
    pub fn new() -> Self {
        Routing { models: RwLock::new((HashSet::new(), 0)) }
    }
    pub async fn refresh(&self, app: &App) {
        let r = app.svc.call(&crate::resp::Cancel::new(), "", "GET", "/v1/models", None).await;
        if r.err.is_some() || r.status != 200 || !r.json.g("data").is_array() {
            return;
        }
        let m: HashSet<String> = r.json.a("data").iter().map(|d| d.s("id").to_string()).filter(|s| !s.is_empty()).collect();
        *self.models.write().unwrap() = (m, now_ms());
    }
    pub fn has(&self, m: &str) -> bool {
        self.models.read().unwrap().0.contains(m)
    }
    pub fn size(&self) -> usize {
        self.models.read().unwrap().0.len()
    }
    pub fn at(&self) -> i64 {
        self.models.read().unwrap().1
    }
    pub fn models(&self) -> Vec<String> {
        let mut v: Vec<String> = self.models.read().unwrap().0.iter().cloned().collect();
        v.sort();
        v
    }
    pub fn list(&self, app: &App) -> Vec<String> {
        let size = self.size();
        let mut seen = HashSet::new();
        let mut out = vec![];
        for (id, p) in app.policies.ordered() {
            if size > 0 && !self.has(&id) {
                continue;
            }
            if seen.insert(id.clone()) {
                out.push(id.clone());
            }
            let at = format!("{}{}", AT_PREFIX, id);
            if p.anti_truncation && seen.insert(at.clone()) {
                out.push(at);
            }
        }
        out.sort();
        out
    }
}
pub fn is_build_model(m: &str) -> bool {
    matches!(parse_build_model(m), Ok(Some(_)))
}