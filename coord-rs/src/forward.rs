// forward(): recorded-forward + headless-forward + Build wrapper (forward.go).
// Paths: Build, anti-truncation/, fake streaming, passthrough. Errors on early-opened streams become
// stream error events (see resp.rs).
use crate::app::App;
use crate::build_chan::{call_build, read_file, valid_base, RE_APP};
use crate::build_ctx::{pack, prepare, WIRE_PREFIX};
use crate::build_resp::{document_name, find_hash, is_ack, openai_usage, parse as parse_build, DOC_NAME};
use crate::build_tools;
use crate::history::{outcome_of, Begin};
use crate::metrics::{ExecResult, Metrics, MetricsOut, Rejection};
use crate::resp::{Cancel, Resp};
use crate::sched::{Plan, Req, Ticket, AT_PREFIX};
use crate::util::*;
use bytes::Bytes;
use http_body_util::BodyExt;
use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn retry_status(s: u16) -> bool {
    matches!(s, 401 | 403 | 429)
}
fn rejection_of(status: u16, headers: &hyper::HeaderMap, body: Bytes) -> Rejection {
    let ct = headers.get("content-type").and_then(|v| v.to_str().ok()).filter(|s| !s.is_empty()).unwrap_or("application/json");
    let mut h = vec![("content-type".to_string(), ct.to_string())];
    if let Some(v) = headers.get("retry-after").and_then(|v| v.to_str().ok()).filter(|s| !s.is_empty()) {
        h.push(("retry-after".into(), v.into()));
    }
    Rejection { status, headers: h, body }
}
fn json_rejection(status: u16, payload: &Value, retry_after: &str, extra: &[(&str, &str)]) -> Rejection {
    let mut h = vec![("content-type".to_string(), "application/json".to_string())];
    if !retry_after.is_empty() {
        h.push(("retry-after".into(), retry_after.into()));
    }
    for (k, v) in extra {
        h.push((k.to_string(), v.to_string()));
    }
    Rejection { status, headers: h, body: Bytes::from(js_bytes(payload)) }
}
fn er(status: u16) -> ExecResult {
    ExecResult { status, ..Default::default() }
}
fn fin(m: &Arc<Mutex<Metrics>>, complete: bool) -> Option<MetricsOut> {
    Some(m.lock().unwrap().finish(complete))
}
fn hdr(h: &hyper::HeaderMap, k: &str) -> String {
    h.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
}

impl App {
    /// one execution (called by the scheduler, outside the state lock)
    pub async fn forward(self: Arc<Self>, t: Ticket, req: Arc<Req>, plan: Plan, cancel: Arc<Cancel>) -> ExecResult {
        self.lock().disp.live.insert(t.id.clone(), (t.clone(), req.res.clone()));
        let started = self.hist.begin(Begin { id: &t.id, model: &t.model, requested: &req.model, account: t.account, epoch: &self.epoch(),
            stream: req.stream, price: self.prices.get(&t.model) }).is_ok();
        if !started {
            self.health.fail(true);
        }
        let result = if plan.build.is_some() {
            self.forward_build(&t, &req, &plan, &cancel).await
        } else {
            self.forward_headless(&t, &req, &plan, &cancel, None).await
        };
        {
            let mut st = self.lock();
            st.disp.live.remove(&t.id);
            st.disp.settle(&t);
        }
        if started {
            let out = outcome_of(Some(&result));
            let m = result.metrics.as_ref();
            if out == "success" && !m.map(|m| m.usage_complete).unwrap_or(false) {
                self.health.missing(json!({"at":now_ms(),"id":t.id,"model":t.model,"stream":m.is_some(),"malformed":m.map(|m| m.malformed).unwrap_or(false),
                    "hasUsage":m.map(|m| m.usage.is_some()).unwrap_or(false),"doneSeen":m.map(|m| m.stream_done_seen).unwrap_or(false)}));
            }
            if self.hist.finish(&t.id, out, result.status, m).is_err() {
                self.health.fail(false);
            }
        }
        result
    }

