// HTTP layer (http.go): auth, generation entry, internal API, ops API, console auth.
use crate::app::{ro, App};
use crate::build_ctx::build_models;
use crate::console::*;
use crate::history::parse_query;
use crate::resp::{OutBody, Resp, RespGuard};
use crate::sanitize::sanitize_request;
use crate::sched::{is_build_model, split_pin, Req, AT_PREFIX, SLOT};
use crate::svc::read_limited;
use crate::util::*;
use bytes::Bytes;
use hyper::body::Incoming;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub type Res = hyper::Response<OutBody>;

static SAN: Lazy<Mutex<(i64, i64, Value, Value)>> = Lazy::new(|| Mutex::new((0, 0, Value::Null, Value::Null)));
pub fn sanitize_stats() -> Value {
    let s = SAN.lock().unwrap();
    let mut o = json!({"repaired":s.0,"rejected":s.1,"lastRejected":s.2});
    if !s.3.is_null() {
        o["lastParams"] = s.3.clone();
    }
    o
}
fn write_json(code: u16, body: &Value) -> Res {
    hyper::Response::builder().status(code).header("Content-Type", "application/json").header("Cache-Control", "no-store")
        .body(OutBody::full(js_bytes(body))).unwrap()
}
fn err_body(msg: &str) -> Value {
    json!({"error":msg})
}
static RE_JSON_CT: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^application/json(?:\s*;|$)").unwrap());
static RE_NATIVE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^/v1beta/models/([^/:]+):(generateContent|streamGenerateContent)$").unwrap());
static RE_BUILD_PREFIX: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(build(-st)?|bridge|code)/").unwrap());

struct Ctx {
    method: String,
    path: String,
    query: Vec<(String, String)>,
    headers: hyper::HeaderMap,
    body: Option<Incoming>,
}
impl Ctx {
    fn q(&self, k: &str) -> String {
        self.query.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()).unwrap_or_default()
    }
    fn h(&self, k: &str) -> String {
        self.headers.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
    }
    fn ct_json(&self) -> bool {
        RE_JSON_CT.is_match(&self.h("content-type"))
    }
    async fn bytes(&mut self, max: usize) -> R<Bytes> {
        let Some(body) = self.body.take() else { return herr(400, "Invalid JSON body") };
        match read_limited(body, max, &crate::resp::Cancel::new()).await {
            Ok(b) => Ok(b),
            Err(e) if e == "reply too large" => herr(413, "Body too large"),
            Err(_) => herr(400, "Invalid JSON body"),
        }
    }
    async fn obj(&mut self, max: usize) -> R<Value> {
        let b = self.bytes(max).await?;
        match serde_json::from_slice::<Value>(&b) {
            Ok(v) if v.is_object() => Ok(v),
            Ok(_) => herr(400, "JSON object required"),
            Err(_) => herr(400, "Invalid JSON body"),
        }
    }
}

fn code_in(e: &HttpErr, codes: &[u16]) -> Option<u16> {
    codes.contains(&e.status).then_some(e.status)
}
fn status_or(e: &HttpErr, def: u16) -> u16 {
    if e.status == 0 { def } else { e.status }
}

impl App {
    pub async fn handle(self: Arc<Self>, req: hyper::Request<Incoming>) -> Res {
        let (parts, body) = req.into_parts();
        let query: Vec<(String, String)> = parts.uri.query().map(|q| url::form_urlencoded::parse(q.as_bytes()).into_owned().collect()).unwrap_or_default();
        let mut c = Ctx { method: parts.method.to_string(), path: parts.uri.path().to_string(), query, headers: parts.headers, body: Some(body) };
        let mut supplied = c.h("x-goog-api-key");
        if supplied.is_empty() {
            if let Some(b) = c.h("authorization").strip_prefix("Bearer ") {
                supplied = b.to_string();
            }
        }
        if supplied.is_empty() {
            supplied = c.h("x-api-key");
        }
        if supplied.is_empty() {
            supplied = c.q("key");
        }
        let internal = c.path.starts_with("/internal/");
        let ok = if internal { self.auth.is_internal(&supplied) } else { self.auth.allows(&supplied, true) };
        if supplied.is_empty() || !ok {
            return write_json(401, &err_body("Unauthorized"));
        }
        if c.method == "GET" && c.path == "/v1/models" {
            let mut ids = self.routing.list(&self);
            ids.extend(build_models());
            let data: Vec<Value> = ids.into_iter().map(|id| json!({"id":id,"object":"model","owned_by":"google"})).collect();
            return write_json(200, &json!({"object":"list","data":data}));
        }
        if internal {
            return match self.internal(&mut c).await {
                Ok(r) => r,
                Err(e) => write_json(status_or(&e, 503), &err_body(&e.msg)),
            };
        }
        let native = RE_NATIVE.captures(&c.path).map(|m| (m[1].to_string(), m[2].to_string()));
        if c.method != "POST" || (c.path != "/v1/chat/completions" && native.is_none()) {
            return write_json(404, &err_body("Endpoint unavailable"));
        }
        if !c.ct_json() {
            return write_json(415, &err_body("JSON required"));
        }
        self.generate(c, native).await
    }

