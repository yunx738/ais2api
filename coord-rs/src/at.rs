// anti-truncation/<model> (headless-at.js, at-plain.js, at-prompt-store.js).
use crate::util::*;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::Mutex;

pub const AT_TOOL: &str = "seal_final_reply";
const NAMES: [&str; 3] = ["seal_final_reply", "final_answer", "emit_answer"];
const MAX_ATTEMPTS: i64 = 3;
const MAX_RETRIES: i64 = 3;
const DEADLINE_MS: i64 = 360_000;
const STOP_MIN: usize = 2000;
const EMPTY_DELAY_MS: u64 = 3000;
const KEYS: [&str; 5] = ["classic", "once", "tool_only", "lite", "custom"];

#[derive(Clone)]
pub struct AtPreset {
    pub desc: String,
    pub hint: String,
    pub cont: String,
}

// ---------------- prompt store ----------------
struct PInner {
    value: String,
    custom: Option<Value>,
}
pub struct AtPromptStore {
    file: String,
    defaults: Value,
    presets: Vec<Value>,
    inner: Mutex<PInner>,
}

impl AtPromptStore {
    pub fn open(file: &str, defaults_file: &str) -> Result<Self, String> {
        let defaults = read_json(defaults_file).ok().filter(|v| v.is_object()).ok_or("at-prompt-defaults.json unreadable")?;
        let labels = [
            ("classic", "原版", "原来的提示词，只要求用工具交答案"),
            ("once", "只交一次（推荐）", "明确要求只用工具交一次，不许再用正文写一遍，也不许把调用写成文字"),
            ("tool_only", "只许工具调用", "回复里除了这一次工具调用不许有任何文字，最严格"),
            ("lite", "精简", "一句话版本，占用最少的提示词"),
            ("custom", "自定义", "用下面编辑框里的内容；{tool} 会换成工具名，{partial} 是续写时上一轮没交完的内容"),
        ];
        let presets = labels.iter().map(|(k, l, n)| {
            let mut p = json!({"key":k,"label":l,"note":n});
            let d = defaults.g("presets").g(k);
            if d.is_object() {
                let m = p.as_object_mut().unwrap();
                m.insert("desc".into(), d.g("desc").clone());
                m.insert("hint".into(), d.g("hint").clone());
                m.insert("cont".into(), defaults.g("cont").clone());
            }
            p
        }).collect();
        let s = AtPromptStore { file: file.into(), defaults, presets, inner: Mutex::new(PInner { value: "classic".into(), custom: None }) };
        if let Ok(d) = read_json(file) {
            let mut i = s.inner.lock().unwrap();
            if d.g("custom").is_object() {
                i.custom = s.valid_custom(d.g("custom")).ok();
            }
            let p = d.s("preset");
            if KEYS.contains(&p) && (p != "custom" || i.custom.is_some()) {
                i.value = p.into();
            }
        }
        Ok(s)
    }
    fn valid_custom(&self, c: &Value) -> R<Value> {
        if !c.is_object() {
            return herr(400, "自定义提示词格式不对");
        }
        let mut out = Map::new();
        for (k, lim) in [("desc", 1000usize), ("hint", 6000), ("cont", 2000)] {
            let v = if !c.has(k) && k == "cont" { self.defaults.g("cont").clone() } else { c.g(k).clone() };
            let Some(s) = v.as_str() else { return herr(400, format!("{} 必须是文字", k)) };
            if js_len(s) > lim {
                return herr(400, format!("{} 太长（最多 {} 字）", k, lim));
            }
            out.insert(k.into(), json!(s.replace("\r\n", "\n")));
        }
        if out.s("desc").trim().is_empty() {
            return herr(400, "工具说明（desc）不能为空");
        }
        if out.s("hint").trim().is_empty() {
            return herr(400, "系统提示词（hint）不能为空");
        }
        let v = Value::Object(out);
        if js(&v).len() > 8000 {
            return herr(400, "自定义提示词总共太长（最多约 8000 字节）");
        }
        Ok(v)
    }
    fn key(i: &PInner) -> String {
        if KEYS.contains(&i.value.as_str()) && (i.value != "custom" || i.custom.is_some()) { i.value.clone() } else { "classic".into() }
    }
    pub fn preset(&self) -> AtPreset {
        let i = self.inner.lock().unwrap();
        let fill = |t: &str| t.replace("{tool}", AT_TOOL);
        let k = Self::key(&i);
        if k == "custom" {
            let c = i.custom.as_ref().unwrap();
            let cont = if c.s("cont").is_empty() { self.defaults.s("cont") } else { c.s("cont") };
            return AtPreset { desc: fill(c.s("desc")), hint: fill(c.s("hint")), cont: cont.into() };
        }
        let mut p = self.defaults.g("presets").g(&k);
        if !p.is_object() {
            p = self.defaults.g("presets").g("classic");
        }
        AtPreset { desc: fill(p.s("desc")), hint: fill(p.s("hint")), cont: self.defaults.s("cont").into() }
    }
    fn status_of(&self, i: &PInner) -> Value {
        json!({"preset":Self::key(i),"default":"classic","presets":self.presets,"custom":i.custom.clone().unwrap_or(Value::Null),
            "limits":{"desc":1000,"hint":6000,"cont":2000,"bytes":8000},
            "placeholders":{"tool":"工具名 seal_final_reply","partial":"续写时：上一轮没交完的内容（没有就为空）"}})
    }
    pub fn status(&self) -> Value {
        self.status_of(&self.inner.lock().unwrap())
    }
    pub fn set(&self, b: &Value) -> R<Value> {
        let v = b.s("preset").to_string();
        if !KEYS.contains(&v.as_str()) {
            return herr(400, format!("提示词只能是 {} 之一", KEYS.join("、")));
        }
        let mut i = self.inner.lock().unwrap();
        let custom = if !b.g("custom").is_null() { Some(self.valid_custom(b.g("custom"))?) } else { i.custom.clone() };
        if v == "custom" && custom.is_none() {
            return herr(400, "选“自定义”前先填写自定义提示词");
        }
        let data = json!({"preset":v,"custom":custom.clone().unwrap_or(Value::Null)});
        write_atomic(&self.file, &js_bytes(&data), 0o600, true).map_err(|e| HttpErr::plain(e.to_string()))?;
        i.value = v;
        i.custom = custom;
        Ok(self.status_of(&i))
    }
    pub fn import(&self, b: &Value) -> R<Value> {
        let d = if b.s("format") == "ais2api-at-prompt" {
            b.clone()
        } else if b.g("hint").is_string() {
            json!({"preset":"custom","custom":b})
        } else {
            return herr(400, "不是防截断提示词导出文件");
        };
        let p = if KEYS.contains(&d.s("preset")) { d.s("preset") } else { "custom" };
        self.set(&json!({"preset":p,"custom":d.g("custom")}))
    }
    pub fn export(&self) -> Value {
        let i = self.inner.lock().unwrap();
        let c = i.custom.clone().unwrap_or_else(|| {
            let o = self.defaults.g("presets").g("once");
            json!({"desc":o.g("desc"),"hint":o.g("hint"),"cont":self.defaults.g("cont")})
        });
        let ts = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        json!({"format":"ais2api-at-prompt","version":1,"exportedAt":ts,"preset":Self::key(&i),"custom":c})
    }
}

