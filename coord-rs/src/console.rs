// console-auth (password scrypt N=16384 r=8 p=1, client keys) + stream mode + run mode + ops tools (console.go).
use crate::state::READ_ONLY;
use crate::util::*;
use base64::Engine;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::Duration;

fn ro() -> bool {
    READ_ONLY.load(Ordering::Relaxed)
}
pub fn pw_hash(password: &str, salt: &str) -> String {
    let params = scrypt::Params::new(14, 8, 1, 32).unwrap();
    let mut out = [0u8; 32];
    scrypt::scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut out).unwrap();
    hex::encode(out)
}
fn safe_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
static RE_HEX32: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[0-9a-f]{32}$").unwrap());
static RE_HEX64: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[0-9a-f]{64}$").unwrap());

// ---------------- console auth ----------------
pub struct ConsoleAuth {
    file: String,
    internal_key: String,
    state: Mutex<Map<String, Value>>,
}
fn mask(k: &str) -> String {
    let c: Vec<char> = k.chars().collect();
    if k.len() < 10 {
        return k.into();
    }
    format!("{}…{}", c[..6].iter().collect::<String>(), c[c.len() - 4..].iter().collect::<String>())
}
impl ConsoleAuth {
    pub fn open(file: &str, internal_key: &str) -> Result<Self, String> {
        if internal_key.len() < 16 {
            return Err("Internal key required".into());
        }
        let mut state = json!({"password":null,"keys":[],"internalExternal":true}).as_object().unwrap().clone();
        match std::fs::read_to_string(file) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("console-auth.json unreadable".into()),
            Ok(s) => {
                let d: Value = serde_json::from_str(&s).map_err(|_| "console-auth.json unreadable".to_string())?;
                if d.is_object() {
                    let p = d.g("password");
                    if RE_HEX32.is_match(p.s("salt")) && RE_HEX64.is_match(p.s("hash")) {
                        let ua = if truthy(p.g("updatedAt")) { p.g("updatedAt").clone() } else { Value::Null };
                        state.insert("password".into(), json!({"salt":p.s("salt"),"hash":p.s("hash"),"updatedAt":ua}));
                    }
                    let keys: Vec<Value> = d.a("keys").iter().filter(|k| k.g("key").as_str().map(|s| s.len() >= 24).unwrap_or(false) && k.g("id").is_string()).cloned().collect();
                    state.insert("keys".into(), Value::Array(keys));
                    state.insert("internalExternal".into(), json!(d.get("internalExternal") != Some(&Value::Bool(false))));
                }
            }
        }
        Ok(ConsoleAuth { file: file.into(), internal_key: internal_key.into(), state: Mutex::new(state) })
    }
    fn save(&self, s: &Map<String, Value>) -> R<()> {
        if ro() {
            return Ok(());
        }
        write_simple(&self.file, js_indent(&Value::Object(s.clone()), " ").as_bytes(), 0o600).map_err(|e| HttpErr::plain(e.to_string()))
    }
    pub fn is_internal(&self, k: &str) -> bool {
        !k.is_empty() && safe_eq(k, &self.internal_key)
    }
    pub fn allows(&self, k: &str, external: bool) -> bool {
        if k.is_empty() {
            return false;
        }
        let s = self.state.lock().unwrap();
        if self.is_internal(k) {
            return !external || s.get("internalExternal") != Some(&Value::Bool(false));
        }
        s.a("keys").iter().any(|x| !truthy(x.g("disabled")) && safe_eq(x.s("key"), k))
    }
    fn verify_l(&self, s: &Map<String, Value>, secret: &str) -> bool {
        if secret.is_empty() || secret.len() > 512 {
            return false;
        }
        let p = s.g("password");
        if p.is_object() {
            return safe_eq(&pw_hash(secret, p.s("salt")), p.s("hash"));
        }
        self.is_internal(secret)
    }
    pub fn verify_login(&self, secret: &Value) -> bool {
        let s = self.state.lock().unwrap();
        self.verify_l(&s, secret.as_str().unwrap_or(""))
    }
    fn status_l(&self, s: &Map<String, Value>) -> Value {
        let p = s.g("password");
        let keys: Vec<Value> = s.a("keys").iter().map(|x| json!({"id":x.g("id"),"name":x.g("name"),"masked":mask(x.s("key")),"createdAt":x.g("createdAt"),"disabled":truthy(x.g("disabled"))})).collect();
        json!({"passwordSet":p.is_object(),"passwordUpdatedAt":if p.is_object() { p.g("updatedAt").clone() } else { Value::Null },
            "internalExternal":s.get("internalExternal") != Some(&Value::Bool(false)),"internalMasked":mask(&self.internal_key),"keys":keys})
    }
    pub fn status(&self) -> Value {
        self.status_l(&self.state.lock().unwrap())
    }
    pub fn set_password(&self, cur: &Value, next: &Value) -> R<Value> {
        let mut s = self.state.lock().unwrap();
        if !self.verify_l(&s, cur.as_str().unwrap_or("")) {
            return herr(403, "当前密码不正确");
        }
        let ns = next.as_str().unwrap_or("");
        if !next.is_string() || js_len(ns) < 8 || js_len(ns) > 128 {
            return herr(400, "新密码长度需为 8–128 位");
        }
        let salt = rand_hex(16);
        s.insert("password".into(), json!({"salt":salt,"hash":pw_hash(ns, &salt),"updatedAt":now_ms()}));
        self.save(&s)?;
        Ok(self.status_l(&s))
    }
    pub fn create_key(&self, name: &Value) -> R<Value> {
        let mut s = self.state.lock().unwrap();
        let mut keys = s.a("keys").to_vec();
        if keys.len() >= 50 {
            return herr(400, "Key 数量已达上限");
        }
        let mut label = clip_runes(js_str(name).trim(), 40);
        if label.is_empty() {
            label = "未命名".into();
        }
        let mut b = [0u8; 24];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut b);
        let key = format!("sk-ais-{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b));
        let id = uuid4();
        keys.push(json!({"id":id,"name":label,"key":key,"createdAt":now_ms()}));
        s.insert("keys".into(), Value::Array(keys));
        self.save(&s)?;
        let mut out = self.status_l(&s);
        out["created"] = json!({"id":id,"name":label,"key":key});
        Ok(out)
    }
    pub fn update_key(&self, id: &str, disabled: &Value, remove: bool) -> R<Value> {
        let mut s = self.state.lock().unwrap();
        let mut keys = s.a("keys").to_vec();
        let Some(i) = keys.iter().position(|x| x.s("id") == id) else { return herr(404, "Key 不存在") };
        if remove {
            keys.remove(i);
        } else {
            keys[i]["disabled"] = json!(truthy(disabled));
        }
        s.insert("keys".into(), Value::Array(keys));
        self.save(&s)?;
        Ok(self.status_l(&s))
    }
    pub fn set_internal_external(&self, on: bool) -> R<Value> {
        let mut s = self.state.lock().unwrap();
        if !on && !s.a("keys").iter().any(|x| !truthy(x.g("disabled"))) {
            return herr(400, "请先创建至少一个可用的客户端 Key");
        }
        s.insert("internalExternal".into(), json!(on));
        self.save(&s)?;
        Ok(self.status_l(&s))
    }
}