    // ---------------- generation ----------------
    async fn generate(self: Arc<Self>, mut c: Ctx, native: Option<(String, String)>) -> Res {
        let body = match c.bytes(20 << 20).await {
            Ok(b) => b,
            Err(e) if e.status == 413 => return write_json(413, &err_body("Request too large")),
            Err(_) => return write_json(400, &err_body("Invalid JSON")),
        };
        let mut parsed = match serde_json::from_slice::<Value>(&body) {
            Ok(Value::Object(o)) => o,
            Ok(_) => return write_json(400, &err_body("JSON object required")),
            Err(_) => return write_json(400, &err_body("Invalid JSON")),
        };
        let route = c.path.clone();
        let is_native = native.is_some();
        let (model, stream, query) = if let Some((m, method)) = &native {
            if let Some(v) = parsed.get("model").filter(|v| !v.is_null()) {
                if js_str(v) != *m {
                    return write_json(400, &err_body("Invalid request model"));
                }
            }
            let mut q: Vec<(String, String)> = c.query.iter().filter(|(k, _)| k != "key").cloned().collect();
            q.sort_by(|a, b| a.0.cmp(&b.0));
            let qs = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(q.iter()).finish();
            (m.clone(), method == "streamGenerateContent", qs)
        } else {
            let Some(m) = parsed.get("model").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from) else {
                return write_json(400, &err_body("Invalid request model"));
            };
            let s = parsed.b("stream");
            (m, s, String::new())
        };
        let (base, mut pin, mut group) = split_pin(&model);
        let ha = c.h("x-ais-account");
        if !ha.trim().is_empty() && pin == 0 {
            pin = ha.trim().trim_start_matches('#').parse().unwrap_or(0);
        }
        let hg = c.h("x-ais-group");
        if !hg.trim().is_empty() && group.is_empty() && pin == 0 {
            group = hg.trim().to_string();
        }
        if pin < 0 {
            pin = 0;
        }
        if !is_native {
            parsed.insert("model".into(), json!(base));
        }
        // Build channel: tool fields -> __tools, response_format dropped; client internals never trusted
        if !is_native && RE_BUILD_PREFIX.is_match(&base) {
            for k in ["__tools", "__build", "__tcprobe"] {
                parsed.shift_remove(k);
            }
            let mut tools = Map::new();
            for k in crate::build_tools::FIELDS {
                if let Some(v) = parsed.shift_remove(k) {
                    tools.insert(k.into(), v);
                }
            }
            parsed.shift_remove("response_format");
            if !base.starts_with("bridge/") && (!tools.a("tools").is_empty() || !tools.a("functions").is_empty()) {
                parsed.insert("__tools".into(), Value::Object(tools));
            }
        }
        match sanitize_request(&route, &mut parsed) {
            Err(e) => {
                {
                    let mut s = SAN.lock().unwrap();
                    s.1 += 1;
                    s.2 = json!({"at":now_ms(),"reason":e});
                }
                elog(format!("[Gateway] rejected before upstream: {}", e));
                let msg = format!("请求未发送到上游，网关无法自动修复：{}", e);
                return if is_native {
                    write_json(400, &json!({"error":{"code":400,"status":"INVALID_ARGUMENT","message":msg}}))
                } else {
                    write_json(400, &json!({"error":{"message":msg,"type":"invalid_request_error","code":"gateway_unfixable_request"}}))
                };
            }
            Ok((_, notes)) if !notes.is_empty() => {
                {
                    let mut s = SAN.lock().unwrap();
                    s.0 += 1;
                    s.3 = json!({"at":now_ms(),"fixes":notes.iter().take(8).collect::<Vec<_>>()});
                }
                log(format!("[Gateway] params adjusted: {}", notes.join("; ")));
            }
            _ => {}
        }
        let up_body = Bytes::from(js_bytes(&Value::Object(parsed.clone())));
        // early stream: anti-truncation and Build answer only at the end; fake mode buffers on purpose
        let mut soft = String::new();
        if stream {
            let build_model = is_build_model(&base) && RE_BUILD_PREFIX.is_match(&base);
            let fake = self.stream.get() == "fake";
            if !is_native && (base.starts_with(AT_PREFIX) || build_model) {
                soft = "openai".into();
            } else if fake && !is_native {
                soft = "openai".into();
            } else if fake && is_native {
                soft = if c.q("alt") == "sse" { "gemini-sse".into() } else { "gemini-array".into() };
            }
        }
        let (res, head_rx) = Resp::new();
        let mut guard = RespGuard(res.clone(), false);
        let r = Req { route, body: up_body, res: res.clone(), pin, group, soft, model: base, parsed, query, native: is_native, stream };
        self.submit(r);
        let head = match head_rx.await {
            Ok(h) => h,
            Err(_) => {
                guard.1 = true;
                return hyper::Response::builder().status(499).body(OutBody::full(Bytes::new())).unwrap();
            }
        };
        guard.1 = true;
        let mut b = hyper::Response::builder().status(head.status);
        for (k, v) in &head.headers {
            b = b.header(k.as_str(), v.as_str());
        }
        b.body(OutBody::stream(head.rx, res)).unwrap()
    }

    fn with_pool_id(&self, b: &Value) -> R<i64> {
        let id = match b.g("id") {
            Value::String(s) => s.trim().parse::<f64>().ok(),
            v => as_num(v),
        };
        let ok = id.filter(|n| n.fract() == 0.0).map(|n| n as i64).filter(|&n| self.lock().core.in_pool(n));
        ok.ok_or_else(|| HttpErr::new(404, format!("账号 {} 不在账号池", js_str(b.g("id")))))
    }
    fn fail(e: HttpErr, keep: &[u16], fallback: &str) -> Res {
        match code_in(&e, keep) {
            Some(c) => write_json(c, &err_body(&e.msg)),
            None => write_json(503, &err_body(fallback)),
        }
    }

    // ---------------- internal API ----------------
    async fn internal(self: &Arc<Self>, c: &mut Ctx) -> R<Res> {
        let (path, m) = (c.path.clone(), c.method.clone());
        let p = path.as_str();
        let ok = |v: Value| Ok(write_json(200, &v));
        if m == "GET" && p == "/internal/coordinator-status" {
            return ok(self.status());
        }
        if m == "GET" && (p == "/internal/requests" || p == "/internal/usage") {
            let Ok(q) = parse_query(&c.query, p == "/internal/usage") else { return Ok(write_json(400, &err_body("Invalid analytics filters"))) };
            let out = if p == "/internal/requests" { self.hist.list(&q) } else { self.hist.summary(&q) };
            return match out {
                Ok(mut o) => {
                    o["recording"] = self.health.json(&self.hist);
                    ok(o)
                }
                Err(_) => Ok(write_json(503, &err_body("Analytics unavailable"))),
            };
        }
        if p.starts_with("/internal/console-auth") {
            return Ok(self.console_auth(c).await);
        }
        if p == "/internal/proxies" && m == "GET" {
            return ok(json!({"slots":[],"headless":true}));
        }
        if (p == "/internal/proxies" || p == "/internal/proxies/apply") && m == "POST" {
            if !c.ct_json() {
                return Ok(write_json(415, &err_body("JSON required")));
            }
            return Ok(write_json(503, &err_body("代理操作未确认，请重新读取状态")));
        }
        if m == "POST" && p == "/internal/models/policy" {
            let b = match c.obj(4096).await {
                Ok(b) => b,
                Err(e) => return Ok(write_json(status_or(&e, 400), &err_body(&e.msg))),
            };
            let rev = as_safe_int(b.g("revision"));
            let at = b.g("antiTruncation").as_bool();
            let model = b.g("model").as_str();
            if model.is_none() || rev.map(|r| r < 0).unwrap_or(true) || !["flash", "pro", "ultra"].contains(&b.s("quotaFamily")) || at.is_none() {
                return Ok(write_json(400, &err_body("Invalid model policy")));
            }
            let busy = {
                let st = self.lock();
                !st.queue.is_empty() || !st.executing.is_empty()
            };
            if busy {
                return Ok(write_json(409, &json!({"saved":false,"reason":"requests_or_operations_busy"})));
            }
            return match self.policies.set(model.unwrap(), b.s("quotaFamily"), at.unwrap(), rev.unwrap()) {
                Ok(snap) => {
                    let mut out = Map::new();
                    out.insert("saved".into(), json!(true));
                    if let Value::Object(s) = snap {
                        out.extend(s);
                    }
                    ok(Value::Object(out))
                }
                Err(e) if e.status == 409 => Ok(write_json(409, &err_body("Policy revision changed; refresh first"))),
                Err(_) => Ok(write_json(503, &err_body("Policy save not confirmed; refresh before retry"))),
            };
        }
        if m == "GET" && p == "/internal/models" {
            self.routing.refresh(self).await;
            let ms: Vec<Value> = self.routing.models().into_iter().map(|id| json!({"id":id,"methods":["generateContent"]})).collect();
            return ok(json!({"slots":{SLOT:{"account":null,"catalog":{"snapshot":{"models":ms}}}},"errors":{},"generationRoutingIntegrated":true,
                "configuredPolicies":self.policies.size(),"policyState":self.policies.snapshot()}));
        }
        if m == "GET" && p == "/internal/prices" {
            let mut s = self.prices.snapshot();
            s["models"] = json!(self.policies.sorted_ids());
            return ok(s);
        }
        if m == "POST" && p == "/internal/prices" {
            if !c.ct_json() {
                return Ok(write_json(415, &err_body("JSON required")));
            }
            let Ok(b) = c.obj(4096).await else { return Ok(write_json(400, &err_body("Invalid JSON body"))) };
            if self.policies.get(b.s("model")).is_none() {
                return Ok(write_json(400, &err_body("Invalid price configuration")));
            }
            return match self.prices.set(&b) {
                Ok(mut s) => {
                    s["models"] = json!(self.policies.sorted_ids());
                    ok(s)
                }
                Err(e) if e.status == 409 => Ok(write_json(409, &err_body("Price revision changed; refresh first"))),
                Err(e) if e.status == 400 => Ok(write_json(400, &err_body("Invalid price configuration"))),
                Err(_) => Ok(write_json(503, &err_body("Price save not confirmed; refresh before retry"))),
            };
        }
        if m == "POST" && p == "/internal/models/refresh" {
            let b = c.obj(4096).await.unwrap_or(Value::Null);
            if !["A", "B", "H"].contains(&b.s("slot")) {
                return Ok(write_json(400, &err_body("Invalid slot")));
            }
            self.routing.refresh(self).await;
            return Ok(write_json(202, &json!({"accepted":true,"models":self.routing.size()})));
        }
        if m == "POST" && p == "/internal/set-mode" {
            let b = c.obj(4096).await.unwrap_or(Value::Null);
            let mode = b.s("mode").to_string();
            if !["fake", "real"].contains(&mode.as_str()) {
                return Ok(write_json(400, &err_body("Invalid mode")));
            }
            if self.stream.set(&mode).is_err() {
                return Ok(write_json(503, &err_body("保存未确认")));
            }
            log(format!("[Coordinator] streaming mode -> {}", mode));
            return ok(json!({"mode":mode,"results":{SLOT:{"mode":mode,"applied":true}}}));
        }
        if m == "POST" && p == "/internal/rotate" {
            if !c.ct_json() {
                return Ok(write_json(415, &err_body("JSON required")));
            }
            return Ok(write_json(409, &json!({"started":[],"skipped":[{"slot":SLOT,"reason":"无浏览器模式下所有账号同时可用，无需切换"}]})));
        }
        if m == "POST" && p == "/internal/restart" {
            let b = c.obj(4096).await.unwrap_or(Value::Null);
            if !["A", "B", "H"].contains(&b.s("slot")) {
                return Ok(write_json(400, &err_body("Invalid slot")));
            }
            if ro() {
                return Ok(write_json(409, &json!({"started":[],"skipped":[{"slot":SLOT,"reason":"readonly"}]})));
            }
            return match self.svc.reload().await {
                Err(e) => Ok(write_json(409, &json!({"started":[],"skipped":[{"slot":SLOT,"reason":e}]}))),
                Ok(_) => Ok(write_json(202, &json!({"started":[SLOT],"skipped":[]}))),
            };
        }
        if m == "POST" && p == "/internal/accounts/delete" {
            if !c.ct_json() {
                return Ok(write_json(415, &err_body("JSON required")));
            }
            return Ok(match async {
                let b = c.obj(4096).await?;
                let id = as_safe_int(b.g("id")).unwrap_or(0);
                // delete the account's Google Build projects while its login still works (best effort, bounded)
                if id > 0 && b.s("confirm") == format!("DELETE {}", id) && !ro() {
                    let email = self.acc.email(id);
                    let projects = self.rotation.projects_of(self, id);
                    if !email.is_empty() && !projects.is_empty() {
                        let n = tokio::time::timeout(Duration::from_secs(30), crate::build_chan::Rotation::delete_projects(self, &email, &projects)).await.unwrap_or(0);
                        log(format!("[Accounts] #{} Build projects deleted {}/{}", id, n, projects.len()));
                    }
                }
                self.delete_account(&b)
            }.await {
                Ok(v) => write_json(200, &v),
                Err(e) => Self::fail(e, &[400, 404, 409, 413], "删除未确认，请刷新状态后核对"),
            });
        }
        if p == "/internal/accounts/verify" {
            if m == "GET" {
                let id: i64 = c.q("id").parse().unwrap_or(0);
                let f = self.lock().core.flag(id).map(|f| json!(f.s("status"))).unwrap_or(Value::Null);
                return ok(json!({"job":null,"flag":f}));
            }
            if m == "POST" {
                let b = match c.obj(4096).await {
                    Ok(b) => b,
                    Err(e) => return Ok(write_json(status_or(&e, 503), &err_body(&e.msg))),
                };
                let id = as_safe_int(b.g("id")).unwrap_or(0);
                let r = if self.importer.has(&self.acc, id) { "ok" } else { "not_imported" };
                return Ok(write_json(202, &json!({"id":id,"state":"done","result":r})));
            }
        }
        if m == "POST" && p == "/internal/accounts/revalidate" {
            return Ok(match async { let b = c.obj(4096).await?; self.revalidate(&b) }.await {
                Ok(v) => write_json(200, &v),
                Err(e) => Self::fail(e, &[400, 409], "恢复未确认"),
            });
        }
        if m == "GET" && p == "/internal/client-script" {
            return Ok(match std::fs::read(format!("{}/refactor/black-browser.js", self.root)) {
                Err(_) => write_json(503, &err_body("脚本不可用")),
                Ok(b) => hyper::Response::builder().status(200).header("Content-Type", "text/plain; charset=utf-8").header("Cache-Control", "no-store").body(OutBody::full(b)).unwrap(),
            });
        }
        if p == "/internal/target-app" {
            if m == "GET" {
                return ok(json!({"headless":true}));
            }
            if m == "POST" {
                return Ok(write_json(409, &err_body("无浏览器模式下没有实例，此操作不可用")));
            }
        }
        if m == "GET" && p == "/internal/build-status" {
            let mut s = self.build.status(self);
            s["appletRotation"] = self.rotation.status();
            return ok(s);
        }
        if p == "/internal/build/settings" {
            if m == "GET" {
                return ok(self.build.settings_status());
            }
            return Ok(match async { let b = c.obj(4096).await?; self.build.set_settings(&b) }.await {
                Ok(v) => write_json(200, &v),
                Err(e) => write_json(status_or(&e, 500), &err_body(&e.msg)),
            });
        }
        if p == "/internal/build/document" {
            if m == "GET" {
                return ok(self.build.doc.status());
            }
            return Ok(match async { let b = c.obj(4096).await?; self.build.doc.set(&b) }.await {
                Ok(v) => write_json(200, &v),
                Err(e) => write_json(status_or(&e, 500), &err_body(&e.msg)),
            });
        }
        if p == "/internal/build/presets" {
            if m == "GET" {
                return ok(json!({"presets":self.build.presets.list()}));
            }
            let b = match c.obj(4 << 20).await {
                Ok(b) => b,
                Err(e) if e.status == 413 => return Ok(write_json(413, &err_body("预设文件超过 4MB"))),
                Err(e) => return Ok(write_json(400, &err_body(&e.msg))),
            };
            let r = match b.s("action") {
                "add" => self.build.presets.add(b.g("name"), b.g("preset")),
                "remove" => self.build.presets.remove(&js_str(b.g("id"))),
                "enable" => self.build.presets.set_enabled(&js_str(b.g("id")), truthy(b.g("enabled"))),
                _ => return Ok(write_json(400, &err_body("未知操作"))),
            };
            return Ok(match r {
                Ok(v) => write_json(200, &v),
                Err(e) => write_json(status_or(&e, 500), &err_body(&e.msg)),
            });
        }
        if m == "POST" && p == "/internal/build/rotate-applets" {
            let b = c.obj(4096).await.unwrap_or(Value::Null);
            let only = as_safe_int(b.g("account")).unwrap_or(0);
            if ro() {
                return Ok(write_json(409, &err_body("readonly")));
            }
            return ok(self.rotation.tick(self, true, only).await);
        }
        if m == "GET" && p == "/internal/usage-counts" {
            let acc = self.acc.clone();
            return Ok(match self.hist.counts(&move |id| acc.tier(id)) {
                Ok(v) => write_json(200, &v),
                Err(e) => write_json(503, &err_body(&e.msg)),
            });
        }
        if m == "POST" && p == "/internal/accounts/name" {
            return Ok(match async { let b = c.obj(4096).await?; let id = self.with_pool_id(&b)?; self.acc.set_alias(id, b.g("name")) }.await {
                Ok(v) => write_json(200, &v),
                Err(e) => Self::fail(e, &[400, 404, 409], "保存未确认"),
            });
        }
        if p == "/internal/ultra-mode" && m == "GET" {
            let ids = self.lock().core.ids.clone();
            return ok(self.acc.status(&ids));
        }
        if (p == "/internal/ultra-mode" || p == "/internal/accounts/tier") && m == "POST" {
            let r = async {
                let b = c.obj(4096).await?;
                if p == "/internal/ultra-mode" {
                    self.acc.set_mode(&b)?;
                    let ids = self.lock().core.ids.clone();
                    Ok(self.acc.status(&ids))
                } else {
                    let id = self.with_pool_id(&b)?;
                    self.acc.set_tier(id, b.s("tier"))
                }
            }.await;
            return Ok(match r {
                Ok(v) => write_json(200, &v),
                Err(e) => Self::fail(e, &[400, 404, 409], "保存未确认"),
            });
        }
        if p == "/internal/concurrency" {
            if m == "GET" {
                let n = self.per_account();
                return ok(json!({"A":n,"B":n,"perAccount":n,"headless":true}));
            }
            return Ok(write_json(503, &err_body("保存未确认")));
        }
        if p == "/internal/at-prompt/export" && m == "GET" {
            return ok(self.at_prompt.export());
        }
        if p == "/internal/at-prompt/import" && m == "POST" {
            return Ok(match async { let b = c.obj(32768).await?; self.at_prompt.import(&b) }.await {
                Ok(v) => write_json(200, &v),
                Err(e) if e.status == 400 => write_json(400, &err_body(&e.msg)),
                Err(e) if e.status == 413 => write_json(413, &err_body("文件太大")),
                Err(_) => write_json(503, &err_body("保存未确认")),
            });
        }
        if p == "/internal/at-prompt" {
            if m == "GET" {
                return ok(self.at_prompt.status());
            }
            return Ok(match async { let b = c.obj(32768).await?; self.at_prompt.set(&b) }.await {
                Ok(v) => write_json(200, &v),
                Err(e) => Self::fail(e, &[400], "保存未确认"),
            });
        }
        if p == "/internal/run-mode" {
            if m == "GET" {
                return ok(run_mode_status());
            }
            let r = async {
                let b = c.obj(4096).await?;
                let mut mode = b.s("mode").to_string();
                if mode.is_empty() {
                    if let Some(s) = b.g("single").as_bool() {
                        mode = if s { "single".into() } else { "dual".into() };
                    }
                }
                run_mode_write(&self.root, &mode)
            }.await;
            return Ok(match r {
                Err(e) => Self::fail(e, &[400, 409], "切换未确认"),
                Ok(next) => {
                    let mut phase = "headless";
                    if next.s("mode") != "headless" {
                        log(format!("[Coordinator] run mode -> {}; restarting", next.s("mode")));
                        schedule_restart("ais2api-mode-switch-", "ais2api-dual-coordinator.service");
                        phase = "restarting";
                    }
                    let mut s = run_mode_status();
                    s["mode"] = next.g("mode").clone();
                    s["phase"] = json!(phase);
                    write_json(200, &s)
                }
            });
        }
        if p == "/internal/browser-lease" {
            if m == "GET" {
                return ok(json!({"lease":null}));
            }
            let Ok(b) = c.obj(4096).await else { return Ok(write_json(503, &err_body("实例暂停或恢复未确认"))) };
            return Ok(match b.s("action") {
                "acquire" => write_json(200, &json!({"slot":null,"account":null,"single":false,"headless":true})),
                "release" => write_json(200, &json!({"released":true})),
                _ => write_json(400, &err_body("Invalid action")),
            });
        }
        if let Some(op) = p.strip_prefix("/internal/ops/") {
            return Ok(self.ops(c, op.to_string()).await);
        }
        if m == "POST" && p == "/internal/sync-accounts" {
            return Ok(match self.sync_accounts() {
                Ok(v) => write_json(200, &v),
                Err(_) => write_json(503, &err_body("Coordinator unavailable")),
            });
        }
        Ok(write_json(404, &err_body("Endpoint unavailable")))
    }

    async fn console_auth(&self, c: &mut Ctx) -> Res {
        if c.method == "GET" && c.path == "/internal/console-auth" {
            return write_json(200, &self.auth.status());
        }
        if c.method != "POST" {
            return write_json(404, &err_body("Not found"));
        }
        let path = c.path.clone();
        let r = async {
            let b = c.obj(4096).await?;
            match path.as_str() {
                "/internal/console-auth/login" => Ok(json!({"ok":self.auth.verify_login(b.g("secret"))})),
                "/internal/console-auth/password" => self.auth.set_password(b.g("current"), b.g("next")),
                "/internal/console-auth/keys" => self.auth.create_key(b.g("name")),
                "/internal/console-auth/key" => self.auth.update_key(&js_str(b.g("id")), b.g("disabled"), b.g("remove") == &Value::Bool(true)),
                "/internal/console-auth/internal" => self.auth.set_internal_external(b.g("enabled") == &Value::Bool(true)),
                _ => herr(404, "Not found"),
            }
        }.await;
        match r {
            Ok(v) => write_json(200, &v),
            Err(e) => match code_in(&e, &[400, 403, 404, 413]) {
                Some(c) => write_json(c, &err_body(&e.msg)),
                None => write_json(500, &err_body("保存失败")),
            },
        }
    }

    // ---------------- ops ----------------
    async fn ops(self: &Arc<Self>, c: &mut Ctx, op: String) -> Res {
        if c.method == "GET" && op == "overview" {
            let mut o = ops_overview(&format!("{}/refactor", self.root)).await;
            o.insert("backups".into(), Value::Array(ops_backups()));
            o.insert("coordinator".into(), self.ops_status());
            return write_json(200, &Value::Object(o));
        }
        if c.method == "GET" && op == "logs" {
            let n: i64 = c.q("n").parse().unwrap_or(0);
            let src = c.q("source");
            return match ops_logs(&src, n).await {
                Ok(lines) => write_json(200, &json!({"source":src,"lines":lines})),
                Err(e) => write_json(400, &err_body(&e.msg)),
            };
        }
        if c.method != "POST" {
            return write_json(404, &err_body("当前模式不支持此操作"));
        }
        let b = match c.obj(4096).await {
            Ok(b) => b,
            Err(e) => return write_json(status_or(&e, 400), &err_body(&e.msg)),
        };
        let r: R<Value> = match op.as_str() {
            "restart" => ops_restart_unit(b.s("unit")).await,
            "backup" => ops_backup().await,
            "clear-cooldown" => self.with_pool_id(&b).map(|id| self.clear_cooldown(id)),
            "reset-quota" => self.with_pool_id(&b).and_then(|id| self.reset_quota(id, b.s("confirm"))),
            "write-back" => Ok(self.write_back()),
            "headless-concurrency" => self.set_concurrency(b.g("perAccount")),
            "pause" => self.set_paused(b.g("paused")),
            "account-enable" => self.with_pool_id(&b).and_then(|id| self.set_enabled(id, b.g("enabled"))),
            "account-schedule" => self.with_pool_id(&b).and_then(|id| {
                let r = self.sched.set(id, &b)?;
                log(format!("[Ops] account #{} schedule {}", id, js(&r)));
                self.pump();
                Ok(r)
            }),
            "stream-mode" => {
                let mode = b.s("mode");
                if !["fake", "real"].contains(&mode) {
                    herr(400, "流模式只能是 fake 或 real")
                } else {
                    self.stream.set(mode).map_err(|e| HttpErr::plain(e.to_string())).map(|_| {
                        log(format!("[Ops] streaming mode -> {}", mode));
                        json!({"mode":mode})
                    })
                }
            }
            "test-account" => match self.with_pool_id(&b) {
                Ok(id) => self.test_account(id).await,
                Err(e) => Err(e),
            },
            "cancel-request" => self.cancel_request(&js_str(b.g("id"))),
            _ => return write_json(404, &err_body("当前模式不支持此操作")),
        };
        match r {
            Ok(v) => write_json(200, &v),
            Err(e) => Self::fail(e, &[400, 404, 409, 413], "操作未确认"),
        }
    }
    fn clear_cooldown(self: &Arc<Self>, id: i64) -> Value {
        let n = {
            let mut st = self.lock();
            st.core.clear_cooldown(id);
            let n = st.core.clear_model_cooldowns(id);
            st.core.checkpoint();
            n
        };
        log(format!("[Ops] cooldown cleared #{}", id));
        self.pump();
        json!({"id":id,"cleared":true,"models":n})
    }
    fn reset_quota(self: &Arc<Self>, id: i64, confirm: &str) -> R<Value> {
        if confirm != format!("RESET {}", id) {
            return herr(400, "确认文字不匹配");
        }
        let n = {
            let mut st = self.lock();
            let n = st.core.reset_used(id);
            st.core.checkpoint();
            n
        };
        log(format!("[Ops] quota counters reset #{}", id));
        self.pump();
        Ok(json!({"id":id,"reset":n}))
    }
    fn set_concurrency(self: &Arc<Self>, v: &Value) -> R<Value> {
        let Some(n) = as_safe_int(v).filter(|n| (1..=10).contains(n)) else { return herr(400, "并发数只能是 1 到 10 的整数") };
        if !ro() {
            write_simple(&self.cc_file, &js_bytes(&json!({"perAccount":n})), 0o600).map_err(|e| HttpErr::plain(e.to_string()))?;
        }
        self.set_per_account(n);
        log(format!("[Headless] per-account concurrency -> {}", n));
        self.pump();
        Ok(json!({"perAccount":n}))
    }
    fn set_paused(self: &Arc<Self>, v: &Value) -> R<Value> {
        let Some(p) = v.as_bool() else { return herr(400, "参数无效") };
        self.lock().disp.paused = p;
        log(format!("[Ops] dispatch {}", if p { "paused" } else { "resumed" }));
        if !p {
            self.pump();
        }
        Ok(json!({"paused":p}))
    }
    fn set_enabled(self: &Arc<Self>, id: i64, v: &Value) -> R<Value> {
        let Some(en) = v.as_bool() else { return herr(400, "参数无效") };
        let (list, enabled) = {
            let mut st = self.lock();
            if en {
                st.disp.disabled.remove(&id);
            } else {
                st.disp.disabled.insert(id);
            }
            (st.disp.disabled.iter().copied().collect::<Vec<i64>>(), !st.disp.disabled.contains(&id))
        };
        if !ro() {
            write_simple(&self.dis_file, &js_bytes(&json!(list)), 0o600).map_err(|e| HttpErr::plain(e.to_string()))?;
        }
        log(format!("[Ops] account #{} {}", id, if en { "enabled" } else { "disabled" }));
        if en {
            self.pump();
        }
        Ok(json!({"id":id,"enabled":enabled}))
    }
    async fn test_account(&self, id: i64) -> R<Value> {
        let email = self.acc.email(id);
        if email.is_empty() || !self.importer.has(&self.acc, id) {
            return herr(409, "账号未导入无浏览器服务");
        }
        let mut pick = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.6-flash", "gemini-3.8-flash"].iter().find(|m| self.routing.has(m)).map(|s| s.to_string());
        if pick.is_none() {
            let bad = Regex::new("image|tts|search|live|audio").unwrap();
            pick = self.routing.models().into_iter().find(|m| m.contains("flash") && !bad.is_match(m));
        }
        let Some(pick) = pick else { return herr(409, "模型列表为空，请先刷新模型") };
        let cancel = crate::resp::Cancel::new();
        let t0 = now_ms();
        let body = json!({"model":pick,"messages":[{"role":"user","content":"Reply with the single word OK."}],"stream":false});
        let r = tokio::time::timeout(Duration::from_secs(30), self.svc.call(&cancel, &email, "POST", "/v1/chat/completions", Some(&body))).await;
        let ms = now_ms() - t0;
        let r = match r {
            Err(_) => {
                cancel.cancel();
                return Ok(json!({"id":id,"model":pick,"ok":false,"status":504,"ms":ms,"error":"30 秒未响应"}));
            }
            Ok(r) => r,
        };
        if let Some(e) = r.err {
            return Ok(json!({"id":id,"model":pick,"ok":false,"status":502,"ms":ms,"error":clip_runes(&e, 200)}));
        }
        let text = r.json.a("choices").first().map(|c| clip_runes(js_str(c.g("message").g("content")).trim(), 80)).unwrap_or_default();
        log(format!("[Ops] test #{} {} status={} ms={}", id, pick, r.status, ms));
        let e = if r.status == 200 {
            if text.is_empty() { json!("返回为空") } else { Value::Null }
        } else {
            let mut m = r.json.g("error").s("message").to_string();
            if m.is_empty() {
                m = String::from_utf8_lossy(&r.text).into_owned();
            }
            json!(clip_runes(&m, 200))
        };
        Ok(json!({"id":id,"model":pick,"ok":r.status == 200 && !text.is_empty(),"status":r.status,"ms":ms,"text":text,"error":e}))
    }
    fn cancel_request(&self, id: &str) -> R<Value> {
        let x = self.lock().disp.live.get(id).cloned();
        let Some((t, res)) = x else { return herr(404, "请求已结束或不存在") };
        res.destroy();
        log(format!("[Ops] request cancelled {} #{}", clip_runes(id, 8), t.account));
        Ok(json!({"id":id,"cancelled":true}))
    }
    fn revalidate(self: &Arc<Self>, b: &Value) -> R<Value> {
        let id = as_safe_int(b.g("id"));
        let mut st = self.lock();
        let Some(id) = id.filter(|&i| st.core.in_pool(i)) else { return herr(400, "账号无效") };
        let Some(f) = st.core.flag(id) else { return Ok(json!({"revalidated":false,"id":id})) };
        if f.s("status") != "invalid" {
            return herr(409, "账号状态不允许恢复");
        }
        st.core.set_flag(id, None);
        st.core.clear_cooldown(id);
        st.core.checkpoint();
        drop(st);
        self.reload_soon();
        Ok(json!({"revalidated":true,"id":id}))
    }
    fn delete_account(self: &Arc<Self>, b: &Value) -> R<Value> {
        let id = as_safe_int(b.g("id")).unwrap_or(0);
        if id < 1 || b.s("confirm") != format!("DELETE {}", id) {
            return herr(400, "删除确认不匹配");
        }
        if ro() {
            return herr(409, "只读模式下不执行");
        }
        let mut st = self.lock();
        if !st.core.in_pool(id) {
            return herr(404, format!("账号 {} 不在账号池", id));
        }
        if st.core.deleted(id) {
            return Ok(json!({"deleted":true,"id":id}));
        }
        if st.stopping || st.core.halted || st.disp.busy(id) > 0 || self.build.busy(id) > 0 {
            return herr(409, "账号正在处理请求，请稍后再删除");
        }
        let email = self.acc.email(id);
        let mut f = st.core.flag(id).cloned().unwrap_or_else(|| json!({"reason":"login_required","at":now_ms()}).as_object().unwrap().clone());
        f.insert("status".into(), json!("deleting"));
        st.core.set_flag(id, Some(Value::Object(f.clone())));
        st.core.checkpoint();
        if let Err(e) = std::fs::remove_file(self.acc.file(id)) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(HttpErr::plain(e.to_string()));
            }
        }
        if !email.is_empty() && !email.contains('/') && email.contains('@') {
            let _ = std::fs::remove_dir_all(format!("{}/{}", self.importer.target, email));
        }
        f.insert("status".into(), json!("deleted"));
        f.insert("deletedAt".into(), json!(now_ms()));
        st.core.set_flag(id, Some(Value::Object(f)));
        st.core.checkpoint();
        drop(st);
        remove_login_credential(id);
        self.build.forget(id);
        self.rotation.forget(id);
        self.reload_soon();
        Ok(json!({"deleted":true,"id":id,"historyPreserved":true}))
    }
}

/// drop the stored encrypted password of a deleted account
fn remove_login_credential(id: i64) {
    let file = "/opt/ais2api-direct/credentials.json";
    let Ok(Value::Object(mut o)) = read_json(file) else { return };
    if o.shift_remove(&id.to_string()).is_some() {
        let _ = write_atomic(file, &js_bytes(&Value::Object(o)), 0o600, true);
    }
}