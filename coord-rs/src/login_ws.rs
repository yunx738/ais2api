// Workspace config + login proxy (workspace.js) and auto-registered accounts (nightly-relogin.js registered()).
use crate::login_store::{read_obj, write_secure};
use crate::util::*;
use base64::Engine;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

pub const WS_DIR: &str = "/opt/ais2api/auto-register";
pub const WS_DATA: &str = "/opt/ais2api/auto-register/data";
pub const WS_IMAGE: &str = "ais-workspace-register:1";
const WS_CFG: &str = "/opt/ais2api/auto-register/data/ws-config.json";
const PROXY_FILE: &str = "/opt/ais2api-direct/login-proxy.json";
const LEGACY_UP: &str = "/opt/ais2api-direct/login-upstream.env";
const KEYS: [&str; 8] = ["domain", "mailbox", "graph_client_id", "recovery_email", "mail_subject_keywords", "mail_provider", "tempmail_api", "tempmail_name"];

static RE_EMAIL: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^[^\s@]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$").unwrap());
static RE_DOMAIN: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^[a-z0-9.-]{3,190}$").unwrap());
static RE_APPID: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^[0-9a-f-]{36}$").unwrap());
static RE_TMPNAME: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^[a-z0-9._-]{1,64}$").unwrap());
static RE_HOST: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^[a-z0-9.-]{1,190}$").unwrap());

pub fn email_ok(s: &str) -> bool {
    RE_EMAIL.is_match(s)
}
fn jwt_address(j: &str) -> String {
    let Some(p) = j.split('.').nth(1) else { return String::new() };
    let p = p.replace('-', "+").replace('_', "/");
    let pad = (4 - p.len() % 4) % 4;
    let p = format!("{}{}", p, "=".repeat(pad));
    base64::engine::general_purpose::STANDARD.decode(p).ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("address").and_then(|a| a.as_str()).map(String::from))
        .unwrap_or_default()
}
/// public view of ws-config.json (secrets never returned)
pub fn ws_config() -> Map<String, Value> {
    let c = read_obj(WS_CFG);
    let mut o = Map::new();
    for k in KEYS {
        let v = match c.get(k).filter(|v| !v.is_null()) {
            Some(v) => v.clone(),
            None => match k {
                "mail_subject_keywords" => json!(["新的 Google", "Google 帐号"]),
                "mail_provider" => json!("tempmail"),
                _ => json!(""),
            },
        };
        o.insert(k.into(), v);
    }
    let addr = if truthy(c.g("mailbox")) { js_str(c.g("mailbox")) } else { jwt_address(c.s("tempmail_jwt")) };
    o.insert("tempmail_address".into(), json!(addr));
    o.insert("has_tempmail_admin".into(), json!(truthy(c.g("tempmail_admin"))));
    o
}
/// save ws-config.json (same validation as workspace.js saveConfig)
pub fn ws_save_config(b: &Value) -> Result<Map<String, Value>, String> {
    let mut c = ws_config();
    if let Some(v) = b.get("domain").filter(|v| !v.is_null()) {
        let s = js_string(v);
        if !RE_DOMAIN.is_match(&s) {
            return Err("域名格式不正确".into());
        }
        c.insert("domain".into(), json!(s));
    }
    for k in ["mailbox", "recovery_email"] {
        if let Some(v) = b.get(k).filter(|v| !v.is_null()) {
            let s = js_string(v);
            if !RE_EMAIL.is_match(&s) {
                return Err("邮箱格式不正确".into());
            }
            c.insert(k.into(), json!(s));
        }
    }
    if let Some(v) = b.get("graph_client_id").filter(|v| !v.is_null()) {
        let s = js_string(v);
        if !RE_APPID.is_match(&s) {
            return Err("应用 ID 格式不正确".into());
        }
        c.insert("graph_client_id".into(), json!(s));
    }
    if let Some(v) = b.get("tempmail_name").filter(|v| !v.is_null()) {
        let s = js_string(v);
        if !RE_TMPNAME.is_match(&s) {
            return Err("邮箱名格式不正确".into());
        }
        c.insert("tempmail_name".into(), json!(s));
    }
    if let Some(v) = b.get("mail_provider").filter(|v| !v.is_null()) {
        let s = js_string(v);
        if s != "tempmail" && s != "graph" {
            return Err("邮箱类型无效".into());
        }
        c.insert("mail_provider".into(), json!(s));
    }
    if let Some(v) = b.get("tempmail_api").filter(|v| !v.is_null() && v.as_str() != Some("")) {
        let u = url::Url::parse(&js_string(v)).map_err(|_| "接口地址不正确".to_string())?;
        if u.scheme() != "https" {
            return Err("接口地址需为 https".into());
        }
        c.insert("tempmail_api".into(), json!(u.origin().ascii_serialization()));
    }
    let jt = js_str(b.g("tempmail_admin")).trim().to_string();
    let admin: String = jt.chars().take(128).collect();
    if let Value::Array(a) = b.g("mail_subject_keywords") {
        let kw: Vec<Value> = a.iter().map(js_string).filter(|s| !s.is_empty()).take(8).map(|s| json!(s.chars().take(40).collect::<String>())).collect();
        c.insert("mail_subject_keywords".into(), Value::Array(kw));
    }
    let raw = read_obj(WS_CFG);
    c.shift_remove("tempmail_address");
    c.shift_remove("has_tempmail_admin");
    let mut keep = c;
    keep.insert("tempmail_admin".into(), json!(if !admin.is_empty() { admin.clone() } else { js_str(raw.g("tempmail_admin")) }));
    keep.insert("tempmail_jwt".into(), json!(if !admin.is_empty() { String::new() } else { js_str(raw.g("tempmail_jwt")) }));
    if keep.s("mail_provider") == "tempmail" && !truthy(keep.g("recovery_email")) {
        let a = jwt_address(keep.s("tempmail_jwt"));
        keep.insert("recovery_email".into(), json!(a));
    }
    write_secure(WS_CFG, &js_bytes(&Value::Object(keep)), Some(1000)).map_err(|e| e.to_string())?;
    Ok(ws_config())
}
// ---------------- login proxy (independent of the worker egress; password never returned) ----------------
fn proxy_raw() -> Option<Map<String, Value>> {
    read_json(PROXY_FILE).ok().and_then(|v| v.as_object().cloned())
}
fn legacy_up() -> String {
    std::fs::read_to_string(LEGACY_UP).ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("UPSTREAM=")).map(|l| l[9..].trim().to_string()))
        .unwrap_or_default()
}
pub fn proxy_view() -> Value {
    match proxy_raw().filter(|p| truthy(p.g("host"))) {
        None => json!({"enabled":false,"source":if legacy_up().is_empty() { "none" } else { "default" }}),
        Some(p) => json!({"enabled":p.get("enabled") != Some(&Value::Bool(false)),"type":p.g("type"),"host":p.g("host"),"port":p.g("port"),
            "username":js_str(p.g("username")),"hasPassword":truthy(p.g("password"))}),
    }
}
pub fn proxy_save(b: &Value) -> Result<Value, String> {
    if b.get("clear") == Some(&Value::Bool(true)) {
        if !crate::state::READ_ONLY.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = std::fs::remove_file(PROXY_FILE);
        }
        return Ok(proxy_view());
    }
    let old = proxy_raw().unwrap_or_default();
    let typ = match b.s("type") {
        "http" => "http",
        _ => "socks5",
    };
    let host = js_str(b.g("host")).trim().to_string();
    let port = as_num(b.g("port")).or_else(|| b.s("port").parse().ok()).unwrap_or(0.0);
    if !RE_HOST.is_match(&host) || port.fract() != 0.0 || !(1.0..=65535.0).contains(&port) {
        return Err("代理地址或端口不正确".into());
    }
    let username: String = js_str(b.g("username")).chars().take(128).collect();
    let password: String = match b.get("password").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        Some(p) => p.chars().take(256).collect(),
        None if username == old.s("username") => js_str(old.g("password")),
        None => String::new(),
    };
    let v = json!({"type":typ,"host":host,"port":port as i64,"username":username,"password":password,"enabled":b.get("enabled") != Some(&Value::Bool(false))});
    write_secure(PROXY_FILE, &js_bytes(&v), None).map_err(|e| e.to_string())?;
    Ok(proxy_view())
}
/// upstream URL for login browsers: configured proxy | legacy env | direct ("")
pub fn upstream_for() -> String {
    if let Some(p) = proxy_raw().filter(|p| truthy(p.g("host"))) {
        if p.get("enabled") == Some(&Value::Bool(false)) {
            return String::new();
        }
        let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>().replace('+', "%20");
        let auth = if truthy(p.g("username")) { format!("{}:{}@", enc(p.s("username")), enc(&js_str(p.g("password")))) } else { String::new() };
        return format!("{}://{}{}:{}", js_str(p.g("type")), auth, js_str(p.g("host")), js_string(p.g("port")));
    }
    legacy_up()
}