// ---------------- loop ----------------
fn inject(body: &Map<String, Value>, p: &AtPreset) -> Map<String, Value> {
    let mut b = body.clone();
    b.insert("stream".into(), json!(false));
    b.shift_remove("stream_options");
    let mut tools: Vec<Value> = b.a("tools").iter().filter(|t| !NAMES.contains(&t.g("function").s("name"))).cloned().collect();
    tools.push(json!({"type":"function","function":{"name":AT_TOOL,"description":p.desc,
        "parameters":{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}}}));
    b.insert("tools".into(), Value::Array(tools));
    let mut msgs = b.a("messages").to_vec();
    let idx = msgs.iter().position(|m| m.s("role") == "system");
    match idx.and_then(|i| msgs[i].g("content").as_str().map(|c| (i, c.to_string()))) {
        Some((i, c)) => {
            msgs[i].as_object_mut().unwrap().insert("content".into(), json!(format!("{}\n\n{}", c, p.hint)));
        }
        None => msgs.insert(0, json!({"role":"system","content":p.hint})),
    }
    b.insert("messages".into(), Value::Array(msgs));
    b
}

struct X {
    found: bool,
    answer: String,
    finish: String,
    plain: String,
    calls: Vec<Value>,
    reasoning: String,
}
fn extract(r: &Value) -> X {
    let c = r.a("choices").first().cloned().unwrap_or(Value::Null);
    let m = c.g("message");
    let mut x = X { found: false, answer: String::new(), finish: c.s("finish_reason").into(), plain: m.s("content").into(), calls: m.a("tool_calls").to_vec(), reasoning: String::new() };
    for tc in &x.calls {
        let f = tc.g("function");
        if !NAMES.contains(&f.s("name")) {
            continue;
        }
        let args = if f.s("arguments").is_empty() { "{}" } else { f.s("arguments") };
        if let Ok(a) = serde_json::from_str::<Value>(args) {
            if let Some(s) = a.g("answer").as_str() {
                x.answer = s.into();
                x.found = true;
            }
        }
    }
    if truthy(m.g("reasoning_content")) {
        x.reasoning = js_string(m.g("reasoning_content"));
    }
    x
}

