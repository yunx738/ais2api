// Uploaded SillyTavern presets -> server-side context splitting for the Build channel (build-presets.js).
// Matching runs on UTF-16 units so every split position equals the JS version.
use crate::build_ctx::{btokens, INLINE_BUDGET, WIRE_PREFIX};
use crate::util::*;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::sync::Mutex;

const BACKGROUND: [&str; 13] = ["worldInfoBefore", "worldInfoAfter", "charDescription", "charPersonality", "scenario", "personaDescription",
    "dialogueExamples", "chatHistory", "summary", "authorsNote", "vectorsMemory", "vectorsDataBank", "smartContext"];
const MIN_LITERAL: usize = 12;
const MAX_GAP: usize = 300000;
const GAP_FILE: usize = 1500;
const MAX_PRESETS: usize = 20;
const MAX_PROMPTS: usize = 1000;
const MAX_DEPTH: usize = 8;

type U = Vec<u16>;
fn u16s(s: &str) -> U {
    s.encode_utf16().collect()
}
fn st(u: &[u16]) -> String {
    String::from_utf16_lossy(u)
}
fn js_ws16(c: u16) -> bool {
    matches!(c, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
fn trim16(u: &[u16]) -> &[u16] {
    let mut a = 0;
    let mut b = u.len();
    while a < b && js_ws16(u[a]) {
        a += 1;
    }
    while b > a && js_ws16(u[b - 1]) {
        b -= 1;
    }
    &u[a..b]
}
fn starts(t: &[u16], i: usize, p: &[u16]) -> bool {
    t.len() >= i + p.len() && &t[i..i + p.len()] == p
}
fn bytes(u: &[u16]) -> &[u8] {
    // SAFETY: u16 slice viewed as bytes; same layout on both sides, alignment of u8 is 1.
    unsafe { std::slice::from_raw_parts(u.as_ptr() as *const u8, u.len() * 2) }
}
/// String#indexOf(p, from)
fn index_of(t: &[u16], p: &[u16], from: usize) -> Option<usize> {
    if p.is_empty() {
        return Some(from.min(t.len()));
    }
    if from >= t.len() || p.len() > t.len() - from {
        return None;
    }
    let f = memchr::memmem::Finder::new(bytes(p));
    let hay = bytes(t);
    let mut at = from * 2;
    while let Some(i) = f.find(&hay[at..]) {
        let b = at + i;
        if b % 2 == 0 {
            return Some(b / 2);
        }
        at = b + 1;
    }
    None
}
/// String#lastIndexOf(p, pos)
fn last_index_of(t: &[u16], p: &[u16], pos: usize) -> Option<usize> {
    if p.len() > t.len() {
        return None;
    }
    let start = pos.min(t.len() - p.len());
    let f = memchr::memmem::FinderRev::new(bytes(p));
    let hay = bytes(t);
    let mut end = (start + p.len()) * 2;
    while let Some(b) = f.rfind(&hay[..end]) {
        if b % 2 == 0 {
            return Some(b / 2);
        }
        end = b + bytes(p).len() - 1;
    }
    None
}
fn norm(t: &str) -> String {
    let t = t.strip_prefix('\u{feff}').unwrap_or(t);
    t.replace("\r\n", "\n").replace('\r', "\n")
}

/// Literal text pieces of a prompt; macros / templates / placeholders act as wildcards.
pub fn chunks_of(text: &str) -> Vec<String> {
    let t = u16s(&norm(text));
    let mut out: Vec<String> = vec![];
    let mut buf: U = vec![];
    let flush = |buf: &mut U, out: &mut Vec<String>| {
        let x = trim16(buf);
        if !x.is_empty() {
            out.push(st(x));
        }
        buf.clear();
    };
    let (ob, cb, op, cp) = (u16s("{{"), u16s("}}"), u16s("<%"), u16s("%>"));
    const TAGS: [&str; 5] = ["<USER>", "<BOT>", "<CHAR>", "<CHARIFNOTGROUP>", "<GROUP>"];
    let mut i = 0;
    while i < t.len() {
        if starts(&t, i, &ob) {
            let mut d = 0i64;
            let mut j = i;
            while j < t.len() {
                if starts(&t, j, &ob) {
                    d += 1;
                    j += 2;
                } else if starts(&t, j, &cb) {
                    d -= 1;
                    j += 2;
                    if d == 0 {
                        break;
                    }
                } else {
                    j += 1;
                }
            }
            flush(&mut buf, &mut out);
            i = j;
            continue;
        }
        if starts(&t, i, &op) {
            let j = index_of(&t, &cp, i + 2);
            flush(&mut buf, &mut out);
            i = match j {
                None => t.len(),
                Some(j) => j + 2,
            };
            continue;
        }
        if t[i] == b'<' as u16 {
            let win = st(&t[i..(i + 20).min(t.len())]).to_uppercase();
            if let Some(tag) = TAGS.iter().find(|g| win.starts_with(*g)) {
                flush(&mut buf, &mut out);
                i += tag.len();
                continue;
            }
        }
        if t[i] == b'$' as u16 && i + 1 < t.len() {
            let c = t[i + 1];
            let is_ph = (b'0' as u16..=b'9' as u16).contains(&c) || (b'A' as u16..=b'Z' as u16).contains(&c);
            let next_ok = match t.get(i + 2) {
                None => true,
                Some(&n) => !((b'0' as u16..=b'9' as u16).contains(&n) || (b'A' as u16..=b'Z' as u16).contains(&n) || (b'a' as u16..=b'z' as u16).contains(&n)),
            };
            if is_ph && next_ok {
                flush(&mut buf, &mut out);
                i += 2;
                continue;
            }
        }
        buf.push(t[i]);
        i += 1;
    }
    flush(&mut buf, &mut out);
    out
}

fn collect<'a>(node: &'a Value, depth: usize, out: &mut Vec<&'a Map<String, Value>>) {
    if depth > MAX_DEPTH || out.len() >= MAX_PROMPTS * 4 {
        return;
    }
    match node {
        Value::Array(a) => {
            for x in a {
                match x {
                    Value::Object(o) if o.get("content").map(|c| c.is_string()).unwrap_or(false) => out.push(o),
                    _ => collect(x, depth + 1, out),
                }
            }
        }
        Value::Object(o) => {
            for v in o.values() {
                collect(v, depth + 1, out);
            }
        }
        _ => {}
    }
}
fn label_of(p: &Map<String, Value>, chunks: &[String]) -> String {
    for k in ["name", "identifier"] {
        if let Some(v) = p.get(k).filter(|v| truthy(v)) {
            return js_string(v);
        }
    }
    let mut best = String::new();
    for c in chunks {
        if js_len(c) > js_len(&best) {
            best = c.clone();
        }
    }
    let collapsed = WS_RE.replace_all(&best, " ");
    format!("{}…", st(&u16s(&collapsed)[..js_len(&collapsed).min(18)]))
}
static WS_RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| regex::Regex::new(r"[\s\u{feff}]+").unwrap());
fn slice16s(s: &str, n: usize) -> String {
    let u = u16s(s);
    st(&u[..u.len().min(n)])
}

