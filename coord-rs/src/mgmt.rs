// Management backend (start-management.js + management-control.js + console-routes.js + import-ui.js).
// Same routes, allow-list, origin checks, CSRF token, login throttle and cookie sync. Coordinator calls go
// over loopback HTTP (works with any coordinator implementation); login-service calls run in-process.
use crate::login_acc::{chown_1000, AUTH};
use crate::login_http::{handle as login_handle, KEY};
use crate::resp::OutBody;
use crate::util::*;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::HeaderMap;
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use hyper_util::rt::{TokioExecutor, TokioIo};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::time::Duration;

const UI: &str = "/opt/ais2api/dual-runtime/refactor/ui";
const IMPORT_HTML: &str = "/opt/ais2api/dual-runtime/code/import-ui.html";
const COORD: &str = "http://127.0.0.1:8890";
const FAILED: &str = "Coordinator unavailable; operation result may require a status refresh";
const DAY_MS: i64 = 86_400_000;
pub static SESS_FILE: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new("/opt/ais2api/dual-runtime/console-sessions.json".into()));

// ---------------- response ----------------
pub struct Out {
    pub code: u16,
    pub h: Vec<(String, String)>,
    pub body: Bytes,
}
impl Out {
    fn new(code: u16, ctype: &str, body: impl Into<Bytes>) -> Out {
        Out { code, h: vec![("Content-Type".into(), ctype.into())], body: body.into() }
    }
    fn json(code: u16, v: &Value) -> Out {
        Out::new(code, "application/json; charset=utf-8", js_bytes(v))
    }
    fn err(code: u16, m: &str) -> Out {
        Out::json(code, &json!({"error":m}))
    }
    fn fwd(r: (u16, Value)) -> Out {
        Out::json(r.0, &r.1)
    }
    fn redirect(code: u16, loc: &str) -> Out {
        Out::new(code, "text/plain; charset=utf-8", format!("{}. Redirecting to {}", if code == 301 { "Moved Permanently" } else { "Found" }, loc)).set("Location", loc)
    }
    fn set(mut self, k: &str, v: &str) -> Out {
        self.h.retain(|(n, _)| !n.eq_ignore_ascii_case(k));
        self.h.push((k.into(), v.into()));
        self
    }
    fn add(mut self, k: &str, v: &str) -> Out {
        self.h.push((k.into(), v.into()));
        self
    }
    fn has(&self, k: &str) -> bool {
        self.h.iter().any(|(n, _)| n.eq_ignore_ascii_case(k))
    }
    fn or_set(self, k: &str, v: &str) -> Out {
        if self.has(k) { self } else { self.add(k, v) }
    }
}

// ---------------- request ----------------
pub struct Rq {
    pub method: String,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub headers: HeaderMap,
    pub body: Option<Vec<u8>>,
    pub ip: String,
}
impl Rq {
    fn h(&self, k: &str) -> &str {
        self.headers.get(k).and_then(|v| v.to_str().ok()).unwrap_or("")
    }
    fn q(&self, k: &str) -> String {
        self.query.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()).unwrap_or_default()
    }
    fn is_json(&self) -> bool {
        static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^application/json\s*(;|$)").unwrap());
        // type-is: no body -> not json
        (self.headers.contains_key("content-length") || self.headers.contains_key("transfer-encoding")) && RE.is_match(self.h("content-type").trim())
    }
    /// origin header present, http(s), and its host equals the Host header
    fn same_origin(&self, proto: bool) -> bool {
        let o = self.h("origin");
        let Ok(u) = url::Url::parse(o) else { return false };
        if proto && u.scheme() != "http" && u.scheme() != "https" {
            return false;
        }
        let Some(host) = u.host_str() else { return false };
        let host = match u.port() {
            Some(p) => format!("{}:{}", host, p),
            None => host.to_string(),
        };
        host == self.h("host")
    }
}

// ---------------- coordinator calls (management-control.js createControlCall) ----------------
static HC: Lazy<Client<HttpConnector, Full<Bytes>>> = Lazy::new(|| {
    let mut c = HttpConnector::new();
    c.set_connect_timeout(Some(Duration::from_secs(5)));
    Client::builder(TokioExecutor::new()).pool_max_idle_per_host(0).build(c)
});
async fn raw_call(method: &str, path: &str, body: Option<&Value>, timeout: u64, max: usize) -> Option<(u16, Bytes)> {
    let payload = body.map(js_bytes).unwrap_or_default();
    let req = hyper::Request::builder().method(method).uri(format!("{}{}", COORD, path)).header("Authorization", format!("Bearer {}", *KEY))
        .header("Content-Type", "application/json").body(Full::new(Bytes::from(payload))).ok()?;
    let run = async {
        let r = HC.request(req).await.ok()?;
        let s = r.status().as_u16();
        let mut b = r.into_body();
        let mut out = Vec::new();
        while let Some(f) = b.frame().await {
            if let Ok(d) = f.ok()?.into_data() {
                out.extend_from_slice(&d);
                if out.len() > max {
                    return None;
                }
            }
        }
        Some((s, Bytes::from(out)))
    };
    tokio::time::timeout(Duration::from_secs(timeout), run).await.ok().flatten()
}
async fn call_t(method: &str, path: &str, body: Option<Value>, timeout: u64) -> (u16, Value) {
    match raw_call(method, path, body.as_ref(), timeout, 8 << 20).await {
        Some((s, b)) => match serde_json::from_slice(&b) {
            Ok(v) => (s, v),
            Err(_) => (503, json!({"error":FAILED})),
        },
        None => (503, json!({"error":FAILED})),
    }
}
async fn call(method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    call_t(method, path, body, 10).await
}
/// login service, in-process
async fn lcall(method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    let b = body.map(|v| js_bytes(&v)).unwrap_or_default();
    login_handle(method, path, &format!("Bearer {}", *KEY), Some(&b)).await
}

