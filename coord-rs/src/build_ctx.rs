// Build model names (build-routing.js) and context packing (build-context.js).
use crate::util::*;
use base64::Engine;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};

pub const WIRE_PREFIX: &str = "BUILD_ST_CONTEXT_V1\n";
pub const BASES: [&str; 3] = ["gemini-4-argon", "gemini-4-carbon", "gemini-3.8-flash"];
pub const PREFIXES: [&str; 4] = ["build/", "build-st/", "bridge/", "code/"];
const LEVELS: [(&str, i64); 3] = [("low", 1), ("medium", 2), ("high", 3)];
const SHORT_PRESET: usize = 2000;
pub const INLINE_BUDGET: usize = 45000;
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_COMPOSER: usize = 1024 * 1024;
const INLINE_FILE_BYTES: usize = 200 * 1024;
const MAX_MEDIA: usize = 20 * 1024 * 1024;
const MAX_SEGMENTS: usize = 20000;
const CODE_SYSTEM_MAX: usize = 30000;
const CODE_TOOL_INLINE: usize = 3000;

#[derive(Debug, Clone)]
pub struct BErr {
    pub status: u16,
    pub msg: String,
    pub code: String,
}
pub fn bfail<T>(msg: impl Into<String>, status: u16, code: &str) -> Result<T, BErr> {
    Err(BErr { status: if status == 0 { 400 } else { status }, msg: msg.into(), code: if code.is_empty() { "build_context_invalid".into() } else { code.into() } })
}
pub type BR<T> = Result<T, BErr>;

#[derive(Clone, Debug)]
pub struct BuildSpec {
    pub requested: String,
    pub prefix: String,
    pub model: String,
    pub thinking: i64,
}

pub fn parse_build_model(name: &str) -> R<Option<BuildSpec>> {
    let Some(prefix) = PREFIXES.iter().find(|p| name.starts_with(*p)) else { return Ok(None) };
    let rest = &name[prefix.len()..];
    for b in BASES {
        if rest == b {
            return Ok(Some(BuildSpec { requested: name.into(), prefix: prefix.to_string(), model: b.into(), thinking: 3 }));
        }
        for (l, n) in LEVELS {
            if rest == format!("{}-{}", b, l) {
                return Ok(Some(BuildSpec { requested: name.into(), prefix: prefix.to_string(), model: b.into(), thinking: n }));
            }
        }
    }
    herr(404, format!("Build 通道没有此模型：{}（可用：{}）", name, build_models().join(", ")))
}
pub fn build_models() -> Vec<String> {
    let mut out = vec![];
    for p in PREFIXES {
        for b in BASES {
            out.push(format!("{}{}", p, b));
            for (l, _) in LEVELS {
                out.push(format!("{}{}-{}", p, b, l));
            }
        }
    }
    out
}

/// CJK ~1 token/char, other text ~4 chars/token (UTF-16 length like JS).
pub fn btokens(s: &str) -> usize {
    let mut cjk = 0usize;
    let mut len = 0usize;
    for c in s.chars() {
        let u = c as u32;
        if (0x3000..=0x9fff).contains(&u) || (0xac00..=0xd7af).contains(&u) || (0xff00..=0xffef).contains(&u) {
            cjk += 1;
        }
        len += c.len_utf16();
    }
    cjk + (len - cjk + 3) / 4
}

// ---------------- segments ----------------
#[derive(Clone, Debug)]
pub struct Seg {
    pub message: i64,
    pub part: i64,
    pub role: String,
    pub name: String,
    pub source: String,
    pub placement: String,
    pub text: String,
    forced: String,
}
impl Seg {
    pub fn new(message: i64, part: i64, role: &str, name: &str, source: &str, placement: &str, text: String) -> Self {
        Seg { message, part, role: role.into(), name: name.into(), source: source.into(), placement: placement.into(), text, forced: String::new() }
    }
    fn meta(&self, segment: usize) -> Map<String, Value> {
        let mut o = Map::new();
        o.insert("segment".into(), json!(segment));
        o.insert("message".into(), json!(self.message));
        o.insert("part".into(), json!(self.part));
        o.insert("role".into(), json!(self.role));
        o.insert("source".into(), json!(self.source));
        o.insert("placement".into(), json!(self.placement));
        if !self.name.is_empty() {
            o.insert("name".into(), json!(self.name));
        }
        o
    }
}
#[derive(Clone, Debug)]
pub struct Media {
    pub mime: String,
    pub data: String,
    pub name: String,
}
#[derive(Clone, Debug, Default)]
pub struct Prepared {
    pub segments: Vec<Seg>,
    pub gen_type: String,
    pub inline_tokens: usize,
    pub plugin: bool,
    pub media: Vec<Media>,
}