#[derive(Default)]
struct Sum {
    incomplete: bool,
    prompt: Option<i64>,
    completion: Option<i64>,
    total: Option<i64>,
    cached: Option<i64>,
    reasoning: Option<i64>,
}
fn addo(p: &mut Option<i64>, v: Option<i64>) {
    if let Some(v) = v {
        *p = Some(p.unwrap_or(0) + v);
    }
}
impl Sum {
    fn add(&mut self, u: &Value) {
        if !u.is_object() {
            self.incomplete = true;
            return;
        }
        addo(&mut self.prompt, as_count(u.g("prompt_tokens")));
        addo(&mut self.completion, as_count(u.g("completion_tokens")));
        addo(&mut self.total, as_count(u.g("total_tokens")));
        addo(&mut self.cached, as_safe_int(u.g("prompt_tokens_details").g("cached_tokens")));
        addo(&mut self.reasoning, as_safe_int(u.g("completion_tokens_details").g("reasoning_tokens")));
    }
    fn out(&self) -> Option<Value> {
        if self.incomplete {
            return None;
        }
        let p = self.prompt?;
        let c = self.completion.unwrap_or(0);
        let t = self.total.filter(|t| *t != 0).unwrap_or(p + c);
        let mut u = json!({"prompt_tokens":p,"completion_tokens":c,"total_tokens":t});
        let m = u.as_object_mut().unwrap();
        if let Some(x) = self.cached {
            m.insert("prompt_tokens_details".into(), json!({"cached_tokens":x}));
        }
        if let Some(x) = self.reasoning {
            m.insert("completion_tokens_details".into(), json!({"reasoning_tokens":x}));
        }
        Some(u)
    }
}

pub struct CallResult {
    pub status: u16,
    pub json: Value,
    pub text: String,
    pub retry_after: String,
}

pub struct AtResult {
    pub ok: bool,
    pub answer: String,
    pub reasoning: String,
    pub usage: Option<Value>,
    pub rounds: i64,
    pub status: u16,
    pub payload: Value,
    pub upstream: bool,
    pub retry_after: String,
    pub cancelled: bool,
}
impl AtResult {
    fn fail(status: u16, payload: Value) -> Self {
        AtResult { ok: false, answer: String::new(), reasoning: String::new(), usage: None, rounds: 0, status, payload, upstream: false, retry_after: String::new(), cancelled: false }
    }
}
fn at_err(status: u16, typ: &str, st: &str, msg: &str, usage: Option<Value>) -> Value {
    let mut p = json!({"error":{"code":status,"type":typ,"status":st,"message":msg}});
    if let Some(u) = usage {
        p.as_object_mut().unwrap().insert("usage".into(), u);
    }
    p
}

