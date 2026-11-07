// Login service data: encrypted password store (login-credentials.js), workspace + login-proxy config
// (workspace.js), auto-registered accounts (nightly-relogin.js registered()).
// File formats unchanged: the Node login service can run on the same files.
use crate::state::READ_ONLY;
use crate::util::*;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Mutex;

fn ro() -> bool {
    READ_ONLY.load(Ordering::Relaxed)
}
fn b64() -> &'static base64::engine::GeneralPurpose {
    &base64::engine::general_purpose::STANDARD
}
/// tmp + fsync + rename, mode 0600, optional chown
pub fn write_secure(file: &str, data: &[u8], uid: Option<u32>) -> std::io::Result<()> {
    if ro() {
        return Ok(());
    }
    write_atomic(file, data, 0o600, true)?;
    if let Some(u) = uid {
        let _ = std::os::unix::fs::chown(file, Some(u), Some(u));
    }
    Ok(())
}
pub fn read_obj(file: &str) -> Map<String, Value> {
    read_json(file).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

// ---------------- encrypted credentials (AES-256-GCM) ----------------
const CRED_KEY: &str = "/opt/ais2api-direct/cred.key";
const CRED_DATA: &str = "/opt/ais2api-direct/credentials.json";
static CRED_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

fn cred_key() -> Result<[u8; 32], String> {
    if !file_exists(CRED_KEY) {
        if ro() {
            return Err("no credential key".into());
        }
        let mut k = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut k);
        write_atomic(CRED_KEY, &k, 0o600, true).map_err(|e| e.to_string())?;
    }
    let k = std::fs::read(CRED_KEY).map_err(|e| e.to_string())?;
    k.try_into().map_err(|_| "bad key".to_string())
}
fn cred_save(d: &Map<String, Value>) {
    let _ = write_secure(CRED_DATA, &js_bytes(&Value::Object(d.clone())), None);
}
/// store a password for account `id` (keeps the last attempt fields)
pub fn cred_put(id: i64, email: &str, password: &str) -> Result<(), String> {
    let _g = CRED_LOCK.lock().unwrap();
    let key = cred_key()?;
    let mut iv = [0u8; 12];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut iv);
    let c = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let mut out = c.encrypt(Nonce::from_slice(&iv), password.as_bytes()).map_err(|_| "encrypt failed".to_string())?;
    let tag = out.split_off(out.len() - 16);
    let mut d = read_obj(CRED_DATA);
    let k = id.to_string();
    let mut rec = json!({"email":email,"iv":b64().encode(iv),"tag":b64().encode(tag),"data":b64().encode(&out),"savedAt":now_ms()});
    if let Some(old) = d.get(&k) {
        rec["lastAttemptAt"] = old.g("lastAttemptAt").clone();
        rec["lastResult"] = old.g("lastResult").clone();
    }
    d.insert(k, rec);
    cred_save(&d);
    Ok(())
}
/// (email, password)
pub fn cred_get(id: i64) -> Result<Option<(String, String)>, String> {
    let d = read_obj(CRED_DATA);
    let Some(r) = d.get(&id.to_string()) else { return Ok(None) };
    let key = cred_key()?;
    let iv = b64().decode(r.s("iv")).map_err(|e| e.to_string())?;
    let mut data = b64().decode(r.s("data")).map_err(|e| e.to_string())?;
    data.extend(b64().decode(r.s("tag")).map_err(|e| e.to_string())?);
    if iv.len() != 12 {
        return Err("bad iv".into());
    }
    let c = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let pw = c.decrypt(Nonce::from_slice(&iv), data.as_ref()).map_err(|_| "decrypt failed".to_string())?;
    Ok(Some((r.s("email").to_string(), String::from_utf8(pw).map_err(|_| "decrypt failed".to_string())?)))
}
/// id -> {email,lastAttemptAt,lastResult}
pub fn cred_meta() -> HashMap<i64, (String, i64, String)> {
    read_obj(CRED_DATA).iter().filter_map(|(k, r)| {
        let id = k.parse().ok()?;
        Some((id, (r.s("email").to_string(), as_num(r.g("lastAttemptAt")).unwrap_or(0.0) as i64, r.s("lastResult").to_string())))
    }).collect()
}
pub fn cred_mark(id: i64, result: &str) {
    let _g = CRED_LOCK.lock().unwrap();
    let mut d = read_obj(CRED_DATA);
    let Some(Value::Object(r)) = d.get_mut(&id.to_string()) else { return };
    r.insert("lastAttemptAt".into(), json!(now_ms()));
    r.insert("lastResult".into(), json!(result));
    cred_save(&d);
}
pub fn cred_remove(id: i64) {
    let _g = CRED_LOCK.lock().unwrap();
    let mut d = read_obj(CRED_DATA);
    if d.shift_remove(&id.to_string()).is_some() {
        cred_save(&d);
    }
}