const ROLES: [&str; 4] = ["system", "developer", "user", "assistant"];
const ENV_ROLES: [&str; 6] = ["system", "developer", "user", "assistant", "tool", "function"];
static RE_DATA: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$").unwrap());
static RE_WS: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").unwrap());
static RE_OVR: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^\s*\[\[(inline|file)\]\]\s*").unwrap());

enum MediaOf {
    None,
    Data(Media),
    Link(String),
}
fn media_of(p: &Value) -> MediaOf {
    if !p.is_object() {
        return MediaOf::None;
    }
    let iu = p.g("image_url");
    let u = if truthy(iu) {
        if truthy(iu.g("url")) { iu.g("url") } else { iu }
    } else if truthy(p.g("file")) {
        let f = p.g("file");
        if truthy(f.g("file_data")) { f.g("file_data") } else { f.g("url") }
    } else {
        p.g("url")
    };
    if let Some(s) = u.as_str() {
        if let Some(c) = RE_DATA.captures(s) {
            return MediaOf::Data(Media { mime: c[1].into(), data: RE_WS.replace_all(&c[2], "").into(), name: p.g("file").s("filename").into() });
        }
        return MediaOf::Link(s.into());
    }
    let ia = p.g("input_audio");
    if let Some(d) = ia.g("data").as_str() {
        let f = if ia.s("format").is_empty() { "wav" } else { ia.s("format") };
        return MediaOf::Data(Media { mime: format!("audio/{}", f), data: d.into(), name: String::new() });
    }
    MediaOf::None
}

fn text_of(content: &Value, dropped: &mut usize, media: &mut Option<Vec<Media>>) -> String {
    if let Some(s) = content.as_str() {
        return s.into();
    }
    if content.is_null() {
        return String::new();
    }
    let list: Vec<Value> = match content {
        Value::Array(a) => a.clone(),
        v => vec![v.clone()],
    };
    let mut out = vec![];
    for x in &list {
        if let Some(s) = x.as_str() {
            out.push(s.to_string());
            continue;
        }
        if let Some(t) = x.g("text").as_str() {
            if x.g("type").is_null() || ["text", "input_text"].contains(&x.s("type")) {
                out.push(t.into());
                continue;
            }
        }
        if let Some(m) = media.as_mut() {
            match media_of(x) {
                MediaOf::Data(f) => {
                    let nm = if f.name.is_empty() { String::new() } else { format!(" {}", clip_runes(&f.name, 80)) };
                    let mime = f.mime.clone();
                    m.push(f);
                    out.push(format!("[attached file #{}{} ({})]", m.len(), nm, mime));
                    continue;
                }
                MediaOf::Link(l) => {
                    out.push(format!("[file link: {}]", clip_runes(&l, 500)));
                    continue;
                }
                MediaOf::None => {}
            }
        }
        *dropped += 1;
    }
    out.join("\n")
}

fn sum_inline(rows: &[Seg]) -> usize {
    rows.iter().filter(|r| r.placement == "inline").map(|r| btokens(&r.text)).sum()
}

