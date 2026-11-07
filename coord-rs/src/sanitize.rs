// request-sanitizer.js + sampling-limits.js: repair tool schemas and sampling params before upstream.
use crate::util::*;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashSet;

pub struct SanErr(pub String);
type SR<T> = Result<T, SanErr>;
fn fail<T>(m: String) -> SR<T> {
    Err(SanErr(m))
}

const TYPES: [&str; 6] = ["STRING", "NUMBER", "INTEGER", "BOOLEAN", "ARRAY", "OBJECT"];
const KEEP: [&str; 23] = ["type", "format", "description", "nullable", "enum", "items", "properties", "required", "anyOf", "minItems", "maxItems",
    "minimum", "maximum", "minLength", "maxLength", "pattern", "title", "default", "example", "propertyOrdering", "minProperties", "maxProperties", "anyOf"];
static RE_NAME: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$").unwrap());
static RE_REF: Lazy<Regex> = Lazy::new(|| Regex::new(r"^#/(?:\$defs|definitions)/(.+)$").unwrap());
const MAX_DEPTH: usize = 32;

fn lower(v: &Value) -> String {
    js_string(v).to_lowercase()
}
fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() + 0 && i + 2 <= b.len() - 1 {
            if let Ok(n) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(n);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn schema(input: &Value, wh: &str, defs: &Map<String, Value>, depth: usize, seen: &HashSet<String>) -> SR<Value> {
    if depth > MAX_DEPTH {
        return fail(format!("{}: 参数结构嵌套过深（超过 {} 层）", wh, MAX_DEPTH));
    }
    if input == &Value::Bool(true) || input.is_null() {
        return Ok(json!({"type":"STRING"}));
    }
    let Some(s0) = input.as_object() else { return fail(format!("{}: 参数定义必须是对象", wh)) };
    let mut s = s0.clone();
    if let Some(r) = s.get("$ref").and_then(|v| v.as_str()).map(|x| x.to_string()) {
        let target = RE_REF.captures(&r).and_then(|c| defs.get(&url_decode(&c[1]))).and_then(|v| v.as_object()).cloned();
        let Some(mut merged) = target else { return fail(format!("{}: 无法解析引用 {}", wh, r)) };
        if seen.contains(&r) {
            return fail(format!("{}: 存在循环引用 {}，无法展开", wh, r));
        }
        for (k, v) in &s {
            if k != "$ref" {
                merged.insert(k.clone(), v.clone());
            }
        }
        let mut ns = seen.clone();
        ns.insert(r);
        return schema(&Value::Object(merged), wh, defs, depth + 1, &ns);
    }
    if let Some(all) = s.get("allOf").and_then(|v| v.as_array()).cloned() {
        let mut merged = s.clone();
        merged.shift_remove("allOf");
        for part in &all {
            let Some(p) = part.as_object() else { return fail(format!("{}: allOf 内容无效", wh)) };
            if truthy(p.g("properties")) {
                let mut props = merged.o("properties").cloned().unwrap_or_default();
                if let Some(pp) = p.o("properties") {
                    for (k, v) in pp {
                        props.insert(k.clone(), v.clone());
                    }
                }
                merged.insert("properties".into(), Value::Object(props));
            }
            if let Some(req) = p.get("required").and_then(|v| v.as_array()) {
                let mut cur = merged.a("required").to_vec();
                cur.extend(req.iter().cloned());
                merged.insert("required".into(), Value::Array(cur));
            }
            for (k, v) in p {
                if k != "properties" && k != "required" && !merged.contains_key(k) {
                    merged.insert(k.clone(), v.clone());
                }
            }
        }
        s = merged;
    }
    let mut out = Map::new();
    let mut typ: Option<Value> = s.get("type").cloned();
    let mut nullable = s.g("nullable") == &Value::Bool(true);
    if let Some(Value::Array(arr)) = &typ {
        let real: Vec<Value> = arr.iter().filter(|t| lower(t) != "null").cloned().collect();
        if real.len() != arr.len() {
            nullable = true;
        }
        if real.len() > 1 {
            let mut vs = vec![];
            for t in &real {
                let mut x = s.clone();
                x.insert("type".into(), t.clone());
                x.shift_remove("nullable");
                vs.push(schema(&Value::Object(x), wh, defs, depth + 1, seen)?);
            }
            out.insert("anyOf".into(), Value::Array(vs));
            if nullable {
                out.insert("nullable".into(), json!(true));
            }
            if truthy(s.g("description")) {
                out.insert("description".into(), json!(js_string(s.g("description"))));
            }
            return Ok(Value::Object(out));
        }
        typ = real.into_iter().next();
    }
    if let Some(c) = s.get("const").cloned() {
        if !s.contains_key("enum") {
            s.insert("enum".into(), json!([c]));
        }
    }
    let variants = s.get("anyOf").filter(|v| truthy(v)).or_else(|| s.get("oneOf")).and_then(|v| v.as_array()).cloned();
    if let Some(variants) = variants {
        let list: Vec<Value> = variants.iter().filter(|v| !(v.is_object() && lower(v.g("type")) == "null")).cloned().collect();
        if list.len() != variants.len() {
            nullable = true;
        }
        if list.is_empty() {
            return fail(format!("{}: anyOf/oneOf 中没有可用类型", wh));
        }
        if list.len() == 1 && typ.is_none() {
            let Some(one) = list[0].as_object() else { return schema(&list[0], wh, defs, depth + 1, seen) };
            let mut x = one.clone();
            let d = s.get("description").filter(|v| !v.is_null()).or_else(|| one.get("description").filter(|v| !v.is_null())).cloned();
            match d {
                Some(d) => x.insert("description".into(), d),
                None => x.shift_remove("description"),
            };
            if nullable {
                x.insert("nullable".into(), json!(true));
            } else {
                x.shift_remove("nullable");
            }
            return schema(&Value::Object(x), wh, defs, depth + 1, seen);
        }
        let mut outs = vec![];
        for (i, v) in list.iter().enumerate() {
            outs.push(schema(v, &format!("{}.anyOf[{}]", wh, i), defs, depth + 1, seen)?);
        }
        out.insert("anyOf".into(), Value::Array(outs));
    }
    if typ.is_none() {
        if truthy(s.g("properties")) {
            typ = Some(json!("object"));
        } else if truthy(s.g("items")) {
            typ = Some(json!("array"));
        } else if !out.contains_key("anyOf") {
            typ = Some(json!("string"));
        }
    }
    if let Some(t) = &typ {
        let u = js_string(t).to_uppercase();
        if !TYPES.contains(&u.as_str()) {
            return fail(format!("{}: 不支持的类型 \"{}\"", wh, js_string(t)));
        }
        out.insert("type".into(), json!(u));
    }
    for (k, v) in &s {
        if !KEEP.contains(&k.as_str()) || k == "type" || k == "anyOf" {
            continue;
        }
        match k.as_str() {
            "properties" => {
                let Some(po) = v.as_object() else { return fail(format!("{}: properties 必须是对象", wh)) };
                let mut props = Map::new();
                for (pk, pv) in po {
                    props.insert(pk.clone(), schema(pv, &format!("{}.{}", wh, pk), defs, depth + 1, seen)?);
                }
                out.insert("properties".into(), Value::Object(props));
            }
            "items" => {
                let it = match v {
                    Value::Array(a) => a.first().cloned().unwrap_or(Value::Null),
                    _ => v.clone(),
                };
                out.insert("items".into(), schema(&it, &format!("{}[]", wh), defs, depth + 1, seen)?);
            }
            "required" => {
                if let Some(a) = v.as_array() {
                    let mut seen_r = HashSet::new();
                    let r: Vec<Value> = a.iter().filter_map(|x| x.as_str()).filter(|x| seen_r.insert(x.to_string())).map(|x| json!(x)).collect();
                    out.insert("required".into(), Value::Array(r));
                }
            }
            "enum" => {
                let Some(a) = v.as_array().filter(|a| !a.is_empty()) else { continue };
                let vals: Vec<&Value> = a.iter().filter(|x| !x.is_null()).collect();
                if vals.len() != a.len() {
                    nullable = true;
                }
                if out.s("type") == "STRING" || !out.contains_key("type") {
                    out.insert("enum".into(), Value::Array(vals.iter().map(|x| json!(js_string(x))).collect()));
                } else {
                    let pre = if truthy(s.g("description")) { format!("{} ", js_string(s.g("description"))) } else { String::new() };
                    let parts: Vec<String> = vals.iter().map(|x| js_string(x)).collect();
                    out.insert("description".into(), json!(format!("{}可选值: {}", pre, parts.join(", "))));
                }
            }
            "description" | "title" | "format" | "pattern" => {
                if !out.contains_key(k) {
                    out.insert(k.clone(), json!(js_string(v)));
                }
            }
            "nullable" => {}
            _ => {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    if out.s("type") == "ARRAY" && !out.contains_key("items") {
        out.insert("items".into(), json!({"type":"STRING"}));
    }
    if out.contains_key("required") {
        let props = out.o("properties").cloned();
        let r: Vec<Value> = out.a("required").iter().filter(|x| props.as_ref().map(|p| p.contains_key(x.as_str().unwrap_or(""))).unwrap_or(false)).cloned().collect();
        if r.is_empty() {
            out.shift_remove("required");
        } else {
            out.insert("required".into(), Value::Array(r));
        }
    }
    if out.s("type") == "OBJECT" && out.o("properties").map(|p| p.is_empty()).unwrap_or(false) {
        out.shift_remove("properties");
    }
    if nullable {
        out.insert("nullable".into(), json!(true));
    }
    Ok(Value::Object(out))
}

fn params(p: &Value, wh: &str) -> SR<Option<Value>> {
    if p.is_null() {
        return Ok(None);
    }
    let Some(o) = p.as_object() else { return fail(format!("{}: parameters 必须是对象", wh)) };
    let mut defs = Map::new();
    for k in ["definitions", "$defs"] {
        if let Some(d) = o.o(k) {
            for (x, v) in d {
                defs.insert(x.clone(), v.clone());
            }
        }
    }
    schema(p, wh, &defs, 0, &HashSet::new()).map(Some)
}

fn check_name(name: &Value, wh: &str, names: &mut HashSet<String>) -> SR<()> {
    let Some(n) = name.as_str().filter(|n| RE_NAME.is_match(n)) else {
        return fail(format!("{}: 工具名 \"{}\" 不合法（只能用字母、数字、_ . -，以字母或下划线开头，最长 64 位）", wh, clip_runes(&js_str(name), 80)));
    };
    if !names.insert(n.to_string()) {
        return fail(format!("{}: 工具名 \"{}\" 重复", wh, n));
    }
    Ok(())
}

fn fix(holder: &mut Map<String, Value>, key: &str, wh: &str, changed: &mut bool) -> SR<()> {
    let Some(v) = holder.get(key) else { return Ok(()) };
    let before = js(v);
    if let Some(after) = params(v, wh)? {
        if js(&after) != before {
            holder.insert(key.into(), after);
            *changed = true;
        }
    }
    Ok(())
}

/// Mutates parsed. Ok((changed, notes)) or Err(unfixable message).
pub fn sanitize_request(route: &str, parsed: &mut Map<String, Value>) -> Result<(bool, Vec<String>), String> {
    sanitize_inner(route, parsed).map_err(|e| e.0)
}
fn sanitize_inner(route: &str, parsed: &mut Map<String, Value>) -> SR<(bool, Vec<String>)> {
    let notes = fix_sampling(route, parsed);
    let mut changed = !notes.is_empty();
    let mut names = HashSet::new();
    if route == "/v1/chat/completions" {
        if let Some(t) = parsed.get("tools") {
            if !t.is_null() && !t.is_array() {
                return fail("tools 必须是数组".into());
            }
        }
        if let Some(Value::Array(tools)) = parsed.get_mut("tools") {
            for (i, t) in tools.iter_mut().enumerate() {
                let Some(to) = t.as_object_mut() else { continue };
                if to.g("type") != &json!("function") {
                    continue;
                }
                let Some(f) = to.get_mut("function").and_then(|f| f.as_object_mut()) else { return fail(format!("tools[{}]: 缺少 function 定义", i)) };
                check_name(f.g("name"), &format!("tools[{}]", i), &mut names)?;
                let wh = format!("工具 {}", js_str(f.g("name")));
                fix(f, "parameters", &wh, &mut changed)?;
                if f.shift_remove("strict").is_some() {
                    changed = true;
                }
            }
        }
        if let Some(Value::Array(fs)) = parsed.get_mut("functions") {
            for (i, fv) in fs.iter_mut().enumerate() {
                let nm = fv.g("name").clone();
                check_name(&nm, &format!("functions[{}]", i), &mut names)?;
                if let Some(f) = fv.as_object_mut() {
                    fix(f, "parameters", &format!("函数 {}", js_str(&nm)), &mut changed)?;
                }
            }
        }
        if let Some(rf) = parsed.get_mut("response_format") {
            if !rf.is_null() {
                let Some(rf) = rf.as_object_mut() else { return fail("response_format 必须是对象".into()) };
                let t = rf.g("type").clone();
                let ts = t.as_str().unwrap_or("");
                if !["text", "json_object", "json_schema"].contains(&ts) {
                    return fail(format!("response_format.type 不支持: {}", clip_runes(&js_string(&t), 40)));
                }
                if ts == "json_schema" {
                    let ok = rf.g("json_schema").is_object() && truthy(rf.g("json_schema").g("schema"));
                    if !ok {
                        return fail("response_format.json_schema.schema 缺失".into());
                    }
                    let js_ = rf.get_mut("json_schema").unwrap().as_object_mut().unwrap();
                    fix(js_, "schema", "response_format", &mut changed)?;
                    if js_.shift_remove("strict").is_some() {
                        changed = true;
                    }
                }
            }
        }
    } else {
        let gk = if parsed.g("generationConfig").is_object() { "generationConfig" } else { "generation_config" };
        if let Some(gc) = parsed.get_mut(gk).and_then(|v| v.as_object_mut()) {
            for k in ["responseJsonSchema", "response_json_schema"] {
                if let Some(v) = gc.shift_remove(k) {
                    if !gc.contains_key("responseSchema") {
                        gc.insert("responseSchema".into(), v);
                    }
                    changed = true;
                }
            }
            if gc.contains_key("response_schema") && !gc.contains_key("responseSchema") {
                let v = gc.shift_remove("response_schema").unwrap();
                gc.insert("responseSchema".into(), v);
                changed = true;
            }
            if gc.contains_key("responseSchema") {
                fix(gc, "responseSchema", "responseSchema", &mut changed)?;
            }
        }
        if let Some(t) = parsed.get("tools") {
            if !t.is_null() && !t.is_array() {
                return fail("tools 必须是数组".into());
            }
        }
        if let Some(Value::Array(tools)) = parsed.get_mut("tools") {
            for t in tools.iter_mut() {
                let Some(to) = t.as_object_mut() else { continue };
                for key in ["functionDeclarations", "function_declarations"] {
                    let Some(Value::Array(ds)) = to.get_mut(key) else { continue };
                    for (i, dv) in ds.iter_mut().enumerate() {
                        let Some(d) = dv.as_object_mut() else { return fail(format!("{}[{}]: 声明无效", key, i)) };
                        check_name(d.g("name"), &format!("{}[{}]", key, i), &mut names)?;
                        if d.contains_key("parametersJsonSchema") && !d.contains_key("parameters") {
                            let v = d.shift_remove("parametersJsonSchema").unwrap();
                            d.insert("parameters".into(), v);
                            changed = true;
                        }
                        let wh = format!("工具 {}", js_str(d.g("name")));
                        fix(d, "parameters", &wh, &mut changed)?;
                    }
                }
            }
        }
    }
    Ok((changed, notes))
}

// ---------------- sampling ----------------
struct Rule {
    min: f64,
    max: Option<f64>,
    int: bool,
    drop_below: bool,
}
const TEMP: Rule = Rule { min: 0.0, max: Some(2.0), int: false, drop_below: false };
const TOPP: Rule = Rule { min: 0.0, max: Some(1.0), int: false, drop_below: false };
const TOPK: Rule = Rule { min: 1.0, max: None, int: true, drop_below: true };
const BUDGET: Rule = Rule { min: -1.0, max: Some(65535.0), int: true, drop_below: false };

fn js_number(s: &str) -> f64 {
    let t = s.trim();
    if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return u64::from_str_radix(h, 16).map(|n| n as f64).unwrap_or(f64::NAN);
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if t.contains('_') || t.eq_ignore_ascii_case("inf") || t.eq_ignore_ascii_case("nan") || t.to_lowercase().contains("infinity") {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

fn clamp(h: &mut Map<String, Value>, key: &str, r: &Rule, label: &str, notes: &mut Vec<String>) {
    let Some(raw) = h.get(key).cloned() else { return };
    if raw.is_null() {
        return;
    }
    let mut n = match &raw {
        Value::String(s) if !s.trim().is_empty() => js_number(s),
        Value::Number(_) => as_num(&raw).unwrap_or(f64::NAN),
        _ => f64::NAN,
    };
    if !n.is_finite() {
        h.shift_remove(key);
        notes.push(format!("{} 无效已忽略", label));
        return;
    }
    if r.int {
        n = (n + 0.5).floor();
    }
    if r.drop_below && n < r.min {
        h.shift_remove(key);
        notes.push(format!("{}={} 已忽略", label, js_string(&raw)));
        return;
    }
    if n < r.min {
        n = r.min;
    }
    if let Some(mx) = r.max {
        if n > mx {
            n = mx;
        }
    }
    let same = matches!(&raw, Value::Number(_)) && as_num(&raw) == Some(n);
    if !same {
        h.insert(key.into(), num(n));
        notes.push(format!("{} {}→{}", label, js(&raw), js_num_str(n)));
    }
}

fn fix_stop(h: &mut Map<String, Value>, key: &str, notes: &mut Vec<String>) {
    let Some(raw) = h.get(key).cloned() else { return };
    match &raw {
        Value::Null => {}
        Value::String(s) => {
            if s.is_empty() {
                h.shift_remove(key);
                notes.push(format!("{} 为空已忽略", key));
            }
        }
        Value::Array(arr) => {
            let mut seen = HashSet::new();
            let mut list: Vec<Value> = arr.iter().filter_map(|x| x.as_str()).filter(|s| !s.is_empty() && seen.insert(s.to_string())).map(|s| json!(s)).collect();
            if list.len() > 5 {
                notes.push(format!("{} {}个→前5个", key, list.len()));
                list.truncate(5);
            } else if list.len() != arr.len() {
                notes.push(format!("{} 去掉了空值或重复", key));
            }
            if list.is_empty() {
                h.shift_remove(key);
            } else if list.len() != arr.len() {
                h.insert(key.into(), Value::Array(list));
            }
        }
        _ => {
            h.shift_remove(key);
            notes.push(format!("{} 无效已忽略", key));
        }
    }
}

pub fn fix_sampling(route: &str, p: &mut Map<String, Value>) -> Vec<String> {
    let mut notes = vec![];
    if route == "/v1/chat/completions" {
        clamp(p, "temperature", &TEMP, "temperature", &mut notes);
        clamp(p, "top_p", &TOPP, "top_p", &mut notes);
        clamp(p, "top_k", &TOPK, "top_k", &mut notes);
        fix_stop(p, "stop", &mut notes);
        return notes;
    }
    for gk in ["generationConfig", "generation_config"] {
        let Some(gc) = p.get_mut(gk).and_then(|v| v.as_object_mut()) else { continue };
        clamp(gc, "temperature", &TEMP, "temperature", &mut notes);
        for k in ["topP", "top_p"] {
            clamp(gc, k, &TOPP, k, &mut notes);
        }
        for k in ["topK", "top_k"] {
            clamp(gc, k, &TOPK, k, &mut notes);
        }
        for k in ["stopSequences", "stop_sequences"] {
            fix_stop(gc, k, &mut notes);
        }
        for tk in ["thinkingConfig", "thinking_config"] {
            if let Some(tc) = gc.get_mut(tk).and_then(|v| v.as_object_mut()) {
                for k in ["thinkingBudget", "thinking_budget"] {
                    clamp(tc, k, &BUDGET, k, &mut notes);
                }
            }
        }
    }
    notes
}