// Login job manager (login-service.js startJob / wsJob / cancel / sweeper).
// Each job runs one throwaway container; JSON lines on stdout, input lines on stdin.
use crate::login_acc::*;
use crate::login_ws::{upstream_for, WS_DATA, WS_DIR, WS_IMAGE};
use crate::util::*;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};

pub const RUNNER: &str = "/opt/ais2api/dual-runtime/login/login-runner.js";
const RT: &str = "/opt/ais2api/dual-runtime";
#[derive(Clone, Default)]
pub struct Opts {
    pub tier: String,
    pub alias: String,
    pub target: i64,
    pub auto: bool,
    pub slot: String,
    pub totp: Option<String>,
    pub no_lease: bool,
    pub remember: bool,
}
#[derive(Default)]
pub struct Job {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub email: String,
    pub target: i64,
    pub tier: String,
    pub alias: String,
    pub status: String,
    pub step: String,
    pub need: Value,
    pub message: String,
    pub account: Value,
    pub resume: Value,
    pub created: i64,
    pub updated: i64,
    pub leased: bool,
    pub running: bool,
    pub verify: bool,
    pub log: Vec<String>,
    pub items: Value,
    pub ws_email: Value,
    pub stdin: Option<Arc<tokio::sync::Mutex<ChildStdin>>>,
}
pub type JobRef = Arc<Mutex<Job>>;
pub static JOBS: Lazy<Mutex<HashMap<String, JobRef>>> = Lazy::new(|| Mutex::new(HashMap::new()));

impl Job {
    fn new(kind: &str, email: &str) -> Job {
        let id = uuid4();
        let now = now_ms();
        Job { name: format!("ais-login-{}", &id[..8]), id, kind: kind.into(), email: email.into(), status: "running".into(), step: "starting".into(),
            need: Value::Null, account: Value::Null, resume: Value::Null, items: Value::Null, ws_email: Value::Null, created: now, updated: now, ..Default::default() }
    }
    /// view of a login job (login-service.js view())
    pub fn view(&self) -> Value {
        json!({"id":self.id,"status":self.status,"step":self.step,"need":self.need,"message":self.message,"account":self.account,"resume":self.resume})
    }
    /// view of a workspace job (wsView())
    pub fn ws_view(&self) -> Value {
        let n = self.log.len();
        let log: Vec<&String> = self.log.iter().skip(n.saturating_sub(30)).collect();
        json!({"id":self.id,"kind":self.kind,"status":self.status,"step":self.step,"need":self.need,"message":self.message,"account":self.account,
            "email":self.ws_email,"items":self.items,"log":log,"resume":self.resume})
    }
    fn touch(&mut self) {
        self.updated = now_ms();
    }
    fn active(&self) -> bool {
        self.status == "running" || self.status == "need"
    }
}
pub fn get(id: &str) -> Option<JobRef> {
    JOBS.lock().unwrap().get(id).cloned()
}
fn insert(j: Job) -> JobRef {
    let id = j.id.clone();
    let r = Arc::new(Mutex::new(j));
    JOBS.lock().unwrap().insert(id, r.clone());
    r
}
/// any login / workspace job holding the browser slot
pub fn busy() -> bool {
    JOBS.lock().unwrap().values().any(|j| {
        let j = j.lock().unwrap();
        j.running || j.leased || j.active()
    })
}
/// jobs still running (graceful shutdown waits for these)
pub fn running_count() -> usize {
    JOBS.lock().unwrap().values().filter(|j| j.lock().unwrap().running).count()
}
pub fn find_target(id: i64) -> Option<JobRef> {
    JOBS.lock().unwrap().values().find(|j| {
        let j = j.lock().unwrap();
        j.target == id && j.active()
    }).cloned()
}

