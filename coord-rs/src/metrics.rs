// Passive response observer (response-metrics.js), usage normalisation and cost estimate (usage-metrics.js),
// execution result types shared by scheduler/forward/history.
use crate::util::*;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub struct Usage {
    pub input: Option<i64>,
    pub output: Option<i64>,
    pub cached: Option<i64>,
    pub reasoning: Option<i64>,
    pub total: Option<i64>,
    pub format: &'static str,
    pub source: String,
    pub reasoning_included: bool,
    pub valid_cache: bool,
}
impl Usage {
    pub fn json(&self) -> Value {
        json!({"input":self.input,"output":self.output,"cached":self.cached,"reasoning":self.reasoning,"total":self.total,
            "format":self.format,"source":self.source,"reasoningIncludedInOutput":self.reasoning_included,"validCache":self.valid_cache})
    }
}

pub fn normalize_usage(o: &Value) -> Option<Usage> {
    if !o.is_object() {
        return None;
    }
    let nat = truthy(o.g("usageMetadata"));
    let u = if nat { o.g("usageMetadata") } else { o.g("usage") };
    if !u.is_object() {
        return None;
    }
    let c = |k: &str| as_count(u.g(k));
    let (input, output, cached, mut reasoning, total) = if nat {
        (c("promptTokenCount"), c("candidatesTokenCount"), c("cachedContentTokenCount"), c("thoughtsTokenCount"), c("totalTokenCount"))
    } else {
        (
            c("prompt_tokens"),
            c("completion_tokens"),
            as_count(u.g("prompt_tokens_details").g("cached_tokens")),
            as_count(u.g("completion_tokens_details").g("reasoning_tokens")),
            c("total_tokens"),
        )
    };
    if input.is_none() && output.is_none() && cached.is_none() && reasoning.is_none() && total.is_none() {
        return None;
    }
    if nat && reasoning.is_none() && input.is_some() {
        reasoning = Some(0);
    }
    let mut output = output;
    if output.is_none() {
        if let (Some(i), Some(t)) = (input, total) {
            let d = t - i - if nat { reasoning.unwrap_or(0) } else { 0 };
            if d >= 0 {
                output = Some(d);
            }
        }
    }
    Some(Usage {
        input,
        output,
        cached,
        reasoning,
        total,
        format: if nat { "gemini" } else { "openai" },
        source: "response-reported-unverified".into(),
        reasoning_included: !nat,
        valid_cache: match (cached, input) {
            (Some(c), Some(i)) => c <= i,
            _ => true,
        },
    })
}

#[derive(Clone, Debug, Default)]
pub struct MetricsOut {
    pub usage: Option<Usage>,
    pub usage_complete: bool,
    pub first_byte_ms: Option<i64>,
    pub first_content_ms: Option<i64>,
    pub duration_ms: Option<i64>,
    pub transport_complete: bool,
    pub stream_done_seen: bool,
    pub application_error: bool,
    pub capture_limited: bool,
    pub malformed: bool,
    pub error_kind: String,
}

pub static RE_KIND: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9_]{1,40}$").unwrap());

pub struct Metrics {
    stream: bool,
    max: usize,
    started: i64,
    first_byte: Option<i64>,
    first_content: Option<i64>,
    buf: Vec<u8>,
    event: Vec<Vec<u8>>,
    event_bytes: usize,
    discard_event: bool,
    discard_line: bool,
    usage: Option<Usage>,
    complete: bool,
    limited: bool,
    malformed: bool,
    pub done: bool,
    app_err: bool,
    closed: bool,
    error_kind: String,
    duration: i64,
    out: Option<MetricsOut>,
}