// ---------------- sessions (express-session equivalent; only the hash of the id is stored) ----------------
#[derive(Clone, Default)]
struct Sess {
    auth: bool,
    token: String,
    exp: i64,
}
static SESS: Lazy<Mutex<HashMap<String, Sess>>> = Lazy::new(|| Mutex::new(load_sessions()));
fn sid_hash(sid: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(sid.as_bytes()))
}
fn load_sessions() -> HashMap<String, Sess> {
    let now = now_ms();
    let f = SESS_FILE.lock().unwrap().clone();
    read_json(&f).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default().into_iter().filter_map(|(k, v)| {
        let exp = as_safe_int(v.g("exp"))?;
        (exp > now && v.b("auth")).then(|| (k, Sess { auth: true, token: v.s("token").to_string(), exp }))
    }).collect()
}
fn save_sessions(m: &HashMap<String, Sess>) {
    let now = now_ms();
    let o: Map<String, Value> = m.iter().filter(|(_, s)| s.auth && s.exp > now).map(|(k, s)| (k.clone(), json!({"auth":true,"token":s.token,"exp":s.exp}))).collect();
    let f = SESS_FILE.lock().unwrap().clone();
    let _ = write_atomic(&f, &js_bytes(&Value::Object(o)), 0o600, false);
}
fn cookie_sid(h: &HeaderMap) -> Option<String> {
    for v in h.get_all("cookie") {
        for part in v.to_str().ok()?.split(';') {
            if let Some(x) = part.trim().strip_prefix("connect.sid=") {
                if x.len() == 64 && x.bytes().all(|c| c.is_ascii_hexdigit()) {
                    return Some(x.to_string());
                }
            }
        }
    }
    None
}
fn session(rq: &Rq) -> Option<(String, Sess)> {
    let sid = cookie_sid(&rq.headers)?;
    let k = sid_hash(&sid);
    let mut m = SESS.lock().unwrap();
    let s = m.get(&k)?.clone();
    if s.exp <= now_ms() {
        m.remove(&k);
        return None;
    }
    Some((k, s))
}
/// new authenticated session (session.regenerate); returns the Set-Cookie value
fn new_session(old: Option<String>, secure: bool) -> String {
    let sid = rand_hex(32);
    let exp = now_ms() + DAY_MS;
    let mut m = SESS.lock().unwrap();
    if let Some(o) = old {
        m.remove(&o);
    }
    let now = now_ms();
    m.retain(|_, s| s.exp > now);
    while m.len() >= 200 {
        let Some(k) = m.iter().min_by_key(|(_, s)| s.exp).map(|(k, _)| k.clone()) else { break };
        m.remove(&k);
    }
    m.insert(sid_hash(&sid), Sess { auth: true, token: String::new(), exp });
    save_sessions(&m);
    let when = std::time::UNIX_EPOCH + Duration::from_millis(exp as u64);
    format!("connect.sid={}; Path=/; Expires={}; HttpOnly; SameSite=Lax{}", sid, httpdate::fmt_http_date(when), if secure { "; Secure" } else { "" })
}
fn set_token(k: &str) -> String {
    let mut m = SESS.lock().unwrap();
    let Some(s) = m.get_mut(k) else { return String::new() };
    if s.token.is_empty() {
        s.token = rand_hex(32);
        let t = s.token.clone();
        save_sessions(&m);
        return t;
    }
    s.token.clone()
}

// ---------------- static files (console-routes.js) ----------------
const FIXED_ASSETS: [&str; 20] = ["console.css", "console-panels.css", "models.css", "analytics.css", "proxies.js", "console.js", "shell.js", "models.js", "prices.js",
    "analytics.js", "admin.css", "admin-tools.js", "theme-nai.css", "theme-nai.js", "security.js", "build.js", "build.css", "ops.js", "ops.css", "theme-studio.css"];
const PUBLIC_ASSETS: [&str; 3] = ["nai-hero.webp", "nai-logo.webp", "nai-favicon.png"];
static ASSETS: Lazy<Vec<String>> = Lazy::new(|| {
    let re = Regex::new(r"^nai-[a-z0-9-]{1,40}\.webp$").unwrap();
    let mut art: Vec<String> = std::fs::read_dir(UI).map(|d| d.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| re.is_match(n)).collect()).unwrap_or_default();
    art.sort();
    FIXED_ASSETS.iter().map(|s| s.to_string()).chain(art).collect()
});
fn mime(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("") {
        "css" => "text/css; charset=UTF-8",
        "js" => "application/javascript; charset=UTF-8",
        "html" => "text/html; charset=UTF-8",
        "webp" => "image/webp",
        "png" => "image/png",
        _ => "application/octet-stream",
    }
}
async fn serve_file(name: &str, cache: &str) -> Out {
    match tokio::fs::read(format!("{}/{}", UI, name)).await {
        Ok(b) => Out::new(200, mime(name), b).set("Cache-Control", cache).set("X-Content-Type-Options", "nosniff"),
        Err(_) => Out::new(404, "text/html; charset=utf-8", "Not Found"),
    }
}

// ---------------- allow-list ----------------
static ALLOWED: Lazy<HashSet<String>> = Lazy::new(|| {
    let mut s: HashSet<String> = [
        "GET /login", "POST /login", "GET /import", "POST /api/import-account", "GET /", "GET /api/status", "GET /api/models", "POST /api/models/refresh",
        "GET /favicon.ico", "GET /console-assets/console.css", "GET /console-assets/console.js", "GET /console-assets/models.js", "POST /api/set-mode",
        "POST /api/rotate", "POST /api/restart", "GET /api/ultra-mode", "GET /api/usage-counts", "POST /api/ultra-mode", "POST /api/accounts/tier",
        "POST /api/accounts/name", "POST /api/sync-accounts", "POST /api/models/policy", "GET /api/requests", "GET /api/build-status", "GET /api/build/presets",
        "POST /api/build/presets", "GET /api/build/document", "POST /api/build/document", "GET /api/build/settings", "POST /api/build/settings", "GET /api/usage",
        "POST /api/login/start", "GET /api/client-script", "GET /api/target-app", "POST /api/target-app", "GET /api/run-mode", "POST /api/run-mode",
        "GET /api/ws/config", "POST /api/ws/config", "POST /api/login-proxy", "POST /api/ws/start", "GET /api/ws/job", "POST /api/ws/cancel", "GET /api/login/job",
        "POST /api/login/job", "POST /api/accounts/delete", "GET /api/relogin", "POST /api/relogin/retry", "GET /api/proxies", "POST /api/proxies",
        "POST /api/proxies/apply", "GET /api/prices", "GET /api/auth", "POST /api/auth/password", "POST /api/auth/keys", "POST /api/auth/key",
        "POST /api/auth/internal", "POST /api/prices", "GET /api/concurrency", "POST /api/concurrency", "GET /api/ops/overview", "GET /api/ops/logs",
        "POST /api/build/rotate", "GET /api/at-prompt", "POST /api/at-prompt", "GET /api/at-prompt/export", "POST /api/at-prompt/import",
    ].iter().map(|s| s.to_string()).collect();
    for op in OPS {
        s.insert(format!("POST /api/ops/{}", op));
    }
    for a in ASSETS.iter() {
        s.insert(format!("GET /console-assets/{}", a));
    }
    s
});
const OPS: [&str; 12] = ["restart", "backup", "clear-cooldown", "reset-quota", "write-back", "headless-concurrency", "pause", "account-enable", "test-account",
    "cancel-request", "account-schedule", "stream-mode"];

// ---------------- small JS-compat helpers ----------------
/// String.prototype.slice(0, n) on UTF-16 units
fn u16_take(s: &str, n: usize) -> String {
    let mut used = 0;
    s.chars().take_while(|c| {
        used += c.len_utf16();
        used <= n
    }).collect()
}
/// {k: b[k]} for keys present in b (JSON.stringify drops undefined)
fn pick(b: &Value, keys: &[&str]) -> Value {
    let mut o = Map::new();
    for k in keys {
        if let Some(v) = b.get(*k) {
            o.insert(k.to_string(), v.clone());
        }
    }
    Value::Object(o)
}
/// Number(v) as JSON (NaN -> null)
fn js_number(v: Option<&Value>) -> Value {
    match v {
        None => Value::Null,
        Some(Value::Number(_)) => v.unwrap().clone(),
        Some(Value::Bool(b)) => json!(if *b { 1 } else { 0 }),
        Some(Value::Null) => json!(0),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                json!(0)
            } else {
                t.parse::<f64>().ok().filter(|f| f.is_finite() || t.contains("Infinity")).map(num).unwrap_or(Value::Null)
            }
        }
        Some(Value::Array(a)) if a.is_empty() => json!(0),
        Some(Value::Array(a)) if a.len() == 1 => js_number(a.first()),
        _ => Value::Null,
    }
}
fn is_obj(v: &Value) -> bool {
    v.is_object()
}
fn safe_id(v: &Value) -> Option<i64> {
    as_safe_int(v).filter(|i| *i >= 1)
}
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
/// decodeURIComponent; invalid -> ""
fn uri_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = b.get(i + 1..i + 3).and_then(|x| std::str::from_utf8(x).ok()).and_then(|x| u8::from_str_radix(x, 16).ok());
            let Some(v) = h else { return String::new() };
            out.push(v);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_default()
}

