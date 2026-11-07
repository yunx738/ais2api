// Nightly re-login queue (nightly-relogin.js) + automatic re-login of password-login accounts (autoRelogin).
// State file nightly-relogin.json keeps the same fields; unknown fields are preserved.
use crate::login_acc::{email_of, mem_ok};
use crate::login_jobs::{busy, cancel, coord, start_job, JobRef, Opts};
use crate::login_store::{cred_get, cred_mark, cred_meta, cred_remove, write_secure};
use crate::login_ws::registered;
use crate::util::*;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::Mutex;
use std::time::Duration;

const FILE: &str = "/opt/ais2api/dual-runtime/login/nightly-relogin.json";
const RECENT_OK_MS: i64 = 30 * 60_000;
const RETRY_MS: i64 = 6 * 3_600_000;
static LEASE_ERR: Lazy<Regex> = Lazy::new(|| Regex::new("未就绪，暂不暂停|已有登录占用|实例正在执行其他操作|运行模式切换中|等待请求结束超时|暂停实例失败|暂停失败|单实例模式尚未就绪|调度不可用").unwrap());

pub struct Nightly {
    st: Map<String, Value>,
    job: Option<(JobRef, i64)>,
    waiting: Value,
    ticking: bool,
}
pub static NIGHTLY: Lazy<Mutex<Nightly>> = Lazy::new(|| Mutex::new(Nightly::load()));/// local calendar day (server runs on Beijing time)
fn day(t: i64) -> String {
    chrono::DateTime::from_timestamp_millis(t + 8 * 3_600_000).map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()
}
fn mask(e: &str) -> String {
    match e.find('@') {
        Some(i) if i > 0 => format!("{}***{}", e.chars().take(3).collect::<String>(), &e[i..]),
        _ => "***".into(),
    }
}
fn ids(v: &Value) -> Vec<i64> {
    v.as_array().map(|a| a.iter().filter_map(as_safe_int).collect()).unwrap_or_default()
}
impl Nightly {
    fn load() -> Nightly {
        let mut st = read_json(FILE).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
        for k in ["queue", "manual"] {
            if !st.g(k).is_array() {
                st.insert(k.into(), json!([]));
            }
        }
        for k in ["triedDay", "results", "held"] {
            if !st.g(k).is_object() {
                st.insert(k.into(), json!({}));
            }
        }
        if !st.contains_key("lastStartAt") {
            st.insert("lastStartAt".into(), json!(0));
        }
        if let Some(Value::Object(h)) = st.get_mut("held") {
            h.retain(|_, v| !LEASE_ERR.is_match(v.s("message")));
        }
        if !truthy(st.g("scanDay")) {
            st.insert("scanDay".into(), json!(day(now_ms())));
            st.insert("scanAt".into(), json!(now_ms()));
        }
        Nightly { st, job: None, waiting: Value::Null, ticking: false }
    }
    fn save(&self) {
        let _ = write_secure(FILE, &js_bytes(&Value::Object(self.st.clone())), None);
    }
    fn obj(&mut self, k: &str) -> &mut Map<String, Value> {
        self.st.get_mut(k).and_then(|v| v.as_object_mut()).unwrap()
    }
    fn queue(&self) -> Vec<i64> {
        ids(self.st.g("queue"))
    }
    fn set_queue(&mut self, q: Vec<i64>) {
        self.st.insert("queue".into(), json!(q));
    }
    fn result(&mut self, id: i64, result: &str, message: &str) {
        let msg: String = message.chars().take(160).collect();
        self.obj("results").insert(id.to_string(), json!({"at":now_ms(),"result":result,"message":msg}));
        log(format!("[NightlyRelogin] #{} {}{}", id, result, if message.is_empty() { String::new() } else { format!(" {}", message) }));
    }
    fn held(&self, id: i64) -> bool {
        self.st.g("held").get(&id.to_string()).is_some()
    }
}
type Reg = std::collections::HashMap<String, (String, Option<String>)>;
fn id_of(a: &Value) -> Option<i64> {
    as_safe_int(a.g("id"))
}
/// accounts from the coordinator status
async fn accounts() -> Result<Vec<Value>, String> {
    let (s, b) = coord("GET", "/internal/coordinator-status", None).await;
    match b.get("accounts").and_then(|v| v.as_array()) {
        Some(a) if s == 200 => Ok(a.clone()),
        _ => Err("读取账号状态失败".into()),
    }
}
impl Nightly {
    /// auto-registered e-mail of an invalid account that may be re-logged (None = not eligible)
    fn eligible(&self, a: &Value, reg: &Reg) -> Option<String> {
        if a.s("authStatus") != "invalid" || a.s("invalidReason") != "login_required" || truthy(a.g("owner")) {
            return None;
        }
        let id = id_of(a)?;
        if self.held(id) {
            return None;
        }
        let email = email_of(id).to_lowercase();
        if reg.contains_key(&email) { Some(email) } else { None }
    }
    /// midnight: rebuild the queue from all invalid accounts; otherwise append newly failed ones
    fn scan(&mut self, full: bool, list: &[Value], reg: &Reg) {
        let now = now_ms();
        let today = day(now);
        if full {
            self.st.insert("scanDay".into(), json!(today));
            self.st.insert("scanAt".into(), json!(now));
            self.st.insert("triedDay".into(), json!({}));
        }
        let mut q = self.queue();
        let mut added = 0;
        for a in list {
            let Some(id) = id_of(a) else { continue };
            if self.eligible(a, reg).is_none() {
                continue;
            }
            if !full {
                let r = self.st.g("results").get(&id.to_string()).cloned().unwrap_or(Value::Null);
                if r.s("result") == "ok" && now - (as_num(r.g("at")).unwrap_or(0.0) as i64) < RECENT_OK_MS {
                    continue;
                }
            }
            if !q.contains(&id) {
                q.push(id);
                added += 1;
            }
        }
        let by: std::collections::HashMap<i64, &Value> = list.iter().filter_map(|a| Some((id_of(a)?, a))).collect();
        q.retain(|id| by.get(id).map_or(false, |a| self.eligible(a, reg).is_some()));
        let gone: Vec<String> = self.st.g("held").as_object().map(|h| h.keys().filter(|k| {
            let a = k.parse::<i64>().ok().and_then(|i| by.get(&i));
            a.map_or(true, |a| a.s("authStatus") != "invalid")
        }).cloned().collect()).unwrap_or_default();
        for k in gone {
            self.obj("held").remove(&k);
        }
        let joined = q.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
        let n = q.len();
        self.set_queue(q);
        if full {
            log(format!("[NightlyRelogin] scan {}: {} invalid account(s) queued [{}]", today, n, joined));
        } else if added > 0 {
            log(format!("[NightlyRelogin] queued newly failed account(s): [{}]", joined));
        }
        self.save();
    }
    pub fn status(&self) -> Value {
        let q = self.queue();
        let last = as_num(self.st.g("lastStartAt")).unwrap_or(0.0) as i64;
        let running = match &self.job {
            Some((j, _)) => {
                let j = j.lock().unwrap();
                json!({"account":j.target,"step":j.step,"status":j.status})
            }
            None => Value::Null,
        };
        json!({"queue":q,"scanDay":self.st.g("scanDay"),"lastStartAt":self.st.g("lastStartAt"),
            "nextAt": if q.is_empty() { Value::Null } else { json!(last.max(now_ms())) },
            "waiting":self.waiting,"running":running,"results":self.st.g("results"),"held":self.st.g("held")})
    }
}

