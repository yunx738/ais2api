// model-access.json {"ultraOnly":[model...]} (model-access.js): premium models listed here run on Ultra
// accounts only until the console opens them to Pro. Re-read when the file changes.
use crate::util::*;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::os::unix::fs::MetadataExt;
use std::sync::Mutex;

static CACHE: Lazy<Mutex<(String, Vec<String>)>> = Lazy::new(|| Mutex::new((String::new(), vec![])));
fn file() -> String {
    format!("{}/model-access.json", dual_root())
}
pub fn list() -> Vec<String> {
    let f = file();
    let Ok(m) = std::fs::metadata(&f) else { return vec![] };
    let tag = format!("{}:{}:{}:{}", f, m.ino(), m.mtime() * 1_000_000_000 + m.mtime_nsec(), m.len());
    let mut c = CACHE.lock().unwrap();
    if c.0 != tag {
        if let Ok(v) = read_json(&f) {
            let l: Vec<String> = v.get("ultraOnly").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            *c = (tag, l);
        }
    }
    c.1.clone()
}
pub fn ultra_only(model: &str) -> bool {
    list().iter().any(|m| m == model)
}
pub fn snapshot() -> R<Value> {
    Ok(json!({"ultraOnly": list()}))
}
/// pro=true opens the model to Pro accounts, pro=false makes it Ultra-only
pub fn set(model: &str, pro: Option<bool>) -> R<Value> {
    let Some(pro) = pro else { return herr(400, "pro 必须是 true/false") };
    if model.is_empty() || model.len() > 200 || !model.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return herr(400, "模型无效");
    }
    let mut l = list();
    l.retain(|m| m != model);
    if !pro {
        l.push(model.to_string());
    }
    l.sort();
    write_simple(&file(), js_indent(&json!({"ultraOnly": l}), " ").as_bytes(), 0o644).map_err(|e| HttpErr::plain(e.to_string()))?;
    snapshot()
}

#[cfg(test)]
mod tests {
    #[test]
    fn access_switch() {
        let d = std::env::temp_dir().join(format!("ma-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::env::set_var("DUAL_ROOT", &d);
        assert!(!super::ultra_only("gemini-4-carbon"));
        super::set("gemini-4-carbon", Some(false)).unwrap();
        assert!(super::ultra_only("gemini-4-carbon"));
        assert!(!super::ultra_only("gemini-4-argon"));
        super::set("gemini-4-carbon", Some(true)).unwrap();
        assert!(!super::ultra_only("gemini-4-carbon"));
        assert!(super::set("bad model", Some(true)).is_err());
        assert!(super::set("gemini-4-carbon", None).is_err());
    }
}