fn classify(messages: &[Value], keep_media: bool) -> BR<Prepared> {
    if messages.is_empty() || messages.len() > 10000 {
        return bfail("messages 必须为非空数组", 0, "");
    }
    let mut media: Option<Vec<Media>> = if keep_media { Some(vec![]) } else { None };
    let mut rows: Vec<Seg> = vec![];
    let mut dropped = 0usize;
    for (i, m) in messages.iter().enumerate() {
        if !m.is_object() || !ROLES.contains(&m.s("role")) {
            continue;
        }
        let had_tool = truthy(m.g("tool_calls")) || truthy(m.g("function_call"));
        let before = dropped;
        let mut text = text_of(m.g("content"), &mut dropped, &mut media);
        let mut forced = String::new();
        if let Some(c) = RE_OVR.captures(&text) {
            forced = c[1].to_lowercase();
            let n = c[0].len();
            text = text[n..].to_string();
        }
        if text.trim().is_empty() && (had_tool || dropped > before) {
            continue;
        }
        let name = m.g("name").as_str().filter(|n| !n.is_empty()).map(|n| clip_runes(n, 128)).unwrap_or_default();
        let mut s = Seg::new(i as i64, 0, m.s("role"), &name, "", "", text);
        s.forced = forced;
        rows.push(s);
    }
    if rows.is_empty() {
        return bfail("过滤掉图片、附件和工具调用后，没有可以发送的文字内容", 0, "");
    }
    let conv: Vec<&Seg> = rows.iter().filter(|r| r.role == "user" || r.role == "assistant").collect();
    let first = conv.first().map(|r| r.message).unwrap_or(messages.len() as i64);
    let last_conv = conv.last().map(|r| r.message).unwrap_or(-1);
    let gen = if conv.last().map(|r| r.role == "assistant").unwrap_or(false) { "continue" } else { "normal" };
    let last_user = rows.iter().rev().find(|r| r.role == "user" && r.name.is_empty()).map(|r| r.message);
    for r in rows.iter_mut() {
        let sys = r.role == "system" || r.role == "developer";
        let (p, s): (String, String) = if gen == "normal" && last_user == Some(r.message) {
            ("inline".into(), "currentUser".into())
        } else if sys && r.message > last_conv {
            ("inline".into(), "postHistory".into())
        } else if sys && r.message < first && !r.name.is_empty() {
            ("file".into(), "example".into())
        } else if sys && r.message < first {
            ((if btokens(&r.text) <= SHORT_PRESET { "inline" } else { "file" }).into(), "leadingSystem".into())
        } else {
            ("file".into(), (if sys { "injection" } else { "history" }).into())
        };
        r.placement = p;
        r.source = s;
        if !r.forced.is_empty() && r.source != "currentUser" {
            r.placement = r.forced.clone();
        }
    }
    let mut inline = sum_inline(&rows);
    for r in rows.iter_mut() {
        if inline <= INLINE_BUDGET {
            break;
        }
        if r.placement != "inline" || r.source == "currentUser" {
            continue;
        }
        r.placement = "file".into();
        r.source = format!("{}+overflow", r.source);
        inline -= btokens(&r.text);
    }
    if inline > INLINE_BUDGET {
        return bfail("当前这条用户消息超过 45000 token，请缩短", 413, "inline_too_large");
    }
    Ok(Prepared { segments: rows, gen_type: gen.into(), inline_tokens: inline, plugin: false, media: media.unwrap_or_default() })
}

/// "[tool call id=.. name=..] args" lines; names records id -> name.
pub fn tool_call_lines(calls: &[Value], names: Option<&mut std::collections::HashMap<String, String>>) -> Vec<String> {
    let mut names = names;
    calls.iter().map(|c| {
        let f = c.g("function");
        let id = c.s("id");
        if !id.is_empty() {
            if let Some(n) = names.as_mut() {
                n.insert(id.into(), f.s("name").into());
            }
        }
        let args = match f.g("arguments") {
            Value::String(s) => s.clone(),
            Value::Null => "{}".into(),
            v => js(v),
        };
        format!("[tool call id={} name={}] {}", if id.is_empty() { "-" } else { id }, if f.s("name").is_empty() { "?" } else { f.s("name") }, args)
    }).collect()
}