/// Preset file -> prompt list (each prompt as JSON {id,name,chunks}).
pub fn parse_preset(preset: &Value) -> R<Vec<Value>> {
    if !matches!(preset, Value::Object(_) | Value::Array(_)) {
        return herr(400, "文件内容不是预设（需要 JSON 对象或数组）");
    }
    let mut items = vec![];
    collect(preset, 0, &mut items);
    if items.is_empty() {
        return herr(400, "文件里没有找到提示词条目（带 content 的条目）");
    }
    let mut out: Vec<Value> = vec![];
    let mut seen: HashSet<String> = HashSet::new();
    for p in items {
        if out.len() >= MAX_PROMPTS {
            break;
        }
        if p.get("marker") == Some(&Value::Bool(true)) {
            continue;
        }
        let idv = p.get("identifier").filter(|v| truthy(v)).or_else(|| p.get("id").filter(|v| truthy(v)));
        let ident = slice16s(&idv.map(js_string).unwrap_or_default(), 100);
        if BACKGROUND.contains(&ident.as_str()) {
            continue;
        }
        let chunks = chunks_of(p.s("content"));
        if js_len(&chunks.concat()) < MIN_LITERAL {
            continue;
        }
        let key = chunks.join("\u{0}");
        if !seen.insert(key) {
            continue;
        }
        let label = label_of(p, &chunks);
        out.push(json!({"id":format!("{}#{}", if ident.is_empty() { "p" } else { &ident }, out.len()),"name":slice16s(&label, 128),"chunks":chunks}));
    }
    if out.is_empty() {
        return herr(400, "预设里没有可识别的条目（条目需有正文，且不能只有宏）");
    }
    Ok(out)
}

