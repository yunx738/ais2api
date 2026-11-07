// Login files (/opt/ais2api/auth/auth-<id>.json): e-mail, tier, alias, cookie info (account-tiers.js, auth-maintenance.js).
// headless-import.js: /opt/as2a-nb/auth/<email>/storage-state.json kept in step with the login files.
// account-schedule.json (new): per-account groups and priority.
use crate::state::READ_ONLY;
use crate::util::*;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, RwLock};

pub const AUTH_DIR: &str = "/opt/ais2api/auth";
pub const TIERS: [&str; 4] = ["standard", "pro", "ultra", "ultra20"];
static RE_EMAIL: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[^\s@]+@[^\s@]+$").unwrap());
static RE_CTL: Lazy<Regex> = Lazy::new(|| Regex::new("[\u{0000}-\u{001f}\u{007f}]").unwrap());
static RE_GOOGLE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(^|\.)google\.com$").unwrap());
static RE_GROUP: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[\p{L}\p{N}_-]{1,20}$").unwrap());

type Tag = (u64, u64, i64, i64);
fn tag(m: &std::fs::Metadata) -> Tag {
    (m.ino(), m.len(), m.mtime(), m.mtime_nsec())
}
pub fn mtime_ms(m: &std::fs::Metadata) -> f64 {
    m.mtime() as f64 * 1000.0 + m.mtime_nsec() as f64 / 1e6
}

pub struct Accounts {
    dir: String,
    mode_file: String,
    cache: Mutex<HashMap<i64, (Tag, Option<Value>)>>,
    mode: Mutex<Value>,
}

