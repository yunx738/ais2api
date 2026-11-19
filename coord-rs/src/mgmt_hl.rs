// Bridge endpoints on the management server (8893) for upstream AIStudio2API features:
// live active requests & cancel, WAA 4-phase ledger records & request/response body drawer,
// account exit IP geo/timezone grouping, Gemini 4 periodic table catalog specs,
// headless runtime config switches, and in-console streaming Playground (via 8890).
// Credentials (PROXY_API_KEY, proxy passwords, console API keys) never leave the server.
use crate::mgmt::{Out, Rq};
use crate::resp::{OutBody, Resp};
use crate::util::*;
use bytes::Bytes;
use chrono::{SecondsFormat, TimeZone, Utc};
use http_body_util::{BodyExt, Full};
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use hyper_util::rt::TokioExecutor;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::time::Duration;

static HLC: Lazy<Client<HttpConnector, Full<Bytes>>> = Lazy::new(|| {
    let mut c = HttpConnector::new();
    c.set_connect_timeout(Some(Duration::from_secs(5)));
    c.set_nodelay(true);
    Client::builder(TokioExecutor::new()).pool_max_idle_per_host(0).build(c)
});

static RE_SAFE_ID: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9._:-]{1,120}$").unwrap());
static RE_PROXY_CRED: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^([a-z0-9]+://)([^/@:]+):([^/@]+)@(.+)$").unwrap());

fn hl_base_and_key() -> Option<(String, String)> {
    let dir = std::env::var("HEADLESS_DIR").unwrap_or_else(|_| "/opt/as2a-nb".into());
    let env = std::fs::read_to_string(format!("{}/.env", dir)).ok()?;
    let mut key = String::new();
    for l in env.lines() {
        if let Some(v) = l.strip_prefix("PROXY_API_KEY=") {
            key = v.trim().split(',').next().unwrap_or("").trim().to_string();
        }
    }
    if key.is_empty() {
        return None;
    }
    let addr = std::env::var("HEADLESS_ADDR").unwrap_or_else(|_| "127.0.0.1:2048".into());
    Some((format!("http://{}", addr), key))
}

fn coord_public_key() -> Option<String> {
    let root = std::env::var("DUAL_ROOT").unwrap_or_else(|_| "/opt/ais2api/dual-runtime".into());
    let auth = read_json(&format!("{}/console-auth.json", root)).ok()?;
    for k in auth.a("keys") {
        if !k.b("disabled") {
            let s = k.s("key").trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

async fn hl_req(method: &str, path: &str, body: Option<&Value>, timeout_secs: u64) -> (u16, Value) {
    let Some((base, key)) = hl_base_and_key() else {
        return (503, json!({"error": "无浏览器服务密钥未配置"}));
    };
    let payload = body.map(js_bytes).unwrap_or_default();
    let Ok(req) = hyper::Request::builder()
        .method(method)
        .uri(format!("{}{}", base, path))
        .header("Authorization", format!("Bearer {}", key))
        .header("Content-Type", "application/json")
        .body(Full::new(Bytes::from(payload)))
    else {
        return (500, json!({"error": "请求构造失败"}));
    };
    let run = async {
        let r = HLC.request(req).await.ok()?;
        let s = r.status().as_u16();
        let mut b = r.into_body();
        let mut out = Vec::new();
        while let Some(f) = b.frame().await {
            if let Ok(d) = f.ok()?.into_data() {
                out.extend_from_slice(&d);
                if out.len() > (16 << 20) {
                    return None;
                }
            }
        }
        if out.is_empty() {
            return Some((s, json!({"ok": s < 300})));
        }
        let v = serde_json::from_slice::<Value>(&out).unwrap_or_else(|_| json!({"raw": String::from_utf8_lossy(&out)}));
        Some((s, v))
    };
    tokio::time::timeout(Duration::from_secs(timeout_secs), run)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| (503, json!({"error": "无浏览器服务暂不可达"})))
}

fn mask_proxy(p: &str) -> String {
    if p.is_empty() {
        return "直连".into();
    }
    if let Some(c) = RE_PROXY_CRED.captures(p) {
        return format!("{}{}:*** @{}", &c[1], &c[2], &c[4]).replace(" @", "@");
    }
    p.to_string()
}

fn clean_config(v: &Value) -> Value {
    let Some(o) = v.as_object() else { return json!({}) };
    let keep = [
        "request_body_log",
        "strip_thought_signatures",
        "search_model_aliases",
        "discover_hidden_models",
        "google_search",
        "youtube_links",
        "nonstream_keepalive",
        "fake_stream",
        "continuation_rewrite",
        "warm_worker_limit",
        "max_active_workers",
        "per_account_concurrency",
        "max_account_switches",
        "waa_backend",
        "request_timeout",
        "routing_strategy",
    ];
    let mut m = Map::new();
    for k in keep {
        if let Some(val) = o.get(k) {
            m.insert(k.into(), val.clone());
        }
    }
    Value::Object(m)
}

/// GET /api/hl/live -> { requests, cooldowns, exits, accounts, catalog, config }
pub async fn get_live() -> Out {
    let (r_req, r_cd, r_ex, r_acc, r_mod, r_cfg) = tokio::join!(
        hl_req("GET", "/api/requests", None, 8),
        hl_req("GET", "/api/cooldowns", None, 8),
        hl_req("GET", "/api/accounts/exits", None, 10),
        hl_req("GET", "/api/accounts", None, 8),
        hl_req("GET", "/api/models", None, 8),
        hl_req("GET", "/api/config", None, 8),
    );
    let exits: Vec<Value> = r_ex.1.a("exits").iter().map(|e| {
        let mut m = e.as_object().cloned().unwrap_or_default();
        let px = e.s("proxy");
        m.insert("proxy".into(), json!(mask_proxy(px)));
        Value::Object(m)
    }).collect();

    // Map accounts with masked proxy + email/label/tier/state/models count so exit grouping can link accounts
    let acc_raw = if r_acc.1.is_array() { r_acc.1.as_array().cloned().unwrap_or_default() } else { r_acc.1.a("accounts").to_vec() };
    let accounts: Vec<Value> = acc_raw.iter().map(|a| {
        let models_n = a.get("models").and_then(|x| x.as_array().map(|v| v.len() as i64).or_else(|| x.as_i64())).unwrap_or(0);
        json!({
            "id": a.s("id"),
            "label": a.s("label"),
            "state": a.s("state"),
            "enabled": a.get("enabled") != Some(&Value::Bool(false)),
            "tier": a.s("benefit_tier"),
            "proxy": mask_proxy(a.s("effective_proxy")),
            "locale": a.s("locale"),
            "timezone": a.s("timezone"),
            "models": models_n,
            "reason": a.s("reason"),
        })
    }).collect();

    let mod_raw = if r_mod.1.is_array() { r_mod.1.as_array().cloned().unwrap_or_default() } else { r_mod.1.a("models").to_vec() };
    let catalog: Vec<Value> = mod_raw.into_iter().filter(|m| {
        let id = m.s("id");
        !id.is_empty() && !id.contains("-build")
    }).collect();

    Out::json(200, &json!({
        "ok": r_req.0 == 200 || r_mod.0 == 200,
        "requests": r_req.1.get("requests").cloned().unwrap_or_else(|| json!([])),
        "cooldowns": r_cd.1.get("cooldowns").cloned().unwrap_or_else(|| json!([])),
        "exits": exits,
        "accounts": accounts,
        "catalog": catalog,
        "config": clean_config(&r_cfg.1),
    }))
}

fn rfc3339_ms(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// GET /api/hl/records?range=today|1h|6h|7d|30d&model=...&status=...&limit=...
pub async fn get_records(rq: &Rq) -> Out {
    let now = now_ms();
    let range = rq.query.iter().find(|(k, _)| k == "range").map(|(_, v)| v.as_str()).unwrap_or("today");
    let from_ms = match range {
        "1h" => now - 3_600_000,
        "6h" => now - 6 * 3_600_000,
        "7d" => now - 7 * 86_400_000,
        "30d" => now - 30 * 86_400_000,
        _ => now - 24 * 3_600_000,
    };
    let limit: usize = rq.query.iter().find(|(k, _)| k == "limit").and_then(|(_, v)| v.parse().ok()).unwrap_or(80).clamp(1, 200);
    let qstr = {
        let mut qs = url::form_urlencoded::Serializer::new(String::new());
        qs.append_pair("from", &rfc3339_ms(from_ms));
        qs.append_pair("to", &rfc3339_ms(now + 60_000));
        qs.append_pair("limit", &limit.to_string());
        for key in ["model", "account", "channel", "status"] {
            if let Some((_, v)) = rq.query.iter().find(|(k, _)| k == key) {
                let t = v.trim();
                if !t.is_empty() && t.len() <= 200 {
                    qs.append_pair(key, t);
                }
            }
        }
        qs.finish()
    };
    let (s, v) = hl_req("GET", &format!("/api/usage/records?{}", qstr), None, 12).await;
    Out::json(s, &v)
}

/// GET /api/hl/request-body?id=...
pub async fn get_request_body(rq: &Rq) -> Out {
    let id = rq.query.iter().find(|(k, _)| k == "id").map(|(_, v)| v.trim()).unwrap_or("");
    if !RE_SAFE_ID.is_match(id) {
        return Out::json(400, &json!({"error": "请求 ID 无效"}));
    }
    let (s, v) = hl_req("GET", &format!("/api/requests/{}/body", id), None, 10).await;
    Out::json(s, &v)
}

/// POST /api/hl/cancel-request { id }
pub async fn post_cancel_request(b: &Value) -> Out {
    let id = b.s("id").trim();
    if !RE_SAFE_ID.is_match(id) {
        return Out::json(400, &json!({"error": "请求 ID 无效"}));
    }
    let (s, v) = hl_req("POST", &format!("/api/requests/{}/cancel", id), Some(&json!({})), 10).await;
    if s < 300 {
        Out::json(200, &json!({"ok": true, "id": id}))
    } else {
        Out::json(s, &v)
    }
}

/// POST /api/hl/config { patch: { strip_thought_signatures, request_body_log, ... } }
pub async fn post_config(b: &Value) -> Out {
    let Some(patch) = b.get("patch").and_then(|x| x.as_object()) else {
        return Out::json(400, &json!({"error": "缺少 patch 对象"}));
    };
    let allowed = [
        "strip_thought_signatures",
        "request_body_log",
        "search_model_aliases",
        "discover_hidden_models",
        "google_search",
        "youtube_links",
        "nonstream_keepalive",
        "fake_stream",
        "continuation_rewrite",
    ];
    let restart_keys = ["strip_thought_signatures", "request_body_log", "discover_hidden_models", "youtube_links", "continuation_rewrite"];
    let mut needs_restart = false;
    let (s, mut current) = hl_req("GET", "/api/config", None, 10).await;
    if s != 200 || !current.is_object() {
        return Out::json(503, &json!({"error": "读取当前引擎配置失败"}));
    }
    {
        let obj = current.as_object_mut().unwrap();
        // handleUpdateRuntimeConfig expects admin_password empty to keep current password
        obj.insert("admin_password".into(), json!(""));
        for (k, val) in patch {
            if !allowed.contains(&k.as_str()) || !val.is_boolean() {
                return Out::json(400, &json!({"error": format!("不允许修改字段 {}", k)}));
            }
            if obj.get(k) != Some(val) && restart_keys.contains(&k.as_str()) {
                needs_restart = true;
            }
            obj.insert(k.clone(), val.clone());
        }
    }
    let (ps, pv) = hl_req("PUT", "/api/config", Some(&current), 12).await;
    if ps >= 300 {
        return Out::json(ps, &pv);
    }
    Out::json(200, &json!({
        "saved": true,
        "needsRestart": needs_restart,
        "config": clean_config(&pv),
    }))
}

/// POST /api/hl/playground -> streams SSE from 127.0.0.1:8890/v1/chat/completions
pub async fn post_playground(b: &Value) -> Out {
    let model = b.s("model").trim().to_string();
    if model.is_empty() || model.len() > 200 {
        return Out::json(400, &json!({"error": "请选择模型"}));
    }
    // Hard safety constraint: never send requests to any -build model
    if model.to_lowercase().contains("-build") {
        return Out::json(403, &json!({"error": "-build 模型已封存，禁止调用"}));
    }
    let Some(msgs) = b.get("messages").and_then(|m| m.as_array()).filter(|a| !a.is_empty() && a.len() <= 200) else {
        return Out::json(400, &json!({"error": "消息列表为空"}));
    };
    let Some(pub_key) = coord_public_key() else {
        return Out::json(503, &json!({"error": "未找到可用的公开 API Key，请先在设置页创建一把启用的 Key"}));
    };
    let stream = b.get("stream") != Some(&Value::Bool(false));
    let mut payload = Map::new();
    payload.insert("model".into(), json!(model));
    payload.insert("messages".into(), Value::Array(msgs.clone()));
    payload.insert("stream".into(), json!(stream));
    if stream {
        payload.insert("stream_options".into(), json!({"include_usage": true}));
    }
    for k in ["temperature", "top_p", "max_tokens", "reasoning_effort", "tools", "stop"] {
        if let Some(v) = b.get(k) {
            if !v.is_null() {
                payload.insert(k.into(), v.clone());
            }
        }
    }
    let coord = std::env::var("COORD_URL").ok().filter(|u| u.starts_with("http://127.0.0.1:")).unwrap_or_else(|| "http://127.0.0.1:8890".into());
    let Ok(req) = hyper::Request::builder()
        .method("POST")
        .uri(format!("{}/v1/chat/completions", coord))
        .header("Authorization", format!("Bearer {}", pub_key))
        .header("Content-Type", "application/json")
        .body(Full::new(Bytes::from(js_bytes(&Value::Object(payload)))))
    else {
        return Out::json(500, &json!({"error": "构造试用请求失败"}));
    };

    if !stream {
        let run = async {
            let r = HLC.request(req).await.ok()?;
            let s = r.status().as_u16();
            let mut body = r.into_body();
            let mut out = Vec::new();
            while let Some(f) = body.frame().await {
                if let Ok(d) = f.ok()?.into_data() {
                    out.extend_from_slice(&d);
                    if out.len() > (16 << 20) { return None; }
                }
            }
            Some((s, Bytes::from(out)))
        };
        return match tokio::time::timeout(Duration::from_secs(300), run).await.ok().flatten() {
            Some((s, bytes)) => Out::raw(s, "application/json; charset=utf-8", bytes),
            None => Out::json(504, &json!({"error": "试用请求超时或连接失败"})),
        };
    }

    let (resp, hrx) = Resp::new();
    let resp_task = resp.clone();
    tokio::spawn(async move {
        let res = tokio::select! {
            r = HLC.request(req) => r,
            _ = resp_task.cancel.wait() => return,
        };
        let Ok(up) = res else {
            resp_task.set_status(502);
            resp_task.set_header("Content-Type", "application/json; charset=utf-8");
            resp_task.end(&js_bytes(&json!({"error": {"message": "连接本地 8890 调度器失败"}})));
            return;
        };
        let status = up.status().as_u16();
        let ctype = up.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("text/event-stream; charset=utf-8").to_string();
        resp_task.set_status(status);
        resp_task.set_header("Content-Type", &ctype);
        resp_task.set_header("Cache-Control", "no-cache");
        resp_task.set_header("X-Accel-Buffering", "no");
        let mut body = up.into_body();
        // Force header flush immediately for SSE
        let _ = resp_task.write(b"");
        loop {
            let frame = tokio::select! {
                f = body.frame() => f,
                _ = resp_task.cancel.wait() => break,
            };
            let Some(Ok(fr)) = frame else { break };
            if let Ok(data) = fr.into_data() {
                if !data.is_empty() && !resp_task.write(&data) {
                    break;
                }
            }
        }
        resp_task.end(b"");
    });

    match tokio::time::timeout(Duration::from_secs(120), hrx).await {
        Ok(Ok(head)) => Out::streaming(head.status, head.headers, OutBody::stream(head.rx, resp)),
        _ => {
            resp.cancel.cancel();
            Out::json(504, &json!({"error": "等待调度器响应头超时"}))
        }
    }
}