// ---------------- coordinator callbacks (in-process when merged; loopback HTTP otherwise) ----------------
/// how the login service reaches the coordinator: (status, body)
pub type CoordFn = Arc<dyn Fn(String, String, Option<Value>, u64) -> futures_util::future::BoxFuture<'static, (u16, Value)> + Send + Sync>;
pub static COORD: Lazy<Mutex<Option<CoordFn>>> = Lazy::new(|| Mutex::new(None));
pub async fn coord(method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    let f = COORD.lock().unwrap().clone();
    let timeout = if path == "/internal/browser-lease" { 420 } else { 15 };
    match f {
        Some(f) => f(method.into(), path.into(), body, timeout).await,
        None => (0, Value::Null),
    }
}
async fn lease_acquire(owner: &str, slot: &str) -> Result<(), String> {
    let mut b = json!({"action":"acquire","owner":owner});
    if !slot.is_empty() {
        b["slot"] = json!(slot);
    }
    let (s, r) = coord("POST", "/internal/browser-lease", Some(b)).await;
    if s != 200 {
        let e = r.s("error").to_string();
        return Err(if e.is_empty() { "暂停实例失败".into() } else { e });
    }
    Ok(())
}
async fn lease_release() -> bool {
    for _ in 0..3 {
        if coord("POST", "/internal/browser-lease", Some(json!({"action":"release"}))).await.0 == 200 {
            return true;
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    false
}
pub async fn sync_pool() -> bool {
    coord("POST", "/internal/sync-accounts", Some(json!({}))).await.0 == 200
}
/// the worker's network + SOCKS egress (re-login looks like the browser that just failed)
fn worker_net(slot: &str) -> Option<(String, String)> {
    let env = std::fs::read_to_string(format!("{}/slots/{}/worker.env", RT, slot)).ok()?;
    let l = env.lines().find(|l| l.starts_with("SOCKS_UPSTREAM_URL="))?;
    let u = url::Url::parse(l[19..].trim()).ok()?;
    (u.scheme() == "socks5").then(|| (format!("ais2api-dual-{}", slot.to_lowercase()), u.to_string()))
}
fn image() -> String {
    read_json(&format!("{}/coordinator.json", RT)).ok().map(|c| js_str(c.g("image"))).unwrap_or_default()
}
fn sandbox_args(name: &str) -> Vec<String> {
    ["run", "--rm", "-i", "--name", name, "--user", "1000:1000", "--memory", "700m", "--memory-swap", "1400m", "--shm-size", "256m",
        "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--log-driver", "none"]
        .iter().map(|s| s.to_string()).collect()
}
fn docker_rm(name: &str) {
    let n = name.to_string();
    tokio::spawn(async move {
        let _ = Command::new("docker").args(["rm", "-f", &n]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().await;
    });
}


// ---------------- login job (startJob) ----------------
fn clean_alias(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(40).collect()
}
pub fn start_job(email: &str, password: String, o: Opts) -> JobRef {
    let mut j = Job::new("", email);
    j.tier = if ["pro", "ultra", "ultra20"].contains(&o.tier.as_str()) { o.tier.clone() } else { "standard".into() };
    j.alias = clean_alias(&o.alias);
    j.target = o.target;
    let job = insert(j);
    let jr = job.clone();
    let email = email.to_string();
    tokio::spawn(async move { run_login(jr, email, password, o).await });
    job
}
fn set(job: &JobRef, f: impl FnOnce(&mut Job)) {
    let mut j = job.lock().unwrap();
    f(&mut j);
    j.touch();
}
fn fail(job: &JobRef, msg: &str) {
    set(job, |j| {
        j.status = "failed".into();
        j.message = msg.into();
    });
}
async fn run_login(job: JobRef, email: String, mut password: String, o: Opts) {
    let short = job.lock().unwrap().id[..8].to_string();
    let slot = if o.slot == "A" || o.slot == "B" { o.slot.clone() } else { String::new() };
    // a re-login of a failed account uses its own browser and never pauses a worker
    if !o.no_lease {
        set(&job, |j| j.step = "pausing_worker".into());
        if let Err(e) = lease_acquire(&format!("login:{}", short), &slot).await {
            fail(&job, &e);
            return;
        }
        set(&job, |j| j.leased = true);
        if job.lock().unwrap().status != "running" {
            set(&job, |j| j.leased = false);
            lease_release().await;
            return;
        }
    }
    set(&job, |j| j.step = "starting".into());
    let wn = if slot.is_empty() { None } else { worker_net(&slot) };
    if !slot.is_empty() && wn.is_none() {
        fail(&job, &format!("读取实例 {} 出口配置失败", slot));
        if o.no_lease {
            return;
        }
        set(&job, |j| j.leased = false);
        lease_release().await;
        return;
    }
    let upstream = wn.as_ref().map(|w| w.1.clone()).unwrap_or_else(upstream_for);
    let name = job.lock().unwrap().name.clone();
    let mut args = sandbox_args(&name);
    if let Some((net, _)) = &wn {
        args.extend(["--network".into(), net.clone()]);
    }
    args.extend(["-v".into(), format!("{}:/app/login-runner.js:ro", RUNNER), "-v".into(), "/opt/ais2api/proxy-relay:/relay:ro".into(),
        "--entrypoint".into(), "node".into(), image(), "/app/login-runner.js".into()]);
    let child = Command::new("docker").args(&args).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null()).kill_on_drop(true).spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            fail(&job, &format!("启动登录容器失败：{}", clip_runes(&e.to_string(), 80)));
            finish_lease(&job).await;
            return;
        }
    };
    let stdin = Arc::new(tokio::sync::Mutex::new(child.stdin.take().unwrap()));
    let mut first = json!({"email":email,"password":password});
    if !upstream.is_empty() {
        first["upstream"] = json!(upstream);
    }
    if let Some(t) = &o.totp {
        first["totp"] = json!(t);
    }
    let line = format!("{}\n", js(&first));
    drop(first);
    let keep = if o.remember { Some(password.clone()) } else { None };
    password.clear();
    let _ = stdin.lock().await.write_all(line.as_bytes()).await;
    drop(line);
    set(&job, |j| {
        j.running = true;
        j.stdin = Some(stdin.clone());
    });
    read_runner(&job, &mut child, keep, &email).await;
    let _ = child.wait().await;
    set(&job, |j| {
        j.running = false;
        j.stdin = None;
        if j.active() {
            j.status = "failed".into();
            if j.message.is_empty() {
                j.message = "登录进程已结束".into();
            }
        }
    });
    finish_lease(&job).await;
}
async fn finish_lease(job: &JobRef) {
    if !job.lock().unwrap().leased {
        return;
    }
    set(job, |j| {
        j.leased = false;
        j.resume = json!("resuming");
    });
    let ok = lease_release().await;
    set(job, |j| j.resume = json!(if ok { "ok" } else { "failed" }));
}
/// runner protocol: {type:status,step} | {type:need,kind,prompt} | {type:result,ok,message,storage}
async fn read_runner(job: &JobRef, child: &mut tokio::process::Child, keep: Option<String>, email: &str) {
    let Some(out) = child.stdout.take() else { return };
    let mut lines = BufReader::new(out).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.len() > 2_097_152 {
            continue;
        }
        let Ok(mut m) = serde_json::from_str::<Value>(&line) else { continue };
        match m.s("type") {
            "status" => set(job, |j| {
                j.step = m.s("step").into();
                j.need = Value::Null;
                j.status = "running".into();
            }),
            "need" => set(job, |j| {
                j.status = "need".into();
                j.need = json!({"kind":m.g("kind"),"prompt":m.g("prompt")});
            }),
            "result" => {
                set(job, |j| j.need = Value::Null);
                if !m.b("ok") {
                    let msg = if m.s("message").is_empty() { "登录失败".to_string() } else { m.s("message").to_string() };
                    fail(job, &msg);
                    continue;
                }
                let storage = m.get_mut("storage").map(std::mem::take).unwrap_or(Value::Null);
                save_result(job, &storage, keep.as_deref(), email).await;
            }
            _ => {}
        }
    }
}
async fn save_result(job: &JobRef, storage: &Value, keep: Option<&str>, email: &str) {
    let (target, tier, alias) = {
        let j = job.lock().unwrap();
        (j.target, j.tier.clone(), j.alias.clone())
    };
    if target > 0 {
        if let Err(e) = refresh_account(target, storage) {
            return fail(job, &e);
        }
        let (s, _) = coord("POST", "/internal/accounts/revalidate", Some(json!({"id":target}))).await;
        set(job, |j| {
            j.account = json!(target);
            j.status = "done".into();
            j.message = if s == 200 { "已重新登录".into() } else { "登录已更新，恢复状态未确认".into() };
        });
        return;
    }
    match write_account(storage, email, &tier, &alias) {
        Err(e) => fail(job, &e),
        Ok(id) => {
            if let Some(pw) = keep {
                remember(id, email, pw);
            }
            let ok = sync_pool().await;
            set(job, |j| {
                j.account = json!(id);
                j.status = "done".into();
                j.message = if ok { String::new() } else { "账号已保存，同步账号池未确认".into() };
            });
        }
    }
}
/// operator / verification input for a job waiting on a code
pub async fn send_input(job: &JobRef, value: &str) -> Result<(), &'static str> {
    let stdin = {
        let j = job.lock().unwrap();
        if j.status != "need" || j.stdin.is_none() {
            return Err("当前不需要输入");
        }
        j.stdin.clone().unwrap()
    };
    set(job, |j| {
        j.status = "running".into();
        j.need = Value::Null;
        j.step = "verifying".into();
    });
    let _ = stdin.lock().await.write_all(format!("{}\n", js(&json!({"value":value}))).as_bytes()).await;
    Ok(())
}
pub fn cancel(job: &JobRef) {
    let (stdin, name) = {
        let j = job.lock().unwrap();
        (j.stdin.clone(), j.name.clone())
    };
    if let Some(s) = stdin {
        tokio::spawn(async move {
            let _ = s.lock().await.write_all(b"{\"cancel\":true}\n").await;
            tokio::time::sleep(Duration::from_secs(3)).await;
            docker_rm(&name);
        });
    }
    set(job, |j| {
        j.need = Value::Null;
        if j.active() {
            j.status = "failed".into();
            j.message = "已取消".into();
        }
    });
}
// ---------------- workspace jobs (wsJob) ----------------
static RE_SECRET: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)(密码|password|secret|code)[^\s]*\s*[:：=]\s*\S+").unwrap());
static RE_COOKIEFILE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9._@-]{1,200}\.json$").unwrap());