impl Accounts {
    pub fn new(dir: &str, mode_file: &str) -> Self {
        let mut mode = json!({"enabled":false,"slot":"B"});
        if let Ok(m) = read_json(mode_file) {
            let slot = if ["A", "B"].contains(&m.s("slot")) { m.s("slot").to_string() } else { "B".into() };
            mode = json!({"enabled":m.b("enabled"),"slot":slot});
        }
        Accounts { dir: dir.into(), mode_file: mode_file.into(), cache: Mutex::new(HashMap::new()), mode: Mutex::new(mode) }
    }
    pub fn file(&self, id: i64) -> String {
        format!("{}/auth-{}.json", self.dir, id)
    }
    pub fn data(&self, id: i64) -> Option<Value> {
        if id < 1 {
            return None;
        }
        let st = std::fs::metadata(self.file(id)).ok()?;
        let t = tag(&st);
        if let Some((ct, d)) = self.cache.lock().unwrap().get(&id) {
            if *ct == t {
                return d.clone();
            }
        }
        let d = read_json(&self.file(id)).ok().filter(|v| v.is_object());
        self.cache.lock().unwrap().insert(id, (t, d.clone()));
        d
    }
    pub fn email(&self, id: i64) -> String {
        let Some(d) = self.data(id) else { return String::new() };
        for k in ["accountName", "displayName"] {
            if let Some(s) = d.g(k).as_str() {
                if RE_EMAIL.is_match(s.trim()) {
                    return s.trim().to_lowercase();
                }
            }
        }
        String::new()
    }
    pub fn tier(&self, id: i64) -> String {
        let t = self.data(id).map(|d| d.s("accountTier").to_string()).unwrap_or_default();
        if TIERS.contains(&t.as_str()) { t } else { "standard".into() }
    }
    pub fn is_premium(&self, id: i64) -> bool {
        self.tier(id) != "standard"
    }
    pub fn is_ultra(&self, id: i64) -> bool {
        let t = self.tier(id);
        t == "ultra" || t == "ultra20"
    }
    pub fn names(&self, id: i64) -> (String, String) {
        let d = self.data(id).unwrap_or(Value::Null);
        (d.s("displayName").into(), d.s("accountName").into())
    }
    fn update(&self, id: i64, change: impl FnOnce(&mut Map<String, Value>)) -> R<()> {
        let f = self.file(id);
        let st = std::fs::symlink_metadata(&f).map_err(|_| HttpErr::new(404, format!("账号 {} 不存在", id)))?;
        if !st.is_file() {
            return herr(409, "认证文件类型异常");
        }
        let mut d = read_json(&f).ok().and_then(|v| v.as_object().cloned()).ok_or_else(|| HttpErr::plain("auth file unreadable"))?;
        change(&mut d);
        write_atomic(&f, &js_bytes(&Value::Object(d)), st.mode() & 0o777, true).map_err(|e| HttpErr::plain(e.to_string()))?;
        let _ = std::os::unix::fs::chown(&f, Some(st.uid()), Some(st.gid()));
        self.cache.lock().unwrap().remove(&id);
        Ok(())
    }
    pub fn set_tier(&self, id: i64, tier: &str) -> R<Value> {
        if !TIERS.contains(&tier) {
            return herr(400, "分类只能是 standard、pro、ultra 或 ultra20");
        }
        let t = tier.to_string();
        self.update(id, |d| {
            if t == "standard" {
                d.shift_remove("accountTier");
            } else {
                d.insert("accountTier".into(), json!(t));
            }
        })?;
        Ok(json!({"id":id,"tier":tier}))
    }
    pub fn set_alias(&self, id: i64, name: &Value) -> R<Value> {
        if !name.is_null() && !name.is_string() {
            return herr(400, "名称格式无效");
        }
        let s = RE_CTL.replace_all(name.as_str().unwrap_or(""), "").trim().to_string();
        if js_len(&s) > 40 {
            return herr(400, "名称最多 40 个字");
        }
        let s2 = s.clone();
        self.update(id, move |d| {
            if s2.is_empty() {
                d.shift_remove("displayName");
            } else {
                d.insert("displayName".into(), json!(s2));
            }
        })?;
        Ok(json!({"id":id,"alias":s}))
    }
    pub fn status(&self, ids: &[i64]) -> Value {
        let u: Vec<i64> = ids.iter().copied().filter(|i| self.is_ultra(*i)).collect();
        let p: Vec<i64> = ids.iter().copied().filter(|i| self.tier(*i) == "pro").collect();
        let pr: Vec<i64> = ids.iter().copied().filter(|i| self.is_premium(*i)).collect();
        let mut m = self.mode.lock().unwrap().as_object().cloned().unwrap_or_default();
        m.insert("active".into(), json!(false));
        m.insert("single".into(), json!(true));
        m.insert("ultraAccounts".into(), json!(u));
        m.insert("proAccounts".into(), json!(p));
        m.insert("premiumAccounts".into(), json!(pr));
        Value::Object(m)
    }
    pub fn set_mode(&self, b: &Value) -> R<()> {
        let cur = self.mode.lock().unwrap().s("slot").to_string();
        let slot = if b.g("slot").is_null() { cur } else { b.s("slot").to_string() };
        let Some(en) = b.g("enabled").as_bool() else { return herr(400, "参数无效") };
        if !["A", "B"].contains(&slot.as_str()) {
            return herr(400, "参数无效");
        }
        let m = json!({"enabled":en,"slot":slot});
        write_simple(&self.mode_file, &js_bytes(&m), 0o600).map_err(|e| HttpErr::plain(e.to_string()))?;
        *self.mode.lock().unwrap() = m;
        Ok(())
    }
    pub fn file_info(&self, id: i64) -> Value {
        let f = self.file(id);
        let st = match std::fs::symlink_metadata(&f) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return json!({"state":"missing"}),
            Err(_) => return json!({"state":"unreadable"}),
        };
        if !st.is_file() || st.len() > 262_144 {
            return json!({"state":"unreadable"});
        }
        let Some(d) = self.data(id).filter(|d| d.g("cookies").is_array() && d.g("origins").is_array()) else { return json!({"state":"unreadable"}) };
        let mut n = 0;
        let mut exp: Vec<i64> = vec![];
        for c in d.a("cookies") {
            if !["SID", "__Secure-1PSID", "__Secure-3PSID"].contains(&c.s("name")) || !RE_GOOGLE.is_match(&js_str(c.g("domain"))) {
                continue;
            }
            n += 1;
            if let Some(e) = as_num(c.g("expires")).filter(|e| *e > 0.0) {
                exp.push((e * 1000.0).round() as i64);
            }
        }
        let modified = (st.mtime() * 1000) + st.mtime_nsec() / 1_000_000;
        let mut o = json!({"state":"ok","modifiedAt":modified,"keyCookies":n});
        let m = o.as_object_mut().unwrap();
        if n == 0 {
            m.insert("expiresAt".into(), Value::Null);
            m.insert("session".into(), json!(false));
        } else {
            m.insert("expiresAt".into(), exp.iter().min().map(|x| json!(x)).unwrap_or(Value::Null));
            m.insert("session".into(), json!(exp.len() < n));
        }
        o
    }
}