static TICKING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
const TICK_MS: u64 = 30_000;
/// accounts flagged before the slot was recorded: the newest exited container of that account tells which worker failed
async fn failed_slot(id: i64) -> String {
    let out = tokio::process::Command::new("docker")
        .args(["ps", "-a", "--filter", "label=operit.project=ais2api-dual", "--filter", &format!("label=operit.account={}", id),
            "--format", "{{.CreatedAt}}|{{.Label \"operit.slot\"}}|{{.Status}}"])
        .stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).output().await;
    let Ok(o) = out else { return String::new() };
    let t = String::from_utf8_lossy(&o.stdout).to_string();
    let mut rows: Vec<Vec<&str>> = t.trim().split('\n').filter(|l| !l.is_empty()).map(|l| l.split('|').collect::<Vec<_>>())
        .filter(|r| r.len() > 2 && r[2].starts_with("Exited")).collect();
    rows.sort_by(|a, b| b[0].cmp(a[0]));
    match rows.first() {
        Some(r) if r[1] == "A" || r[1] == "B" => r[1].to_string(),
        _ => String::new(),
    }
}
/// wait for a job to end; a job asking for input is cancelled (needs a human). returns (status, message, verify)
async fn finish(job: &JobRef, verify_msg: bool) -> (String, String, bool) {
    loop {
        tokio::time::sleep(Duration::from_secs(3)).await;
        let need = {
            let mut j = job.lock().unwrap();
            if j.status == "need" {
                j.verify = true;
                if verify_msg {
                    let p = if j.need.s("prompt").is_empty() { j.need.s("kind").to_string() } else { j.need.s("prompt").to_string() };
                    j.message = format!("需要人工验证：{}", p);
                }
                true
            } else {
                false
            }
        };
        if need {
            let keep = job.lock().unwrap().message.clone();
            cancel(job);
            if verify_msg {
                job.lock().unwrap().message = keep;
            }
        }
        let j = job.lock().unwrap();
        if j.status == "done" || j.status == "failed" {
            return (j.status.clone(), j.message.clone(), j.verify);
        }
    }
}
pub async fn tick() {
    use std::sync::atomic::Ordering;
    if TICKING.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Err(e) = tick_inner().await {
        log(format!("[NightlyRelogin] tick error: {}", e.chars().take(160).collect::<String>()));
    }
    TICKING.store(false, Ordering::SeqCst);
}
async fn tick_inner() -> Result<(), String> {
    let list = accounts().await?;
    let reg = registered();
    let (id, email, a) = {
        let mut n = NIGHTLY.lock().unwrap();
        let full = n.st.s("scanDay") != day(now_ms());
        n.scan(full, &list, &reg);
        let q = n.queue();
        if n.job.is_some() || q.is_empty() {
            return Ok(());
        }
        if busy() {
            n.waiting = json!("另一登录任务进行中");
            return Ok(());
        }
        if !mem_ok() {
            n.waiting = json!("服务器内存不足");
            return Ok(());
        }
        let id = q[0];
        let a = list.iter().find(|x| id_of(x) == Some(id)).cloned();
        match a.as_ref().and_then(|a| n.eligible(a, &reg)) {
            Some(e) => (id, e, a.unwrap()),
            None => {
                n.set_queue(q[1..].to_vec());
                n.save();
                return Ok(());
            }
        }
    };
    let slot = match a.s("invalidSlot") {
        s @ ("A" | "B") => s.to_string(),
        _ => failed_slot(id).await,
    };
    let (pw, totp) = reg.get(&email).cloned().unwrap_or_default();
    let now = now_ms();
    let job = {
        let mut n = NIGHTLY.lock().unwrap();
        if let Some(Value::Array(m)) = n.st.get_mut("manual") {
            m.retain(|x| as_safe_int(x) != Some(id));
        }
        let mut q = n.queue();
        if let Some(p) = q.iter().position(|x| *x == id) {
            q.remove(p);
        }
        n.set_queue(q);
        n.st.insert("lastStartAt".into(), json!(now));
        n.obj("triedDay").insert(id.to_string(), json!(day(now)));
        n.waiting = Value::Null;
        n.save();
        log(format!("[NightlyRelogin] #{} {} start on {}{}", id, mask(&email),
            if slot.is_empty() { "default login network".to_string() } else { format!("worker {} network", slot) },
            if totp.is_some() { "" } else { " (no TOTP secret)" }));
        let job = start_job(&email, pw, Opts { target: id, auto: true, slot, totp, no_lease: true, ..Default::default() });
        n.job = Some((job.clone(), now));
        job
    };
    let (status, message, verify) = finish(&job, true).await;
    let mut n = NIGHTLY.lock().unwrap();
    if status == "failed" && LEASE_ERR.is_match(&message) {
        n.obj("triedDay").remove(&id.to_string());
        let mut q = n.queue();
        q.push(id);
        n.set_queue(q);
        n.result(id, "deferred", &message);
    } else if status == "done" {
        n.result(id, "ok", &message);
    } else {
        let r = if verify { "needs_verification" } else { "failed" };
        n.result(id, r, &message);
        let m: String = if message.is_empty() { "登录失败".into() } else { message.chars().take(160).collect() };
        n.obj("held").insert(id.to_string(), json!({"at":now_ms(),"result":r,"message":m}));
    }
    n.job = None;
    n.save();
    Ok(())
}
/// operator: retry a held account now
pub fn retry(v: &Value) -> Result<Value, String> {
    let id = as_safe_int(v).filter(|i| *i >= 1).ok_or("账号编号无效")?;
    let mut n = NIGHTLY.lock().unwrap();
    if let Some((j, _)) = &n.job {
        if j.lock().unwrap().target == id {
            return Err("该账号正在登录".into());
        }
    }
    n.obj("held").remove(&id.to_string());
    let mut q = vec![id];
    q.extend(n.queue().into_iter().filter(|x| *x != id));
    n.set_queue(q);
    if let Some(Value::Array(m)) = n.st.get_mut("manual") {
        if !m.iter().any(|x| as_safe_int(x) == Some(id)) {
            m.push(json!(id));
        }
    }
    n.st.insert("lastStartAt".into(), json!(0));
    n.save();
    log(format!("[NightlyRelogin] #{} retry requested by operator", id));
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_secs(1)).await;
        tick().await;
    });
    Ok(n.status())
}
pub fn status() -> Value {
    NIGHTLY.lock().unwrap().status()
}
/// password-login accounts (stored credentials, not auto-registered): one attempt per 6 hours, stop after a failure
pub async fn auto_relogin() {
    if busy() || !mem_ok() {
        return;
    }
    let Ok(list) = accounts().await else { return };
    let stored = cred_meta();
    let reg = registered();
    for a in &list {
        let Some(id) = id_of(a) else { continue };
        let Some((email, last, res)) = stored.get(&id) else { continue };
        if a.s("authStatus") != "invalid" || a.s("invalidReason") != "login_required" || truthy(a.g("owner")) {
            continue;
        }
        if now_ms() - last < RETRY_MS || (!res.is_empty() && res != "ok") || reg.contains_key(&email.to_lowercase()) {
            continue;
        }
        let (cem, pw) = match cred_get(id) {
            Ok(Some(c)) => c,
            Ok(None) => continue,
            Err(_) => {
                cred_mark(id, "decrypt_failed");
                continue;
            }
        };
        let owner = email_of(id).to_lowercase();
        if !owner.contains('@') {
            continue;
        }
        if owner != cem.to_lowercase() {
            cred_remove(id);
            continue;
        }
        cred_mark(id, "running");
        let job = start_job(&cem, pw, Opts { target: id, auto: true, no_lease: true, ..Default::default() });
        tokio::spawn(async move {
            let (status, message, verify) = finish(&job, false).await;
            let r = if status == "done" { "ok".to_string() } else if verify { "needs_verification".into() } else if message.is_empty() { "failed".into() } else { message };
            cred_mark(id, &r.chars().take(60).collect::<String>());
        });
        return;
    }
}
/// background loops (login-service.js: nightly.start(), autoRelogin timers)
pub fn start() {
    Lazy::force(&NIGHTLY);
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_secs(90)).await;
        loop {
            tick().await;
            tokio::time::sleep(Duration::from_millis(TICK_MS)).await;
        }
    });
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            auto_relogin().await;
            tokio::time::sleep(Duration::from_secs(300)).await;
        }
    });
}