// ---------------- account import (import-ui.js saveImport) ----------------
pub struct HErr {
    pub code: u16,
    pub body: Value,
}
fn he(code: u16, msg: &str, extra: Value) -> HErr {
    let mut o = Map::new();
    o.insert("error".into(), json!(msg));
    if let Value::Object(e) = extra {
        o.extend(e);
    }
    HErr { code, body: Value::Object(o) }
}
static RE_GDOMAIN: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^\.?([a-z0-9-]+\.)*google\.com$").unwrap());
const IMPORT_ORIGINS: [&str; 3] = ["https://aistudio.google.com", "https://ai.studio", "https://accounts.google.com"];
const SESSION_NAMES: [&str; 3] = ["SID", "__Secure-1PSID", "__Secure-3PSID"];
static IMPORT_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
fn validate(d: &Value) -> Result<(Vec<Value>, Vec<Value>), String> {
    let top = "顶层结构无效：需要 cookies(1-200) 与 origins(1-20) 数组".to_string();
    let (Some(cs), Some(os)) = (d.g("cookies").as_array(), d.g("origins").as_array()) else { return Err(top) };
    if cs.is_empty() || cs.len() > 200 || os.len() > 20 {
        return Err(top);
    }
    let st = |v: &Value| v.as_str().map(|s| s.to_string());
    let mut cookies = vec![];
    for (i, c) in cs.iter().enumerate() {
        let bad = || format!("Cookie #{} 字段无效(需name/value/domain=google.com子域/path/expires秒/httpOnly/secure/sameSite)", i + 1);
        let (Some(name), Some(value), Some(domain), Some(path)) = (st(c.g("name")), st(c.g("value")), st(c.g("domain")), st(c.g("path"))) else { return Err(bad()) };
        let exp = c.g("expires").as_f64().filter(|e| e.is_finite() && *e >= -1.0);
        let ok = !name.is_empty() && js_len(&name) <= 256 && js_len(&value) <= 16384 && RE_GDOMAIN.is_match(&domain) && path.starts_with('/') && js_len(&path) <= 2048
            && exp.is_some() && c.g("httpOnly").is_boolean() && c.g("secure").is_boolean() && ["Lax", "Strict", "None"].contains(&c.s("sameSite"));
        if !ok {
            return Err(bad());
        }
        cookies.push(json!({"name":name,"value":value,"domain":domain,"path":path,"expires":num(exp.unwrap()),"httpOnly":c.g("httpOnly"),"secure":c.g("secure"),"sameSite":c.g("sameSite")}));
    }
    let mut origins = vec![];
    for o in os {
        let ls = o.g("localStorage").as_array();
        if !IMPORT_ORIGINS.contains(&o.s("origin")) || !o.g("origin").is_string() || ls.map_or(true, |l| l.len() > 200) {
            return Err("origins.origin 只允许 aistudio.google.com / ai.studio / accounts.google.com".into());
        }
        let mut items = vec![];
        for v in ls.unwrap() {
            let (Some(n), Some(x)) = (st(v.g("name")), st(v.g("value"))) else { return Err("localStorage 项无效".into()) };
            if js_len(&n) > 1024 || js_len(&x) > 65536 {
                return Err("localStorage 项无效".into());
            }
            items.push(json!({"name":n,"value":x}));
        }
        origins.push(json!({"origin":o.g("origin"),"localStorage":items}));
    }
    Ok((cookies, origins))
}
fn sess_map(list: &[Value]) -> HashMap<String, String> {
    list.iter().filter(|c| SESSION_NAMES.contains(&c.s("name")) && !c.s("value").is_empty()).map(|c| (c.s("name").to_string(), c.s("value").to_string())).collect()
}
fn list_ids() -> Vec<i64> {
    static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^auth-(\d+)\.json$").unwrap());
    let mut names: Vec<String> = std::fs::read_dir(AUTH).map(|d| d.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| RE.is_match(n)).collect()).unwrap_or_default();
    names.sort();
    names.iter().filter_map(|n| RE.captures(n).and_then(|c| c[1].parse().ok())).collect()
}
fn find_same(cookies: &[Value], nums: &[i64]) -> Option<i64> {
    let mine = sess_map(cookies);
    if mine.is_empty() {
        return None;
    }
    nums.iter().copied().find(|n| {
        let other = read_json(&format!("{}/auth-{}.json", AUTH, n)).ok().map(|d| sess_map(d.a("cookies"))).unwrap_or_default();
        mine.iter().any(|(k, v)| other.get(k) == Some(v))
    })
}
fn clean_alias(v: &str) -> String {
    u16_take(v.chars().filter(|c| !matches!(*c as u32, 0..=0x1f | 0x7f)).collect::<String>().trim(), 40)
}
fn norm_tier(t: &Value) -> &'static str {
    match t.as_str() {
        Some("pro") => "pro",
        Some("ultra") => "ultra",
        Some("ultra20") => "ultra20",
        _ => "standard",
    }
}
fn write_new(file: &str, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(file)?;
    f.write_all(data)?;
    drop(f);
    chown_1000(file);
    Ok(())
}
/// mode: new (409 on duplicate) | upsert (refresh in place) | update (refresh only)
pub fn save_import(body: &Value, tier: &Value, alias: &str, mode: &str) -> Result<Value, HErr> {
    let _g = IMPORT_LOCK.lock().unwrap();
    let (cookies, origins) = validate(body).map_err(|e| he(400, "文件结构不符合要求，或无法安全保存", json!({"detail":u16_take(&e, 200)})))?;
    if sess_map(&cookies).is_empty() {
        return Err(he(400, "没有找到登录 Cookie（SID / __Secure-1PSID），请确认已登录 Google", Value::Null));
    }
    let io = |_e: std::io::Error| he(500, "保存失败", Value::Null);
    let nums = list_ids();
    if let Some(same) = find_same(&cookies, &nums) {
        if mode == "new" {
            return Err(he(409, &format!("这个账号已经导入过（账号 #{}），没有重复添加", same), json!({"duplicate":same})));
        }
        let file = format!("{}/auth-{}.json", AUTH, same);
        let old = read_json(&file).ok().unwrap_or(Value::Null);
        let mut o = Map::new();
        o.insert("cookies".into(), Value::Array(cookies));
        o.insert("origins".into(), Value::Array(origins));
        for k in ["accountName", "accountTier", "displayName"] {
            if let Some(v) = old.get(k) {
                o.insert(k.into(), v.clone());
            }
        }
        let content = js_bytes(&Value::Object(o.clone()));
        if content.len() > 262144 {
            return Err(he(413, "文件过大", Value::Null));
        }
        let tmp = format!("{}.tmp-{}-{}", file, std::process::id(), now_ms());
        write_new(&tmp, &content).map_err(io)?;
        if let Err(e) = std::fs::rename(&tmp, &file) {
            let _ = std::fs::remove_file(&tmp);
            return Err(io(e));
        }
        log(format!("[Import] 更新账号 #{} 的 Cookie", same));
        return Ok(json!({"index":same,"updated":true,"tier":norm_tier(o.g("accountTier")),"alias":js_str(o.g("displayName")),"verified":false}));
    }
    if mode == "update" {
        return Err(he(404, "这个 Google 账号还没导入过；自动同步只更新已导入的账号", Value::Null));
    }
    if nums.len() >= 50 {
        return Err(he(409, "账号数量已达上限", Value::Null));
    }
    let index = nums.iter().copied().max().unwrap_or(0).max(0) + 1;
    let tier = norm_tier(tier);
    let alias = clean_alias(alias);
    let mut o = Map::new();
    o.insert("cookies".into(), Value::Array(cookies));
    o.insert("origins".into(), Value::Array(origins));
    o.insert("accountName".into(), json!(format!("导入账号 {}", index)));
    if tier != "standard" {
        o.insert("accountTier".into(), json!(tier));
    }
    if !alias.is_empty() {
        o.insert("displayName".into(), json!(alias));
    }
    let content = js_bytes(&Value::Object(o));
    if content.len() > 262144 {
        return Err(he(413, "文件过大", Value::Null));
    }
    write_new(&format!("{}/auth-{}.json", AUTH, index), &content).map_err(io)?;
    log(format!("[Import] 新增账号 #{}，尚未验证", index));
    Ok(json!({"index":index,"updated":false,"tier":tier,"alias":alias,"verified":false}))
}