#[derive(Clone)]
pub struct Prompt {
    pub id: String,
    chunks: Vec<U>,
    total: usize,
}
impl Prompt {
    pub fn from_json(v: &Value) -> Prompt {
        let chunks: Vec<U> = v.a("chunks").iter().map(|c| u16s(&js_string(c))).collect();
        let total = chunks.iter().map(|c| c.len()).sum();
        Prompt { id: v.s("id").into(), chunks, total }
    }
}
fn find_one(text: &[u16], chunks: &[U], from: usize) -> Option<Vec<(usize, usize)>> {
    let mut k = 0;
    for i in 1..chunks.len() {
        if chunks[i].len() > chunks[k].len() {
            k = i;
        }
    }
    let mut pos = index_of(text, &chunks[k], from);
    while let Some(p) = pos {
        let mut hit = vec![(0usize, 0usize); chunks.len()];
        hit[k] = (p, p + chunks[k].len());
        let mut ok = true;
        let mut i = k as isize - 1;
        while i >= 0 && ok {
            let iu = i as usize;
            let lim = hit[iu + 1].0 as isize - chunks[iu].len() as isize;
            let at = if lim < from as isize { None } else { last_index_of(text, &chunks[iu], lim as usize) };
            match at {
                Some(a) if a >= from && hit[iu + 1].0 - (a + chunks[iu].len()) <= MAX_GAP => hit[iu] = (a, a + chunks[iu].len()),
                _ => ok = false,
            }
            i -= 1;
        }
        let mut i = k + 1;
        while i < chunks.len() && ok {
            match index_of(text, &chunks[i], hit[i - 1].1) {
                Some(a) if a - hit[i - 1].1 <= MAX_GAP => hit[i] = (a, a + chunks[i].len()),
                _ => ok = false,
            }
            i += 1;
        }
        if ok {
            return Some(hit);
        }
        pos = index_of(text, &chunks[k], p + 1);
    }
    None
}
struct Span {
    start: usize,
    end: usize,
    source: String,
    pos: Vec<(usize, usize)>,
}
fn spans(text: &[u16], prompts: &[&Prompt]) -> Vec<Span> {
    let mut found: Vec<Span> = vec![];
    for p in prompts {
        let mut from = 0;
        while from < text.len() {
            let Some(hit) = find_one(text, &p.chunks, from) else { break };
            let (start, end) = (hit[0].0, hit[hit.len() - 1].1);
            if !found.iter().any(|s| start < s.end && end > s.start) {
                found.push(Span { start, end, source: p.id.clone(), pos: hit });
            }
            from = end;
        }
    }
    found.sort_by_key(|s| s.start);
    found
}
fn text_of(c: &Value) -> Option<String> {
    match c {
        Value::String(s) => Some(s.clone()),
        Value::Array(a) if a.iter().all(|p| p.s("type") == "text" && p.g("text").is_string()) => Some(a.iter().map(|p| p.s("text")).collect::<Vec<_>>().join("\n")),
        _ => None,
    }
}
pub struct Segmented {
    pub segments: Vec<Value>,
    pub gen_type: String,
    pub inline_tokens: usize,
    pub hits: usize,
    pub matched: Vec<String>,
}
/// messages -> preset-based split, or None when nothing matched / not applicable.
pub fn segment(messages: &[Value], prompts: &[Prompt]) -> Option<Segmented> {
    if messages.is_empty() || prompts.is_empty() {
        return None;
    }
    struct Row {
        role: String,
        name: String,
        text: U,
    }
    let mut rows: Vec<Row> = vec![];
    for m in messages {
        let role = m.s("role");
        if !["system", "developer", "user", "assistant"].contains(&role) || truthy(m.g("tool_calls")) || truthy(m.g("function_call")) {
            return None;
        }
        let t = text_of(m.g("content"))?;
        let name = match m.g("name") {
            Value::String(s) if !s.is_empty() => slice16s(s, 128),
            _ => String::new(),
        };
        rows.push(Row { role: role.into(), name, text: u16s(&norm(&t)) });
    }
    if rows.len() == 1 && starts(&rows[0].text, 0, &u16s(WIRE_PREFIX)) {
        return None;
    }
    let mut ordered: Vec<&Prompt> = prompts.iter().collect();
    ordered.sort_by(|a, b| b.total.cmp(&a.total));
    let conv: Vec<usize> = rows.iter().enumerate().filter(|(_, r)| r.role == "user" || r.role == "assistant").map(|(i, _)| i).collect();
    let gen_type = if conv.last().map(|&l| rows[l].role == "assistant").unwrap_or(false) { "continue" } else { "normal" };
    let mut current: isize = -1;
    if gen_type == "normal" {
        for i in (0..rows.len()).rev() {
            if rows[i].role == "user" && rows[i].name.is_empty() {
                current = i as isize;
                break;
            }
        }
    }
    let mut segs: Vec<(Map<String, Value>, String, String, String)> = vec![]; // base+part, source, placement, text
    let mut matched: Vec<String> = vec![];
    let mut hits = 0;
    for (i, r) in rows.iter().enumerate() {
        let list = spans(&r.text, &ordered);
        let rest = if i as isize == current { ("inline", "currentUser") } else { ("file", "context") };
        let mut part = 0;
        let mut at = 0;
        let mut push = |segs: &mut Vec<(Map<String, Value>, String, String, String)>, text: &[u16], placement: &str, source: &str| {
            if !trim16(text).is_empty() {
                let mut b = Map::new();
                b.insert("message".into(), json!(i));
                b.insert("role".into(), json!(r.role));
                if !r.name.is_empty() {
                    b.insert("name".into(), json!(r.name));
                }
                b.insert("part".into(), json!(part));
                part += 1;
                segs.push((b, source.into(), placement.into(), st(text)));
            }
        };
        for s in &list {
            push(&mut segs, &r.text[at..s.start], rest.0, rest.1);
            hits += 1;
            if !matched.contains(&s.source) {
                matched.push(s.source.clone());
            }
            let mut piece = s.start;
            for k in 1..s.pos.len() {
                let (gs, ge) = (s.pos[k - 1].1, s.pos[k].0);
                if ge - gs > GAP_FILE {
                    push(&mut segs, &r.text[piece..gs], "inline", &s.source);
                    push(&mut segs, &r.text[gs..ge], rest.0, rest.1);
                    piece = ge;
                }
            }
            push(&mut segs, &r.text[piece..s.end], "inline", &s.source);
            at = s.end;
        }
        push(&mut segs, &r.text[at..], rest.0, rest.1);
        if !segs.iter().any(|x| x.0.get("message") == Some(&json!(i))) {
            let mut b = Map::new();
            b.insert("message".into(), json!(i));
            b.insert("role".into(), json!(r.role));
            if !r.name.is_empty() {
                b.insert("name".into(), json!(r.name));
            }
            b.insert("part".into(), json!(0));
            segs.push((b, rest.1.into(), rest.0.into(), st(&r.text)));
        }
    }
    if hits == 0 {
        return None;
    }
    let mut inline: usize = segs.iter().filter(|x| x.2 == "inline").map(|x| btokens(&x.3)).sum();
    for x in segs.iter_mut() {
        if inline <= INLINE_BUDGET {
            break;
        }
        if x.2 != "inline" || x.1 == "currentUser" {
            continue;
        }
        x.2 = "file".into();
        x.1.push_str("+overflow");
        inline -= btokens(&x.3);
    }
    let segments = segs.into_iter().map(|(mut b, source, placement, text)| {
        b.insert("source".into(), json!(source));
        b.insert("placement".into(), json!(placement));
        b.insert("text".into(), json!(text));
        Value::Object(b)
    }).collect();
    Some(Segmented { segments, gen_type: gen_type.into(), inline_tokens: inline, hits, matched })
}
pub fn envelope(p: &Segmented) -> String {
    format!("{}{}", WIRE_PREFIX, js(&json!({"version":1,"generationType":p.gen_type,"segments":p.segments,"inlineTokens":p.inline_tokens})))
}