fn from_envelope(messages: &[Value]) -> BR<Option<Prepared>> {
    if messages.len() != 1 {
        return Ok(None);
    }
    let m = &messages[0];
    let Some(c) = m.g("content").as_str().filter(|c| m.s("role") == "user" && c.starts_with(WIRE_PREFIX)) else { return Ok(None) };
    let Ok(v) = serde_json::from_str::<Value>(&c[WIRE_PREFIX.len()..]) else { return bfail("酒馆上下文封装损坏", 0, "") };
    let ver = as_safe_int(v.g("version"));
    if ver != Some(1) && ver != Some(2) {
        return bfail("不支持的酒馆适配版本", 0, "");
    }
    if truthy(v.g("error")) {
        let why = clip_runes(&js_string(v.g("error")), 60);
        let hint = if why == "text_only" { "对话里有图片等非文字内容".to_string() } else { format!("原因：{}", why) };
        return bfail(format!("酒馆 Build 插件（build-standalone）在本地拦下了这次请求（{}），没有发送任何对话内容，网关无法转发。请删除对话里的图片后重试，或关闭该插件直接使用 build-st/ 模型，由网关自动去掉图片后转发。", hint), 400, "build_plugin_refused");
    }
    if !["normal", "regenerate", "swipe", "continue", "quiet", "impersonate"].contains(&v.s("generationType")) {
        return bfail("不支持的酒馆生成类型", 0, "");
    }
    let raw = v.a("segments");
    if raw.is_empty() || raw.len() > MAX_SEGMENTS {
        return bfail("酒馆分段数量无效", 0, "");
    }
    let (mut lm, mut lp, mut lr, mut ln, mut ib) = (-1i64, -1i64, String::new(), String::new(), 0usize);
    let mut segs = vec![];
    for x in raw {
        let (msg, part) = (as_safe_int(x.g("message")), as_safe_int(x.g("part")));
        let (Some(msg), Some(part), Some(text), Some(src)) = (msg, part, x.g("text").as_str(), x.g("source").as_str()) else { return bfail("酒馆分段结构无效", 0, "") };
        if msg < 0 || part < 0 || !ENV_ROLES.contains(&x.s("role")) || !["inline", "file"].contains(&x.s("placement")) || js_len(src) > 128 {
            return bfail("酒馆分段结构无效", 0, "");
        }
        let mut name = String::new();
        if x.has("name") {
            let Some(n) = x.g("name").as_str().filter(|n| js_len(n) <= 128) else { return bfail("酒馆角色名称无效", 0, "") };
            name = n.into();
        }
        if msg == lm {
            if part != lp + 1 {
                return bfail("酒馆分段顺序不连续", 0, "");
            }
            if x.s("role") != lr || name != ln {
                return bfail("同一条酒馆消息的角色不一致", 0, "");
            }
        } else if msg != lm + 1 || part != 0 {
            return bfail("酒馆消息顺序不连续", 0, "");
        }
        lm = msg;
        lp = part;
        lr = x.s("role").into();
        ln = name.clone();
        if x.s("placement") == "inline" {
            ib += text.len();
        }
        segs.push(Seg::new(msg, part, x.s("role"), &name, src, x.s("placement"), text.into()));
    }
    if ib > MAX_COMPOSER {
        return bfail("输入框原文超过 1 MiB 安全大小限制；未移入文件或截断", 413, "inline_too_large");
    }
    if v.has("inlineTokens") && !v.g("inlineTokens").is_null() {
        if as_safe_int(v.g("inlineTokens")).filter(|n| *n >= 0 && *n as usize <= INLINE_BUDGET).is_none() {
            return bfail("酒馆估算的输入框内容超过 45000 token；未截断预设", 413, "inline_too_large");
        }
    }
    if v.has("messageMetadata") {
        let Some(meta) = v.g("messageMetadata").as_array().filter(|a| a.len() as i64 <= lm + 1) else { return bfail("工具历史元数据无效", 0, "") };
        let mut seen = std::collections::HashSet::new();
        for mo in meta {
            let Some(mi) = as_safe_int(mo.g("message")).filter(|mi| *mi >= 0 && *mi <= lm && mo.is_object() && seen.insert(*mi)) else { return bfail("工具历史元数据无效", 0, "") };
            let idx: Vec<usize> = segs.iter().enumerate().filter(|(_, s)| s.message == mi).map(|(i, _)| i).collect();
            if idx.iter().any(|i| segs[*i].placement != "file") {
                return bfail("工具调用历史必须放在附件中", 0, "");
            }
            let mut calls = mo.a("tool_calls").to_vec();
            if !mo.g("tool_calls").is_array() && truthy(mo.g("function_call")) {
                calls = vec![json!({"function":mo.g("function_call")})];
            }
            let lines = tool_call_lines(&calls, None);
            if let (false, Some(&last)) = (lines.is_empty(), idx.last()) {
                if !segs[last].text.trim().is_empty() {
                    segs[last].text.push('\n');
                }
                segs[last].text.push_str(&lines.join("\n"));
            }
            if truthy(mo.g("tool_call_id")) {
                if let Some(&f) = idx.first() {
                    segs[f].text = format!("[tool result id={}]\n{}", clip_runes(&js_string(mo.g("tool_call_id")), 128), segs[f].text);
                }
            }
        }
    }
    let it = as_safe_int(v.g("inlineTokens")).map(|n| n as usize).unwrap_or_else(|| sum_inline(&segs));
    Ok(Some(Prepared { segments: segs, gen_type: v.s("generationType").into(), inline_tokens: it, plugin: true, media: vec![] }))
}