// ---------------- userscript cookie sync ----------------
static SYNC_KEY: Lazy<String> = Lazy::new(|| {
    use hmac::Mac;
    let mut m = <hmac::Hmac<sha2::Sha256> as Mac>::new_from_slice(KEY.as_bytes()).unwrap();
    m.update(b"ais2api-cookie-sync-v1");
    hex::encode(m.finalize().into_bytes())
});
static SYNC_HITS: Lazy<Mutex<VecDeque<i64>>> = Lazy::new(|| Mutex::new(VecDeque::new()));
fn sync_ok(rq: &Rq) -> bool {
    static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^Bearer\s+").unwrap());
    let got = RE.replace(rq.h("authorization"), "");
    !KEY.is_empty() && ct_eq(got.as_bytes(), SYNC_KEY.as_bytes())
}
const SYNC_KEYS: [&str; 11] = ["SID", "HSID", "SSID", "APISID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PSIDTS", "__Secure-3PSIDTS", "__Secure-1PSIDCC", "__Secure-3PSIDCC"];
async fn cookie_sync(rq: &Rq, b: Value) -> Out {
    if !sync_ok(rq) {
        return Out::err(401, "同步密钥无效");
    }
    {
        let now = now_ms();
        let mut h = SYNC_HITS.lock().unwrap();
        while h.front().map_or(false, |t| now - t > 60_000) {
            h.pop_front();
        }
        if h.len() >= 20 {
            return Out::err(429, "请求太频繁，请稍后再试");
        }
        h.push_back(now);
    }
    let mode = match b.s("mode") {
        m @ ("new" | "upsert" | "update") => m.to_string(),
        _ => "upsert".into(),
    };
    let names: HashSet<String> = b.g("state").a("cookies").iter().filter_map(|c| c.g("name").as_str().map(|s| s.to_string())).collect();
    let present: Vec<&str> = SYNC_KEYS.iter().copied().filter(|n| names.contains(*n)).collect();
    let missing: Vec<&str> = SYNC_KEYS.iter().copied().filter(|n| !names.contains(*n)).collect();
    let no_ts = !names.contains("__Secure-1PSIDTS") && !names.contains("__Secure-3PSIDTS");
    let au = as_safe_int(b.g("authUser")).filter(|n| (0..10).contains(n)).unwrap_or(0);
    let check = json!({"present":present,"missing":missing,"total":names.len(),"authUser":au});
    if b.s("mode") == "check" {
        return Out::json(200, &json!({"check":check,"ok":au == 0}));
    }
    if au != 0 && b.g("force") != &Value::Bool(true) {
        return Out::json(422, &json!({"error":format!("这是浏览器里的第 {} 个 Google 账号（authuser={}）。服务器只会打开第 1 个账号，导入后会用错账号或跳到登录页，没有导入", au + 1, au),
            "check":check,"needForce":true,"reason":"authuser"}));
    }
    let alias = b.g("alias").as_str().unwrap_or("").to_string();
    let state = b.g("state").clone();
    let tier = b.g("tier").clone();
    let r = match tokio::task::spawn_blocking(move || save_import(&state, &tier, &alias, &mode)).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return Out::json(e.code, &e.body),
        Err(_) => {
            elog("[CookieSync] failed");
            return Out::err(500, "保存失败");
        }
    };
    let index = r.g("index").clone();
    let mut note = String::new();
    if r.b("updated") {
        let st = call("GET", "/internal/coordinator-status", None).await.1;
        let using: Vec<String> = st.o("slots").map(|s| s.iter().filter(|(_, x)| x.is_object() && x.g("account") == &index).map(|(k, _)| k.clone()).collect()).unwrap_or_default();
        if !using.is_empty() {
            note = format!("实例 {} 正在用这个账号，下次切换或重启实例后使用新 Cookie", using.join("/"));
        }
    } else {
        call("POST", "/internal/sync-accounts", Some(json!({}))).await;
    }
    let mut verifying = false;
    if !note.contains("正在用") {
        verifying = call("POST", "/internal/accounts/verify", Some(json!({"id":index}))).await.0 == 202;
    }
    if no_ts {
        let t = "没有 __Secure-1PSIDTS，大多数账号仍可用，若启动时跳登录页请改用账号密码登录";
        note = if note.is_empty() { t.to_string() } else { format!("{}；{}", note, t) };
    }
    let mut o = r.as_object().cloned().unwrap_or_default();
    o.insert("note".into(), json!(note));
    o.insert("check".into(), check);
    o.insert("verifying".into(), json!(verifying));
    Out::json(200, &Value::Object(o))
}
async fn cookie_verify(rq: &Rq) -> Out {
    if !sync_ok(rq) {
        return Out::err(401, "同步密钥无效");
    }
    let q = rq.q("id");
    let t = q.trim();
    let id = if t.is_empty() { Some(0.0) } else { t.parse::<f64>().ok() };
    let Some(id) = id.filter(|f| f.fract() == 0.0 && *f >= 1.0 && *f <= 9_007_199_254_740_991.0).map(|f| f as i64) else { return Out::err(400, "账号无效") };
    Out::fwd(call("GET", &format!("/internal/accounts/verify?id={}", id), None).await)
}