/// build-presets.json. Memory: only preset metadata + compiled UTF-16 chunks are kept (the 4 MB file is not held as JSON).
struct Preset {
    meta: Map<String, Value>, // every field except "prompts"
    names: Vec<Value>,
    prompts: Vec<Prompt>,
}
impl Preset {
    fn from_json(p: &Value) -> Preset {
        let mut meta = p.as_object().cloned().unwrap_or_default();
        meta.shift_remove("prompts");
        let names = p.a("prompts").iter().map(|x| x.g("name").clone()).collect();
        Preset { meta, names, prompts: p.a("prompts").iter().map(Prompt::from_json).collect() }
    }
    fn to_json(&self) -> Value {
        let mut o = Map::new();
        for (k, v) in &self.meta {
            if k == "enabled" || k == "requests" || k == "lastHitAt" || k == "lastHits" {
                continue;
            }
            o.insert(k.clone(), v.clone());
            if k == "uploadedAt" {
                o.insert("enabled".into(), self.meta.get("enabled").cloned().unwrap_or(json!(true)));
            }
        }
        if !o.contains_key("enabled") {
            o.insert("enabled".into(), self.meta.get("enabled").cloned().unwrap_or(json!(true)));
        }
        let prompts: Vec<Value> = self.prompts.iter().zip(&self.names).map(|(p, n)| {
            json!({"id":p.id,"name":n,"chunks":p.chunks.iter().map(|c| st(c)).collect::<Vec<_>>()})
        }).collect();
        o.insert("prompts".into(), Value::Array(prompts));
        for k in ["requests", "lastHitAt", "lastHits"] {
            if let Some(v) = self.meta.get(k) {
                o.insert(k.into(), v.clone());
            }
        }
        Value::Object(o)
    }
    fn enabled(&self) -> bool {
        self.meta.get("enabled") != Some(&Value::Bool(false))
    }
}
pub struct PresetStore {
    file: String,
    cache: Mutex<Option<Vec<Preset>>>,
}
pub struct Applied {
    pub content: String,
    pub hits: usize,
    pub inline_tokens: usize,
}
impl PresetStore {
    pub fn new(file: &str) -> Self {
        PresetStore { file: file.into(), cache: Mutex::new(None) }
    }
    fn with<T>(&self, f: impl FnOnce(&mut Vec<Preset>) -> T) -> T {
        let mut g = self.cache.lock().unwrap();
        if g.is_none() {
            let list = match read_json(&self.file) {
                Ok(d) => d.a("presets").iter().map(Preset::from_json).collect(),
                _ => vec![],
            };
            *g = Some(list);
            crate::util::trim_heap();
        }
        f(g.as_mut().unwrap())
    }
    /// serialized file content (same layout as the Node/Go versions)
    pub fn dump(&self) -> String {
        self.with(|list| js(&json!({"presets":list.iter().map(|p| p.to_json()).collect::<Vec<_>>()})))
    }
    fn save(&self, list: &[Preset]) -> std::io::Result<()> {
        if crate::state::READ_ONLY.load(std::sync::atomic::Ordering::Relaxed) {
            return Ok(());
        }
        let v = json!({"presets":list.iter().map(|p| p.to_json()).collect::<Vec<_>>()});
        let r = write_simple(&self.file, js(&v).as_bytes(), 0o600);
        drop(v);
        crate::util::trim_heap();
        r
    }
    pub fn list(&self) -> Value {
        self.with(|list| {
            Value::Array(list.iter().map(|p| {
                let m = &p.meta;
                json!({"id":m.g("id"),"name":m.g("name"),"uploadedAt":m.g("uploadedAt"),"enabled":p.enabled(),"prompts":p.names,
                    "requests":if truthy(m.g("requests")) { m.g("requests").clone() } else { json!(0) },
                    "lastHitAt":if truthy(m.g("lastHitAt")) { m.g("lastHitAt").clone() } else { Value::Null },
                    "lastHits":if truthy(m.g("lastHits")) { m.g("lastHits").clone() } else { json!(0) }})
            }).collect())
        })
    }
    pub fn add(&self, name: &Value, preset: &Value) -> R<Value> {
        let prompts = parse_preset(preset)?;
        self.with(|list| {
            if list.len() >= MAX_PRESETS {
                return herr(400, format!("最多保存 {} 个预设，请先删除不用的", MAX_PRESETS));
            }
            let raw = if truthy(name) { js_string(name) } else { "预设".into() };
            let stripped = if raw.to_lowercase().ends_with(".json") { raw[..raw.len() - 5].to_string() } else { raw };
            let mut nm = slice16s(&stripped, 80);
            if nm.is_empty() {
                nm = "预设".into();
            }
            let n = prompts.len();
            let item = json!({"id":rand_hex(6),"name":nm,"uploadedAt":now_ms(),"enabled":true,"prompts":prompts});
            let id = item["id"].clone();
            list.push(Preset::from_json(&item));
            self.save(list).map_err(|e| HttpErr::plain(e.to_string()))?;
            Ok(json!({"id":id,"name":nm,"prompts":n}))
        })
    }
    pub fn remove(&self, id: &str) -> R<Value> {
        self.with(|list| {
            let Some(i) = list.iter().position(|p| p.meta.s("id") == id) else { return herr(404, "预设不存在") };
            list.remove(i);
            self.save(list).map_err(|e| HttpErr::plain(e.to_string()))?;
            Ok(json!({"ok":true}))
        })
    }
    pub fn set_enabled(&self, id: &str, on: bool) -> R<Value> {
        self.with(|list| {
            let Some(p) = list.iter_mut().find(|p| p.meta.s("id") == id) else { return herr(404, "预设不存在") };
            p.meta.insert("enabled".into(), json!(on));
            self.save(list).map_err(|e| HttpErr::plain(e.to_string()))?;
            Ok(json!({"ok":true}))
        })
    }
    /// messages -> envelope for the worker, or None.
    pub fn apply(&self, messages: &[Value]) -> Option<Applied> {
        self.with(|list| {
            let active: Vec<usize> = (0..list.len()).filter(|&i| list[i].enabled()).collect();
            if active.is_empty() {
                return None;
            }
            let all: Vec<Prompt> = active.iter().flat_map(|&i| list[i].prompts.iter().cloned()).collect();
            let prep = segment(messages, &all)?;
            drop(all);
            let now = now_ms();
            for &i in &active {
                let n = list[i].prompts.iter().filter(|x| prep.matched.contains(&x.id)).count();
                if n > 0 {
                    let m = &mut list[i].meta;
                    let r = as_num(m.g("requests")).filter(|f| *f != 0.0).unwrap_or(0.0);
                    m.insert("requests".into(), num(r + 1.0));
                    m.insert("lastHitAt".into(), json!(now));
                    m.insert("lastHits".into(), json!(n));
                }
            }
            let _ = self.save(list);
            Some(Applied { content: envelope(&prep), hits: prep.hits, inline_tokens: prep.inline_tokens })
        })
    }
}