    async fn forward_headless(&self, t: &Ticket, req: &Req, plan: &Plan, cancel: &Arc<Cancel>, build: Option<&Map<String, Value>>) -> ExecResult {
        if cancel.is() {
            return ExecResult { uncertain: true, ..Default::default() };
        }
        let email = self.acc.email(t.account);
        if email.is_empty() {
            req.res.json(503, &json!({"error":{"message":format!("账号 #{} 没有登录邮箱，无浏览器服务无法使用", t.account),"code":"headless_account_unknown"}}), &[]);
            return ExecResult { status: 503, worker_rejection: true, ..Default::default() };
        }
        if let Some(parsed) = build {
            self.build_call(t, req, parsed, &email, cancel).await
        } else if !req.native && req.model.starts_with(AT_PREFIX) {
            self.anti_truncation(t, req, &email, cancel).await
        } else if !req.soft.is_empty() {
            self.fake_stream(req, plan, &email, cancel).await
        } else {
            self.passthrough(req, plan, &email, cancel).await
        }
    }

    fn upstream_path(req: &Req, plan: &Plan) -> String {
        if !req.native {
            return "/v1/chat/completions".into();
        }
        let mut p = format!("/v1beta/models/{}:{}", plan.model, if req.stream { "streamGenerateContent" } else { "generateContent" });
        if !req.query.is_empty() {
            p.push('?');
            p.push_str(&req.query);
        }
        p
    }

    async fn passthrough(&self, req: &Req, plan: &Plan, email: &str, cancel: &Arc<Cancel>) -> ExecResult {
        let res = &req.res;
        let up = match self.svc.request(cancel, email, "POST", &Self::upstream_path(req, plan), req.body.clone()).await {
            Ok(u) => u,
            Err(_) => {
                if cancel.is() {
                    return ExecResult { uncertain: true, ..Default::default() };
                }
                res.json(502, &json!({"error":{"message":"无浏览器服务连接失败","code":"headless_unavailable"}}), &[]);
                return er(502);
            }
        };
        let status = up.status().as_u16();
        let headers = up.headers().clone();
        let ra = hdr(&headers, "retry-after");
        let stream = hdr(&headers, "content-type").contains("text/event-stream");
        let mut obs = Metrics::new(stream);
        let mut held = retry_status(status);
        let mut chunks: Vec<u8> = vec![];
        let publish = || {
            for k in ["content-type", "retry-after", "cache-control"] {
                let v = hdr(&headers, k);
                if !v.is_empty() {
                    res.set_header(k, &v);
                }
            }
            res.set_status(status);
        };
        if !held {
            publish();
        }
        let mk = |obs: &mut Metrics, complete: bool, uncertain: bool, cancelled: bool| ExecResult {
            status, retry_after: ra.clone(), metrics: Some(obs.finish(complete)), uncertain, cancelled, ..Default::default()
        };
        let mut body = up.into_body();
        loop {
            let f = tokio::select! {
                f = body.frame() => f,
                _ = cancel.wait() => {
                    let was = res.destroyed();
                    let done = stream && obs.done;
                    res.destroy();
                    return mk(&mut obs, false, !was, was && !done);
                }
            };
            match f {
                None => break,
                Some(Err(_)) => {
                    let was = res.destroyed();
                    res.destroy();
                    if was && !(stream && obs.done) {
                        return mk(&mut obs, false, false, true);
                    }
                    return mk(&mut obs, false, true, false);
                }
                Some(Ok(fr)) => {
                    let Ok(c) = fr.into_data() else { continue };
                    obs.write(&c);
                    if held {
                        chunks.extend_from_slice(&c);
                        if chunks.len() > 65536 {
                            held = false;
                            publish();
                            if !res.write(&chunks) {
                                return mk(&mut obs, false, false, true);
                            }
                            chunks.clear();
                        }
                    } else if !res.write(&c) {
                        if stream && obs.done {
                            return mk(&mut obs, false, true, false);
                        }
                        return mk(&mut obs, false, false, true);
                    }
                }
            }
        }
        if held {
            let mut r = mk(&mut obs, true, false, false);
            r.rejection = Some(rejection_of(status, &headers, Bytes::from(chunks)));
            return r;
        }
        res.end(b"");
        mk(&mut obs, true, false, false)
    }

