// Login service listener (127.0.0.1:8894) + loopback coordinator client.
// When merged, main() installs an in-process CoordFn instead of loopback_coord().
use crate::login_http::{handle, BODY_MAX, KEY};
use crate::login_jobs::{CoordFn, COORD};
use crate::resp::OutBody;
use crate::util::*;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use hyper_util::rt::{TokioExecutor, TokioIo};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
/// coordinator reached over loopback HTTP (login-service.js coord())
pub fn loopback_coord(base: &str) -> CoordFn {
    let mut conn = HttpConnector::new();
    conn.set_connect_timeout(Some(Duration::from_secs(5)));
    let hc: Client<HttpConnector, Full<Bytes>> = Client::builder(TokioExecutor::new()).pool_max_idle_per_host(0).build(conn);
    let base = base.to_string();
    Arc::new(move |method: String, path: String, body: Option<Value>, timeout: u64| {
        let hc = hc.clone();
        let url = format!("{}{}", base, path);
        Box::pin(async move {
            let payload = body.map(|b| js_bytes(&b)).unwrap_or_default();
            let Ok(req) = hyper::Request::builder().method(method.as_str()).uri(url).header("Authorization", format!("Bearer {}", *KEY))
                .header("Content-Type", "application/json").body(Full::new(Bytes::from(payload))) else { return (0, Value::Null) };
            let run = async {
                let r = hc.request(req).await.ok()?;
                let s = r.status().as_u16();
                let b = r.into_body().collect().await.ok()?.to_bytes();
                Some((s, serde_json::from_slice(&b).unwrap_or(Value::Null)))
            };
            match tokio::time::timeout(Duration::from_secs(timeout), run).await {
                Ok(Some(x)) => x,
                _ => (0, Value::Null),
            }
        })
    })
}
pub fn install_coord(f: CoordFn) {
    *COORD.lock().unwrap() = Some(f);
}
/// body limited to max bytes (None = too large / broken)
pub async fn read_body(mut b: Incoming, max: usize) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    while let Some(f) = b.frame().await {
        let f = f.ok()?;
        if let Ok(d) = f.into_data() {
            out.extend_from_slice(&d);
            if out.len() > max {
                return None;
            }
        }
    }
    Some(out)
}
pub async fn serve_req(req: hyper::Request<Incoming>) -> hyper::Response<OutBody> {
    let (p, b) = req.into_parts();
    let auth = p.headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let body = if p.method == hyper::Method::GET || p.method == hyper::Method::HEAD { Some(Vec::new()) } else { read_body(b, BODY_MAX).await };
    let (code, v) = handle(p.method.as_str(), p.uri.path(), &auth, body.as_deref()).await;
    hyper::Response::builder().status(code).header("Content-Type", "application/json").header("Cache-Control", "no-store")
        .body(OutBody::full(js_bytes(&v))).unwrap()
}
/// accept loop; returns when stop resolves
pub async fn serve(addr: &str, stop: impl std::future::Future<Output = ()>) -> Result<(), String> {
    let ln = tokio::net::TcpListener::bind(addr).await.map_err(|e| format!("{}: {}", addr, e))?;
    log(format!("login service on {}", addr));
    tokio::pin!(stop);
    loop {
        tokio::select! {
            r = ln.accept() => {
                let Ok((sock, _)) = r else { continue };
                tokio::spawn(async move {
                    let svc = service_fn(|req| async move { Ok::<_, std::convert::Infallible>(serve_req(req).await) });
                    let _ = http1::Builder::new().timer(hyper_util::rt::TokioTimer::new()).header_read_timeout(Duration::from_secs(30))
                        .serve_connection(TokioIo::new(sock), svc).await;
                });
            }
            _ = &mut stop => return Ok(()),
        }
    }
}
/// background work of the login service: job sweeper; loops=false for side-by-side tests (no automatic logins)
pub fn start_background(loops: bool) {
    tokio::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            crate::login_jobs::sweep();
        }
    });
    if loops {
        crate::login_nightly::start();
    }
}
