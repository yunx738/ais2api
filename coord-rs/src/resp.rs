// One client response (resp.go). Writes go through a channel to the hyper body, so no write ever blocks
// the scheduler. Early SSE mode: streams the coordinator buffers itself (anti-truncation, Build, fake
// streaming) are opened at once and kept alive; until the first real frame the stream is "soft", the
// scheduler may still retry, and errors become an OpenAI/Gemini stream error event.
use crate::metrics::{Metrics, Rejection};
use crate::util::*;
use bytes::Bytes;
use hyper::body::{Body, Frame, SizeHint};
use serde_json::{json, Value};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use tokio::sync::{mpsc, oneshot, Notify};

// ---------------- cancellation ----------------
pub struct Cancel {
    flag: AtomicBool,
    n: Notify,
}
impl Cancel {
    pub fn new() -> Arc<Cancel> {
        Arc::new(Cancel { flag: AtomicBool::new(false), n: Notify::new() })
    }
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.n.notify_waiters();
    }
    pub fn is(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
    pub async fn wait(&self) {
        loop {
            let f = self.n.notified();
            tokio::pin!(f);
            f.as_mut().enable();
            if self.is() {
                return;
            }
            f.await;
        }
    }
    /// child that is cancelled together with self
    pub fn child(self: &Arc<Self>) -> Arc<Cancel> {
        let c = Cancel::new();
        let (p, c2) = (self.clone(), c.clone());
        tokio::spawn(async move {
            tokio::select! {
                _ = p.wait() => c2.cancel(),
                _ = c2.wait() => {}
            }
        });
        c
    }
}

pub type Chunk = Result<Bytes, ()>;
pub struct Head {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub rx: mpsc::UnboundedReceiver<Chunk>,
}

struct Inner {
    status: u16,
    headers: Vec<(String, String)>,
    head_tx: Option<oneshot::Sender<Head>>,
    tx: Option<mpsc::UnboundedSender<Chunk>>,
    rx: Option<mpsc::UnboundedReceiver<Chunk>>,
    headers_sent: bool,
    ended: bool,
    destroyed: bool,
    soft: bool,
    sse_kind: String,
    sse_model: String,
    ka: u64,
    tap: Option<Arc<Mutex<Metrics>>>,
}
impl Inner {
    fn write_header(&mut self) {
        if self.headers_sent {
            return;
        }
        self.headers_sent = true;
        if let (Some(h), Some(rx)) = (self.head_tx.take(), self.rx.take()) {
            let _ = h.send(Head { status: self.status, headers: self.headers.clone(), rx });
        }
    }
    fn write(&mut self, b: &[u8], tap: bool) -> bool {
        if self.ended || self.destroyed {
            return false;
        }
        if !self.headers_sent {
            self.write_header();
        }
        if tap && !b.is_empty() {
            if let Some(t) = &self.tap {
                t.lock().unwrap().write(b);
            }
        }
        if b.is_empty() {
            return true;
        }
        match &self.tx {
            Some(tx) => tx.send(Ok(Bytes::copy_from_slice(b))).is_ok(),
            None => false,
        }
    }
    fn set_header(&mut self, k: &str, v: &str) {
        self.headers.retain(|(n, _)| !n.eq_ignore_ascii_case(k));
        self.headers.push((k.into(), v.into()));
    }
}

pub struct Resp {
    inner: Mutex<Inner>,
    pub cancel: Arc<Cancel>,
}

pub fn err_type(status: u16) -> &'static str {
    if status >= 500 {
        "upstream_error"
    } else if status == 429 {
        "rate_limit_error"
    } else {
        "invalid_request_error"
    }
}

