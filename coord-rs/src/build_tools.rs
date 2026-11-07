// Function tools over the Build channel (build-tools.js): text protocol with a per-request nonce tag.
use crate::build_ctx::{bfail, BR};
use crate::util::*;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

const MAX_TOOLS: usize = 128;
const MAX_SPEC_BYTES: usize = 256 * 1024;
pub const FIELDS: [&str; 5] = ["tools", "tool_choice", "functions", "function_call", "parallel_tool_calls"];
static RE_NAME: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9_.:-]{1,128}$").unwrap());
static RE_FENCE_HEAD: Lazy<Regex> = Lazy::new(|| Regex::new(r"^```(?:json)?\s*").unwrap());
static RE_FENCE_TAIL: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s*```$").unwrap());

fn tfail<T>(m: impl Into<String>, status: u16) -> BR<T> {
    bfail(m, status, "build_tools_invalid")
}
/// JS whitespace (String#trim / \s), including U+FEFF.
pub fn js_ws(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(js_ws)
}
/// String#slice(0,n) on UTF-16 units.
pub fn slice16(s: &str, n: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for c in s.chars() {
        used += c.len_utf16();
        if used > n {
            break;
        }
        out.push(c);
    }
    out
}
/// String(x) where x may be undefined (None).
fn js_string_opt(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => js_string(v),
    }
}
fn is_js_object(v: &Value) -> bool {
    matches!(v, Value::Object(_) | Value::Array(_))
}

#[derive(Clone, Debug)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}
#[derive(Clone, Debug)]
pub struct ToolSpec {
    pub tools: Vec<Tool>,
    pub mode: String,
    pub name: String,
    pub parallel: bool,
}

/// OpenAI tools / legacy functions -> ToolSpec, or None when the request has no tools.
pub fn normalize(spec: &Value) -> BR<Option<ToolSpec>> {
    let Value::Object(sp) = spec else { return Ok(None) };
    let mut list: Vec<Tool> = vec![];
    let mut add = |f: &Value| -> BR<()> {
        let name_ok = f.get("name").and_then(|v| v.as_str()).filter(|n| RE_NAME.is_match(n));
        let Some(name) = name_ok else {
            let shown = if !truthy(f) { js_string(f) } else if let Value::Object(m) = f { js_string_opt(m.get("name")) } else { "undefined".into() };
            return tfail(format!("工具名称无效：{}", slice16(&shown, 60)), 400);
        };
        if list.iter().any(|x| x.name == name) {
            return tfail(format!("工具名称重复：{}", name), 400);
        }
        let description = f.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let parameters = match f.get("parameters") {
            Some(p) if is_js_object(p) => p.clone(),
            _ => json!({"type":"object","properties":{}}),
        };
        list.push(Tool { name: name.into(), description, parameters });
        Ok(())
    };
    if let Some(Value::Array(ts)) = sp.get("tools") {
        for t in ts {
            if truthy(t) && t.get("type").and_then(|v| v.as_str()) == Some("function") && t.get("function").map(truthy).unwrap_or(false) {
                add(&t["function"])?;
            }
        }
    }
    if let Some(Value::Array(fs)) = sp.get("functions") {
        for f in fs {
            add(f)?;
        }
    }
    if list.is_empty() {
        return Ok(None);
    }
    if list.len() > MAX_TOOLS {
        return tfail(format!("工具最多 {} 个", MAX_TOOLS), 400);
    }
    let (mut mode, mut name) = ("auto".to_string(), String::new());
    let c = match sp.get("tool_choice") {
        Some(v) => Some(v),
        None => sp.get("function_call"),
    };
    if let Some(c) = c {
        match c {
            Value::String(s) if s == "none" => mode = "none".into(),
            Value::String(s) if s == "required" || s == "any" => mode = "required".into(),
            Value::Object(_) | Value::Array(_) => {
                let f = c.g("function");
                let mut cand: &Value = &Value::Null;
                if truthy(f) && truthy(f.g("name")) {
                    cand = f.g("name");
                } else if truthy(c.g("name")) {
                    cand = c.g("name");
                }
                match cand.as_str() {
                    Some(n) if list.iter().any(|t| t.name == n) => {
                        name = n.into();
                        mode = "named".into();
                    }
                    _ => return tfail(format!("指定的工具不存在：{}", slice16(&js_string(cand), 60)), 400),
                }
            }
            _ => {}
        }
    }
    let parallel = sp.get("parallel_tool_calls") != Some(&Value::Bool(false));
    Ok(Some(ToolSpec { tools: list, mode, name, parallel }))
}

pub fn nonce() -> String {
    rand_hex(4)
}
pub fn tag(n: &str) -> String {
    format!("tool_call_{}", n)
}

/// Composer text: tool list + calling rules; empty when tools are off for this turn.
pub fn instructions(spec: Option<&ToolSpec>, n: &str) -> BR<String> {
    let Some(spec) = spec.filter(|s| s.mode != "none") else { return Ok(String::new()) };
    let t = tag(n);
    let defs: Vec<Value> = spec.tools.iter().map(|x| {
        let mut o = Map::new();
        o.insert("name".into(), json!(x.name));
        if !x.description.is_empty() {
            o.insert("description".into(), json!(x.description));
        }
        o.insert("parameters".into(), x.parameters.clone());
        Value::Object(o)
    }).collect();
    let body = js(&Value::Array(defs));
    if body.len() > MAX_SPEC_BYTES {
        return tfail("工具定义超过 256 KiB", 413);
    }
    let rule = match spec.mode.as_str() {
        "required" => "You must call at least one tool in this reply.".to_string(),
        "named" => format!("You must call the tool \"{}\" in this reply.", spec.name),
        _ => "Call a tool only when it is needed; otherwise answer normally without any tool block.".to_string(),
    };
    let lines = [
        "[FUNCTION TOOLS]".to_string(),
        "The client application runs these functions on its own machine and sends back the results. They are not limited to this project workspace: when the user asks for something a function can do (files, commands, web, etc.), call it instead of refusing. Your built-in workspace (index.html, metadata.json, ...) is an unrelated sandbox: the user's real project and files are on the client and reachable only through these functions, so never answer from the sandbox or say a file does not exist without calling a function first. Definitions (JSON Schema parameters):".to_string(),
        body,
        "To call a function, end your reply with one block per call, exactly in this form:".to_string(),
        format!("<{}>{{\"name\":\"FUNCTION_NAME\",\"arguments\":{{...}}}}</{}>", t, t),
        format!("Rules: {}{} Put any normal text before the blocks. The JSON must be valid; arguments must match the schema. Do not invent results: stop after the blocks and wait for the client.",
            rule, if spec.parallel { " Several blocks may follow each other." } else { " Use at most one block." }),
        format!("Earlier calls appear in the history as [tool call ...] and [tool result ...] lines; only the <{}> form above triggers a new call.", t),
        "[/FUNCTION TOOLS]".to_string(),
    ];
    Ok(lines.join("\n"))
}

/// OpenAI messages with tool history -> plain text messages the Build packer accepts.
pub fn flatten(messages: &[Value]) -> (Vec<Value>, bool) {
    let mut changed = false;
    let mut names: HashMap<String, Value> = HashMap::new();
    let mut out = Vec::with_capacity(messages.len());
    for m in messages {
        let Value::Object(mo) = m else {
            out.push(m.clone());
            continue;
        };
        let calls: Vec<Value> = match mo.get("tool_calls") {
            Some(Value::Array(a)) => a.clone(),
            _ => match mo.get("function_call") {
                Some(fc) if truthy(fc) => vec![json!({"id":null,"function":fc})],
                _ => vec![],
            },
        };
        let role = mo.s("role");
        if role == "assistant" && !calls.is_empty() {
            changed = true;
            let lines: Vec<String> = calls.iter().map(|c| {
                let f = if truthy(c) && truthy(c.g("function")) { c.g("function").clone() } else { json!({}) };
                let id = if truthy(c) { c.g("id").clone() } else { Value::Null };
                if truthy(&id) {
                    names.insert(js(&id), f.get("name").cloned().unwrap_or(Value::Null));
                }
                let args = match f.get("arguments") {
                    Some(Value::String(s)) => s.clone(),
                    Some(v) if truthy(v) => js(v),
                    _ => "{}".into(),
                };
                format!("[tool call id={} name={}] {}",
                    if truthy(&id) { js_string(&id) } else { "-".into() },
                    if truthy(f.g("name")) { js_string(f.g("name")) } else { "?".into() }, args)
            }).collect();
            let text = match mo.get("content") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Array(ps)) => ps.iter().filter_map(|p| p.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join("\n"),
                _ => String::new(),
            };
            let mut rest = mo.clone();
            rest.shift_remove("tool_calls");
            rest.shift_remove("function_call");
            let content = format!("{}{}", if js_trim(&text).is_empty() { String::new() } else { format!("{}\n", text) }, lines.join("\n"));
            rest.insert("content".into(), json!(content));
            out.push(Value::Object(rest));
            continue;
        }
        if role == "tool" || role == "function" {
            changed = true;
            let id = mo.get("tool_call_id").filter(|v| truthy(v)).cloned();
            let name = match mo.get("name").filter(|v| truthy(v)) {
                Some(n) => js_string(n),
                None => match id.as_ref().and_then(|i| names.get(&js(i))).filter(|v| truthy(v)) {
                    Some(n) => js_string(n),
                    None => "?".into(),
                },
            };
            let text = match mo.get("content") {
                Some(Value::String(s)) => s.clone(),
                None => "undefined".into(),
                Some(v) => js(v),
            };
            out.push(json!({"role":"user","name":"tool","content":format!("[tool result id={} name={}]\n{}",
                id.as_ref().map(js_string).unwrap_or_else(|| "-".into()), name, text)}));
            continue;
        }
        out.push(m.clone());
    }
    (out, changed)
}

fn type_ok(t: &str, v: &Value) -> bool {
    match t {
        "string" => v.is_string(),
        "number" => v.is_number(),
        "integer" => as_num(v).map(|f| f.is_finite() && f.fract() == 0.0).unwrap_or(false),
        "boolean" => v.is_boolean(),
        "array" => v.is_array(),
        "object" => v.is_object(),
        "null" => v.is_null(),
        _ => false,
    }
}
/// Light argument check: object, required keys present, primitive types / enums of known properties.
pub fn check_args(schema: &Value, args: &Value) -> Option<String> {
    let Value::Object(a) = args else { return Some("arguments 不是对象".into()) };
    if !is_js_object(schema) {
        return None;
    }
    for k in schema.a("required") {
        let k = js_string(k);
        if !a.contains_key(&k) {
            return Some(format!("缺少参数 {}", k));
        }
    }
    let empty = Map::new();
    let props = schema.o("properties").unwrap_or(&empty);
    for (k, v) in a {
        let Some(p) = props.get(k).filter(|p| truthy(p) && is_js_object(p)) else { continue };
        let types: Vec<String> = match p.g("type") {
            t if !truthy(t) => vec![],
            Value::Array(xs) => xs.iter().map(js_string).collect(),
            t => vec![js_string(t)],
        };
        if !types.is_empty() && !types.iter().any(|t| type_ok(t, v)) && !(v.is_null() && truthy(p.g("nullable"))) {
            return Some(format!("参数 {} 类型应为 {}", k, types.join("|")));
        }
        if let Value::Array(en) = p.g("enum") {
            let jv = js(v);
            if !en.iter().any(|e| js(e) == jv) {
                return Some(format!("参数 {} 不在可选值内", k));
            }
        }
    }
    None
}

#[derive(Clone, Debug, Default)]
pub struct Extracted {
    pub content: String,
    pub calls: Vec<Value>,
    pub rejected: Vec<String>,
}
pub fn extract(text: &str, spec: Option<&ToolSpec>, n: &str) -> Extracted {
    extract_with(text, spec, n, &mut || format!("call_{}", rand_hex(9)))
}
/// Model reply -> content + tool calls. Only blocks with this request's nonce count; bad blocks stay as text.
pub fn extract_with(text: &str, spec: Option<&ToolSpec>, n: &str, mk_id: &mut dyn FnMut() -> String) -> Extracted {
    let mut out = Extracted { content: text.to_string(), ..Default::default() };
    let Some(spec) = spec.filter(|s| s.mode != "none") else { return out };
    let t = regex::escape(&tag(n));
    let re = Regex::new(&format!(r"<{}>\s*((?s:.)*?)\s*</{}>", t, t)).unwrap();
    let mut kept = String::new();
    let mut at = 0usize;
    for m in re.captures_iter(text) {
        let whole = m.get(0).unwrap();
        let raw0 = m.get(1).map(|x| x.as_str()).unwrap_or("");
        let raw1 = RE_FENCE_HEAD.replace(raw0, "");
        let raw = RE_FENCE_TAIL.replace(&raw1, "").into_owned();
        let mut why: Option<String> = None;
        let v: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => {
                why = Some("JSON 无效".into());
                Value::Null
            }
        };
        let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if why.is_none() && !(truthy(&v) && v.get("name").map(|x| x.is_string()).unwrap_or(false)) {
            why = Some("缺少 name".into());
        }
        let tool = spec.tools.iter().find(|x| x.name == name);
        if why.is_none() && tool.is_none() {
            why = Some(format!("未知工具 {}", name));
        }
        let mut args: Option<Value> = None;
        if why.is_none() {
            args = match v.get("arguments") {
                Some(Value::String(s)) => serde_json::from_str::<Value>(s).ok(),
                Some(a) if !a.is_null() => Some(a.clone()),
                _ => match v.get("parameters") {
                    Some(p) if !p.is_null() => Some(p.clone()),
                    _ => Some(json!({})),
                },
            };
            if args.is_none() {
                why = Some("arguments 不是合法 JSON".into());
            }
        }
        if why.is_none() {
            why = check_args(&tool.unwrap().parameters, args.as_ref().unwrap());
        }
        if why.is_none() && spec.mode == "named" && name != spec.name {
            why = Some(format!("本轮只允许调用 {}", spec.name));
        }
        if why.is_none() && !spec.parallel && !out.calls.is_empty() {
            why = Some("本轮只允许一个调用".into());
        }
        kept.push_str(&text[at..whole.start()]);
        at = whole.end();
        if let Some(w) = why {
            out.rejected.push(w);
            kept.push_str(whole.as_str());
            continue;
        }
        out.calls.push(json!({"id":mk_id(),"type":"function","function":{"name":name,"arguments":js(args.as_ref().unwrap())}}));
    }
    kept.push_str(&text[at..]);
    if !out.calls.is_empty() {
        out.content = kept.trim_end_matches(js_ws).to_string();
    }
    out
}
