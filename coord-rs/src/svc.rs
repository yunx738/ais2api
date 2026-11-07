// HTTP client for the local no-browser service (service.go). Calls are pinned to one account
// (X-Pin-Account + X-Build-Raw-Key). raw() is the Build endpoint /v1/x-build-raw.
use crate::resp::Cancel;
use crate::util::*;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use hyper_util::rt::TokioExecutor;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

pub struct Service {
    base: String,
    key: String,
    raw_key: String,
    hc: Client<HttpConnector, Full<Bytes>>,
}
pub struct CallRes {
    pub status: u16,
    pub retry_after: String,
    pub text: Bytes,
    pub json: Value,
    pub err: Option<String>,
}
pub struct RawErr {
    pub status: u16,
    pub msg: String,
}

impl Service {
    pub fn from_files(dir: &str) -> Result<Service, String> {
        let env = std::fs::read_to_string(format!("{}/.env", dir)).map_err(|e| e.to_string())?;
        let mut key = String::new();
        for l in env.lines() {
            if let Some(v) = l.strip_prefix("PROXY_API_KEY=") {
                key = v.trim().split(',').next().unwrap_or("").trim().to_string();
            }
        }
        let raw = std::fs::read_to_string(format!("{}/build-raw.key", dir)).map_err(|e| e.to_string())?.trim().to_string();
        if key.is_empty() || raw.len() < 16 {
            return Err("headless keys required".into());
        }
        let host = std::env::var("HEADLESS_ADDR").unwrap_or_else(|_| "127.0.0.1:2048".into());
        let mut conn = HttpConnector::new();
        conn.set_connect_timeout(Some(Duration::from_secs(10)));
        conn.set_nodelay(true);
        let hc = Client::builder(TokioExecutor::new()).pool_max_idle_per_host(0).build(conn);
        Ok(Service { base: format!("http://{}", host), key, raw_key: raw, hc })
    }
    fn req(&self, account: &str, method: &str, path: &str, body: Bytes, raw: bool) -> hyper::Request<Full<Bytes>> {
        let mut b = hyper::Request::builder().method(method).uri(format!("{}{}", self.base, path))
            .header("Content-Type", "application/json").header("Authorization", format!("Bearer {}", self.key));
        if !account.is_empty() {
            b = b.header("X-Pin-Account", account);
        }
        if !account.is_empty() || raw {
            b = b.header("X-Build-Raw-Key", &self.raw_key);
        }
        b.body(Full::new(body)).unwrap()
    }
    /// streaming request; Err = connection failure or cancellation
    pub async fn request(&self, cancel: &Arc<Cancel>, account: &str, method: &str, path: &str, body: Bytes) -> Result<hyper::Response<Incoming>, String> {
        let fut = self.hc.request(self.req(account, method, path, body, false));
        tokio::select! {
            r = fut => r.map_err(|e| e.to_string()),
            _ = cancel.wait() => Err("cancelled".into()),
        }
    }
    /// JSON request, buffered reply (max 64 MiB)
    pub async fn call(&self, cancel: &Arc<Cancel>, account: &str, method: &str, path: &str, obj: Option<&Value>) -> CallRes {
        let body = obj.map(|o| Bytes::from(js_bytes(o))).unwrap_or_default();
        let fail = |e: String, status: u16| CallRes { status, retry_after: String::new(), text: Bytes::new(), json: Value::Null, err: Some(e) };
        let res = match self.request(cancel, account, method, path, body).await {
            Ok(r) => r,
            Err(e) => return fail(e, 0),
        };
        let status = res.status().as_u16();
        let ra = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let text = match read_limited(res.into_body(), 64 << 20, cancel).await {
            Ok(b) => b,
            Err(e) => return fail(e, status),
        };
        let json = serde_json::from_slice(&text).unwrap_or(Value::Null);
        CallRes { status, retry_after: ra, text, json, err: None }
    }
    /// Build op through the service: returns the decoded body {s,t,path,data}
    pub async fn raw(&self, cancel: &Arc<Cancel>, call: &Value, deadline: Duration) -> Result<Value, RawErr> {
        let deadline = if deadline.is_zero() { Duration::from_secs(120) } else { deadline };
        let run = async {
            let res = self.hc.request(self.req("", "POST", "/v1/x-build-raw", Bytes::from(js_bytes(call)), true)).await.map_err(|e| RawErr { status: 0, msg: e.to_string() })?;
            let st = res.status().as_u16();
            let b = read_limited(res.into_body(), 96 << 20, &Cancel::new()).await.map_err(|e| RawErr { status: 0, msg: e })?;
            let o: Value = serde_json::from_slice(&b).ok().filter(|v: &Value| v.is_object()).ok_or(RawErr { status: 502, msg: format!("raw reply unparseable ({})", st) })?;
            if st != 200 {
                let m = o.g("error").s("message");
                return Err(RawErr { status: st, msg: clip_runes(if m.is_empty() { "raw call failed" } else { m }, 300) });
            }
            Ok(o)
        };
        tokio::select! {
            r = run => r,
            _ = cancel.wait() => Err(RawErr { status: 499, msg: "cancelled".into() }),
            _ = tokio::time::sleep(deadline) => Err(RawErr { status: 504, msg: "raw call deadline".into() }),
        }
    }
}
pub async fn read_limited(mut body: Incoming, max: usize, cancel: &Arc<Cancel>) -> Result<Bytes, String> {
    let mut out = Vec::new();
    loop {
        let f = tokio::select! {
            f = body.frame() => f,
            _ = cancel.wait() => return Err("cancelled".into()),
        };
        match f {
            None => break,
            Some(Err(e)) => return Err(e.to_string()),
            Some(Ok(fr)) => {
                if let Ok(d) = fr.into_data() {
                    out.extend_from_slice(&d);
                    if out.len() > max {
                        return Err("reply too large".into());
                    }
                }
            }
        }
    }
    Ok(Bytes::from(out))
}
pub fn raw_s(o: &Value) -> u16 {
    as_safe_int(o.g("s")).unwrap_or(0) as u16
}
pub fn raw_t(o: &Value) -> String {
    js_str(o.g("t"))
}
pub fn rpc_body(account: &str, method: &str, body: Value) -> Value {
    json!({"op":"rpc","account":account,"method":method,"body":body})
}