    // ---------------- anti-truncation ----------------
    async fn anti_truncation(&self, t: &Ticket, req: &Req, email: &str, cancel: &Arc<Cancel>) -> ExecResult {
        let res = &req.res;
        let model = req.parsed.s("model").to_string();
        let real = model[AT_PREFIX.len()..].to_string();
        let stream = req.parsed.b("stream");
        let mut body = req.parsed.clone();
        body.insert("model".into(), json!(real));
        let obs = Arc::new(Mutex::new(Metrics::new(stream)));
        res.set_tap(obs.clone());
        let t0 = now_ms();
        let call = |b: Map<String, Value>| {
            let cancel = cancel.clone();
            async move {
                let r = self.svc.call(&cancel, email, "POST", "/v1/chat/completions", Some(&Value::Object(b))).await;
                if let Some(e) = r.err {
                    let st = if cancel.is() { 499 } else { 502 };
                    return crate::at::CallResult { status: st, json: json!({"error":{"message":clip_runes(&e, 200)}}), text: String::new(), retry_after: String::new() };
                }
                crate::at::CallResult { status: r.status, json: r.json, text: String::from_utf8_lossy(&r.text).into_owned(), retry_after: r.retry_after }
            }
        };
        let r = crate::at::run(call, || cancel.is(), &body, &self.at_prompt.preset()).await;
        let st = if r.ok { 200 } else { r.status };
        log(format!("[HL] AT #{} {} ok={} status={} rounds={} ms={}", t.account, real, r.ok, st, if r.rounds > 0 { r.rounds.to_string() } else { "-".into() }, now_ms() - t0));
        if r.cancelled || res.destroyed() {
            return ExecResult { cancelled: true, metrics: fin(&obs, false), ..Default::default() };
        }
        if !r.ok {
            if r.upstream && retry_status(st) {
                return ExecResult { status: st, retry_after: r.retry_after.clone(), rejection: Some(json_rejection(st, &r.payload, &r.retry_after, &[])), metrics: fin(&obs, true), ..Default::default() };
            }
            let h: Vec<(&str, &str)> = if r.retry_after.is_empty() { vec![] } else { vec![("Retry-After", r.retry_after.as_str())] };
            res.json(st, &r.payload, &h);
            return ExecResult { status: st, retry_after: r.retry_after.clone(), metrics: fin(&obs, true), ..Default::default() };
        }
        let mut msg = json!({"role":"assistant","content":r.answer});
        if !r.reasoning.is_empty() {
            msg["reasoning_content"] = json!(r.reasoning);
        }
        write_completion(res, &model, stream, &msg, "stop", r.usage.as_ref());
        ExecResult { status: 200, metrics: fin(&obs, true), ..Default::default() }
    }

