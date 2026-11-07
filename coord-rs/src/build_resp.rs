// Build reply parsing (build-response.js) and document delivery helpers (build-document.js).
use crate::util::*;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};

fn is_turn(v: &[Value]) -> bool {
    let role = v.first().and_then(|a| a.as_array()).and_then(|a| a.first()).and_then(|a| a.as_array());
    let Some(r) = role else { return false };
    if !r.first().map(|x| x.is_array()).unwrap_or(false) {
        return false;
    }
    let ok_role = matches!(r.get(1).and_then(|x| x.as_str()), Some("user") | Some("model"));
    ok_role && v.iter().any(|x| x.as_str().map(|s| s.starts_with("models/")).unwrap_or(false))
}
fn walk_turns<'a>(v: &'a Value, d: usize, out: &mut Vec<&'a Vec<Value>>) {
    let Value::Array(a) = v else { return };
    if d > 6 {
        return;
    }
    if is_turn(a) {
        out.push(a);
        return;
    }
    for x in a {
        walk_turns(x, d + 1, out);
    }
}
fn walk_fail(v: &Value, d: usize, hit: &mut Option<String>) {
    if hit.is_some() || d > 6 {
        return;
    }
    let Value::Array(a) = v else { return };
    let first_null = a.first().map(|x| x.is_null()).unwrap_or(true);
    if first_null {
        if let Some(Value::Array(e)) = a.get(5) {
            if let Some(Value::String(m)) = e.first() {
                if a.iter().any(|x| x.as_str().map(|s| s.starts_with("models/")).unwrap_or(false)) {
                    *hit = Some(slice16(m, 300));
                    return;
                }
            }
        }
    }
    for x in a {
        walk_fail(x, d + 1, hit);
    }
}
fn slice16(s: &str, n: usize) -> String {
    crate::build_tools::slice16(s, n)
}
/// Google-side generation failure message, if present.
pub fn upstream_failure(raw: &str) -> Option<String> {
    let j: Value = serde_json::from_str(raw).ok()?;
    let mut hit = None;
    walk_fail(&j, 0, &mut hit);
    hit
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct BUsage {
    pub uncached: i64,
    pub output: i64,
    pub cached: i64,
}
#[derive(Clone, Debug, Default)]
pub struct BuildOut {
    pub ok: bool,
    pub error: String,
    pub upstream_failed: bool,
    pub text: String,
    pub thought: String,
    pub usage: Option<BUsage>,
    pub model: Option<String>,
    pub complete: bool,
}
static RE_ERR: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\[\s*\d+\s*,\s*"([^"]{1,300})"\s*\]"#).unwrap());
static RE_DIGITS: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d+$").unwrap());
fn unum(s: &str) -> i64 {
    match s.parse::<f64>() {
        Ok(f) if f >= 0.0 && f <= 9_007_199_254_740_991.0 && f.fract() == 0.0 => f as i64,
        _ => 0,
    }
}

pub fn parse(raw: &str) -> BuildOut {
    let j: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return BuildOut { error: "unparseable".into(), ..Default::default() },
    };
    let mut list = vec![];
    walk_turns(&j, 0, &mut list);
    let last = list.iter().rev().find(|t| t[0][0][1].as_str() == Some("model"));
    let Some(last) = last else {
        if let Some(f) = upstream_failure(raw) {
            return BuildOut { error: f, upstream_failed: true, ..Default::default() };
        }
        let m = RE_ERR.captures(raw).map(|c| c[1].to_string());
        return BuildOut { error: m.unwrap_or_else(|| "no model turn".into()), ..Default::default() };
    };
    let (mut text, mut thought) = (String::new(), String::new());
    if let Some(parts) = last[0][0][0].as_array() {
        for p in parts {
            let Some(pa) = p.as_array() else { continue };
            let Some(t) = pa.get(1).and_then(|x| x.as_str()) else { continue };
            let is_thought = pa.get(12).and_then(as_num_ref).map(|f| f == 1.0).unwrap_or(false);
            if is_thought {
                thought.push_str(t);
            } else {
                text.push_str(t);
            }
        }
    }
    let mut usage = None;
    for u in last.iter().rev() {
        if let Value::Array(u) = u {
            if (u.len() == 2 || u.len() == 3) && u.iter().all(|x| x.as_str().map(|s| RE_DIGITS.is_match(s)).unwrap_or(false)) {
                let s = |i: usize| unum(u[i].as_str().unwrap());
                usage = Some(BUsage { uncached: s(0), output: s(1), cached: if u.len() == 3 { s(2) } else { 0 } });
                break;
            }
        }
    }
    let model = last.iter().find_map(|x| x.as_str().filter(|s| s.starts_with("models/")).map(|s| s[7..].to_string()));
    let complete = usage.is_some();
    BuildOut { ok: true, text, thought, usage, model, complete, ..Default::default() }
}
fn as_num_ref(v: &Value) -> Option<f64> {
    as_num(v)
}
pub fn openai_usage(u: Option<&BUsage>) -> Value {
    let Some(u) = u else { return Value::Null };
    let prompt = u.uncached + u.cached;
    json!({"prompt_tokens":prompt,"completion_tokens":u.output,"total_tokens":prompt+u.output,"prompt_tokens_details":{"cached_tokens":u.cached}})
}