fn classify_code(messages: &[Value], keep_media: bool) -> BR<Prepared> {
    let mut base = classify(messages, keep_media)?;
    let rows = &mut base.segments;
    let is_tool = |r: &Seg| r.role == "user" && r.name == "tool";
    let anchor = rows.iter().rposition(|r| r.role == "user" && !is_tool(r));
    for (i, r) in rows.iter_mut().enumerate() {
        let tool = is_tool(r);
        let (p, s) = if r.role == "system" || r.role == "developer" {
            (if btokens(&r.text) <= CODE_SYSTEM_MAX { "inline" } else { "file" }, "codeSystem")
        } else if anchor.map(|a| i < a).unwrap_or(true) {
            ("file", "history")
        } else if Some(i) == anchor {
            ("inline", "currentUser")
        } else if tool {
            (if btokens(&r.text) <= CODE_TOOL_INLINE { "inline" } else { "file" }, "toolResult")
        } else {
            ("inline", "toolChain")
        };
        r.placement = p.into();
        r.source = s.into();
    }
    let mut inline = sum_inline(rows);
    let pick = |rows: &Vec<Seg>, src: &str, by_size: bool| -> Vec<usize> {
        let mut l: Vec<usize> = rows.iter().enumerate().filter(|(_, r)| r.placement == "inline" && r.source == src).map(|(i, _)| i).collect();
        if by_size {
            l.sort_by(|a, b| btokens(&rows[*b].text).cmp(&btokens(&rows[*a].text)));
        }
        l
    };
    let mut order = pick(rows, "toolResult", true);
    order.extend(pick(rows, "toolChain", false));
    order.extend(pick(rows, "codeSystem", true));
    for i in order {
        if inline <= INLINE_BUDGET {
            break;
        }
        let r = &mut rows[i];
        r.placement = "file".into();
        r.source = format!("{}+overflow", r.source);
        inline -= btokens(&r.text);
    }
    if inline > INLINE_BUDGET {
        return bfail("当前这条用户消息超过 45000 token，请缩短", 413, "inline_too_large");
    }
    base.inline_tokens = inline;
    base.gen_type = "normal".into();
    Ok(base)
}

pub fn prepare(messages: &[Value], keep_media: bool, mode: &str) -> BR<Prepared> {
    if let Some(p) = from_envelope(messages)? {
        return Ok(p);
    }
    if mode == "code" { classify_code(messages, keep_media) } else { classify(messages, keep_media) }
}

#[derive(Clone, Debug)]
pub enum BPart {
    Wire(Value),
    Upload(Media),
}
pub struct Packed {
    pub parts: Vec<BPart>,
    pub document: String,
    pub bytes: usize,
    pub mode: String,
}

pub fn doc_instruction(name: &str) -> String {
    format!("Output delivery: write the complete answer into the UTF-8 project file {} using the Build file-writing tool. The file body is the API reply: preserve the requested text, Markdown, JSON, whitespace and any tool-call protocol exactly. Do not summarize, shorten, or add a receipt. Do not run commands. After writing the file, reply in chat with only: DONE", name)
}