impl Metrics {
    pub fn new(stream: bool) -> Self {
        Metrics {
            stream,
            max: 1_048_576,
            started: now_ms(),
            first_byte: None,
            first_content: None,
            buf: vec![],
            event: vec![],
            event_bytes: 0,
            discard_event: false,
            discard_line: false,
            usage: None,
            complete: false,
            limited: false,
            malformed: false,
            done: false,
            app_err: false,
            closed: false,
            error_kind: String::new(),
            duration: 0,
            out: None,
        }
    }
    fn accept(&mut self, v: &Value) {
        if let Value::Array(a) = v {
            for x in a {
                self.accept(x);
            }
            return;
        }
        if !v.is_object() {
            return;
        }
        if let Some(u) = normalize_usage(v) {
            self.usage = Some(u);
        }
        if truthy(v.g("error")) {
            self.app_err = true;
            let e = v.g("error");
            if e.is_object() && self.error_kind.is_empty() {
                let st = ["status", "type", "code"].iter().map(|k| e.g(k)).find(|x| truthy(x));
                if let Some(st) = st {
                    let s = js_string(st);
                    if RE_KIND.is_match(&s) {
                        self.error_kind = s;
                    }
                }
            }
        }
        let mut text = false;
        for c in v.a("choices") {
            for k in ["delta", "message"] {
                if c.g(k).g("content").as_str().map(|s| !s.is_empty()).unwrap_or(false) {
                    text = true;
                }
            }
        }
        for c in v.a("candidates") {
            for p in c.g("content").a("parts") {
                if p.g("text").as_str().map(|s| !s.is_empty()).unwrap_or(false) && p.g("thought") != &Value::Bool(true) {
                    text = true;
                }
            }
        }
        if text && self.first_content.is_none() {
            self.first_content = Some(now_ms() - self.started);
        }
    }
    fn parse(&mut self, b: &[u8]) {
        let t = trim_ascii(b);
        if t.is_empty() {
            return;
        }
        if t == b"[DONE]" {
            self.done = true;
            return;
        }
        match serde_json::from_slice::<Value>(b) {
            Ok(v) => self.accept(&v),
            Err(_) => self.malformed = true,
        }
    }
    fn line(&mut self, l: &[u8]) {
        let l = l.strip_suffix(b"\r").unwrap_or(l);
        if l.is_empty() {
            if !self.discard_event && !self.event.is_empty() {
                let joined = self.event.join(&b'\n');
                self.parse(&joined);
            }
            self.event.clear();
            self.event_bytes = 0;
            self.discard_event = false;
            return;
        }
        if self.discard_event || !l.starts_with(b"data:") {
            return;
        }
        let mut d = &l[5..];
        if d.first() == Some(&b' ') {
            d = &d[1..];
        }
        self.event_bytes += d.len() + 1;
        if self.event_bytes > self.max {
            self.limited = true;
            self.discard_event = true;
            self.event.clear();
            return;
        }
        self.event.push(d.to_vec());
    }
    fn feed(&mut self, mut b: &[u8]) {
        if !self.stream {
            if self.limited {
                return;
            }
            if self.buf.len() + b.len() > self.max {
                self.limited = true;
                self.buf.clear();
                return;
            }
            self.buf.extend_from_slice(b);
            return;
        }
        while !b.is_empty() {
            let nl = b.iter().position(|c| *c == b'\n');
            let part = match nl {
                Some(i) => &b[..i],
                None => b,
            };
            if !self.discard_line {
                if self.buf.len() + part.len() > self.max {
                    self.buf.clear();
                    self.discard_line = true;
                    self.discard_event = true;
                    self.event.clear();
                    self.limited = true;
                } else {
                    self.buf.extend_from_slice(part);
                }
            }
            let Some(i) = nl else { break };
            if !self.discard_line {
                let l = std::mem::take(&mut self.buf);
                self.line(&l);
            }
            self.buf.clear();
            self.discard_line = false;
            b = &b[i + 1..];
        }
    }
    pub fn write(&mut self, b: &[u8]) {
        if self.closed {
            return;
        }
        if !b.is_empty() && self.first_byte.is_none() {
            self.first_byte = Some(now_ms() - self.started);
        }
        self.feed(b);
    }
    pub fn finish(&mut self, complete: bool) -> MetricsOut {
        if !self.closed {
            if self.stream {
                if !self.buf.is_empty() && !self.discard_line {
                    let l = std::mem::take(&mut self.buf);
                    self.line(&l);
                }
                if complete {
                    self.line(b"");
                }
            } else if complete && !self.limited {
                let t = std::mem::take(&mut self.buf);
                let s = trim_start_ascii(&t);
                if s.starts_with(b"data:") || s.starts_with(b":") {
                    self.stream = true;
                    self.feed(&t);
                    if !self.buf.is_empty() {
                        let l = std::mem::take(&mut self.buf);
                        self.line(&l);
                    }
                    self.line(b"");
                } else {
                    self.parse(&t);
                }
            }
            self.closed = true;
            self.complete = complete;
            self.duration = now_ms() - self.started;
            self.buf = vec![];
            self.event = vec![];
        }
        if self.out.is_none() {
            self.out = Some(MetricsOut {
                usage: self.usage.clone(),
                usage_complete: self.usage.is_some() && (self.complete || self.done) && !self.limited && !self.malformed && !self.app_err,
                first_byte_ms: self.first_byte,
                first_content_ms: self.first_content,
                duration_ms: Some(self.duration),
                transport_complete: self.complete,
                stream_done_seen: self.done,
                application_error: self.app_err,
                capture_limited: self.limited,
                malformed: self.malformed,
                error_kind: self.error_kind.clone(),
            });
        }
        self.out.clone().unwrap()
    }
}

fn trim_ascii(b: &[u8]) -> &[u8] {
    let s = b.iter().position(|c| !c.is_ascii_whitespace()).unwrap_or(b.len());
    let e = b.iter().rposition(|c| !c.is_ascii_whitespace()).map(|i| i + 1).unwrap_or(s);
    &b[s..e.max(s)]
}
fn trim_start_ascii(b: &[u8]) -> &[u8] {
    let s = b.iter().position(|c| !c.is_ascii_whitespace()).unwrap_or(b.len());
    &b[s..]
}