// ---------------- headless import ----------------
pub struct Importer {
    pub target: String,
    state_file: String,
    lock: Mutex<()>,
}
impl Importer {
    pub fn new(target: &str, state_file: &str) -> Self {
        Importer { target: target.into(), state_file: state_file.into(), lock: Mutex::new(()) }
    }
    fn state(&self) -> Map<String, Value> {
        let mut s = read_json(&self.state_file).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
        if !s.g("accounts").is_object() {
            s.insert("accounts".into(), json!({}));
        }
        s
    }
    fn save(&self, s: &Map<String, Value>) {
        if READ_ONLY.load(Ordering::Relaxed) {
            return;
        }
        let _ = write_atomic(&self.state_file, &js_bytes(&Value::Object(s.clone())), 0o600, true);
    }
    pub fn has(&self, acc: &Accounts, id: i64) -> bool {
        let e = acc.email(id);
        !e.is_empty() && file_exists(&format!("{}/{}/storage-state.json", self.target, e))
    }
    /// Returns (added, changed, skipped).
    pub fn sync(&self, acc: &Accounts, ids: &[i64]) -> (Vec<i64>, Vec<i64>, Map<String, Value>) {
        let _g = self.lock.lock().unwrap();
        let mut st = self.state();
        let (mut added, mut changed, mut skipped) = (vec![], vec![], Map::new());
        if READ_ONLY.load(Ordering::Relaxed) {
            return (added, changed, skipped);
        }
        let _ = std::fs::create_dir_all(&self.target);
        for &id in ids {
            let file = acc.file(id);
            let Ok(fst) = std::fs::metadata(&file) else {
                skipped.insert(id.to_string(), json!("no_auth_file"));
                continue;
            };
            let email = acc.email(id);
            if email.is_empty() {
                skipped.insert(id.to_string(), json!("no_email"));
                continue;
            }
            let dir = format!("{}/{}", self.target, email);
            let prev = st.g("accounts").g(&id.to_string()).clone();
            let fresh = !file_exists(&format!("{}/storage-state.json", dir));
            let pm = as_num(prev.g("mtime")).unwrap_or(0.0);
            if !fresh && prev.is_object() && prev.s("email") == email && pm >= mtime_ms(&fst) {
                continue;
            }
            let Some(data) = read_json(&file).ok().filter(|v| v.is_object()) else {
                skipped.insert(id.to_string(), json!("unreadable"));
                continue;
            };
            if data.a("cookies").is_empty() {
                skipped.insert(id.to_string(), json!("no_cookies"));
                continue;
            }
            let _ = std::fs::create_dir_all(&dir);
            let origins = if data.g("origins").is_array() { data.g("origins").clone() } else { json!([]) };
            let mut storage = json!({"cookies":data.g("cookies"),"origins":origins,"accountName":email});
            if truthy(data.g("accountTier")) {
                storage.as_object_mut().unwrap().insert("accountTier".into(), data.g("accountTier").clone());
            }
            let _ = write_atomic(&format!("{}/storage-state.json", dir), &js_bytes(&storage), 0o600, true);
            let cfg_file = format!("{}/account.json", dir);
            let cfg = read_json(&cfg_file).ok().filter(|v| v.is_object()).unwrap_or(json!({}));
            let proxy = if cfg.has("proxy") { cfg.g("proxy").clone() } else { json!("") };
            let next = json!({"label":email,"enabled":true,"proxy":proxy,"locale":"en-US","timezone":"Europe/Berlin"});
            if js(&next) != js(&cfg) {
                let _ = write_atomic(&cfg_file, js_indent(&next, " ").as_bytes(), 0o600, true);
            }
            st.get_mut("accounts").unwrap().as_object_mut().unwrap()
                .insert(id.to_string(), json!({"email":email,"mtime":num(mtime_ms(&fst)),"at":now_ms()}));
            if fresh {
                added.push(id);
            } else {
                changed.push(id);
            }
        }
        if !added.is_empty() || !changed.is_empty() {
            self.save(&st);
        }
        (added, changed, skipped)
    }