// ---------------- stream mode (stream-mode.json) ----------------
pub struct StreamMode {
    file: String,
    mode: Mutex<String>,
}
impl StreamMode {
    pub fn open(file: &str) -> Self {
        let m = read_json(file).ok().map(|v| v.s("mode").to_string()).filter(|m| m == "real" || m == "fake").unwrap_or_else(|| "real".into());
        StreamMode { file: file.into(), mode: Mutex::new(m) }
    }
    pub fn get(&self) -> String {
        self.mode.lock().unwrap().clone()
    }
    pub fn set(&self, m: &str) -> std::io::Result<()> {
        let mut g = self.mode.lock().unwrap();
        if !ro() {
            write_simple(&self.file, &js_bytes(&json!({"mode":m,"updatedAt":now_ms()})), 0o600)?;
        }
        *g = m.into();
        Ok(())
    }
}

// ---------------- run-mode.json ----------------
pub fn run_modes() -> Value {
    json!(["headless", "dual", "single"])
}
/// current run mode from run-mode.json: headless | dual | single
pub fn run_mode_now() -> String {
    run_mode_read(&dual_root()).s("mode").to_string()
}
fn run_mode_read(root: &str) -> Value {
    let m = read_json(&format!("{}/run-mode.json", root)).ok().filter(|v| v.is_object()).unwrap_or(json!({}));
    let mode = if ["headless", "dual", "single"].contains(&m.s("mode")) { m.s("mode") } else { "headless" };
    let parked = if ["A", "B"].contains(&m.s("parked")) { json!(m.s("parked")) } else { Value::Null };
    json!({"mode":mode,"single":m.b("single"),"parked":parked})
}
pub fn run_mode_write(root: &str, mode: &str) -> R<Value> {
    if !["headless", "dual", "single"].contains(&mode) {
        return herr(400, "运行模式只能是 headless、dual 或 single");
    }
    let cur = run_mode_read(root);
    let parked = if mode == "single" { if cur.g("parked").is_null() { json!("B") } else { cur.g("parked").clone() } } else { Value::Null };
    let next = json!({"mode":mode,"single":mode == "single","parked":parked});
    if !ro() {
        write_simple(&format!("{}/run-mode.json", root), &js_bytes(&next), 0o600).map_err(|e| HttpErr::plain(e.to_string()))?;
    }
    Ok(next)
}
pub fn run_mode_status() -> Value {
    json!({"mode":"headless","single":false,"parked":null,"serving":null,"phase":"headless","error":null,"leaseActive":false,"modes":run_modes()})
}
pub fn schedule_restart(prefix: &str, unit: &str) {
    if ro() {
        return;
    }
    let _ = std::process::Command::new("systemd-run").args(["--on-active=2", &format!("--unit={}{}", prefix, now_ms()), "/bin/systemctl", "restart", unit]).spawn();
}

