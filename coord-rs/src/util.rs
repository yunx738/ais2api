// Shared helpers: time windows, JS-compatible JSON access, atomic file writes, errors.
use serde_json::{Map, Value};
use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

pub const DAY: i64 = 86_400_000;
pub const RESET_OFFSET: i64 = 7 * 3_600_000; // quotas reset 15:00 Beijing (07:00 UTC)

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
pub fn period_start(t: i64) -> i64 {
    (t - RESET_OFFSET).div_euclid(DAY) * DAY + RESET_OFFSET
}
pub fn until_next_reset(now: i64) -> i64 {
    period_start(now) + DAY - now
}

/// Beijing time "YYYY-MM-DD HH:MM".
pub fn bj_time(ms: i64) -> String {
    let secs = (ms + 8 * 3_600_000).div_euclid(1000);
    chrono::DateTime::from_timestamp(secs, 0).map(|d| d.format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default()
}

// ---------------- errors ----------------
#[derive(Debug, Clone)]
pub struct HttpErr {
    pub status: u16,
    pub msg: String,
    pub retry_after: i64,
}
impl HttpErr {
    pub fn new(status: u16, msg: impl Into<String>) -> Self {
        HttpErr { status, msg: msg.into(), retry_after: 0 }
    }
    pub fn plain(msg: impl Into<String>) -> Self {
        HttpErr { status: 0, msg: msg.into(), retry_after: 0 }
    }
}
impl std::fmt::Display for HttpErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.msg)
    }
}
impl std::error::Error for HttpErr {}
pub type R<T> = Result<T, HttpErr>;
pub fn herr<T>(status: u16, msg: impl Into<String>) -> R<T> {
    Err(HttpErr::new(status, msg))
}

// ---------------- random / ids ----------------
pub fn rand_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut b);
    hex::encode(b)
}
pub fn uuid4() -> String {
    let mut b = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

// ---------------- files ----------------
/// tmp file (O_EXCL) + optional fsync + rename (+ dir fsync).
pub fn write_atomic(file: &str, data: &[u8], mode: u32, durable: bool) -> std::io::Result<()> {
    let tmp = format!("{}.{}.tmp", file, rand_hex(8));
    let res = (|| {
        let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(mode).open(&tmp)?;
        f.write_all(data)?;
        if durable {
            f.sync_all()?;
        }
        drop(f);
        fs::rename(&tmp, file)?;
        if durable {
            if let Some(dir) = Path::new(file).parent() {
                if let Ok(d) = fs::File::open(dir) {
                    let _ = d.sync_all();
                }
            }
        }
        Ok(())
    })();
    let _ = fs::remove_file(&tmp);
    res
}
/// fs.writeFileSync(file+'.tmp') + renameSync (fixed tmp name).
pub fn write_simple(file: &str, data: &[u8], mode: u32) -> std::io::Result<()> {
    let tmp = format!("{}.tmp", file);
    {
        let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(mode).open(&tmp)?;
        f.write_all(data)?;
    }
    fs::rename(&tmp, file)
}
pub fn read_json(file: &str) -> std::io::Result<Value> {
    let b = fs::read(file)?;
    serde_json::from_slice(&b).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}
pub fn file_exists(p: &str) -> bool {
    fs::metadata(p).is_ok()
}

// ---------------- JSON (JS semantics) ----------------
/// JSON.stringify(v)
pub fn js(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}
pub fn js_bytes(v: &Value) -> Vec<u8> {
    js(v).into_bytes()
}
/// JSON.stringify(v, null, indent)
pub fn js_indent(v: &Value, indent: &str) -> String {
    let mut out = Vec::new();
    let fmt = serde_json::ser::PrettyFormatter::with_indent(indent.as_bytes());
    let mut ser = serde_json::Serializer::with_formatter(&mut out, fmt);
    serde::Serialize::serialize(v, &mut ser).ok();
    String::from_utf8(out).unwrap_or_default()
}

/// Number with JS-like formatting: integral values without ".0".
pub fn num(f: f64) -> Value {
    if !f.is_finite() {
        return Value::Null;
    }
    if f == f.trunc() && f.abs() < 9.007_199_254_740_992e15 {
        return Value::from(f as i64);
    }
    serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
}

pub fn as_num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64().or_else(|| n.to_string().parse().ok()),
        _ => None,
    }
}
/// Number.isSafeInteger(v)
pub fn as_safe_int(v: &Value) -> Option<i64> {
    let f = as_num(v)?;
    if f.fract() != 0.0 || f.abs() > 9_007_199_254_740_991.0 {
        return None;
    }
    Some(f as i64)
}
/// Number.isSafeInteger(v) && v >= 0
pub fn as_count(v: &Value) -> Option<i64> {
    as_safe_int(v).filter(|n| *n >= 0)
}
/// JS truthiness
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(_) => as_num(v).map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        _ => true,
    }
}
/// String(v)
pub fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(_) => as_num(v).map(|f| js_num_str(f)).unwrap_or_default(),
        _ => js(v),
    }
}
/// String(v||'')
pub fn js_str(v: &Value) -> String {
    if !truthy(v) {
        if let Value::Number(_) = v {
            return "0".into();
        }
        return String::new();
    }
    js_string(v)
}
pub fn js_num_str(f: f64) -> String {
    match num(f) {
        Value::Number(n) => n.to_string(),
        _ => "null".into(),
    }
}