    /// Cookies refreshed by the service are written back to auth-<id>.json.
    pub fn write_back(&self, acc: &Accounts, ids: &[i64]) -> Value {
        let _g = self.lock.lock().unwrap();
        let mut st = self.state();
        let (mut written, mut skipped) = (vec![], Map::new());
        if READ_ONLY.load(Ordering::Relaxed) {
            return json!({"written":written,"skipped":skipped});
        }
        for &id in ids {
            let prev = st.g("accounts").g(&id.to_string()).clone();
            if !prev.is_object() {
                continue;
            }
            let file = acc.file(id);
            let src = format!("{}/{}/storage-state.json", self.target, prev.s("email"));
            let (Ok(ss), Ok(asm)) = (std::fs::metadata(&src), std::fs::metadata(&file)) else { continue };
            let pat = as_num(prev.g("at")).unwrap_or(0.0);
            let pm = as_num(prev.g("mtime")).unwrap_or(0.0);
            if mtime_ms(&ss) <= pat + 1000.0 || mtime_ms(&asm) > pm + 1.0 {
                continue;
            }
            let (Ok(state), Ok(auth)) = (read_json(&src), read_json(&file)) else {
                skipped.insert(id.to_string(), json!("unreadable"));
                continue;
            };
            if !state.is_object() || !auth.is_object() {
                skipped.insert(id.to_string(), json!("unreadable"));
                continue;
            }
            if state.a("cookies").is_empty() {
                skipped.insert(id.to_string(), json!("no_cookies"));
                continue;
            }
            let accs = st.get_mut("accounts").unwrap().as_object_mut().unwrap();
            if js(state.g("cookies")) == js(auth.g("cookies")) {
                let mut p = prev.as_object().unwrap().clone();
                p.insert("at".into(), json!(now_ms()));
                accs.insert(id.to_string(), Value::Object(p));
                continue;
            }
            let mut next = auth.as_object().unwrap().clone();
            next.insert("cookies".into(), state.g("cookies").clone());
            if !state.a("origins").is_empty() {
                next.insert("origins".into(), state.g("origins").clone());
            }
            let _ = write_atomic(&file, &js_bytes(&Value::Object(next)), 0o600, true);
            let _ = std::os::unix::fs::chown(&file, Some(asm.uid()), Some(asm.gid()));
            let nm = std::fs::metadata(&file).map(|m| mtime_ms(&m)).unwrap_or(0.0);
            let mut p = prev.as_object().unwrap().clone();
            p.insert("mtime".into(), num(nm));
            p.insert("at".into(), json!(now_ms()));
            accs.insert(id.to_string(), Value::Object(p));
            written.push(id);
        }
        self.save(&st);
        json!({"written":written,"skipped":skipped})
    }
}

