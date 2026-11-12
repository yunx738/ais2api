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
const DEADLINE_MS: i64 = 960_000;
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
    cap_round_tokens(&mut b);
    b
}

static RE_ARG_ANS: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\{\s*"answer"\s*:\s*""#).unwrap());
const AT_ROUND_MAX_TOKENS: i64 = 32768;

fn cap_round_tokens(b: &mut Map<String, Value>) {
    let mut capped = false;
    for k in ["max_tokens", "max_completion_tokens"] {
        if let Some(n) = as_safe_int(b.g(k)) {
            if n > AT_ROUND_MAX_TOKENS {
                b.insert(k.into(), json!(AT_ROUND_MAX_TOKENS));
            }
            capped = true;
        }
    }
    if !capped {
        b.insert("max_tokens".into(), json!(AT_ROUND_MAX_TOKENS));
    }
}

struct X {
    found: bool,
    answer: String,
    partial: String,
    finish: String,
    plain: String,
    calls: Vec<Value>,
    ext_calls: Vec<Value>,
    reasoning: String,
}
fn extract(r: &Value) -> X {
    let c = r.a("choices").first().cloned().unwrap_or(Value::Null);
    let m = c.g("message");
    let mut x = X { found: false, answer: String::new(), partial: String::new(), finish: c.s("finish_reason").into(), plain: m.s("content").into(), calls: m.a("tool_calls").to_vec(), ext_calls: vec![], reasoning: String::new() };
    for tc in &x.calls {
        let f = tc.g("function");
        let name = f.s("name");
        if !NAMES.contains(&name) {
            if !name.is_empty() {
                x.ext_calls.push(tc.clone());
            }
            continue;
        }
        let args = if f.s("arguments").is_empty() { "{}" } else { f.s("arguments") };
        if let Ok(a) = serde_json::from_str::<Value>(args) {
            if let Some(s) = a.g("answer").as_str() {
                x.answer = s.into();
                x.found = true;
            }
        } else if let Some(mm) = RE_ARG_ANS.find(args) {
            let (dec, _) = decode_json_string(args, mm.end() - 1);
            if !dec.is_empty() {
                x.partial = dec;
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
    pub tool_calls: Vec<Value>,
    pub reasoning: String,
    pub usage: Option<Value>,
    pub rounds: i64,
    pub status: u16,
    pub payload: Value,
    pub upstream: bool,
    pub retry_after: String,
    pub cancelled: bool,
    /// non-empty when a salvaged (cut) answer is returned: "length" / "content_filter"
    pub finish: String,
}
impl AtResult {
    fn fail(status: u16, payload: Value) -> Self {
        AtResult { ok: false, answer: String::new(), tool_calls: vec![], reasoning: String::new(), usage: None, rounds: 0, status, payload, upstream: false, retry_after: String::new(), cancelled: false, finish: String::new() }
    }
}
fn at_err(status: u16, typ: &str, st: &str, msg: &str, usage: Option<Value>) -> Value {
    let mut p = json!({"error":{"code":status,"type":typ,"status":st,"message":msg}});
    if let Some(u) = usage {
        p.as_object_mut().unwrap().insert("usage".into(), u);
    }
    p
}

const AT_BUDGET_MS: i64 = 1_140_000;
const MIN_ROUND_MS: i64 = 90_000;
const SALVAGE_MIN: usize = 200;
const MAX_APPEND_ROUNDS: i64 = 5;
const APPEND_CONT: &str = "Your previous {tool} call was cut off by the output length limit. Everything written so far is saved and shown in your previous message (it ends with: \"{tail}\"). Do NOT repeat any of it. Continue writing from exactly where it stopped, then call {tool} with ONLY the new remaining part (key \"answer\"). If the answer was already complete, call {tool} with an empty string.";

fn tail_chars(s: &str, n: usize) -> String {
    let v: Vec<char> = s.chars().collect();
    v[v.len().saturating_sub(n)..].iter().collect()
}

/// Joins a saved (cut) answer with the next round's continuation, dropping any repeated overlap.
pub fn merge_segments(a: &str, b: &str) -> String {
    if b.trim().is_empty() {
        return a.into();
    }
    if a.trim().is_empty() {
        return b.into();
    }
    let head: String = a.chars().take(120).collect();
    if js_len(a) >= 200 && b.trim_start().starts_with(head.trim_start()) {
        return if js_len(b) >= js_len(a) { b.into() } else { a.into() };
    }
    for cand in [b, b.trim_start()] {
        let mut best = 0usize;
        for (n, (i, c)) in cand.char_indices().enumerate() {
            if n >= 4000 {
                break;
            }
            let end = i + c.len_utf8();
            if n + 1 >= 6 && a.ends_with(&cand[..end]) {
                best = end;
            }
        }
        if best > 0 {
            return format!("{}{}", a, &cand[best..]);
        }
    }
    format!("{}{}", a, b)
}

fn salvaged(answer: String, finish: &str, reasoning: String, usage: Option<Value>, rounds: i64, why: &str) -> AtResult {
    elog(format!("[HL-AT] salvaged {} chars after {} rounds ({}), returning finish={}", js_len(&answer), rounds, why, finish));
    AtResult { ok: true, answer, tool_calls: vec![], reasoning, usage, rounds, status: 200, payload: Value::Null, upstream: false, retry_after: String::new(), cancelled: false, finish: finish.into() }
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
    let mut saved = String::new();
    let mut reasoning = String::new();
    let mut first = true;
    loop {
        if cancelled() {
            let mut r = AtResult::fail(499, Value::Null);
            r.cancelled = true;
            return r;
        }
        let left = (AT_BUDGET_MS - (now_ms() - t0)).max(1000) as u64;
        let (r, timed_out) = match tokio::time::timeout(std::time::Duration::from_millis(left), call(cur.clone())).await {
            Ok(r) => (r, false),
            Err(_) => (CallResult { status: 504, json: json!({"error":{"message":"anti-truncation round ran out of time"}}), text: String::new(), retry_after: String::new() }, true),
        };
        if cancelled() {
            let mut r = AtResult::fail(499, Value::Null);
            r.cancelled = true;
            return r;
        }
        if r.status != 200 {
            if !saved.is_empty() {
                return salvaged(saved, "length", reasoning, sum.out(), attempt, &format!("continuation failed {}", r.status));
            }
            if first {
                let pl = if r.json.is_object() { r.json.clone() } else { json!({"error":{"message":clip_runes(&r.text, 500)}}) };
                let mut x = AtResult::fail(r.status, pl);
                x.upstream = !timed_out;
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
        if !x.reasoning.is_empty() {
            reasoning = x.reasoning.clone();
        }
        let elapsed = now_ms() - t0;
        log(format!("[HL-AT] round {} finish={} seal={} plain={} calls={} saved={} ms={}", attempt, if x.finish.is_empty() { "-" } else { &x.finish },
            if x.found { format!("yes({})", js_len(&x.answer)) } else if !x.partial.is_empty() { format!("cut({})", js_len(&x.partial)) } else { "no".into() }, js_len(&x.plain), x.calls.len(), js_len(&saved), elapsed));
        let done = |answer: String, tool_calls: Vec<Value>, sum: &Sum| AtResult { ok: true, answer, tool_calls, reasoning: reasoning.clone(), usage: sum.out(), rounds: attempt, status: 200,
            payload: Value::Null, upstream: false, retry_after: String::new(), cancelled: false, finish: String::new() };
        if x.found && x.finish != "content_filter" && (x.finish == "stop" || x.finish == "tool_calls" || !x.answer.trim().is_empty()) {
            return done(merge_segments(&saved, &x.answer), vec![], &sum);
        }
        if saved.is_empty() && !x.found && !x.ext_calls.is_empty() && x.calls.len() == x.ext_calls.len() && x.finish != "content_filter" && x.finish != "length" {
            return done(x.plain.clone(), x.ext_calls.clone(), &sum);
        }
        if !x.found && x.finish == "stop" && x.calls.is_empty() && (js_len(x.plain.trim()) >= STOP_MIN || (!saved.is_empty() && !x.plain.trim().is_empty())) {
            return done(merge_segments(&saved, &clean_plain_answer(&x.plain).0), vec![], &sum);
        }
        let u = sum.out();
        if x.finish == "content_filter" {
            if !saved.is_empty() {
                return salvaged(saved, "content_filter", reasoning, u, attempt, "content blocked mid-way");
            }
            let uu = u.map(|u| json!({"prompt_tokens":u.g("prompt_tokens")}));
            return AtResult::fail(502, at_err(502, "content_blocked", "SAFETY", "上游内容安全拦截：模型拒绝生成，本次没有输出。这类拦截有时是误判，可以直接重试；多次被拦请调整内容。", uu));
        }
        // cut by the output limit: keep what was written and only ask for the rest
        let cut = x.finish == "length" || x.finish == "max_tokens";
        if cut {
            let seg = if !x.partial.is_empty() {
                x.partial.clone()
            } else if !x.answer.is_empty() {
                x.answer.clone()
            } else if x.calls.is_empty() {
                clean_plain_answer(&x.plain).0
            } else {
                String::new()
            };
            if js_len(seg.trim()) >= if saved.is_empty() { SALVAGE_MIN } else { 1 } {
                saved = merge_segments(&saved, &seg);
            }
        }
        let mut resend = false;
        if !x.found && x.plain.is_empty() && x.calls.is_empty() && elapsed < DEADLINE_MS && retries < MAX_RETRIES {
            retries += 1;
            resend = true;
            elog(format!("[HL-AT] empty reply; resending {}/{}", retries, MAX_RETRIES));
            tokio::time::sleep(std::time::Duration::from_millis(EMPTY_DELAY_MS)).await;
        }
        let limit = if saved.is_empty() { MAX_ATTEMPTS } else { MAX_APPEND_ROUNDS };
        let out_of_time = elapsed >= DEADLINE_MS || AT_BUDGET_MS - elapsed < MIN_ROUND_MS;
        if !resend && (attempt >= limit || out_of_time) {
            if !saved.is_empty() {
                return salvaged(saved, "length", reasoning, u, attempt, if out_of_time { "time budget used up" } else { "round limit" });
            }
            let chars = js_len(&x.answer).max(js_len(&x.partial)).max(js_len(&x.plain));
            let f = if x.finish.is_empty() { "NO_ANSWER".to_string() } else { x.finish.clone() };
            let (msg, st) = if out_of_time {
                (format!("已用时约 {} 分钟仍未得到完整答案，超过 16 分钟不再续写，直接返回失败。已生成约 {} 字被丢弃，可重试。", (elapsed as f64 / 60000.0).round() as i64, chars), "AT_TIME_LIMIT".to_string())
            } else {
                (format!("上游中途结束（finish={}），未返回内容。已生成约 {} 字被丢弃，可重试。", f, chars), format!("FINISH_{}", f.to_uppercase()))
            };
            let uu = u.map(|u| json!({"prompt_tokens":u.g("prompt_tokens"),"completion_tokens":u.g("completion_tokens")}));
            return AtResult::fail(502, at_err(502, "upstream_incomplete", &st, &msg, uu));
        }
        if !saved.is_empty() {
            if resend {
                attempt -= 1;
                continue;
            }
            let mut msgs = base.a("messages").to_vec();
            msgs.push(json!({"role":"assistant","content":saved}));
            msgs.push(json!({"role":"user","content":APPEND_CONT.replace("{tool}", AT_TOOL).replace("{tail}", &tail_chars(&saved, 80))}));
            cur = base.clone();
            cur.insert("messages".into(), Value::Array(msgs));
            cur.shift_remove("max_completion_tokens");
            cur.insert("max_tokens".into(), json!(AT_ROUND_MAX_TOKENS));
            log(format!("[HL-AT] continuing from saved {} chars (round {}/{})", js_len(&saved), attempt + 1, MAX_APPEND_ROUNDS));
            continue;
        }
        if resend {
            attempt = 0;
            cur = base.clone();
            last_partial.clear();
            continue;
        }
        let best_ans = if !x.answer.is_empty() { &x.answer } else { &x.partial };
        let prev = if !best_ans.is_empty() && js_len(best_ans) >= js_len(&x.plain) { best_ans.clone() } else { x.plain.clone() };
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
        cur.shift_remove("max_completion_tokens");
        cur.insert("max_tokens".into(), json!(AT_ROUND_MAX_TOKENS));
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
#[cfg(test)]
mod tests {
    use super::*;
    fn dummy_preset() -> AtPreset {
        AtPreset { desc: "seal".into(), hint: "use {tool}".into(), cont: "{partial}continue {tool}".into() }
    }
    #[tokio::test]
    async fn at_caps_tokens_passes_ext_tools_and_recovers_partial_json() {
        // 1) max_tokens > 32768 is capped to 32768; external tool_calls pass straight through on round 1
        let mut req = Map::new();
        req.insert("model".into(), json!("gemini-4-argon"));
        req.insert("max_tokens".into(), json!(65535));
        req.insert("tools".into(), json!([{"type":"function","function":{"name":"read_file","parameters":{"type":"object"}}}]));
        req.insert("messages".into(), json!([{"role":"user","content":"hi"}]));
        let seen_max = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let sm = seen_max.clone();
        let r = run(move |b| {
            let sm = sm.clone();
            async move {
                sm.lock().unwrap().push(b.g("max_tokens").as_i64().unwrap_or(-1));
                let j = json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,
                    "tool_calls":[{"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a.txt\"}"}}]}}],
                    "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}});
                CallResult { status: 200, json: j, text: String::new(), retry_after: String::new() }
            }
        }, || false, &req, &dummy_preset()).await;
        assert!(r.ok && r.rounds == 1 && r.tool_calls.len() == 1);
        assert_eq!(*seen_max.lock().unwrap(), vec![32768]);

        // 2) truncated seal_final_reply JSON extracts partial answer and continues cleanly on round 2
        let mut req2 = Map::new();
        req2.insert("model".into(), json!("gemini-4-carbon"));
        req2.insert("messages".into(), json!([{"role":"user","content":"write long"}]));
        let seen_msgs = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let sm2 = seen_msgs.clone();
        let n = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let n2 = n.clone();
        let r2 = run(move |b| {
            let sm2 = sm2.clone();
            let k = n2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move {
                sm2.lock().unwrap().push(js(&Value::Object(b)));
                let j = if k == 0 {
                    json!({"choices":[{"finish_reason":"length","message":{"role":"assistant","content":null,
                        "tool_calls":[{"id":"c1","type":"function","function":{"name":"seal_final_reply","arguments":"{\"answer\":\"half_story_12345"}}]}}],
                        "usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}})
                } else {
                    json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,
                        "tool_calls":[{"id":"c2","type":"function","function":{"name":"seal_final_reply","arguments":"{\"answer\":\"half_story_12345_completed\"}"}}]}}],
                        "usage":{"prompt_tokens":30,"completion_tokens":25,"total_tokens":55}})
                };
                CallResult { status: 200, json: j, text: String::new(), retry_after: String::new() }
            }
        }, || false, &req2, &dummy_preset()).await;
        assert!(r2.ok && r2.rounds == 2 && r2.answer == "half_story_12345_completed" && r2.tool_calls.is_empty());
        assert!(seen_msgs.lock().unwrap()[1].contains("Previous partial answer: half_story_12345"));
    }
    fn seal_cut(s: &str) -> Value {
        json!({"choices":[{"finish_reason":"length","message":{"role":"assistant","content":null,
            "tool_calls":[{"id":"c","type":"function","function":{"name":"seal_final_reply","arguments":format!("{{\"answer\":\"{}",s)}}]}}],
            "usage":{"prompt_tokens":10,"completion_tokens":32768,"total_tokens":32778}})
    }
    fn seal_ok(s: &str) -> Value {
        json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":null,
            "tool_calls":[{"id":"d","type":"function","function":{"name":"seal_final_reply","arguments":js(&json!({"answer":s}))}}]}}],
            "usage":{"prompt_tokens":10,"completion_tokens":100,"total_tokens":110}})
    }
    fn ok(j: Value) -> CallResult { CallResult { status: 200, json: j, text: String::new(), retry_after: String::new() } }
    #[test]
    fn merge_drops_overlap() {
        assert_eq!(merge_segments("abc 第一段结尾的句子在这里。", "第一段结尾的句子在这里。第二段"), "abc 第一段结尾的句子在这里。第二段");
        assert_eq!(merge_segments("前文", "后文"), "前文后文");
        assert_eq!(merge_segments("x", ""), "x");
        let a = "甲".repeat(300);
        assert_eq!(merge_segments(&a, &format!("{}乙乙", a)), format!("{}乙乙", a));
    }
    #[tokio::test]
    async fn cut_answer_is_continued_and_joined() {
        let p1 = format!("{}\\n第一部分最后一句话写到这里", "段落一。".repeat(100));
        let mut req = Map::new();
        req.insert("messages".into(), json!([{"role":"user","content":"write"}]));
        let seen = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let n = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (s2, n2, p1c) = (seen.clone(), n.clone(), p1.clone());
        let r = run(move |b| {
            let k = n2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            s2.lock().unwrap().push(js(&Value::Object(b)));
            let p1c = p1c.clone();
            async move { if k == 0 { ok(seal_cut(&p1c)) } else { ok(seal_ok("最后一句话写到这里，然后是第二部分。")) } }
        }, || false, &req, &dummy_preset()).await;
        assert!(r.ok && r.rounds == 2 && r.finish.is_empty());
        assert!(r.answer.starts_with("段落一。") && r.answer.ends_with("第一部分最后一句话写到这里，然后是第二部分。"), "{}", r.answer);
        let s = seen.lock().unwrap();
        assert!(s[1].contains("Do NOT repeat") && !s[1].contains("Previous partial answer") && !s[1].contains("\"tool_calls\""));
    }
    #[tokio::test]
    async fn failed_continuation_returns_saved_text() {
        let p1 = "已经写好的正文。".repeat(60);
        let mut req = Map::new();
        req.insert("messages".into(), json!([{"role":"user","content":"write"}]));
        let n = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (n2, p1c) = (n.clone(), p1.clone());
        let r = run(move |_b| {
            let k = n2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let p1c = p1c.clone();
            async move { if k == 0 { ok(seal_cut(&p1c)) } else { CallResult { status: 502, json: json!({"error":{"message":"boom"}}), text: String::new(), retry_after: String::new() } } }
        }, || false, &req, &dummy_preset()).await;
        assert!(r.ok && r.finish == "length" && r.answer == p1);
        // every round cut again: all pieces are kept and returned after the round limit
        let n = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let n2 = n.clone();
        let r = run(move |_b| {
            let k = n2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move { ok(seal_cut(&format!("第{}段", k).repeat(80))) }
        }, || false, &req, &dummy_preset()).await;
        assert!(r.ok && r.finish == "length" && r.rounds == MAX_APPEND_ROUNDS);
        assert!(r.answer.contains("第0段") && r.answer.contains("第4段"));
    }
}