pub fn obj() -> Map<String, Value> {
    Map::new()
}

/// Accessors that never panic (like optional chaining in JS).
pub trait JV {
    fn g(&self, k: &str) -> &Value;
    fn s(&self, k: &str) -> &str;
    fn o(&self, k: &str) -> Option<&Map<String, Value>>;
    fn a(&self, k: &str) -> &[Value];
    fn b(&self, k: &str) -> bool;
    fn has(&self, k: &str) -> bool;
}
static NULL: Value = Value::Null;
impl JV for Value {
    fn g(&self, k: &str) -> &Value {
        self.get(k).unwrap_or(&NULL)
    }
    fn s(&self, k: &str) -> &str {
        self.get(k).and_then(|v| v.as_str()).unwrap_or("")
    }
    fn o(&self, k: &str) -> Option<&Map<String, Value>> {
        self.get(k).and_then(|v| v.as_object())
    }
    fn a(&self, k: &str) -> &[Value] {
        self.get(k).and_then(|v| v.as_array()).map(|a| a.as_slice()).unwrap_or(&[])
    }
    fn b(&self, k: &str) -> bool {
        self.get(k) == Some(&Value::Bool(true))
    }
    fn has(&self, k: &str) -> bool {
        self.as_object().map(|m| m.contains_key(k)).unwrap_or(false)
    }
}
impl JV for Map<String, Value> {
    fn g(&self, k: &str) -> &Value {
        self.get(k).unwrap_or(&NULL)
    }
    fn s(&self, k: &str) -> &str {
        self.get(k).and_then(|v| v.as_str()).unwrap_or("")
    }
    fn o(&self, k: &str) -> Option<&Map<String, Value>> {
        self.get(k).and_then(|v| v.as_object())
    }
    fn a(&self, k: &str) -> &[Value] {
        self.get(k).and_then(|v| v.as_array()).map(|a| a.as_slice()).unwrap_or(&[])
    }
    fn b(&self, k: &str) -> bool {
        self.get(k) == Some(&Value::Bool(true))
    }
    fn has(&self, k: &str) -> bool {
        self.contains_key(k)
    }
}

// ---------------- strings ----------------
/// String#slice(0,n) approximated on chars.
pub fn clip_runes(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}
/// cut on a byte length, at a char boundary
pub fn clip_bytes(s: &str, mut n: usize) -> &str {
    if s.len() <= n {
        return s;
    }
    while n > 0 && !s.is_char_boundary(n) {
        n -= 1;
    }
    &s[..n]
}
/// UTF-16 length (JS String#length)
pub fn js_len(s: &str) -> usize {
    s.chars().map(|c| c.len_utf16()).sum()
}

pub fn log(msg: impl AsRef<str>) {
    println!("{}", msg.as_ref());
}
pub fn elog(msg: impl AsRef<str>) {
    eprintln!("{}", msg.as_ref());
}

pub fn dual_root() -> String {
    std::env::var("DUAL_ROOT").unwrap_or_else(|_| "/opt/ais2api/dual-runtime".into())
}

/// return freed heap pages to the OS (glibc keeps them after large transient allocations)
pub fn trim_heap() {
    unsafe {
        libc::malloc_trim(0);
    }
}