// ---------------- console login (8 failures per IP per 10 minutes) ----------------
static FAILS: Lazy<Mutex<HashMap<String, (u32, i64)>>> = Lazy::new(|| Mutex::new(HashMap::new()));
fn throttled(ip: &str) -> bool {
    let mut m = FAILS.lock().unwrap();
    let Some(&(n, at)) = m.get(ip) else { return false };
    if now_ms() - at > 600_000 {
        m.remove(ip);
        return false;
    }
    n >= 8
}
fn fail(ip: &str) {
    let mut m = FAILS.lock().unwrap();
    if m.len() > 10_000 {
        let now = now_ms();
        m.retain(|_, v| now - v.1 <= 600_000);
    }
    let e = m.entry(ip.to_string()).or_insert((0, now_ms()));
    e.0 += 1;
    e.1 = now_ms();
}
/// application/x-www-form-urlencoded field
fn form_field(body: &[u8], key: &str) -> String {
    url::form_urlencoded::parse(body).find(|(k, _)| k == key).map(|(_, v)| v.into_owned()).unwrap_or_default()
}
async fn post_login(rq: &Rq) -> Out {
    let ip = rq.ip.clone();
    if throttled(&ip) {
        return Out::redirect(302, "/login?error=2");
    }
    let Some(body) = rq.body.as_ref().filter(|b| b.len() <= 4096) else { return Out::err(413, "request entity too large") };
    let secret = form_field(body, "apiKey");
    let r = if secret.is_empty() { (200, json!({"ok":false})) } else { call("POST", "/internal/console-auth/login", Some(json!({"secret":secret}))).await };
    if r.0 == 200 && r.1.g("ok") == &Value::Bool(true) {
        FAILS.lock().unwrap().remove(&ip);
        let old = session(rq).map(|(k, _)| k);
        let secure = rq.h("x-forwarded-proto") == "https";
        return Out::redirect(302, "/").add("Set-Cookie", &new_session(old, secure));
    }
    if r.0 != 200 {
        return Out::redirect(302, "/login?error=3");
    }
    fail(&ip);
    Out::redirect(302, "/login?error=1")
}
static LOGIN_PAGE: Lazy<String> = Lazy::new(|| std::fs::read_to_string(format!("{}/login.html", UI)).unwrap_or_default());
fn get_login(rq: &Rq, authed: bool) -> Out {
    if authed {
        return Out::redirect(302, "/");
    }
    let msg = match rq.q("error").as_str() {
        "1" => "密码错误，请重新输入",
        "2" => "尝试次数过多，请 10 分钟后再试",
        "3" => "调度服务暂不可用，请稍后再试",
        _ => "",
    };
    let p = if msg.is_empty() { String::new() } else { format!("<p class=\"error\" role=\"alert\">{}</p>", msg) };
    Out::new(200, "text/html; charset=utf-8", LOGIN_PAGE.replacen("<!--ERROR-->", &p, 1))
}