/// import a cookie file produced by ws-runner.py (refresh an existing account of the same e-mail)
fn import_ws(name: &str) -> Result<(i64, String), String> {
    if !RE_COOKIEFILE.is_match(name) {
        return Err("登录态文件名异常".into());
    }
    let d = read_json(&format!("{}/output/cookies/{}", WS_DATA, name)).map_err(|e| e.to_string())?;
    let email = d.s("accountName").to_lowercase();
    let dup = already_imported(&email);
    if dup > 0 {
        refresh_account(dup, &d)?;
        return Ok((dup, email));
    }
    Ok((write_account(&d, &email, "standard", "")?, email))
}
/// kind: mail-auth | list | run. lease = pause a worker first; proxy = route through the login proxy.
pub fn ws_job(kind: &str, args: Vec<String>, lease: bool, proxy: bool) -> JobRef {
    let mut j = Job::new(kind, "");
    j.step = if lease { "pausing_worker".into() } else { "starting".into() };
    j.name = format!("ais-ws-{}", &j.id[..8]);
    let job = insert(j);
    let jr = job.clone();
    let kind = kind.to_string();
    tokio::spawn(async move { run_ws(jr, kind, args, lease, proxy).await });
    job
}
async fn run_ws(job: JobRef, kind: String, args: Vec<String>, lease: bool, proxy: bool) {
    let short = job.lock().unwrap().id[..8].to_string();
    if lease {
        if let Err(e) = lease_acquire(&format!("ws:{}", short), "").await {
            return fail(&job, &e);
        }
        set(&job, |j| j.leased = true);
    }
    if job.lock().unwrap().status != "running" {
        return finish_lease(&job).await;
    }
    set(&job, |j| j.step = "running".into());
    let name = job.lock().unwrap().name.clone();
    let mut a = sandbox_args(&name);
    a.extend(["-v".into(), format!("{}:/src:ro", WS_DIR), "-v".into(), format!("{}:/data", WS_DATA)]);
    let up = if proxy { upstream_for() } else { String::new() };
    let mut cmd = Command::new("docker");
    if proxy {
        a.extend(["-e".into(), "WS_UPSTREAM".into()]);
        cmd.env("WS_UPSTREAM", &up);
    }
    a.extend(["--entrypoint".into(), "python".into(), WS_IMAGE.into(), "/src/ws-runner.py".into()]);
    a.extend(args);
    let child = cmd.args(&a).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true).spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            fail(&job, &format!("启动任务容器失败：{}", clip_runes(&e.to_string(), 80)));
            return finish_lease(&job).await;
        }
    };
    set(&job, |j| j.running = true);
    if let Some(out) = child.stdout.take() {
        let mut lines = BufReader::new(out).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.len() > 1_048_576 {
                continue;
            }
            let Ok(m) = serde_json::from_str::<Value>(&line) else { continue };
            ws_line(&job, &kind, &m).await;
        }
    }
    let _ = child.wait().await;
    set(&job, |j| {
        j.running = false;
        if j.active() {
            j.status = "failed".into();
            if j.message.is_empty() {
                j.message = "进程已结束".into();
            }
        }
    });
    finish_lease(&job).await;
}
async fn ws_line(job: &JobRef, kind: &str, m: &Value) {
    match m.s("type") {
        "log" => set(job, |j| {
            let t = RE_SECRET.replace_all(&js_string(m.g("text")), "$1 ***").into_owned();
            j.log.push(t);
            if j.log.len() > 60 {
                j.log.remove(0);
            }
        }),
        "need" => set(job, |j| {
            j.status = "need".into();
            j.need = json!({"kind":m.g("kind"),"uri":m.g("uri"),"code":m.g("code")});
        }),
        "result" => {
            set(job, |j| j.need = Value::Null);
            if !m.b("ok") {
                let msg = if m.s("message").is_empty() { "失败".to_string() } else { m.s("message").to_string() };
                set(job, |j| {
                    j.status = "failed".into();
                    j.message = msg;
                    j.account = m.get("account").cloned().unwrap_or(Value::Null);
                });
                return;
            }
            if m.g("items").is_array() {
                set(job, |j| j.items = m.g("items").clone());
            }
            if kind == "run" && truthy(m.g("cookies")) {
                match import_ws(&js_string(m.g("cookies"))) {
                    Err(e) => return fail(job, &e),
                    Ok((id, _)) => {
                        let ok = sync_pool().await;
                        set(job, |j| {
                            j.account = json!(id);
                            j.ws_email = m.get("account").cloned().unwrap_or(Value::Null);
                            j.message = if ok { String::new() } else { "已保存，同步账号池未确认".into() };
                        });
                    }
                }
            }
            set(job, |j| j.status = "done".into());
        }
        _ => {}
    }
}
pub fn ws_cancel(job: &JobRef) {
    let (running, name) = {
        let j = job.lock().unwrap();
        (j.running, j.name.clone())
    };
    if running {
        docker_rm(&name);
    }
    set(job, |j| {
        if j.active() {
            j.status = "failed".into();
            j.message = "已取消".into();
        }
    });
}
/// every 60 s: jobs running over 16 min are cancelled, finished jobs are dropped after 30 min idle
pub fn sweep() {
    let now = now_ms();
    let all: Vec<(String, JobRef)> = JOBS.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    for (id, j) in all {
        let (running, created, updated, kind) = {
            let g = j.lock().unwrap();
            (g.running, g.created, g.updated, g.kind.clone())
        };
        if running && now - created > 16 * 60_000 {
            if kind.is_empty() {
                cancel(&j);
            } else {
                ws_cancel(&j);
            }
        }
        if !running && now - updated > 30 * 60_000 {
            JOBS.lock().unwrap().remove(&id);
        }
    }
}