// ---------------- document delivery ----------------
pub static DOC_NAME: Lazy<Regex> = Lazy::new(|| Regex::new(r"^__bridge_reply_[a-f0-9]{24}\.txt$").unwrap());
static HASH: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-f0-9]{64}$").unwrap());
static RE_ACK: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^\s*\**\s*done\s*\**\s*[.!。]?\s*$").unwrap());
pub const DOC_MAX_BYTES: usize = 8 * 1024 * 1024;
pub fn document_name() -> String {
    format!("__bridge_reply_{}.txt", rand_hex(12))
}
fn walk_hash(v: &Value, d: usize, name: &str, hit: &mut Option<String>) {
    let Value::Array(a) = v else { return };
    if d > 14 {
        return;
    }
    if a.len() >= 2 && a[0].as_str() == Some(name) {
        if let Some(h) = a[1].as_str().filter(|h| HASH.is_match(h)) {
            *hit = Some(h.into());
        }
    }
    for x in a {
        walk_hash(x, d + 1, name, hit);
    }
}
/// Latest SHA-256 recorded for `name` in the generation response.
pub fn find_hash(raw: &str, name: &str) -> Option<String> {
    if !DOC_NAME.is_match(name) {
        return None;
    }
    let j: Value = serde_json::from_str(raw).ok()?;
    let mut hit = None;
    walk_hash(&j, 0, name, &mut hit);
    hit
}
/// Chat text that is only the acknowledgement (or empty).
pub fn is_ack(t: &str) -> bool {
    crate::build_tools::js_trim(t).is_empty() || RE_ACK.is_match(t)
}
pub fn valid_hash(h: &str) -> bool {
    HASH.is_match(h)
}

/// build-document.json switch: enabled + per-prefix flags.
pub const DOC_PREFIXES: [(&str, bool); 4] = [("build/", true), ("build-st/", true), ("bridge/", true), ("code/", false)];
pub struct DocumentSwitch {
    file: String,
    state: std::sync::Mutex<(bool, Vec<(String, bool)>)>,
    pub requests: std::sync::atomic::AtomicI64,
}
impl DocumentSwitch {
    pub fn open(file: &str) -> Self {
        let mut enabled = false;
        let mut pre: Vec<(String, bool)> = DOC_PREFIXES.iter().map(|(k, v)| (k.to_string(), *v)).collect();
        match std::fs::read_to_string(file) {
            Ok(s) => match serde_json::from_str::<Value>(&s) {
                Ok(d) => {
                    if let Some(b) = d.get("enabled").and_then(|v| v.as_bool()) {
                        enabled = b;
                    }
                    for (k, v) in pre.iter_mut() {
                        if let Some(b) = d.g("prefixes").get(k.as_str()).and_then(|x| x.as_bool()) {
                            *v = b;
                        }
                    }
                }
                Err(_) => elog("[BuildDoc] build-document.json unreadable, using defaults"),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => elog("[BuildDoc] build-document.json unreadable, using defaults"),
        }
        DocumentSwitch { file: file.into(), state: std::sync::Mutex::new((enabled, pre)), requests: Default::default() }
    }
    fn json_of(st: &(bool, Vec<(String, bool)>)) -> Value {
        let mut p = serde_json::Map::new();
        for (k, v) in &st.1 {
            p.insert(k.clone(), json!(v));
        }
        json!({"enabled":st.0,"prefixes":p})
    }
    pub fn status(&self) -> Value {
        let st = self.state.lock().unwrap();
        let mut v = Self::json_of(&st);
        v["stats"] = json!({"requests":self.requests.load(std::sync::atomic::Ordering::Relaxed)});
        v
    }
    pub fn uses(&self, prefix: &str) -> bool {
        let st = self.state.lock().unwrap();
        st.0 && st.1.iter().any(|(k, v)| k == prefix && *v)
    }
    pub fn set(&self, body: &Value) -> R<Value> {
        let mut next = self.state.lock().unwrap().clone();
        if let Some(e) = body.get("enabled") {
            let Some(b) = e.as_bool() else { return herr(400, "enabled 必须是 true/false") };
            next.0 = b;
        }
        if let Some(p) = body.get("prefixes") {
            let Some(po) = p.as_object() else { return herr(400, "prefixes 无效") };
            for (k, v) in po {
                let slot = next.1.iter_mut().find(|(n, _)| n == k);
                match (slot, v.as_bool()) {
                    (Some(s), Some(b)) => s.1 = b,
                    _ => return herr(400, format!("未知前缀或取值：{}", k)),
                }
            }
        }
        if !crate::state::READ_ONLY.load(std::sync::atomic::Ordering::Relaxed) {
            write_simple(&self.file, js_indent(&Self::json_of(&next), " ").as_bytes(), 0o644).map_err(|e| HttpErr::plain(e.to_string()))?;
        }
        *self.state.lock().unwrap() = next;
        Ok(self.status())
    }
}