// ---------------- dashboard API (authenticated) ----------------
static RE_UUID: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[0-9a-f-]{36}$").unwrap());
static RE_REQID: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-f0-9-]{36}$").unwrap());
static RE_PRESET: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-z_]{1,24}$").unwrap());
const SAME_ORIGIN: &str = "Same-origin browser request required";
const GUARD: &str = "请求校验失败，请刷新页面";
fn bad(m: &str) -> Out {
    Out::err(400, m)
}
/// String(v) when typeof v === 'string', else default
fn str_or(v: &Value, d: &str) -> String {
    v.as_str().map(|s| s.to_string()).unwrap_or_else(|| d.to_string())
}
/// URLSearchParams(originalUrl).toString()
fn requery(q: &[(String, String)]) -> String {
    let mut s = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in q {
        s.append_pair(k, v);
    }
    s.finish()
}
async fn api(rq: &Rq, b: &Value, token: &str) -> Out {
    let m = rq.method.as_str();
    let p = rq.path.as_str();
    let guard = || !token.is_empty() && rq.h("x-import-token") == token;
    macro_rules! need_guard {
        () => {
            if !guard() {
                return Out::err(403, GUARD);
            }
        };
    }
    macro_rules! need_origin {
        () => {
            if !rq.same_origin(true) {
                return Out::err(403, SAME_ORIGIN);
            }
        };
    }
    let fwd = |r: (u16, Value)| Out::fwd(r);
    match (m, p) {
        ("GET", "/api/status") => fwd(call("GET", "/internal/coordinator-status", None).await),
        ("GET", "/api/requests") | ("GET", "/api/usage") => {
            let q = requery(&rq.query);
            if js_len(&q) > 2048 {
                return bad("Query too long");
            }
            let ip = if p == "/api/requests" { "/internal/requests" } else { "/internal/usage" };
            fwd(call("GET", &if q.is_empty() { ip.to_string() } else { format!("{}?{}", ip, q) }, None).await)
        }
        ("POST", "/api/accounts/delete") => {
            need_origin!();
            let id = as_safe_int(b.g("id")).filter(|i| *i >= 1);
            match id {
                Some(id) if b.g("confirm").as_str() == Some(&format!("DELETE {}", id)) => fwd(call("POST", "/internal/accounts/delete", Some(json!({"id":id,"confirm":b.g("confirm")}))).await),
                _ => bad("删除确认不匹配"),
            }
        }
        ("GET", "/api/proxies") => fwd(call("GET", "/internal/proxies", None).await),
        ("POST", "/api/proxies") | ("POST", "/api/proxies/apply") => {
            need_origin!();
            if !is_obj(b) || !["A", "B"].contains(&b.s("slot")) || !b.g("slot").is_string() {
                return bad("Invalid proxy configuration");
            }
            let apply = p.ends_with("/apply");
            let payload = if apply { pick(b, &["slot", "revision", "action"]) } else { pick(b, &["slot", "revision", "host", "port", "username", "password"]) };
            fwd(call("POST", if apply { "/internal/proxies/apply" } else { "/internal/proxies" }, Some(payload)).await)
        }
        ("GET", "/api/prices") => fwd(call("GET", "/internal/prices", None).await),
        ("POST", "/api/prices") => {
            if !rq.is_json() {
                return Out::err(415, "JSON required");
            }
            need_origin!();
            fwd(call("POST", "/internal/prices", Some(b.clone())).await)
        }
        ("GET", "/api/models") => fwd(call("GET", "/internal/models", None).await),
        ("POST", "/api/models/policy") => {
            if !rq.is_json() {
                return Out::err(415, "JSON required");
            }
            let model = b.g("model");
            let rev = as_safe_int(b.g("revision")).filter(|r| *r >= 0);
            let ok = model.as_str().map_or(false, |s| js_len(s) <= 200) && rev.is_some() && b.g("quotaFamily").is_string()
                && ["flash", "pro", "ultra"].contains(&b.s("quotaFamily")) && b.g("antiTruncation").is_boolean();
            if !ok {
                return bad("Invalid model policy");
            }
            fwd(call("POST", "/internal/models/policy", Some(json!({"model":model,"quotaFamily":b.g("quotaFamily"),"antiTruncation":b.g("antiTruncation"),"revision":b.g("revision")}))).await)
        }
        ("POST", "/api/models/refresh") => {
            let slot = b.g("slot");
            if !slot.is_string() || !["A", "B", "H"].contains(&b.s("slot")) {
                return bad("Invalid slot");
            }
            fwd(call("POST", "/internal/models/refresh", Some(json!({"slot":slot}))).await)
        }
        ("POST", "/api/set-mode") => {
            let md = b.g("mode");
            if md.as_str() != Some("fake") && md.as_str() != Some("real") {
                return bad("mode must be fake or real");
            }
            fwd(call("POST", "/internal/set-mode", Some(json!({"mode":md}))).await)
        }
        ("POST", "/api/rotate") => {
            if !b.is_object() {
                return bad("JSON object required");
            }
            let slot = b.get("slot");
            let target = b.get("targetAccount").filter(|t| !t.is_null());
            if let Some(s) = slot {
                if s.as_str() != Some("A") && s.as_str() != Some("B") {
                    return bad("slot must be A or B");
                }
            }
            if let Some(t) = target {
                if as_safe_int(t).filter(|i| *i >= 1).is_none() {
                    return bad("targetAccount must be a positive integer");
                }
                if slot.is_none() {
                    return bad("Target account requires a slot");
                }
            }
            let mut o = Map::new();
            if let Some(s) = slot {
                o.insert("slot".into(), s.clone());
            }
            if let Some(t) = target {
                o.insert("targetAccount".into(), t.clone());
            }
            fwd(call("POST", "/internal/rotate", Some(Value::Object(o))).await)
        }
        ("GET", "/api/build/presets") => fwd(call("GET", "/internal/build/presets", None).await),
        ("POST", "/api/build/presets") => fwd(call("POST", "/internal/build/presets", Some(pick(b, &["action", "id", "enabled", "name", "preset"]))).await),
        ("GET", "/api/build/settings") => fwd(call("GET", "/internal/build/settings", None).await),
        ("POST", "/api/build/settings") => fwd(call("POST", "/internal/build/settings", Some(pick(b, &["premiumOnly"]))).await),
        ("GET", "/api/build/document") => fwd(call("GET", "/internal/build/document", None).await),
        ("POST", "/api/build/document") => fwd(call("POST", "/internal/build/document", Some(pick(b, &["enabled", "prefixes"]))).await),
        ("GET", "/api/build-status") => fwd(call("GET", "/internal/build-status", None).await),
        ("GET", "/api/usage-counts") => fwd(call("GET", "/internal/usage-counts", None).await),
        ("GET", "/api/ultra-mode") => fwd(call("GET", "/internal/ultra-mode", None).await),
        ("POST", "/api/ultra-mode") => fwd(call("POST", "/internal/ultra-mode", Some(pick(b, &["enabled", "slot"]))).await),
        ("POST", "/api/accounts/name") => fwd(call("POST", "/internal/accounts/name", Some(pick(b, &["id", "name"]))).await),
        ("POST", "/api/accounts/tier") => fwd(call("POST", "/internal/accounts/tier", Some(pick(b, &["id", "tier"]))).await),
        ("POST", "/api/restart") => {
            let slot = b.g("slot");
            if slot.as_str() != Some("A") && slot.as_str() != Some("B") {
                return bad("slot must be A or B");
            }
            fwd(call("POST", "/internal/restart", Some(json!({"slot":slot}))).await)
        }
        ("POST", "/api/login/start") => {
            need_guard!();
            let tier = match b.s("tier") {
                t @ ("pro" | "ultra" | "ultra20") if b.g("tier").is_string() => t,
                _ => "standard",
            };
            let body = json!({"email":str_or(b.g("email"), ""),"password":str_or(b.g("password"), ""),"remember":b.g("remember") == &Value::Bool(true),
                "alias":b.g("alias").as_str().map(|a| u16_take(a, 40)).unwrap_or_default(),"tier":tier});
            fwd(lcall("POST", "/login/start", Some(body)).await)
        }
        ("GET", "/api/login/job") => {
            let id = rq.q("id");
            if !RE_UUID.is_match(&id) {
                return bad("任务编号无效");
            }
            fwd(lcall("GET", &format!("/login/{}", id), None).await)
        }
        ("POST", "/api/login/job") => {
            need_guard!();
            let id = js_str(b.g("id"));
            let action = b.g("action").as_str().unwrap_or("");
            if !RE_UUID.is_match(&id) || !["input", "cancel"].contains(&action) {
                return bad("请求无效");
            }
            let body = if action == "input" { json!({"value":js_str(b.g("value"))}) } else { json!({}) };
            fwd(lcall("POST", &format!("/login/{}/{}", id, action), Some(body)).await)
        }
        ("GET", "/api/relogin") => fwd(lcall("GET", "/login/nightly", None).await),
        ("POST", "/api/relogin/retry") => {
            need_origin!();
            let Some(id) = safe_id(b.g("id")) else { return bad("账号编号无效") };
            fwd(lcall("POST", "/login/nightly/retry", Some(json!({"id":id}))).await)
        }
        ("GET", "/api/client-script") => match raw_call("GET", "/internal/client-script", None, 10, 8 << 20).await {
            Some((s, body)) => Out::new(if s == 200 { 200 } else { 503 }, "text/plain; charset=utf-8", body),
            None => Out::err(503, "脚本不可用"),
        },
        ("GET", "/api/target-app") => fwd(call("GET", "/internal/target-app", None).await),
        ("POST", "/api/target-app") => {
            need_guard!();
            let payload = if b.s("action") == "apply" { json!({"action":"apply"}) } else { json!({"url":b.g("url").as_str().map(|u| u16_take(u, 300)).unwrap_or_default()}) };
            fwd(call("POST", "/internal/target-app", Some(payload)).await)
        }
        ("POST", "/api/build/rotate") => {
            need_guard!();
            let a = b.g("account");
            if !a.is_null() && safe_id(a).is_none() {
                return bad("账号编号无效");
            }
            fwd(call_t("POST", "/internal/build/rotate-applets", Some(json!({"account":a})), 120).await)
        }
        ("GET", "/api/ops/overview") => fwd(call("GET", "/internal/ops/overview", None).await),
        ("GET", "/api/ops/logs") => {
            let src = rq.q("source");
            if !["headless", "coordinator", "login"].contains(&src.as_str()) {
                return bad("未知日志来源");
            }
            let n = js_number(Some(&json!(rq.q("n")))).as_f64().filter(|f| *f != 0.0).unwrap_or(200.0).min(1000.0).max(20.0);
            fwd(call("GET", &format!("/internal/ops/logs?source={}&n={}", src, js_num_str(n)), None).await)
        }
        ("POST", _) if p.starts_with("/api/ops/") => ops(&p[9..], b, guard()).await,
        ("GET", "/api/at-prompt") => fwd(call("GET", "/internal/at-prompt", None).await),
        ("POST", "/api/at-prompt") => {
            need_guard!();
            let pr = b.g("preset");
            if !pr.as_str().map_or(false, |s| RE_PRESET.is_match(s)) {
                return bad("参数无效");
            }
            let mut payload = json!({"preset":pr});
            match b.get("custom") {
                None | Some(Value::Null) => {}
                Some(c) if c.is_object() => payload["custom"] = pick(c, &["desc", "hint", "cont"]),
                _ => return bad("参数无效"),
            }
            fwd(call("POST", "/internal/at-prompt", Some(payload)).await)
        }
        ("GET", "/api/at-prompt/export") => {
            let r = call("GET", "/internal/at-prompt/export", None).await;
            if r.0 != 200 {
                return fwd(r);
            }
            let day = chrono::Utc::now().format("%Y-%m-%d").to_string();
            Out::new(200, "application/json; charset=utf-8", js_indent(&r.1, " ")).set("Content-Disposition", &format!("attachment; filename=\"at-prompt-{}.json\"", day))
        }
        ("POST", "/api/at-prompt/import") => {
            need_guard!();
            if !b.is_object() {
                return bad("文件内容不是 JSON 对象");
            }
            fwd(call("POST", "/internal/at-prompt/import", Some(b.clone())).await)
        }
        ("GET", "/api/concurrency") => fwd(call("GET", "/internal/concurrency", None).await),
        ("POST", "/api/concurrency") => {
            need_guard!();
            let mut o = Map::new();
            for s in ["A", "B"] {
                if let Some(v) = b.get(s) {
                    o.insert(s.into(), js_number(Some(v)));
                }
            }
            fwd(call("POST", "/internal/concurrency", Some(Value::Object(o))).await)
        }
        ("GET", "/api/run-mode") => fwd(call("GET", "/internal/run-mode", None).await),
        ("POST", "/api/run-mode") => {
            need_guard!();
            let md = b.get("mode");
            if let Some(v) = md {
                if !v.as_str().map_or(false, |s| ["headless", "dual", "single"].contains(&s)) {
                    return bad("参数无效");
                }
            } else if !b.g("single").is_boolean() {
                return bad("参数无效");
            }
            let payload = match md {
                Some(v) => json!({"mode":v}),
                None => json!({"single":b.g("single")}),
            };
            fwd(call("POST", "/internal/run-mode", Some(payload)).await)
        }
        ("GET", "/api/ws/config") => fwd(lcall("GET", "/ws/config", None).await),
        ("POST", "/api/ws/config") => {
            need_guard!();
            let keys = ["domain", "mailbox", "graph_client_id", "recovery_email", "mail_subject_keywords", "mail_provider", "tempmail_api", "tempmail_admin", "tempmail_name"];
            fwd(lcall("POST", "/ws/config", Some(pick(b, &keys))).await)
        }
        ("POST", "/api/login-proxy") => {
            need_guard!();
            let mut o = pick(b, &["type", "host", "port", "username", "password", "enabled"]);
            o["clear"] = json!(b.g("clear") == &Value::Bool(true));
            fwd(lcall("POST", "/login-proxy", Some(o)).await)
        }
        ("POST", "/api/ws/start") => {
            need_guard!();
            fwd(lcall("POST", "/ws/start", Some(pick(b, &["kind", "mailId"]))).await)
        }
        ("GET", "/api/ws/job") => {
            let id = rq.q("id");
            if !RE_UUID.is_match(&id) {
                return bad("任务编号无效");
            }
            fwd(lcall("GET", &format!("/ws/{}", id), None).await)
        }
        ("POST", "/api/ws/cancel") => {
            need_guard!();
            let id = js_str(b.g("id"));
            if !RE_UUID.is_match(&id) {
                return bad("任务编号无效");
            }
            fwd(lcall("POST", &format!("/ws/{}/cancel", id), Some(json!({}))).await)
        }
        ("POST", "/api/sync-accounts") => fwd(call("POST", "/internal/sync-accounts", Some(json!({}))).await),
        ("GET", "/api/auth") => fwd(call("GET", "/internal/console-auth", None).await),
        ("POST", "/api/auth/password") => fwd(call("POST", "/internal/console-auth/password", Some(json!({"current":js_str(b.g("current")),"next":js_str(b.g("next"))}))).await),
        ("POST", "/api/auth/keys") => fwd(call("POST", "/internal/console-auth/keys", Some(json!({"name":js_str(b.g("name"))}))).await),
        ("POST", "/api/auth/key") => fwd(call("POST", "/internal/console-auth/key", Some(json!({"id":js_str(b.g("id")),"disabled":b.g("disabled") == &Value::Bool(true),"remove":b.g("remove") == &Value::Bool(true)}))).await),
        ("POST", "/api/auth/internal") => fwd(call("POST", "/internal/console-auth/internal", Some(json!({"enabled":b.g("enabled") == &Value::Bool(true)}))).await),
        _ => Out::err(404, "Management endpoint unavailable"),
    }
}
/// /api/ops/<op> (start-management.js validation, then the coordinator)
async fn ops(op: &str, b: &Value, guard: bool) -> Out {
    if !OPS.contains(&op) {
        return Out::err(404, "Management endpoint unavailable");
    }
    if !guard {
        return Out::err(403, GUARD);
    }
    let mut p = Map::new();
    match op {
        "restart" => {
            let u = b.g("unit");
            if !u.as_str().map_or(false, |s| ["headless", "coordinator", "login"].contains(&s)) {
                return bad("未知服务");
            }
            p.insert("unit".into(), u.clone());
        }
        "clear-cooldown" | "reset-quota" => {
            let Some(id) = safe_id(b.g("id")) else { return bad("账号编号无效") };
            p.insert("id".into(), json!(id));
            if op == "reset-quota" {
                p.insert("confirm".into(), json!(u16_take(&js_str(b.g("confirm")), 40)));
            }
        }
        "headless-concurrency" => {
            p.insert("perAccount".into(), js_number(b.get("perAccount")));
        }
        "pause" => {
            if !b.g("paused").is_boolean() {
                return bad("参数无效");
            }
            p.insert("paused".into(), b.g("paused").clone());
        }
        "test-account" | "account-enable" => {
            let Some(id) = safe_id(b.g("id")) else { return bad("账号编号无效") };
            p.insert("id".into(), json!(id));
            if op == "account-enable" {
                if !b.g("enabled").is_boolean() {
                    return bad("参数无效");
                }
                p.insert("enabled".into(), b.g("enabled").clone());
            }
        }
        "account-schedule" => {
            let Some(id) = safe_id(b.g("id")) else { return bad("账号编号无效") };
            p.insert("id".into(), json!(id));
            if let Some(g) = b.get("groups") {
                let ok = g.as_array().map_or(false, |a| a.len() <= 10 && a.iter().all(|x| x.as_str().map_or(false, |s| js_len(s) <= 20)));
                if !ok {
                    return bad("分组无效");
                }
                p.insert("groups".into(), g.clone());
            }
            if let Some(pr) = b.get("priority") {
                if as_safe_int(pr).is_none() {
                    return bad("优先级无效");
                }
                p.insert("priority".into(), pr.clone());
            }
        }
        "stream-mode" => {
            let md = b.g("mode");
            if md.as_str() != Some("fake") && md.as_str() != Some("real") {
                return bad("参数无效");
            }
            p.insert("mode".into(), md.clone());
        }
        "cancel-request" => {
            let id = js_str(b.g("id"));
            if !RE_REQID.is_match(&id) {
                return bad("请求编号无效");
            }
            p.insert("id".into(), json!(id));
        }
        _ => {}
    }
    let t = if op == "test-account" { 120 } else { 10 };
    Out::fwd(call_t("POST", &format!("/internal/ops/{}", op), Some(Value::Object(p)), t).await)
}