// ---------------- account-schedule.json ----------------
#[derive(Clone, Default)]
pub struct SchedEntry {
    pub groups: Vec<String>,
    pub priority: i64,
}
pub struct AccountSched {
    file: String,
    m: RwLock<HashMap<i64, SchedEntry>>,
}
impl AccountSched {
    pub fn open(file: &str) -> Self {
        let mut m = HashMap::new();
        if let Ok(v) = read_json(file) {
            if let Some(acc) = v.o("accounts") {
                for (k, e) in acc {
                    let Ok(id) = k.parse::<i64>() else { continue };
                    if id < 1 || !e.is_object() {
                        continue;
                    }
                    let groups = e.a("groups").iter().filter_map(|g| g.as_str()).filter(|g| RE_GROUP.is_match(g)).map(String::from).collect();
                    let priority = as_safe_int(e.g("priority")).filter(|p| (-100..=100).contains(p)).unwrap_or(0);
                    m.insert(id, SchedEntry { groups, priority });
                }
            }
        }
        AccountSched { file: file.into(), m: RwLock::new(m) }
    }
    pub fn get(&self, id: i64) -> SchedEntry {
        self.m.read().unwrap().get(&id).cloned().unwrap_or_default()
    }
    pub fn priority(&self, id: i64) -> i64 {
        self.m.read().unwrap().get(&id).map(|e| e.priority).unwrap_or(0)
    }
    pub fn in_group(&self, id: i64, g: &str) -> bool {
        self.m.read().unwrap().get(&id).map(|e| e.groups.iter().any(|x| x == g)).unwrap_or(false)
    }
    pub fn all_groups(&self) -> Vec<String> {
        let mut v: Vec<String> = self.m.read().unwrap().values().flat_map(|e| e.groups.clone()).collect();
        v.sort();
        v.dedup();
        v
    }
    pub fn members(&self, g: &str, ids: &[i64]) -> Vec<i64> {
        ids.iter().copied().filter(|i| self.in_group(*i, g)).collect()
    }
    fn json_of(id: i64, e: &SchedEntry) -> Value {
        json!({"id":id,"groups":e.groups,"priority":e.priority})
    }
    pub fn json(&self, id: i64) -> Value {
        Self::json_of(id, &self.get(id))
    }
    pub fn set(&self, id: i64, b: &Value) -> R<Value> {
        let mut m = self.m.write().unwrap();
        let mut e = m.get(&id).cloned().unwrap_or_default();
        if b.has("groups") {
            let list: Vec<String> = match b.g("groups") {
                Value::String(s) => s.split(|c: char| c == ',' || c == '，' || c == '、' || c.is_whitespace()).map(String::from).collect(),
                Value::Array(a) => {
                    let mut l = vec![];
                    for x in a {
                        let Some(s) = x.as_str() else { return herr(400, "分组名称无效") };
                        l.push(s.trim().to_string());
                    }
                    l
                }
                Value::Null => vec![],
                _ => return herr(400, "分组格式无效"),
            };
            let mut clean: Vec<String> = vec![];
            for g in list {
                if g.is_empty() || clean.contains(&g) {
                    continue;
                }
                if !RE_GROUP.is_match(&g) {
                    return herr(400, format!("分组名只能用文字、数字、_ 和 -，最长 20 个字：{}", clip_runes(&g, 30)));
                }
                clean.push(g);
            }
            if clean.len() > 10 {
                return herr(400, "每个账号最多 10 个分组");
            }
            e.groups = clean;
        }
        if b.has("priority") {
            let Some(p) = as_safe_int(b.g("priority")).filter(|p| (-100..=100).contains(p)) else { return herr(400, "优先级只能是 -100 到 100 的整数") };
            e.priority = p;
        }
        let old = m.insert(id, e.clone());
        let mut ids: Vec<i64> = m.keys().copied().collect();
        ids.sort();
        let mut acc = Map::new();
        for i in ids {
            let x = &m[&i];
            if x.groups.is_empty() && x.priority == 0 {
                continue;
            }
            acc.insert(i.to_string(), json!({"groups":x.groups,"priority":x.priority}));
        }
        let data = js_indent(&json!({"version":1,"accounts":acc}), " ");
        if !READ_ONLY.load(Ordering::Relaxed) {
            if let Err(err) = write_atomic(&self.file, data.as_bytes(), 0o600, true) {
                match old {
                    Some(o) => m.insert(id, o),
                    None => m.remove(&id),
                };
                return Err(HttpErr::plain(err.to_string()));
            }
        }
        Ok(Self::json_of(id, &e))
    }
}