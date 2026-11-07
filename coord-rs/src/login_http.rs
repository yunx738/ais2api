// Login service HTTP API (login-service.js routes). Framework-free: handle() maps a request to (status, json),
// so the same code serves the standalone 8894 listener and in-process calls from the management backend.
use crate::login_acc::{already_imported, email_of, mem_ok};
use crate::login_jobs::{busy, cancel, find_target, get, send_input, start_job, ws_cancel, ws_job, Opts};
use crate::login_nightly as nightly;
use crate::login_store::cred_get;
use crate::login_ws::{proxy_save, proxy_view, registered, ws_config, ws_save_config, WS_DATA};
use crate::util::*;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};
static RE_EMAIL: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^[^\s@]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$").unwrap());
static RE_WS: Lazy<Regex> = Lazy::new(|| Regex::new(r"^/ws/([0-9a-f-]{36})(/cancel)?$").unwrap());
static RE_LOGIN: Lazy<Regex> = Lazy::new(|| Regex::new(r"^/login/([0-9a-f-]{36})(/(input|cancel))?$").unwrap());
static RE_MAILID: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9=_+/-]{1,300}$").unwrap());
pub const BODY_MAX: usize = 8192;
/// service key: coordinator.json apiKeys[0]
pub static KEY: Lazy<String> = Lazy::new(|| {
    read_json("/opt/ais2api/dual-runtime/coordinator.json").ok().and_then(|c| c.g("apiKeys").as_array().and_then(|a| a.first()).map(js_str)).unwrap_or_default()
});
fn eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
fn err(code: u16, m: &str) -> (u16, Value) {
    (code, json!({"error":m}))
}
fn view(j: &crate::login_jobs::JobRef) -> Value {
    j.lock().unwrap().view()
}
fn wsv(j: &crate::login_jobs::JobRef) -> Value {
    j.lock().unwrap().ws_view()
}
/// auth: the Authorization header value; body: raw request body (None = too large / unreadable)
pub async fn handle(method: &str, path: &str, auth: &str, body: Option<&[u8]>) -> (u16, Value) {
    let ok = auth.strip_prefix("Bearer ").map_or(false, |k| !KEY.is_empty() && eq(k, &KEY));
    if !ok {
        return err(401, "Unauthorized");
    }
    let b: Value = match body {
        None => return err(400, "请求无效"),
        Some(x) if x.iter().all(|c| c.is_ascii_whitespace()) => json!({}),
        Some(x) => match serde_json::from_slice(x) {
            Ok(v) => v,
            Err(_) => return err(400, "请求无效"),
        },
    };
    let post = method == "POST";
    match (method, path) {
        ("GET", "/login/nightly") => return (200, nightly::status()),
        ("POST", "/login/nightly/retry") => return match nightly::retry(b.g("id")) {
            Ok(v) => (200, v),
            Err(e) => err(409, &e),
        },
        ("POST", "/login/relogin") => return relogin(&b),
        ("POST", "/login/start") => {
            let email = js_str(b.g("email")).trim().to_lowercase();
            let pw = js_str(b.g("password"));
            if !RE_EMAIL.is_match(&email) || pw.is_empty() || pw.encode_utf16().count() > 256 {
                return err(400, "邮箱或密码格式不正确");
            }
            let dup = already_imported(&email);
            if dup > 0 {
                return err(409, &format!("该邮箱已在账号池中（账号 {}）", dup));
            }
            if busy() {
                return err(409, "已有登录在进行，请稍候");
            }
            if !mem_ok() {
                return err(503, "服务器内存不足，暂不能登录");
            }
            let o = Opts { remember: b.g("remember") == &Value::Bool(true), tier: js_str(b.g("tier")), alias: js_str(b.g("alias")), ..Default::default() };
            return (202, view(&start_job(&email, pw, o)));
        }
        ("GET", "/ws/config") => {
            let tok = std::path::Path::new(&format!("{}/mailbox-token.json", WS_DATA)).exists();
            return (200, json!({"config":Value::Object(ws_config()),"mailAuthorized":tok,"proxy":proxy_view(),"busy":busy()}));
        }
        ("POST", "/ws/config") => return match ws_save_config(&b) {
            Ok(c) => (200, json!({"config":Value::Object(c)})),
            Err(e) => err(400, &e),
        },
        ("POST", "/login-proxy") => return match proxy_save(&b) {
            Ok(p) => (200, json!({"proxy":p})),
            Err(e) => err(400, &e),
        },
        ("POST", "/ws/start") => return ws_start(&b),
        _ => {}
    }
    if let Some(c) = RE_WS.captures(path) {
        let j = get(&c[1]).filter(|j| !j.lock().unwrap().kind.is_empty());
        if let Some(j) = j {
            if method == "GET" && c.get(2).is_none() {
                return (200, wsv(&j));
            }
            if post && c.get(2).is_some() {
                ws_cancel(&j);
                return (200, wsv(&j));
            }
        } else {
            return err(404, "任务不存在或已过期");
        }
    }
    let Some(c) = RE_LOGIN.captures(path) else { return err(404, "Not found") };
    let Some(job) = get(&c[1]) else { return err(404, "登录任务不存在或已过期") };
    let act = c.get(3).map(|m| m.as_str());
    match (method, act) {
        ("GET", None) => (200, view(&job)),
        ("POST", Some("input")) => {
            let v = js_str(b.g("value")).trim().to_string();
            {
                let j = job.lock().unwrap();
                if j.status != "need" || j.stdin.is_none() {
                    return err(409, "当前不需要输入");
                }
            }
            if v.is_empty() || v.encode_utf16().count() > 64 {
                return err(400, "输入无效");
            }
            match send_input(&job, &v).await {
                Ok(()) => (200, view(&job)),
                Err(e) => err(409, e),
            }
        }
        ("POST", Some("cancel")) => {
            cancel(&job);
            (200, view(&job))
        }
        _ => err(405, "Method not allowed"),
    }
}
/// immediate re-login of one account (the coordinator calls this when an account turns out logged out)
fn relogin(b: &Value) -> (u16, Value) {
    let Some(id) = as_safe_int(b.g("id")).filter(|i| *i >= 1) else { return err(400, "账号编号无效") };
    let slot = match b.s("slot") {
        s @ ("A" | "B") => s.to_string(),
        _ => String::new(),
    };
    if let Some(cur) = find_target(id) {
        return (202, view(&cur));
    }
    if busy() {
        return err(409, "已有登录在进行，请稍候");
    }
    let email = email_of(id).to_lowercase();
    if !email.contains('@') {
        return err(409, "该账号没有登录邮箱，无法自动登录");
    }
    let (mut pw, totp) = registered().get(&email).cloned().map(|(p, t)| (Some(p), t)).unwrap_or((None, None));
    if pw.as_deref().map_or(true, |p| p.is_empty()) {
        pw = match cred_get(id) {
            Ok(Some((e, p))) if e.to_lowercase() == email => Some(p),
            _ => None,
        };
    }
    let Some(pw) = pw.filter(|p| !p.is_empty()) else { return err(409, "没有该账号的登录密码，无法自动登录") };
    log(format!("[Relogin] #{} immediate re-login requested{}", id, if slot.is_empty() { String::new() } else { format!(" on worker {} network", slot) }));
    (202, view(&start_job(&email, pw, Opts { target: id, auto: true, slot, totp, no_lease: true, ..Default::default() })))
}
fn ws_start(b: &Value) -> (u16, Value) {
    let c = ws_config();
    let kind = b.s("kind");
    let temp = c.s("mail_provider") == "tempmail";
    if kind == "mail-auth" && temp {
        return err(409, "临时邮箱无需授权");
    }
    let unset = if temp { !truthy(c.g("tempmail_address")) && !truthy(c.g("tempmail_name")) } else { !truthy(c.g("graph_client_id")) || !truthy(c.g("mailbox")) };
    if unset {
        return err(409, "请先完成收信邮箱设置");
    }
    if busy() {
        return err(409, "已有登录任务在进行，请稍候");
    }
    match kind {
        "mail-auth" => (202, wsv(&ws_job("mail-auth", vec!["mail-auth".into()], false, false))),
        "list" => (202, wsv(&ws_job("list", vec!["list".into()], false, false))),
        "run" => {
            let mid = js_str(b.g("mailId"));
            if !RE_MAILID.is_match(&mid) {
                return err(400, "邮件编号无效");
            }
            if !truthy(c.g("domain")) || !truthy(c.g("recovery_email")) {
                return err(409, "请先填写域名和辅助邮箱");
            }
            if !mem_ok() {
                return err(503, "服务器内存不足，暂不能登录");
            }
            (202, wsv(&ws_job("run", vec!["run".into(), mid], true, true)))
        }
        _ => err(400, "操作无效"),
    }
}