// ---------------- dispatcher (same order as the Express stack) ----------------
const BODY_MAX: usize = 16 << 20;
const IMPORT_MAX: usize = 262_144;
fn security_headers(o: Out) -> Out {
    o.or_set("X-Frame-Options", "DENY").or_set("X-Content-Type-Options", "nosniff")
}
/// JSON body like express.json: objects/arrays only; non-JSON content type -> {}
fn json_body(rq: &Rq) -> Result<Value, ()> {
    let Some(b) = rq.body.as_ref() else { return Ok(json!({})) };
    if !rq.is_json() || b.iter().all(|c| c.is_ascii_whitespace()) {
        return Ok(json!({}));
    }
    match serde_json::from_slice::<Value>(b) {
        Ok(v) if v.is_object() || v.is_array() => Ok(v),
        _ => Err(()),
    }
}
pub async fn handle(rq: Rq) -> Out {
    let m = rq.method.as_str();
    let p = rq.path.clone();
    // public artwork + favicon (before login)
    if m == "GET" {
        if let Some(n) = p.strip_prefix("/public-assets/") {
            if PUBLIC_ASSETS.contains(&n) {
                return serve_file(n, "public, max-age=2592000, immutable").await;
            }
        }
        if p == "/favicon.ico" {
            return Out::redirect(301, "/public-assets/nai-favicon.png");
        }
    }
    // userscript cookie sync (bearer key derived from the API key; no cookies)
    if m == "POST" && p == "/api/cookie-sync" {
        let b = if rq.body.as_ref().map_or(0, |b| b.len()) > 300 * 1024 { return Out::err(413, "request entity too large").set("Cache-Control", "no-store") } else { json_body(&rq) };
        let Ok(b) = b else { return Out::err(400, "请求无效").set("Cache-Control", "no-store") };
        return cookie_sync(&rq, b).await.set("Cache-Control", "no-store");
    }
    if m == "GET" && p == "/api/cookie-sync/verify" {
        return cookie_verify(&rq).await.set("Cache-Control", "no-store");
    }
    security_headers(dashboard(&rq).await)
}
async fn dashboard(rq: &Rq) -> Out {
    let m = rq.method.as_str();
    let p = rq.path.as_str();
    if m == "POST" {
        if rq.h("sec-fetch-site") == "cross-site" {
            return Out::err(403, "Cross-site management request");
        }
        if rq.headers.contains_key("origin") && !rq.same_origin(true) {
            return Out::err(403, "Cross-origin changes rejected");
        }
        if p.starts_with("/api/") && !rq.is_json() {
            return Out::err(415, "JSON required");
        }
    }
    if !ALLOWED.contains(&format!("{} {}", m, p)) {
        return Out::err(404, "Management endpoint unavailable").set("Cache-Control", "no-store");
    }
    route(rq).await.or_set("Cache-Control", "no-store")
}
async fn route(rq: &Rq) -> Out {
    let m = rq.method.as_str();
    let p = rq.path.as_str();
    let sess = session(rq);
    let authed = sess.as_ref().map_or(false, |(_, s)| s.auth);
    // import-ui.js (own body limit and error text)
    if p == "/import" || p == "/api/import-account" {
        if !authed {
            return Out::err(401, "请先登录");
        }
        let (k, s) = sess.unwrap();
        if m == "GET" {
            let tok = set_token(&k);
            let html = std::fs::read_to_string(IMPORT_HTML).unwrap_or_default().replacen("__CSRF_TOKEN__", &tok, 1);
            return Out::new(200, "text/html; charset=utf-8", html).set("X-Frame-Options", "DENY");
        }
        if rq.body.as_ref().map_or(0, |b| b.len()) > IMPORT_MAX {
            return Out::err(413, "JSON格式错误或超过256KiB");
        }
        let Ok(b) = json_body(rq) else { return Out::err(400, "JSON格式错误或超过256KiB") };
        if !rq.same_origin(true) || s.token.is_empty() || rq.h("x-import-token") != s.token {
            return Out::err(403, "请求校验失败，请刷新导入页面");
        }
        let alias = uri_decode(rq.h("x-account-alias"));
        let tier = json!(rq.h("x-account-tier"));
        return match tokio::task::spawn_blocking(move || save_import(&b, &tier, &alias, "new")).await {
            Ok(Ok(r)) => Out::json(200, &json!({"index":r.g("index"),"tier":r.g("tier"),"alias":r.g("alias"),"verified":false})),
            Ok(Err(e)) => Out::json(e.code, &e.body),
            Err(_) => Out::err(400, "文件结构不符合要求，或无法安全保存"),
        };
    }
    if p == "/login" {
        return if m == "GET" { get_login(rq, authed) } else { post_login(rq).await };
    }
    // everything below requires a session (management-control.js requireSession)
    if !authed {
        return if p.starts_with("/api/") { Out::err(401, "Session expired; sign in again") } else { Out::redirect(302, "/login") };
    }
    let (_, s) = sess.unwrap();
    if m == "GET" && p == "/" {
        return serve_file("index.html", "no-store").await;
    }
    if let Some(n) = p.strip_prefix("/console-assets/") {
        return serve_file(n, "private, max-age=2592000, immutable").await;
    }
    if rq.body.as_ref().map_or(0, |b| b.len()) > BODY_MAX {
        return Out::err(413, "request entity too large");
    }
    let Ok(b) = json_body(rq) else { return Out::err(400, "Invalid JSON body") };
    api(rq, &b, &s.token).await
}