// ---------------- ops tools ----------------
pub async fn run(timeout: Duration, name: &str, args: &[&str]) -> Result<String, String> {
    let fut = tokio::process::Command::new(name).args(args).kill_on_drop(true).output();
    match tokio::time::timeout(timeout, fut).await {
        Err(_) => Err("timeout".into()),
        Ok(Err(e)) => Err(e.to_string()),
        Ok(Ok(o)) if !o.status.success() => Err(format!("exit status {}", o.status.code().unwrap_or(-1))),
        Ok(Ok(o)) => Ok(String::from_utf8_lossy(&o.stdout).into_owned()),
    }
}
const UNITS: [(&str, &str, &str); 3] = [("headless", "ais2api-headless", "无浏览器服务"), ("coordinator", "ais2api-dual-coordinator", "调度器"), ("login", "ais2api-login", "登录服务")];
const CONTAINERS: [&str; 3] = ["ais2api-dual-a", "ais2api-dual-b", "ais2api-dual-management"];
/// management backend + login service run inside the coordinator process
pub static MERGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
fn merged() -> bool {
    MERGED.load(Ordering::Relaxed)
}
/// no-browser service unit (HEADLESS_UNIT overrides, as in backend.rs; used by tests to point at a dummy unit)
static HL_UNIT: Lazy<String> = Lazy::new(|| {
    std::env::var("HEADLESS_UNIT").ok().filter(|u| !u.is_empty() && u.len() <= 64 && u.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'))
        .unwrap_or_else(|| "ais2api-headless".into())
});
fn unit_of(key: &str) -> Option<&'static str> {
    if merged() && key == "login" {
        return Some("ais2api-dual-coordinator");
    }
    if key == "headless" {
        return Some(HL_UNIT.as_str());
    }
    UNITS.iter().find(|u| u.0 == key).map(|u| u.1)
}
/// coordinator log lines that belong to the login service when merged
static RE_LOGIN_LOG: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\[(Login|Relogin|NightlyRelogin|Import|CookieSync|Management)\]|^login service").unwrap());
static RE_CRED_URL: Lazy<Regex> = Lazy::new(|| Regex::new(r"(\w+://)[^\s:@/]+:[^\s@/]+@").unwrap());
static RE_BEARER: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}").unwrap());
static RE_SK: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(sk-|AIza)[A-Za-z0-9_-]{8,}").unwrap());
static RE_LONG_HEX: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b[a-f0-9]{40,}\b").unwrap());
pub fn mask_log(s: &str) -> String {
    let s = RE_CRED_URL.replace_all(s, "${1}***@");
    let s = RE_BEARER.replace_all(&s, "${1}***");
    let s = RE_SK.replace_all(&s, "${1}***");
    RE_LONG_HEX.replace_all(&s, |c: &regex::Captures| format!("{}…", &c[0][..6])).into_owned()
}
fn mem_info() -> Value {
    let b = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let g = |k: &str| -> i64 {
        b.lines().find_map(|l| l.strip_prefix(&format!("{}:", k)).and_then(|r| r.split_whitespace().next()).and_then(|n| n.parse::<i64>().ok())).unwrap_or(0) * 1024
    };
    json!({"total":g("MemTotal"),"available":g("MemAvailable"),"swapTotal":g("SwapTotal"),"swapFree":g("SwapFree")})
}
fn mem_used(cur: Value, cache: &Value) -> Value {
    match (cur.as_i64(), cache.as_i64()) {
        (Some(c), Some(f)) => json!((c - f).max(0)),
        _ => cur,
    }
}
async fn ops_unit(key: &str, unit: &str, name: &str) -> Value {
    let out = run(Duration::from_secs(15), "systemctl", &["show", unit, "-p", "ActiveState", "-p", "SubState", "-p", "MemoryCurrent", "-p", "ActiveEnterTimestamp", "-p", "NRestarts", "-p", "MemoryMax", "-p", "ControlGroup"]).await.unwrap_or_default();
    let kv: std::collections::HashMap<&str, &str> = out.lines().filter_map(|l| l.split_once('=')).collect();
    let num = |k: &str| kv.get(k).filter(|v| !v.is_empty() && v.bytes().all(|c| c.is_ascii_digit())).and_then(|v| v.parse::<i64>().ok()).map(|n| json!(n)).unwrap_or(Value::Null);
    let since = kv.get("ActiveEnterTimestamp").and_then(|ts| {
        let p: Vec<&str> = ts.split_whitespace().collect();
        if p.len() < 3 {
            return None;
        }
        let naive = chrono::NaiveDateTime::parse_from_str(&format!("{} {}", p[1], p[2]), "%Y-%m-%d %H:%M:%S").ok()?;
        // unit timestamps are local time (CST on this host)
        let off = if p.get(3) == Some(&"UTC") { 0 } else { 8 * 3600 };
        Some(json!((naive.and_utc().timestamp() - off) * 1000))
    }).unwrap_or(Value::Null);
    // MemoryCurrent includes page cache charged by child commands (docker CLI, journalctl, git) and is
    // reclaimed on demand; show the non-reclaimable part and report the cache separately
    let cache = kv.get("ControlGroup").filter(|g| g.starts_with('/') && !g.contains("..")).and_then(|g| std::fs::read_to_string(format!("/sys/fs/cgroup{}/memory.stat", g)).ok())
        .and_then(|t| t.lines().find_map(|l| l.strip_prefix("file ")).and_then(|v| v.trim().parse::<i64>().ok())).map(|n| json!(n)).unwrap_or(Value::Null);
    let st = kv.get("ActiveState").filter(|s| !s.is_empty()).copied().unwrap_or("unknown");
    json!({"key":key,"unit":unit,"name":name,"state":st,"sub":kv.get("SubState").copied().unwrap_or(""),"memory":mem_used(num("MemoryCurrent"), &cache),"memoryCache":cache,"memoryMax":num("MemoryMax"),"since":since,"restarts":num("NRestarts")})
}
/// (used, cache, max) of a cgroup v2 directory. used = memory.current minus the page cache the kernel gives
/// back on demand (active_file + inactive_file); shared memory stays counted. Null where unreadable.
fn cgroup_mem(dir: &str) -> (Value, Value, Value) {
    let rd = |f: &str| std::fs::read_to_string(format!("{}/{}", dir, f)).ok();
    let cur = rd("memory.current").and_then(|t| t.trim().parse::<i64>().ok());
    let max = rd("memory.max").and_then(|t| t.trim().parse::<i64>().ok());
    let cache = rd("memory.stat").map(|t| {
        t.lines().filter_map(|l| l.strip_prefix("active_file ").or_else(|| l.strip_prefix("inactive_file "))).filter_map(|v| v.trim().parse::<i64>().ok()).sum::<i64>()
    });
    let j = |v: Option<i64>| v.map(|n| json!(n)).unwrap_or(Value::Null);
    let used = match (cur, cache) {
        (Some(c), Some(f)) => Some((c - f).max(0)),
        (c, _) => c,
    };
    (j(used), j(cache), j(max))
}
pub async fn ops_overview(cwd: &str) -> Map<String, Value> {
    let mut units = vec![];
    for (k, u, n) in UNITS {
        if merged() && k == "login" {
            continue;
        }
        let n = if merged() && k == "coordinator" { "调度器（含管理后台、登录服务）" } else { n };
        units.push(ops_unit(k, if k == "headless" { HL_UNIT.as_str() } else { u }, n).await);
    }
    let out = run(Duration::from_secs(15), "docker", &["ps", "-a", "--no-trunc", "--format", "{{.Names}}\t{{.State}}\t{{.Status}}\t{{.ID}}"]).await.unwrap_or_default();
    let rows: std::collections::HashMap<&str, Value> = out.lines().filter_map(|l| {
        let p: Vec<&str> = l.split('\t').collect();
        if p.len() != 4 {
            return None;
        }
        let mut v = json!({"name":p[0],"state":p[1],"status":p[2]});
        if p[1] == "running" && p[3].len() == 64 && p[3].bytes().all(|c| c.is_ascii_hexdigit()) {
            let (used, cache, max) = cgroup_mem(&format!("/sys/fs/cgroup/system.slice/docker-{}.scope", p[3]));
            v["memory"] = used;
            v["memoryCache"] = cache;
            v["memoryMax"] = max;
        }
        Some((p[0], v))
    }).collect();
    let ctr: Vec<Value> = CONTAINERS.iter().filter(|n| !(merged() && **n == "ais2api-dual-management")).map(|n| rows.get(n).cloned().unwrap_or_else(|| json!({"name":n,"state":"missing","status":""}))).collect();
    let vo = run(Duration::from_secs(15), "git", &["-C", cwd, "log", "-1", "--format=%h%x09%ct%x09%s"]).await.unwrap_or_default();
    let vp: Vec<&str> = vo.trim().splitn(3, '\t').collect();
    let mut ver = json!({"hash":null,"at":null,"subject":""});
    if vp.len() == 3 {
        ver = json!({"hash":vp[0],"at":vp[1].parse::<i64>().unwrap_or(0)*1000,"subject":vp[2]});
    }
    let dout = run(Duration::from_secs(15), "git", &["-C", cwd, "status", "--porcelain"]).await.unwrap_or_default();
    ver["dirty"] = json!(dout.lines().filter(|l| !l.is_empty() && !l.starts_with("??")).count());
    let load: Vec<f64> = std::fs::read_to_string("/proc/loadavg").unwrap_or_default().split_whitespace().take(3).map(|x| x.parse().unwrap_or(0.0)).collect();
    let uptime: f64 = std::fs::read_to_string("/proc/uptime").unwrap_or_default().split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
    let host = std::fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default().trim().to_string();
    let disk = unsafe {
        let mut sf: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(b"/\0".as_ptr() as *const libc::c_char, &mut sf) == 0 {
            json!({"total":(sf.f_blocks as i64)*(sf.f_frsize as i64),"free":(sf.f_bavail as i64)*(sf.f_frsize as i64)})
        } else {
            Value::Null
        }
    };
    let cpus = std::fs::read_to_string("/proc/cpuinfo").map(|b| b.matches("\nprocessor").count() + 1).unwrap_or(0);
    json!({"at":now_ms(),"host":{"hostname":host,"uptime":uptime,"load":load,"cpus":cpus,"memory":mem_info(),"disk":disk},"units":units,"containers":ctr,"version":ver})
        .as_object().unwrap().clone()
}
static RE_ERRW: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)error|failed|失败").unwrap());
static RE_WARN: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\bwarn|gave up|cooldown").unwrap());
pub async fn ops_logs(source: &str, n: i64) -> R<Vec<Value>> {
    let n = if n < 20 { 200 } else { n.min(1000) } as usize;
    let mut out = vec![];
    if source == "headless" {
        let Ok(data) = std::fs::read("/opt/as2a-nb/run.log") else { return Ok(out) };
        let ln = (n * 600).min(data.len());
        let text = String::from_utf8_lossy(&data[data.len() - ln..]).into_owned();
        let mut nz: Vec<&str> = text.split('\n').filter(|l| !l.is_empty()).collect();
        if !nz.is_empty() {
            nz.remove(0);
        }
        if nz.len() > n {
            nz.drain(..nz.len() - n);
        }
        for l in nz {
            let Ok(j) = serde_json::from_str::<Value>(l).map_err(|_| ()).and_then(|v| if v.is_object() { Ok(v) } else { Err(()) }) else {
                out.push(json!({"t":null,"level":"info","source":"","msg":mask_log(l)}));
                continue;
            };
            let mut msg = j.s("msg").to_string();
            let rq = j.g("request");
            if rq.is_object() {
                let st = if rq.g("status").is_null() { rq.g("state") } else { rq.g("status") };
                msg = format!("{} {} {}", rq.s("method"), rq.s("path"), js_str(st));
                if let Some(d) = as_num(rq.g("duration_ms")) {
                    msg.push_str(&format!(" {}ms", (d + 0.5) as i64));
                }
                let e = js_str(rq.g("error"));
                if !e.is_empty() {
                    msg.push(' ');
                    msg.push_str(&e);
                }
            }
            let t = chrono::DateTime::parse_from_rfc3339(j.s("time")).map(|t| json!(t.timestamp_millis())).unwrap_or(Value::Null);
            let lv = j.s("level").to_lowercase();
            out.push(json!({"t":t,"level":if lv.is_empty() { "info".to_string() } else { lv },"source":j.s("source"),"msg":mask_log(&msg)}));
        }
        return Ok(out);
    }
    if let Some(name) = match source {
        "worker-a" => Some("ais2api-dual-a"),
        "worker-b" => Some("ais2api-dual-b"),
        _ => None,
    } {
        return Ok(container_logs(name, n).await);
    }
    let Some(u) = unit_of(source) else { return herr(400, "未知日志来源") };
    let only_login = merged() && source == "login";
    let fetch = if only_login { (n * 20).min(20000) } else { n };
    let text = run(Duration::from_secs(15), "journalctl", &["-u", u, "-n", &fetch.to_string(), "--no-pager", "-o", "json", "--output-fields=MESSAGE,PRIORITY,__REALTIME_TIMESTAMP"]).await.unwrap_or_default();
    for l in text.lines() {
        let Ok(j) = serde_json::from_str::<Value>(l) else { continue };
        let msg = match j.g("MESSAGE") {
            Value::Array(a) => String::from_utf8_lossy(&a.iter().map(|x| as_num(x).unwrap_or(0.0) as u8).collect::<Vec<u8>>()).into_owned(),
            v => js_str(v),
        };
        if only_login && !RE_LOGIN_LOG.is_match(&msg) {
            continue;
        }
        let p: i64 = js_str(j.g("PRIORITY")).parse().unwrap_or(0);
        let lv = if (p <= 3 && !j.g("PRIORITY").is_null()) || RE_ERRW.is_match(&msg) { "error" } else if p == 4 || RE_WARN.is_match(&msg) { "warn" } else { "info" };
        let ts: i64 = js_str(j.g("__REALTIME_TIMESTAMP")).parse().unwrap_or(0);
        out.push(json!({"t":if ts > 0 { json!((ts + 500) / 1000) } else { Value::Null },"level":lv,"source":"","msg":mask_log(&msg)}));
    }
    Ok(out)
}
static RE_WLOG: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\[(INFO|WARN|ERROR|DEBUG)\] \S+ \[([^\]]+)\] - ").unwrap());
/// last n lines of a browser worker container (stdout and stderr merged by timestamp)
async fn container_logs(name: &str, n: usize) -> Vec<Value> {
    let fut = tokio::process::Command::new("docker").args(["logs", "--tail", &n.to_string(), "--timestamps", name]).kill_on_drop(true).output();
    let Ok(Ok(o)) = tokio::time::timeout(Duration::from_secs(15), fut).await else { return vec![] };
    if !o.status.success() {
        return vec![];
    }
    let mut rows: Vec<(i64, Value)> = vec![];
    for buf in [&o.stdout, &o.stderr] {
        for l in String::from_utf8_lossy(buf).lines() {
            if l.is_empty() {
                continue;
            }
            let (ts, tail) = l.split_once(' ').unwrap_or(("", l));
            let t = chrono::DateTime::parse_from_rfc3339(ts).map(|t| t.timestamp_millis()).unwrap_or(0);
            let rest = if t > 0 { tail } else { l };
            let (lv, src, msg) = match RE_WLOG.captures(rest) {
                Some(c) => (c[1].to_lowercase(), c[2].to_string(), rest[c.get(0).unwrap().end()..].to_string()),
                None => ((if RE_ERRW.is_match(rest) { "error" } else { "info" }).to_string(), String::new(), rest.to_string()),
            };
            rows.push((t, json!({"t":if t > 0 { json!(t) } else { Value::Null },"level":lv,"source":src,"msg":mask_log(&msg)})));
        }
    }
    rows.sort_by_key(|r| r.0);
    let skip = rows.len().saturating_sub(n);
    rows.into_iter().skip(skip).map(|r| r.1).collect()
}
/// start / stop / restart a service from the 运维 page. Only the no-browser service can be stopped or started:
/// stopping the coordinator (which also hosts the console and the login service) would take this page down.
pub async fn ops_unit_action(key: &str, action: &str) -> R<Value> {
    if action == "restart" {
        return ops_restart_unit(key).await;
    }
    if action != "start" && action != "stop" {
        return herr(400, "未知操作");
    }
    if key != "headless" {
        return herr(400, "这个服务只能重启");
    }
    let Some(u) = unit_of(key) else { return herr(400, "未知服务") };
    if ro() {
        return herr(409, "只读模式下不执行");
    }
    let word = if action == "start" { "启动" } else { "停止" };
    run(Duration::from_secs(60), "systemctl", &[action, u]).await.map_err(|e| HttpErr::new(409, format!("{}失败：{}", word, clip_runes(&e, 200))))?;
    log(format!("[Ops] unit {} {}", u, action));
    Ok(json!({"unit":key,"action":action,"done":true}))
}
pub async fn ops_restart_unit(key: &str) -> R<Value> {
    let Some(u) = unit_of(key) else { return herr(400, "未知服务") };
    let key = if merged() && key == "login" { "coordinator" } else { key };
    if ro() {
        return herr(409, "只读模式下不执行");
    }
    if key == "coordinator" {
        schedule_restart("ais2api-ops-restart-", u);
        return Ok(json!({"scheduled":true}));
    }
    run(Duration::from_secs(60), "systemctl", &["restart", u]).await.map_err(|e| HttpErr::new(409, format!("重启失败：{}", clip_runes(&e, 200))))?;
    Ok(json!({"restarted":true}))
}
const BACKUP_DIR: &str = "/root/auth-backup";
static RE_BACKUP: Lazy<Regex> = Lazy::new(|| Regex::new(r"^auth-\d{8}-\d{4,6}\.tgz$").unwrap());
fn backup_names() -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(BACKUP_DIR).map(|d| d.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| RE_BACKUP.is_match(n)).collect()).unwrap_or_default();
    v.sort();
    v
}
pub fn ops_backups() -> Vec<Value> {
    let mut names = backup_names();
    names.reverse();
    names.into_iter().take(20).filter_map(|n| {
        let st = std::fs::metadata(format!("{}/{}", BACKUP_DIR, n)).ok()?;
        let at = st.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64;
        Some(json!({"name":n,"size":st.len(),"at":at}))
    }).collect()
}
pub async fn ops_backup() -> R<Value> {
    if ro() {
        return herr(409, "只读模式下不执行");
    }
    let _ = std::fs::create_dir_all(BACKUP_DIR);
    let d = chrono::Utc::now() + chrono::Duration::hours(8);
    let name = format!("auth-{}.tgz", d.format("%Y%m%d-%H%M%S"));
    let path = format!("{}/{}", BACKUP_DIR, name);
    run(Duration::from_secs(60), "tar", &["czf", &path, "-C", "/opt/ais2api", "auth", "-C", "/opt/as2a-nb", "auth", "import-state.json"]).await
        .map_err(|e| HttpErr::new(409, format!("备份失败：{}", clip_runes(&e, 160))))?;
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    let all = backup_names();
    if all.len() > 20 {
        for n in &all[..all.len() - 20] {
            let _ = std::fs::remove_file(format!("{}/{}", BACKUP_DIR, n));
        }
    }
    Ok(json!({"name":name,"backups":ops_backups()}))
}