// ---------------- auto-registered accounts (email -> password, totp) ----------------
/// Gmail accounts are never logged in automatically (no stored password/TOTP; repeated attempts trigger risk control)
pub fn no_auto_login(email: &str) -> bool {
    let e = email.trim().to_lowercase();
    e.ends_with("@gmail.com") || e.ends_with("@googlemail.com")
}
pub fn registered() -> HashMap<String, (String, Option<String>)> {
    let secrets = read_obj(&format!("{}/secrets.json", WS_DATA));
    let rows = std::fs::read_to_string(format!("{}/output/accounts.tsv", WS_DATA)).unwrap_or_default();
    let mut out = HashMap::new();
    for l in rows.split('\n') {
        if l.trim().is_empty() || l.starts_with('#') {
            continue;
        }
        let f: Vec<&str> = l.split('\t').collect();
        let email = f.first().map(|s| s.trim().to_lowercase()).unwrap_or_default();
        let password = f.get(1).copied().unwrap_or("").to_string();
        if !email.contains('@') || password.is_empty() {
            continue;
        }
        let s = secrets.get(&email).cloned().or_else(|| secrets.values().find(|v| v.s("label").to_lowercase() == email).cloned());
        let totp = s.filter(|s| {
            truthy(s.g("secret"))
                && (s.g("algo").is_null() || s.s("algo") == "sha1")
                && (s.g("digits").is_null() || as_num(s.g("digits")) == Some(6.0))
                && (s.g("period").is_null() || as_num(s.g("period")) == Some(30.0))
        }).map(|s| js_str(s.g("secret")));
        out.insert(email, (password, totp));
    }
    out
}