// ---------------- listener ----------------
pub async fn serve_req(req: hyper::Request<Incoming>) -> hyper::Response<OutBody> {
    let (parts, body) = req.into_parts();
    let method = parts.method.to_string();
    let rq_body = if method == "POST" { crate::login_srv::read_body(body, BODY_MAX + 1).await } else { Some(Vec::new()) };
    let out = match rq_body {
        None => security_headers(Out::err(413, "request entity too large")),
        Some(b) => {
            let query: Vec<(String, String)> = parts.uri.query().map(|q| url::form_urlencoded::parse(q.as_bytes()).into_owned().collect()).unwrap_or_default();
            let ip = parts.headers.get("x-real-ip").and_then(|v| v.to_str().ok()).unwrap_or("127.0.0.1").to_string();
            handle(Rq { method, path: parts.uri.path().to_string(), query, headers: parts.headers, body: Some(b), ip }).await
        }
    };
    let mut r = hyper::Response::builder().status(out.code);
    for (k, v) in &out.h {
        r = r.header(k.as_str(), v.as_str());
    }
    r.body(OutBody::full(out.body)).unwrap_or_else(|_| hyper::Response::builder().status(500).body(OutBody::full(Bytes::new())).unwrap())
}
pub async fn serve(addr: &str, stop: impl std::future::Future<Output = ()>) -> Result<(), String> {
    let ln = tokio::net::TcpListener::bind(addr).await.map_err(|e| format!("{}: {}", addr, e))?;
    Lazy::force(&SESS);
    Lazy::force(&ALLOWED);
    log(format!("[Management] {}; sessions persisted; login service in-process", addr));
    tokio::pin!(stop);
    loop {
        tokio::select! {
            r = ln.accept() => {
                let Ok((sock, _)) = r else { continue };
                tokio::spawn(async move {
                    let svc = hyper::service::service_fn(|req| async move { Ok::<_, std::convert::Infallible>(serve_req(req).await) });
                    let _ = hyper::server::conn::http1::Builder::new().timer(hyper_util::rt::TokioTimer::new()).header_read_timeout(Duration::from_secs(15))
                        .serve_connection(TokioIo::new(sock), svc).await;
                });
            }
            _ = &mut stop => return Ok(()),
        }
    }
}