    // ---------------- fake streaming ----------------
    async fn fake_stream(&self, req: &Req, plan: &Plan, email: &str, cancel: &Arc<Cancel>) -> ExecResult {
        let res = &req.res;
        let (path, body) = if req.native {
            (format!("/v1beta/models/{}:generateContent", plan.model), req.body.clone())
        } else {
            let mut b = req.parsed.clone();
            b.insert("stream".into(), json!(false));
            b.shift_remove("stream_options");
            ("/v1/chat/completions".to_string(), Bytes::from(js_bytes(&Value::Object(b))))
        };
        let mut obs = Metrics::new(false);
        let up = match self.svc.request(cancel, email, "POST", &path, body).await {
            Ok(u) => u,
            Err(_) => {
                if cancel.is() {
                    return ExecResult { uncertain: true, ..Default::default() };
                }
                res.json(502, &json!({"error":{"message":"无浏览器服务连接失败","code":"headless_unavailable"}}), &[]);
                return ExecResult { status: 502, metrics: Some(obs.finish(true)), ..Default::default() };
            }
        };
        let st = up.status().as_u16();
        let headers = up.headers().clone();
        let ra = hdr(&headers, "retry-after");
        let data = match crate::svc::read_limited(up.into_body(), 64 << 20, cancel).await {
            Ok(d) => d,
            Err(_) => {
                if res.destroyed() {
                    return ExecResult { cancelled: true, metrics: Some(obs.finish(false)), ..Default::default() };
                }
                res.destroy();
                return ExecResult { uncertain: true, metrics: Some(obs.finish(false)), ..Default::default() };
            }
        };
        obs.write(&data);
        if st != 200 {
            if retry_status(st) {
                return ExecResult { status: st, retry_after: ra, rejection: Some(rejection_of(st, &headers, data)), metrics: Some(obs.finish(true)), ..Default::default() };
            }
            let p: Value = serde_json::from_slice(&data).ok().filter(|v: &Value| v.get("error").is_some())
                .unwrap_or_else(|| json!({"error":{"message":clip_runes(&String::from_utf8_lossy(&data), 500),"code":st}}));
            res.json(st, &p, &[]);
            return ExecResult { status: st, metrics: Some(obs.finish(true)), ..Default::default() };
        }
        let Ok(j) = serde_json::from_slice::<Value>(&data) else {
            res.json(502, &json!({"error":{"message":"上游回复无法解析","code":"bad_upstream_reply"}}), &[]);
            return ExecResult { status: 502, metrics: Some(obs.finish(true)), ..Default::default() };
        };
        if !j.is_object() {
            res.json(502, &json!({"error":{"message":"上游回复无法解析","code":"bad_upstream_reply"}}), &[]);
            return ExecResult { status: 502, metrics: Some(obs.finish(true)), ..Default::default() };
        }
        let kind = res.sse_kind();
        res.commit();
        if req.native {
            if kind == "gemini-array" {
                res.end(format!("{}]", js(&j)).as_bytes());
            } else {
                res.end(format!("data: {}\r\n\r\n", js(&j)).as_bytes());
            }
            return ExecResult { status: 200, metrics: Some(obs.finish(true)), ..Default::default() };
        }
        let ch = j.a("choices").first().cloned().unwrap_or(Value::Null);
        let msg = if ch.g("message").is_object() { ch.g("message").clone() } else { json!({"role":"assistant","content":""}) };
        let f = ch.s("finish_reason");
        let usage = if j.g("usage").is_object() { Some(j.g("usage").clone()) } else { None };
        write_completion(res, req.parsed.s("model"), true, &msg, if f.is_empty() { "stop" } else { f }, usage.as_ref());
        ExecResult { status: 200, metrics: Some(obs.finish(true)), ..Default::default() }
    }