// ---------------- execution results ----------------
#[derive(Clone, Debug)]
pub struct Rejection {
    pub status: u16,
    pub headers: Vec<(String, String)>, // lower-case names
    pub body: bytes::Bytes,
}
impl Rejection {
    pub fn header(&self, k: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }
}
#[derive(Clone, Debug, Default)]
pub struct ExecResult {
    pub status: u16,
    pub retry_after: String,
    pub metrics: Option<MetricsOut>,
    pub rejection: Option<Rejection>,
    pub uncertain: bool,
    pub cancelled: bool,
    pub worker_rejection: bool,
    /// the no-browser service reported this account's Google sign-in as expired (503 auth_required)
    pub auth_expired: bool,
}

// ---------------- prices / cost ----------------
#[derive(Clone, Debug)]
pub struct Price {
    pub currency: String,
    pub revision: String,
    pub input: Option<f64>,
    pub output: Option<f64>,
    pub cached: Option<f64>,
    pub reasoning: Option<f64>,
    pub reasoning_mode: String,
}

fn rate(o: &Value, k: &str) -> Result<Option<f64>, ()> {
    match o.get(k) {
        Some(Value::Null) => Ok(None),
        Some(v @ Value::Number(_)) => as_num(v).map(Some).ok_or(()),
        _ => Err(()),
    }
}
impl Price {
    pub fn from_value(o: &Value) -> Result<Price, String> {
        let p = Price {
            currency: o.s("currency").into(),
            revision: o.g("revision").as_str().ok_or("Invalid price metadata")?.into(),
            input: rate(o, "inputPerMillion").map_err(|_| "Invalid price rate")?,
            output: rate(o, "outputPerMillion").map_err(|_| "Invalid price rate")?,
            cached: rate(o, "cachedPerMillion").map_err(|_| "Invalid price rate")?,
            reasoning: rate(o, "reasoningPerMillion").map_err(|_| "Invalid price rate")?,
            reasoning_mode: o.s("reasoningMode").into(),
        };
        p.validate()?;
        Ok(p)
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.currency != "USD" || self.revision.is_empty() || !["included", "separate", "unknown"].contains(&self.reasoning_mode.as_str()) {
            return Err("Invalid price metadata".into());
        }
        for x in [self.input, self.output, self.cached, self.reasoning].into_iter().flatten() {
            if x < 0.0 || !x.is_finite() {
                return Err("Invalid price rate".into());
            }
        }
        Ok(())
    }
    fn r(x: Option<f64>) -> Value {
        x.map(num).unwrap_or(Value::Null)
    }
    /// priceSnapshot order (request records)
    pub fn json(&self) -> Value {
        json!({"currency":self.currency,"revision":self.revision,"inputPerMillion":Self::r(self.input),"outputPerMillion":Self::r(self.output),
            "cachedPerMillion":Self::r(self.cached),"reasoningPerMillion":Self::r(self.reasoning),"reasoningMode":self.reasoning_mode})
    }
    /// cleanPrice order (model-prices.json)
    pub fn file_json(&self) -> Value {
        json!({"currency":self.currency,"revision":self.revision,"reasoningMode":self.reasoning_mode,"inputPerMillion":Self::r(self.input),
            "outputPerMillion":Self::r(self.output),"cachedPerMillion":Self::r(self.cached),"reasoningPerMillion":Self::r(self.reasoning)})
    }
}

pub fn unknown_cost(reason: &str) -> Value {
    json!({"amount":null,"currency":"USD","estimated":true,"reason":reason})
}

/// estimateCost(usage, price); price: None = missing, Some(Err) = invalid.
pub fn estimate_cost(u: Option<&Usage>, price: Option<Result<Price, String>>) -> Value {
    let Some(u) = u else { return unknown_cost("usage_missing") };
    let p = match price {
        None => return unknown_cost("price_missing"),
        Some(Err(_)) => return unknown_cost("price_invalid"),
        Some(Ok(p)) => p,
    };
    let (Some(i), Some(o)) = (u.input, u.output) else { return unknown_cost("token_breakdown_missing") };
    let (Some(pi), Some(po)) = (p.input, p.output) else { return unknown_cost("rate_missing") };
    let mut v = i as f64 * pi + o as f64 * po;
    if !u.reasoning_included {
        match p.reasoning_mode.as_str() {
            "unknown" => return unknown_cost("reasoning_price_unknown"),
            "separate" => {
                let Some(r) = u.reasoning else { return unknown_cost("reasoning_count_missing") };
                if r > 0 && p.reasoning.is_none() {
                    return unknown_cost("reasoning_rate_missing");
                }
                v += r as f64 * p.reasoning.unwrap_or(0.0);
            }
            _ => {}
        }
    }
    let amount = v / 1e6;
    if !amount.is_finite() {
        return unknown_cost("cost_overflow");
    }
    json!({"amount":num(amount),"currency":p.currency,"estimated":true,"reason":null,"priceRevision":p.revision,"usageSource":u.source})
}