impl Resp {
    pub fn new() -> (Arc<Resp>, oneshot::Receiver<Head>) {
        let (htx, hrx) = oneshot::channel();
        let (tx, rx) = mpsc::unbounded_channel();
        let r = Arc::new(Resp {
            inner: Mutex::new(Inner { status: 200, headers: vec![], head_tx: Some(htx), tx: Some(tx), rx: Some(rx), headers_sent: false, ended: false,
                destroyed: false, soft: false, sse_kind: String::new(), sse_model: String::new(), ka: 0, tap: None }),
            cancel: Cancel::new(),
        });
        (r, hrx)
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn headers_sent(&self) -> bool {
        self.lock().headers_sent
    }
    /// real output has begun (no retry possible)
    pub fn started(&self) -> bool {
        let i = self.lock();
        i.headers_sent && !i.soft
    }
    pub fn soft(&self) -> bool {
        self.lock().soft
    }
    pub fn gone(&self) -> bool {
        let i = self.lock();
        i.ended || i.destroyed
    }
    pub fn destroyed(&self) -> bool {
        self.lock().destroyed
    }
    pub fn sse_kind(&self) -> String {
        self.lock().sse_kind.clone()
    }
    pub fn set_header(&self, k: &str, v: &str) {
        self.lock().set_header(k, v);
    }
    pub fn set_status(&self, s: u16) {
        self.lock().status = s;
    }
    pub fn set_tap(&self, m: Arc<Mutex<Metrics>>) {
        self.lock().tap = Some(m);
    }
    pub fn write(&self, b: &[u8]) -> bool {
        self.lock().write(b, true)
    }
    pub fn end(&self, b: &[u8]) {
        let mut i = self.lock();
        if i.ended || i.destroyed {
            return;
        }
        i.write(b, true);
        i.ended = true;
        i.ka += 1;
        i.tx = None;
    }
    /// abort: nothing sent yet -> handler sees no head; otherwise the connection is cut (client sees truncation)
    pub fn destroy(&self) {
        {
            let mut i = self.lock();
            if i.ended || i.destroyed {
                return;
            }
            i.destroyed = true;
            i.ka += 1;
            if let Some(tx) = i.tx.take() {
                if i.headers_sent {
                    let _ = tx.send(Err(()));
                }
            }
            i.head_tx = None;
        }
        self.cancel.cancel();
    }
    fn client_gone(&self) {
        if !self.lock().ended {
            self.destroy();
        }
    }
    /// JSON reply, only when nothing was sent yet (soft stream -> error event)
    pub fn json(&self, status: u16, body: &Value, headers: &[(&str, &str)]) {
        let soft;
        {
            let mut i = self.lock();
            if i.headers_sent || i.ended || i.destroyed {
                soft = i.soft && !i.ended && !i.destroyed;
            } else {
                i.set_header("Content-Type", "application/json");
                for (k, v) in headers {
                    i.set_header(k, v);
                }
                i.status = status;
                drop(i);
                self.end(&js_bytes(body));
                return;
            }
        }
        if soft {
            self.stream_error(status, body);
        }
    }
    /// RequestScheduler.fail(): JSON error, stream error event, or connection abort
    pub fn fail(&self, status: u16, msg: &str) {
        let (gone, soft, sent) = {
            let i = self.lock();
            (i.ended || i.destroyed, i.soft, i.headers_sent)
        };
        if gone {
            return;
        }
        if soft {
            self.stream_error(status, &json!({"error":{"message":msg,"type":err_type(status),"code":status}}));
            return;
        }
        if sent {
            self.destroy();
            return;
        }
        self.json(status, &json!({"error":{"message":msg}}), &[]);
    }
    /// event stream before any content exists. kind: openai | gemini-sse | gemini-array
    pub fn open_sse(self: &Arc<Self>, kind: &str, model: &str) {
        let gen;
        {
            let mut i = self.lock();
            if i.headers_sent || i.ended || i.destroyed {
                return;
            }
            i.set_header("Content-Type", if kind == "gemini-array" { "application/json; charset=utf-8" } else { "text/event-stream; charset=utf-8" });
            i.set_header("Cache-Control", "no-cache");
            i.set_header("X-Accel-Buffering", "no");
            i.soft = true;
            i.sse_kind = kind.into();
            i.sse_model = model.into();
            i.status = 200;
            i.write_header();
            i.write(if kind == "gemini-array" { b"[" } else { b": stream-open\n\n" }, false);
            i.ka += 1;
            gen = i.ka;
        }
        let r = self.clone();
        tokio::spawn(async move {
            let start = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
            let mut iv = tokio::time::interval_at(start, std::time::Duration::from_secs(5));
            let id = format!("chatcmpl-{}", uuid4());
            let created = now_ms() / 1000;
            let mut n = 0u64;
            loop {
                iv.tick().await;
                n += 1;
                let mut i = r.lock();
                if i.ka != gen || !i.soft || i.ended || i.destroyed {
                    return;
                }
                if i.sse_kind == "openai" && n % 3 == 0 {
                    let f = json!({"id":id,"object":"chat.completion.chunk","created":created,"model":i.sse_model,
                        "choices":[{"index":0,"delta":{},"finish_reason":null}]});
                    let line = format!("data: {}\n\n", js(&f));
                    i.write(line.as_bytes(), false);
                } else if i.sse_kind == "gemini-array" {
                    i.write(b" ", false);
                } else {
                    i.write(b": keep-alive\n\n", false);
                }
            }
        });
    }
    /// real frames follow: no more retries / keep-alive
    pub fn commit(&self) {
        let mut i = self.lock();
        i.soft = false;
        i.ka += 1;
    }
    /// end a soft stream with an error event; payload is anything with an `error` object
    pub fn stream_error(&self, status: u16, payload: &Value) {
        let kind = {
            let mut i = self.lock();
            if i.ended || i.destroyed {
                return;
            }
            i.soft = false;
            i.ka += 1;
            i.sse_kind.clone()
        };
        let mut e = match payload.get("error") {
            Some(Value::Object(m)) => m.clone(),
            _ => json!({"message":format!("上游错误 ({})", status)}).as_object().unwrap().clone(),
        };
        if !e.contains_key("code") {
            e.insert("code".into(), json!(status));
        }
        if !e.contains_key("type") && kind == "openai" {
            e.insert("type".into(), json!(err_type(status)));
        }
        let out = js(&json!({"error":e}));
        if kind == "gemini-array" {
            self.end(format!("{}]", out).as_bytes());
        } else {
            self.end(format!("data: {}\n\n", out).as_bytes());
        }
    }
    pub fn respond_rejection(&self, rj: &Rejection) {
        if self.gone() {
            return;
        }
        if self.soft() {
            let v: Value = serde_json::from_slice(&rj.body).unwrap_or(Value::Null);
            let v = match v.get("error") {
                Some(Value::Object(_)) => v,
                Some(Value::String(s)) => json!({"error":{"message":s,"code":rj.status}}),
                _ => json!({"error":{"message":clip_runes(&String::from_utf8_lossy(&rj.body), 2000),"code":rj.status}}),
            };
            self.stream_error(rj.status, &v);
            return;
        }
        if self.headers_sent() {
            self.destroy();
            return;
        }
        {
            let mut i = self.lock();
            for k in ["content-type", "retry-after", "cache-control"] {
                if let Some(v) = rj.header(k) {
                    i.set_header(k, v);
                }
            }
            i.status = rj.status;
        }
        self.end(&rj.body);
    }
}

// ---------------- response body ----------------
pub struct OutBody {
    full: Option<Bytes>,
    rx: Option<mpsc::UnboundedReceiver<Chunk>>,
    guard: Option<Arc<Resp>>,
}
impl OutBody {
    pub fn full(b: impl Into<Bytes>) -> Self {
        OutBody { full: Some(b.into()), rx: None, guard: None }
    }
    pub fn stream(rx: mpsc::UnboundedReceiver<Chunk>, guard: Arc<Resp>) -> Self {
        OutBody { full: None, rx: Some(rx), guard: Some(guard) }
    }
}
impl Body for OutBody {
    type Data = Bytes;
    type Error = std::io::Error;
    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        if let Some(b) = self.full.take() {
            return Poll::Ready(Some(Ok(Frame::data(b))));
        }
        match self.rx.as_mut() {
            None => Poll::Ready(None),
            Some(rx) => match rx.poll_recv(cx) {
                Poll::Ready(Some(Ok(b))) => Poll::Ready(Some(Ok(Frame::data(b)))),
                Poll::Ready(Some(Err(()))) => Poll::Ready(Some(Err(std::io::Error::other("aborted")))),
                Poll::Ready(None) => Poll::Ready(None),
                Poll::Pending => Poll::Pending,
            },
        }
    }
    fn is_end_stream(&self) -> bool {
        self.full.is_none() && self.rx.is_none()
    }
    fn size_hint(&self) -> SizeHint {
        match (&self.full, &self.rx) {
            (Some(b), None) => SizeHint::with_exact(b.len() as u64),
            (None, None) => SizeHint::with_exact(0),
            _ => SizeHint::default(),
        }
    }
}
impl Drop for OutBody {
    fn drop(&mut self) {
        if let Some(g) = &self.guard {
            g.client_gone();
        }
    }
}
/// destroys the response when the handler future is dropped (client left while queued)
pub struct RespGuard(pub Arc<Resp>, pub bool);
impl Drop for RespGuard {
    fn drop(&mut self) {
        if !self.1 {
            self.0.client_gone();
        }
    }
}