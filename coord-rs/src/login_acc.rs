// Login jobs (login-service.js): one throwaway browser container per login, JSON-lines protocol with
// login-runner.js, then the login state is written to /opt/ais2api/auth and the pool is synced.
use crate::login_store::{cred_put, read_obj};
use crate::util::*;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};

pub const AUTH: &str = "/opt/ais2api/auth";
static RE_DOMAIN: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^\.?([a-z0-9-]+\.)*google\.com$").unwrap());
static RE_KEYCOOKIE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(SID|__Secure-1PSID|__Secure-3PSID|SAPISID|HSID|SSID)$").unwrap());
static RE_AUTHFILE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^auth-(\d+)\.json$").unwrap());
const ORIGINS: [&str; 3] = ["https://aistudio.google.com", "https://ai.studio", "https://accounts.google.com"];

/// login storage filtered to google.com cookies and the three allowed origins
pub fn clean_storage(st: &Value) -> (Vec<Value>, Vec<Value>) {
    let cookies: Vec<Value> = st.a("cookies").iter().filter(|c| {
        let name = c.s("name");
        !name.is_empty() && name.len() <= 256 && c.g("value").as_str().map(|v| v.len() <= 16384).unwrap_or(false)
            && RE_DOMAIN.is_match(c.s("domain")) && c.s("path").starts_with('/')
            && as_num(c.g("expires")).map(|e| e.is_finite() && e >= -1.0).unwrap_or(false)
            && ["Lax", "Strict", "None"].contains(&c.s("sameSite"))
    }).take(200).map(|c| json!({"name":c.g("name"),"value":c.g("value"),"domain":c.g("domain"),"path":c.g("path"),"expires":c.g("expires"),
        "httpOnly":truthy(c.g("httpOnly")),"secure":truthy(c.g("secure")),"sameSite":c.g("sameSite")})).collect();
    let origins: Vec<Value> = st.a("origins").iter().filter(|o| ORIGINS.contains(&o.s("origin"))).take(20).map(|o| {
        let ls: Vec<Value> = o.a("localStorage").iter().filter(|v| v.g("name").as_str().map(|n| n.len() <= 1024).unwrap_or(false)
            && v.g("value").as_str().map(|x| x.len() <= 65536).unwrap_or(false)).take(200).map(|v| json!({"name":v.g("name"),"value":v.g("value")})).collect();
        json!({"origin":o.g("origin"),"localStorage":ls})
    }).collect();
    (cookies, origins)
}
fn key_cookies(c: &[Value]) -> usize {
    c.iter().filter(|x| RE_KEYCOOKIE.is_match(x.s("name"))).count()
}
pub fn auth_ids() -> Vec<i64> {
    std::fs::read_dir(AUTH).map(|d| d.filter_map(|e| e.ok()).filter_map(|e| {
        let n = e.file_name().to_string_lossy().into_owned();
        RE_AUTHFILE.captures(&n).and_then(|c| c[1].parse().ok())
    }).collect()).unwrap_or_default()
}
pub fn chown_1000(f: &str) {
    let _ = std::os::unix::fs::chown(f, Some(1000), Some(1000));
}
/// new account file auth-<max+1>.json (create-new, fsync, owned by uid 1000)
pub fn write_account(st: &Value, email: &str, tier: &str, alias: &str) -> Result<i64, String> {
    let (cookies, origins) = clean_storage(st);
    if key_cookies(&cookies) < 3 {
        return Err("登录状态不完整".into());
    }
    let ids = auth_ids();
    if ids.len() >= 50 {
        return Err("账号数量已达上限".into());
    }
    let index = ids.iter().copied().max().unwrap_or(0) + 1;
    let mut o = Map::new();
    o.insert("cookies".into(), Value::Array(cookies));
    o.insert("origins".into(), Value::Array(origins));
    o.insert("accountName".into(), json!(email));
    if ["pro", "ultra", "ultra20"].contains(&tier) {
        o.insert("accountTier".into(), json!(tier));
    }
    if !alias.is_empty() {
        o.insert("displayName".into(), json!(alias));
    }
    let content = js_bytes(&Value::Object(o));
    if content.len() > 262144 {
        return Err("登录数据过大".into());
    }
    let file = format!("{}/auth-{}.json", AUTH, index);
    if crate::state::READ_ONLY.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("只读模式".into());
    }
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&file).map_err(|e| e.to_string())?;
    f.write_all(&content).and_then(|_| f.sync_all()).map_err(|e| e.to_string())?;
    chown_1000(&file);
    Ok(index)
}
/// replace cookies/origins of an existing account, keep name/tier/alias
pub fn refresh_account(id: i64, st: &Value) -> Result<(), String> {
    let (cookies, origins) = clean_storage(st);
    if key_cookies(&cookies) < 3 {
        return Err("登录状态不完整".into());
    }
    let file = format!("{}/auth-{}.json", AUTH, id);
    let mut old = read_json(&file).map_err(|e| e.to_string())?.as_object().cloned().ok_or("账号文件无效")?;
    old.insert("cookies".into(), Value::Array(cookies));
    old.insert("origins".into(), Value::Array(origins));
    let content = js_bytes(&Value::Object(old));
    if content.len() > 262144 {
        return Err("登录数据过大".into());
    }
    if crate::state::READ_ONLY.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("只读模式".into());
    }
    write_atomic(&file, &content, 0o600, true).map_err(|e| e.to_string())?;
    chown_1000(&file);
    Ok(())
}
/// account id already holding this login e-mail (0 = none)
pub fn already_imported(email: &str) -> i64 {
    let want = email.to_lowercase();
    for id in auth_ids() {
        if read_obj(&format!("{}/auth-{}.json", AUTH, id)).s("accountName").to_lowercase() == want {
            return id;
        }
    }
    0
}
pub fn email_of(id: i64) -> String {
    read_obj(&format!("{}/auth-{}.json", AUTH, id)).s("accountName").to_string()
}
/// one login peaks around 650 MB: need 400 MB available and 1.5 GB with swap
pub fn mem_ok() -> bool {
    let t = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let g = |k: &str| t.lines().find_map(|l| l.strip_prefix(&format!("{}:", k)).and_then(|r| r.split_whitespace().next()).and_then(|n| n.parse::<f64>().ok())).unwrap_or(0.0) / 1024.0;
    let (avail, swap) = (g("MemAvailable"), g("SwapFree"));
    avail >= 400.0 && avail + swap >= 1500.0
}
pub fn remember(id: i64, email: &str, pw: &str) {
    let _ = cred_put(id, email, pw);
}