    // ---------------- Build ----------------
    async fn forward_build(&self, t: &Ticket, req: &Req, plan: &Plan, cancel: &Arc<Cancel>) -> ExecResult {
        let b = &self.build;
        let spec = plan.build.clone().unwrap();
        let reserved = b.take_reservation(&t.id, t.account);
        let app_id = b.app_for(t.account);
        b.inc("requests", 1);
        let t0 = now_ms();
        let result = self.forward_build_inner(t, req, &spec, &app_id, cancel).await;
        let usage = result.metrics.as_ref().and_then(|m| m.usage.clone());
        b.settle(&t.id, t.account, reserved, &spec.requested, &spec.model, result.status, usage.as_ref(), now_ms() - t0);
        if !app_id.is_empty() {
            self.schedule_renew(t.account, 0);
        }
        result
    }
    async fn forward_build_inner(&self, t: &Ticket, req: &Req, spec: &crate::build_ctx::BuildSpec, app_id: &str, cancel: &Arc<Cancel>) -> ExecResult {
        let b = &self.build;
        if app_id.is_empty() {
            req.res.json(503, &json!({"error":{"message":format!("账号 #{} 没有 Build 项目", t.account),"code":"build_app_missing"}}), &[]);
            return er(503);
        }
        let mut parsed = req.parsed.clone();
        let raw = spec.prefix == "build-st/";
        if raw {
            let m = parsed.a("messages");
            let ok = m.len() == 1 && m[0].s("role") == "user" && m[0].g("content").as_str().map(|c| c.starts_with(WIRE_PREFIX)).unwrap_or(false);
            if !ok {
                b.inc("rejected", 1);
                req.res.json(400, &json!({"error":{"message":"build-st/ 只接收酒馆 build-standalone 插件打包好的请求，这条请求没有经过插件处理（插件未启用或没接管）。请启用插件，或改用 bridge/ 前缀由网关拆分。","code":"build_st_plugin_required"}}), &[]);
                return er(400);
            }
        }
        let mut bs = json!({"app":app_id,"model":spec.model,"thinking":spec.thinking});
        if raw {
            bs["keepMedia"] = json!(true);
        }
        if spec.prefix == "code/" {
            bs["mode"] = json!("code");
        }
        if b.doc.uses(&spec.prefix) {
            bs["document"] = json!(document_name());
            b.doc.requests.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        if !raw && spec.prefix != "code/" {
            if let Some(env) = b.presets.apply(parsed.a("messages")) {
                parsed.insert("messages".into(), json!([{"role":"user","content":env.content}]));
                b.inc("presetHits", 1);
            }
        }
        parsed.insert("__build".into(), bs);
        let plan = Plan { model: String::new(), family: String::new(), build: None, estimate: 0 };
        self.forward_headless(t, req, &plan, cancel, Some(&parsed)).await
    }

    async fn build_call(&self, t: &Ticket, req: &Req, parsed: &Map<String, Value>, email: &str, cancel: &Arc<Cancel>) -> ExecResult {
        let res = &req.res;
        let spec = parsed.g("__build");
        let stream = parsed.b("stream");
        let obs = Arc::new(Mutex::new(Metrics::new(stream)));
        res.set_tap(obs.clone());
        let done = |mut r: ExecResult| {
            r.metrics = fin(&obs, !r.cancelled);
            r
        };
        let fail = |status: u16, msg: &str, code: &str, h: &[(&str, &str)]| {
            let typ = if status >= 500 { "upstream_error" } else { "invalid_request_error" };
            res.json(status, &json!({"error":{"message":msg,"type":typ,"code":code}}), h);
            done(er(status))
        };
        let model = spec.s("model").to_string();
        let thinking = as_num(spec.g("thinking")).map(|f| f as i64).unwrap_or(0);
        let app_id = spec.s("app").to_string();
        if !RE_APP.is_match(&app_id) || !valid_base(&model) || !(1..=3).contains(&thinking) {
            return fail(400, "Build 通道参数无效", "build_error", &[]);
        }
        let nonce = build_tools::nonce();
        let prep = (|| {
            let mv = match parsed.get("max_completion_tokens") {
                Some(v) if !v.is_null() => v,
                _ => parsed.g("max_tokens"),
            };
            let max_out = as_safe_int(mv).filter(|n| *n > 0).unwrap_or(0);
            let tool_spec = build_tools::normalize(parsed.g("__tools"))?;
            let (msgs, _) = build_tools::flatten(parsed.a("messages"));
            let p = prepare(&msgs, spec.b("keepMedia"), spec.s("mode"))?;
            let extra = build_tools::instructions(tool_spec.as_ref(), &nonce)?;
            let doc = spec.s("document");
            let doc = if DOC_NAME.is_match(doc) { doc } else { "" };
            let packed = pack(&p, max_out, &extra, spec.s("mode") == "code", doc)?;
            Ok::<_, crate::build_ctx::BErr>((packed, tool_spec))
        })();
        let (packed, tool_spec) = match prep {
            Ok(x) => x,
            Err(e) => return fail(e.status, &e.msg, &e.code, &[]),
        };
        let t0 = now_ms();
        let r = call_build(self.svc, cancel, email, &packed.parts, &model, thinking, &app_id, Duration::from_secs(600)).await;
        log(format!("[HL-Build] #{} {} t{} {} bytes={} stage={} status={} tries={} resent={} polls={} ms={}", t.account, model, thinking, packed.mode, packed.bytes,
            r.stage, r.s, r.tries, r.resent, r.polls, now_ms() - t0));
        if cancel.is() || r.s == 499 {
            res.destroy();
            return done(ExecResult { cancelled: true, ..Default::default() });
        }
        if r.stage != "stream" || r.s != 200 {
            let st = if [400, 403, 404, 413, 429].contains(&r.s) { r.s } else if r.s == 503 { 503 } else { 502 };
            let h: Vec<(&str, &str)> = if r.s == 429 { vec![("Retry-After", "60")] } else { vec![] };
            return fail(st, &format!("Build 上游错误 ({} {})：{}", r.stage, r.s, clip_runes(&r.t, 300)), &format!("build_upstream_{}", r.s), &h);
        }
        let mut out = parse_build(&r.t);
        if !out.ok {
            let _ = write_simple("/tmp/build-last-parsefail.txt", r.t.as_bytes(), 0o600);
            if out.upstream_failed {
                let payload = json!({"error":{"message":format!("谷歌拒绝生成这条请求（{}）。通常是输入内容触发了谷歌的内容审查，同样的内容重试也会失败，请修改输入内容（例如改写最新消息、删减近期聊天记录或世界书条目）后重试。", out.error),
                    "type":"invalid_request_error","code":"build_input_rejected"}});
                return done(ExecResult { status: 400, rejection: Some(json_rejection(400, &payload, "", &[("x-ais-build-retry", "upstream_failed")])), ..Default::default() });
            }
            return fail(502, &format!("Build 回复解析失败：{}", out.error), "build_parse_failed", &[]);
        }
        if !out.complete || out.text.trim().is_empty() {
            let _ = write_simple("/tmp/build-last-incomplete.txt", r.t.as_bytes(), 0o600);
            return fail(502, "Build 回复不完整（未收到结束标记或正文为空），请重试", "build_incomplete", &[]);
        }
        if !packed.document.is_empty() {
            let mut why = "no_file".to_string();
            if let Some(hash) = find_hash(&r.t, &packed.document) {
                let (text, n, e) = read_file(self.svc, cancel, email, &app_id, &hash).await;
                if e.is_empty() && !text.trim().is_empty() {
                    log(format!("[HL-BuildDoc] file used bytes={} chat={}", n, js_len(&out.text)));
                    out.text = text;
                    why.clear();
                } else if !e.is_empty() {
                    why = format!("read_{}", e);
                } else {
                    why = "read_200".into();
                }
            }
            if !why.is_empty() {
                elog(format!("[HL-BuildDoc] fallback to chat reason={} chat={}", why, js_len(&out.text)));
                if is_ack(&out.text) {
                    return fail(502, &format!("抗截断回复文件读取失败（{}），聊天正文里也没有内容，请重试", why), "build_document_missing", &[]);
                }
            }
        }
        let usage = openai_usage(out.usage.as_ref());
        let ex = build_tools::extract(&out.text, tool_spec.as_ref(), &nonce);
        if let Some(ts) = &tool_spec {
            log(format!("[HL-BuildTools] tools={} calls={}{}", ts.tools.len(), ex.calls.len(), if ex.rejected.is_empty() { String::new() } else { format!(" rejected={}", ex.rejected.len()) }));
        }
        let mut msg = json!({"role":"assistant"});
        msg["content"] = if !ex.calls.is_empty() && ex.content.trim().is_empty() { Value::Null } else { json!(ex.content) };
        let mut finish = "stop";
        if !ex.calls.is_empty() {
            msg["tool_calls"] = Value::Array(ex.calls.clone());
            finish = "tool_calls";
        }
        if !out.thought.is_empty() {
            msg["reasoning_content"] = json!(out.thought);
        }
        write_completion(res, &req.model, stream, &msg, finish, if usage.is_null() { None } else { Some(&usage) });
        done(er(200))
    }

    /// Build: fresh project after every request (never blocks the response)
    pub fn schedule_renew(&self, acct: i64, attempt: u32) {
        if self.cfg.get("buildRenewPerRequest") == Some(&Value::Bool(false)) || crate::state::READ_ONLY.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        {
            let mut r = self.renewing.lock().unwrap();
            if !r.insert(acct) {
                return;
            }
        }
        let Some(app) = self.me() else { return };
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(if attempt > 0 { 10 } else { 2 })).await;
            app.renewing.lock().unwrap().remove(&acct);
            if app.build.busy(acct) > 0 {
                if attempt < 60 {
                    app.schedule_renew(acct, attempt + 1);
                }
                return;
            }
            let r = app.rotation.renew(&app, acct, &app.acc.email(acct)).await;
            if !r.starts_with("renewed") && r != "no_project" && r != "changed" {
                if attempt < 60 {
                    app.schedule_renew(acct, attempt + 1);
                } else {
                    elog(format!("[BuildRenew] #{} gave up: {}", acct, r));
                }
            }
        });
    }
}