/// call(body) performs one upstream request; cancelled() reports client cancellation.
pub async fn run<F, Fut>(call: F, cancelled: impl Fn() -> bool, body: &Map<String, Value>, p: &AtPreset) -> AtResult
where
    F: Fn(Map<String, Value>) -> Fut,
    Fut: std::future::Future<Output = CallResult>,
{
    let base = inject(body, p);
    let t0 = now_ms();
    let mut sum = Sum::default();
    let (mut attempt, mut retries) = (0i64, 0i64);
    let mut cur = base.clone();
    let mut last_partial = String::new();
    let mut first = true;
    loop {
        if cancelled() {
            let mut r = AtResult::fail(499, Value::Null);
            r.cancelled = true;
            return r;
        }
        let r = call(cur.clone()).await;
        if r.status != 200 {
            if first {
                let pl = if r.json.is_object() { r.json.clone() } else { json!({"error":{"message":clip_runes(&r.text, 500)}}) };
                let mut x = AtResult::fail(r.status, pl);
                x.upstream = true;
                x.retry_after = r.retry_after;
                return x;
            }
            let m = r.json.g("error").s("message");
            let m = if m.is_empty() { r.text.as_str() } else { m };
            return AtResult::fail(502, at_err(502, "upstream_incomplete", &format!("CONTINUATION_{}", r.status), &format!("续写请求失败（{}）：{}", r.status, clip_runes(m, 200)), None));
        }
        first = false;
        sum.add(r.json.g("usage"));
        attempt += 1;
        let x = extract(&r.json);
        let elapsed = now_ms() - t0;
        log(format!("[HL-AT] round {} finish={} seal={} plain={} calls={} ms={}", attempt, if x.finish.is_empty() { "-" } else { &x.finish },
            if x.found { format!("yes({})", js_len(&x.answer)) } else { "no".into() }, js_len(&x.plain), x.calls.len(), elapsed));
        let done = |answer: String| AtResult { ok: true, answer, reasoning: x.reasoning.clone(), usage: sum.out(), rounds: attempt, status: 200,
            payload: Value::Null, upstream: false, retry_after: String::new(), cancelled: false };
        if x.found && x.finish != "content_filter" && (x.finish == "stop" || x.finish == "tool_calls" || !x.answer.trim().is_empty()) {
            return done(x.answer.clone());
        }
        if !x.found && x.finish == "stop" && x.calls.is_empty() && js_len(x.plain.trim()) >= STOP_MIN {
            return done(clean_plain_answer(&x.plain).0);
        }
        let u = sum.out();
        if x.finish == "content_filter" {
            let uu = u.map(|u| json!({"prompt_tokens":u.g("prompt_tokens")}));
            return AtResult::fail(502, at_err(502, "content_blocked", "SAFETY", "上游内容安全拦截：模型拒绝生成，本次没有输出。这类拦截有时是误判，可以直接重试；多次被拦请调整内容。", uu));
        }
        let mut resend = false;
        if !x.found && x.plain.is_empty() && x.calls.is_empty() && elapsed < DEADLINE_MS && retries < MAX_RETRIES {
            retries += 1;
            resend = true;
            elog(format!("[HL-AT] empty reply; resending original {}/{}", retries, MAX_RETRIES));
            tokio::time::sleep(std::time::Duration::from_millis(EMPTY_DELAY_MS)).await;
        }
        if !resend && (attempt >= MAX_ATTEMPTS || elapsed >= DEADLINE_MS) {
            let chars = js_len(&x.answer).max(js_len(&x.plain));
            let late = elapsed >= DEADLINE_MS;
            let f = if x.finish.is_empty() { "NO_ANSWER".to_string() } else { x.finish.clone() };
            let (msg, st) = if late {
                (format!("已用时约 {} 分钟仍未得到完整答案，超过 6 分钟不再续写，直接返回失败。已生成约 {} 字被丢弃，可重试。", (elapsed as f64 / 60000.0).round() as i64, chars), "AT_TIME_LIMIT".to_string())
            } else {
                (format!("上游中途结束（finish={}），未返回内容。已生成约 {} 字被丢弃，可重试。", f, chars), format!("FINISH_{}", f.to_uppercase()))
            };
            let uu = u.map(|u| json!({"prompt_tokens":u.g("prompt_tokens"),"completion_tokens":u.g("completion_tokens")}));
            return AtResult::fail(502, at_err(502, "upstream_incomplete", &st, &msg, uu));
        }
        if resend {
            attempt = 0;
            cur = base.clone();
            last_partial.clear();
            continue;
        }
        let prev = if !x.answer.is_empty() && js_len(&x.answer) >= js_len(&x.plain) { x.answer.clone() } else { x.plain.clone() };
        if !prev.is_empty() {
            last_partial = prev;
        }
        let mut msgs = cur.a("messages").to_vec();
        let m = r.json.a("choices").first().map(|c| c.g("message").clone()).unwrap_or(Value::Null);
        let tcs = m.a("tool_calls").to_vec();
        if truthy(m.g("content")) || !tcs.is_empty() {
            let mut am = json!({"role":"assistant","content":if truthy(m.g("content")) {m.g("content").clone()} else {Value::Null}});
            if !tcs.is_empty() {
                am.as_object_mut().unwrap().insert("tool_calls".into(), Value::Array(tcs.clone()));
            }
            msgs.push(am);
            for tc in &tcs {
                msgs.push(json!({"role":"tool","tool_call_id":tc.g("id"),"content":"{\"status\":\"incomplete\"}"}));
            }
        }
        let partial = if last_partial.is_empty() { String::new() } else { format!("Previous partial answer: {}\n\n", last_partial) };
        msgs.push(json!({"role":"user","content":p.cont.replace("{tool}", AT_TOOL).replace("{partial}", &partial)}));
        cur.insert("messages".into(), Value::Array(msgs));
        cur.shift_remove("max_tokens");
        cur.shift_remove("max_completion_tokens");
        log(format!("[HL-AT] continuing (attempt {}/{})", attempt + 1, MAX_ATTEMPTS));
    }
}

