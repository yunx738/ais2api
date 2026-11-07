// Backend seam for the no-browser service.
//
// The coordinator talks to the no-browser service only through `Backend`. Today the only implementation
// is `HttpBackend` (loopback 127.0.0.1:2048, see svc.rs). When the no-browser service is rewritten and
// merged into this process, it becomes a second implementation (e.g. `InProcessBackend`) registered in
// `select()`; nothing else in the coordinator changes.
//
// Contract (same as the HTTP API of the service today):
// - request(): streaming OpenAI / Gemini generation pinned to one account (by login e-mail).
//   Returns a hyper response whose body streams the upstream bytes unchanged.
// - call():    buffered JSON request (models list, anti-truncation rounds, account test).
// - raw():     Build channel operation {op: submit|rpc|upload|file, ...} -> {s, t, path?, data?}.
// - reload():  account directories changed (import / delete / re-login): make the service pick them up.
//              HTTP backend = restart the systemd unit; an in-process backend would just rescan.
// - name():    shown in status / logs.
use crate::resp::Cancel;
use crate::svc::{CallRes, RawErr, Service};
use bytes::Bytes;
use hyper::body::Incoming;
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait Backend: Send + Sync {
    fn name(&self) -> &'static str;
    fn request<'a>(&'a self, cancel: &'a Arc<Cancel>, account: &'a str, method: &'a str, path: &'a str, body: Bytes)
        -> BoxFut<'a, Result<hyper::Response<Incoming>, String>>;
    fn call<'a>(&'a self, cancel: &'a Arc<Cancel>, account: &'a str, method: &'a str, path: &'a str, obj: Option<&'a Value>) -> BoxFut<'a, CallRes>;
    fn raw<'a>(&'a self, cancel: &'a Arc<Cancel>, call: &'a Value, deadline: Duration) -> BoxFut<'a, Result<Value, RawErr>>;
    fn reload<'a>(&'a self) -> BoxFut<'a, Result<(), String>>;
}

/// Loopback HTTP to the separate no-browser service process.
pub struct HttpBackend {
    svc: Service,
    unit: String,
}
impl HttpBackend {
    pub fn open(dir: &str) -> Result<Self, String> {
        Ok(HttpBackend { svc: Service::from_files(dir)?, unit: std::env::var("HEADLESS_UNIT").unwrap_or_else(|_| "ais2api-headless".into()) })
    }
}
impl Backend for HttpBackend {
    fn name(&self) -> &'static str {
        "http"
    }
    fn request<'a>(&'a self, cancel: &'a Arc<Cancel>, account: &'a str, method: &'a str, path: &'a str, body: Bytes)
        -> BoxFut<'a, Result<hyper::Response<Incoming>, String>> {
        Box::pin(self.svc.request(cancel, account, method, path, body))
    }
    fn call<'a>(&'a self, cancel: &'a Arc<Cancel>, account: &'a str, method: &'a str, path: &'a str, obj: Option<&'a Value>) -> BoxFut<'a, CallRes> {
        Box::pin(self.svc.call(cancel, account, method, path, obj))
    }
    fn raw<'a>(&'a self, cancel: &'a Arc<Cancel>, call: &'a Value, deadline: Duration) -> BoxFut<'a, Result<Value, RawErr>> {
        Box::pin(self.svc.raw(cancel, call, deadline))
    }
    fn reload<'a>(&'a self) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move { crate::console::run(Duration::from_secs(30), "systemctl", &["restart", &self.unit]).await.map(|_| ()) })
    }
}

/// HEADLESS_BACKEND=http (default). Future: "inproc" -> the merged no-browser service.
pub fn select() -> Result<&'static dyn Backend, String> {
    let kind = std::env::var("HEADLESS_BACKEND").unwrap_or_else(|_| "http".into());
    let b: Box<dyn Backend> = match kind.as_str() {
        "http" => Box::new(HttpBackend::open("/opt/as2a-nb")?),
        other => return Err(format!("unknown HEADLESS_BACKEND {}", other)),
    };
    // lives for the whole process (shared by detached tasks such as Build cancellation)
    Ok(Box::leak(b))
}