// ---------------- completion writer ----------------
pub fn write_completion(res: &Arc<Resp>, model: &str, stream: bool, message: &Value, finish: &str, usage: Option<&Value>) {
    let id = format!("chatcmpl-{}", uuid4());
    let created = now_ms() / 1000;
    if stream {
        if !res.headers_sent() {
            res.set_header("Content-Type", "text/event-stream; charset=utf-8");
            res.set_header("Cache-Control", "no-cache");
            res.set_status(200);
        }
        res.commit();
        let base = || json!({"id":id,"object":"chat.completion.chunk","created":created,"model":model});
        let mut frames = vec![];
        let delta = |frames: &mut Vec<Value>, k: &str, v: Value| {
            let mut f = base();
            let mut d = json!({"role":"assistant"});
            d[k] = v;
            f["choices"] = json!([{"index":0,"delta":d,"finish_reason":null}]);
            frames.push(f);
        };
        if truthy(message.g("reasoning_content")) {
            delta(&mut frames, "reasoning_content", message.g("reasoning_content").clone());
        }
        if truthy(message.g("content")) {
            delta(&mut frames, "content", message.g("content").clone());
        }
        if let Value::Array(tc) = message.g("tool_calls") {
            let calls: Vec<Value> = tc.iter().enumerate().map(|(i, c)| {
                let mut x = Map::new();
                x.insert("index".into(), json!(i));
                if let Some(o) = c.as_object() {
                    for (k, v) in o {
                        x.insert(k.clone(), v.clone());
                    }
                }
                Value::Object(x)
            }).collect();
            delta(&mut frames, "tool_calls", Value::Array(calls));
        }
        let mut last = base();
        last["choices"] = json!([{"index":0,"delta":{},"finish_reason":finish}]);
        if let Some(u) = usage {
            last["usage"] = u.clone();
        }
        frames.push(last);
        let mut b = String::new();
        for f in &frames {
            b.push_str("data: ");
            b.push_str(&js(f));
            b.push_str("\n\n");
        }
        b.push_str("data: [DONE]\n\n");
        res.end(b.as_bytes());
        return;
    }
    let mut o = json!({"id":id,"object":"chat.completion","created":created,"model":model,"choices":[{"index":0,"message":message,"finish_reason":finish}]});
    if let Some(u) = usage {
        o["usage"] = u.clone();
    }
    res.json(200, &o, &[]);
}