// ---------------- at-plain.js ----------------
static RE_CALL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(concat!(
        r#"(?:◁[^▷\n]{0,24}▷\s*)?(?:`{3}[a-z]*\s*)?(?:\[\s*)?(?:\{\s*"name"\s*:\s*"(?:seal_final_reply|final_answer|emit_answer)"\s*,\s*"(?:arguments|args|parameters)"\s*:\s*)?"#,
        r#"(?:\b(?:(?:seal_final_reply|final_answer|emit_answer)|print\(default_api\.(?:seal_final_reply|final_answer|emit_answer)|default_api\.(?:seal_final_reply|final_answer|emit_answer))\s*\(?\s*)?\{\s*"answer"\s*:\s*""#,
        r#"|\b(?:seal_final_reply|final_answer|emit_answer)\s*\(\s*answer\s*=\s*""#
    )).unwrap()
});

/// JSON-ish string decode starting at the opening quote (byte index). Returns (text, ended).
fn decode_json_string(src: &str, q: usize) -> (String, bool) {
    let mut out: Vec<u16> = vec![];
    let b = src.as_bytes();
    let mut j = q + 1;
    while j < b.len() {
        let ch = b[j];
        if ch == b'"' {
            return (String::from_utf16_lossy(&out), true);
        }
        if ch == b'\\' && j + 1 < b.len() {
            let e = b[j + 1];
            match e {
                b'n' => out.push(10),
                b't' => out.push(9),
                b'r' => out.push(13),
                b'b' => out.push(8),
                b'f' => out.push(12),
                b'u' if j + 6 <= b.len() && src.get(j + 2..j + 6).map(|h| h.chars().all(|c| c.is_ascii_hexdigit())).unwrap_or(false) => {
                    out.push(u16::from_str_radix(&src[j + 2..j + 6], 16).unwrap());
                    j += 4;
                }
                _ => {
                    let c = src[j + 1..].chars().next().unwrap();
                    let mut buf = [0u16; 2];
                    out.extend_from_slice(c.encode_utf16(&mut buf));
                    j += c.len_utf8() - 1;
                }
            }
            j += 2;
            continue;
        }
        let c = src[j..].chars().next().unwrap();
        let mut buf = [0u16; 2];
        out.extend_from_slice(c.encode_utf16(&mut buf));
        j += c.len_utf8();
    }
    (String::from_utf16_lossy(&out), false)
}

pub fn clean_plain_answer(plain: &str) -> (String, &'static str) {
    let literal_nl = plain.matches("\\n").count();
    if let Some(m) = RE_CALL.find(plain) {
        let q = m.end() - 1;
        let (dec, ended) = decode_json_string(plain, q);
        let before = plain[..m.start()].trim_end();
        let bt = js_len(before.trim());
        let dt = js_len(dec.trim());
        if !ended && bt > dt {
            return (before.into(), "cut-before-call");
        }
        if dt as f64 >= 200f64.max(bt as f64 * 0.5) {
            return (dec, "decoded-call");
        }
        if bt > 0 {
            return (before.into(), "cut-before-call");
        }
    }
    if literal_nl >= 10 {
        let k = plain.find("\\n").unwrap();
        let st = plain[..k].rfind('\n').map(|i| i + 1).unwrap_or(0);
        let head = plain[..st].trim_end();
        let tail = &plain[st..];
        let tail_nl = tail.matches("\\n").count();
        if js_len(head.trim()) >= 1000 && tail_nl >= 10 && (tail.split('\n').count() as f64) <= 3.0 + tail_nl as f64 / 50.0 {
            return (head.into(), "cut-escaped-tail");
        }
    }
    (plain.into(), "as-is")
}