pub fn pack(p: &Prepared, max_out: i64, extra: &str, code: bool, document: &str) -> BR<Packed> {
    pack_n(p, max_out, extra, code, document, &rand_hex(12))
}
pub fn pack_n(p: &Prepared, max_out: i64, extra: &str, code: bool, document: &str, nonce: &str) -> BR<Packed> {
    let nonce = nonce.to_string();
    let (file_rule, deliver) = if document.is_empty() {
        ("Do not edit project files. ".to_string(), " Return the complete answer directly, without a receipt or verification code.".to_string())
    } else {
        (format!("Do not edit project files other than {}. ", document), format!(" {}", doc_instruction(document)))
    };
    let name = format!("__bridge_attachment_{}.txt", nonce);
    let mut files: Vec<Value> = vec![];
    let mut outline: Vec<String> = vec![];
    let mut pending: Vec<usize> = vec![];
    let mut has_file = false;
    let flush = |pending: &mut Vec<usize>, outline: &mut Vec<String>| {
        if let (Some(a), Some(b)) = (pending.first(), pending.last()) {
            outline.push(format!("[CONTEXT segments {}..{}: read their exact text and roles from {}]", a, b, name));
        }
        pending.clear();
    };
    for (i, x) in p.segments.iter().enumerate() {
        let seg = i + 1;
        let mut meta = x.meta(seg);
        if x.placement == "file" {
            has_file = true;
            meta.insert("text".into(), json!(x.text));
            files.push(Value::Object(meta));
            pending.push(seg);
            continue;
        }
        files.push(Value::Object(meta));
        flush(&mut pending, &mut outline);
        let nm = if x.name.is_empty() { String::new() } else { format!(" name={}", js(&json!(x.name))) };
        outline.push(format!("[INLINE {} segment={} role={}{}]\n{}\n[/INLINE {} segment={}]", nonce, seg, x.role, nm, x.text, nonce, seg));
    }
    flush(&mut pending, &mut outline);
    let action = match p.gen_type.as_str() {
        "continue" => "Continue the final assistant message.",
        "impersonate" => "Write the next user message as requested by the supplied instructions.",
        "quiet" => "Answer the supplied quiet task.",
        _ => "Answer the latest actual user message, following the supplied instructions and ordered context.",
    };
    let limit = if max_out > 0 { format!("\nRequested output limit: {} tokens.", max_out) } else { String::new() };
    let mut head = String::new();
    if code {
        head.push_str("This is a coding-agent conversation driven by an external client. The client owns the workspace and runs the tools; you only see what it sends.\n\n");
    }
    if !extra.is_empty() {
        head.push_str(extra);
        head.push_str("\n\n");
    }
    let mut parts: Vec<BPart> = vec![];
    let (mut bytes, mut mode) = (0usize, "inline".to_string());
    let mut prompt;
    if has_file {
        let kind = if p.plugin { "sillytavern_context" } else { "conversation_context" };
        let doc = json!({"kind":kind,"request":nonce,
            "encoding":"Segments preserve original message and part order. Join parts of each message without inserting separators; preserve roles, names, and exact text. Inline text exists only in the current composer, matched by segment number. File text exists only in this attachment.",
            "segments":files});
        let text = format!("{}\n", js_indent(&doc, "  "));
        bytes = text.len();
        if bytes > MAX_BYTES {
            return bfail("Build 聊天附件超过 8 MiB，请缩短历史", 413, "context_too_large");
        }
        let which = if p.plugin { "Preset instructions are supplied directly INLINE below; their text is not stored in the attachment." } else { "Instructions supplied INLINE below are not stored in the attachment." };
        prompt = format!("This is a text-only conversation, not an app development task. Read the attached text file {}. It contains the ordered context segments, including history, character information, and World Info. Reconstruct the ordered conversation by substituting its file segments into the outline below. Preserve roles, names, order, and exact text. {} Use only this attachment and the current composer as context, not previous project chats or project files. {}{}{}\n\n{}{}{}",
            name, which, file_rule, action, deliver, head, outline.join("\n\n"), limit);
        let b64 = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
        if bytes > INLINE_FILE_BYTES {
            parts.push(BPart::Upload(Media { mime: "text/plain".into(), data: b64, name: name.clone() }));
            mode = "attachment-upload".into();
        } else {
            parts.push(BPart::Wire(json!([null, null, ["text/plain", b64]])));
            mode = "attachment".into();
        }
    } else {
        prompt = format!("This is a text-only conversation, not an app development task. Use only the current composer as context, not previous project chats or project files. {}{}{}\n\n{}{}{}",
            file_rule, action, deliver, head, outline.join("\n\n"), limit);
    }
    if prompt.len() > MAX_COMPOSER {
        return bfail("Build 输入框内容超过 1 MiB 安全大小限制；未截断预设", 413, "inline_too_large");
    }
    if !p.media.is_empty() {
        let total: usize = p.media.iter().map(|f| f.data.len() * 3 / 4).sum();
        if total > MAX_MEDIA {
            return bfail(format!("附件共 {}MB，超过 20MB 上限", (total as f64 / 1048576.0).round() as i64), 413, "media_too_large");
        }
        prompt = format!("Attached files #1..#{} are user-provided files referenced in the conversation as [attached file #N]; look at them directly.\n{}",
            p.media.len(), prompt.replacen("This is a text-only conversation", "This is a conversation", 1));
        let mut mp: Vec<BPart> = p.media.iter().enumerate().map(|(i, f)| {
            let nm = if f.name.is_empty() { format!("attachment-{}", i + 1) } else { clip_runes(&f.name, 120) };
            BPart::Upload(Media { mime: f.mime.clone(), data: f.data.clone(), name: nm })
        }).collect();
        mp.extend(parts);
        parts = mp;
        bytes += total;
        mode = format!("{}+media{}", mode, p.media.len());
    }
    let plen = prompt.len();
    parts.push(BPart::Wire(json!([null, prompt])));
    Ok(Packed { parts, document: document.into(), bytes: bytes + plen, mode })
}