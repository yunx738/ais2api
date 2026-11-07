// model-policies.json (version 2, revision): quota family + anti-truncation flag per model.
use crate::util::*;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::RwLock;

#[derive(Clone, Debug)]
pub struct Policy {
    pub family: String,
    pub anti_truncation: bool,
}

static RE_ID: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$").unwrap());

fn validate(o: &Map<String, Value>) -> Result<Vec<(String, Policy)>, String> {
    if o.len() > 10000 {
        return Err("Too many policies".into());
    }
    let mut out = vec![];
    for (id, p) in o {
        let p = p.as_object().ok_or("Invalid model policy")?;
        if !RE_ID.is_match(id) || p.keys().any(|k| k != "quotaFamily" && k != "antiTruncation") {
            return Err("Invalid model policy".into());
        }
        let f = p.s("quotaFamily");
        let at = p.g("antiTruncation").as_bool().ok_or("Invalid model policy")?;
        if !["flash", "pro", "ultra"].contains(&f) {
            return Err("Invalid model policy".into());
        }
        out.push((id.clone(), Policy { family: f.into(), anti_truncation: at }));
    }
    Ok(out)
}

struct Inner {
    revision: i64,
    blocked: bool,
    list: Vec<(String, Policy)>,
}

pub struct PolicyStore {
    file: String,
    inner: RwLock<Inner>,
}

impl PolicyStore {
    pub fn open(file: &str, initial: Option<&Map<String, Value>>) -> Result<Self, String> {
        let mut list = match initial {
            Some(o) => validate(o)?,
            None => vec![],
        };
        let mut revision = 0;
        match std::fs::symlink_metadata(file) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
            Ok(st) => {
                if !st.is_file() || st.len() > 4_194_304 {
                    return Err("Invalid policy file".into());
                }
                let d = read_json(file).map_err(|e| e.to_string())?;
                let r = as_safe_int(d.g("revision"));
                if as_safe_int(d.g("version")) != Some(2) || r.map(|r| r < 1).unwrap_or(true) {
                    return Err("Invalid policy revision".into());
                }
                list = validate(d.o("policies").ok_or("Invalid policies")?)?;
                revision = r.unwrap();
            }
        }
        Ok(PolicyStore { file: file.into(), inner: RwLock::new(Inner { revision, blocked: false, list }) })
    }
    pub fn get(&self, m: &str) -> Option<Policy> {
        self.inner.read().unwrap().list.iter().find(|(k, _)| k == m).map(|(_, p)| p.clone())
    }
    pub fn ordered(&self) -> Vec<(String, Policy)> {
        self.inner.read().unwrap().list.clone()
    }
    pub fn sorted_ids(&self) -> Vec<String> {
        let mut v: Vec<String> = self.inner.read().unwrap().list.iter().map(|(k, _)| k.clone()).collect();
        v.sort();
        v
    }
    pub fn size(&self) -> usize {
        self.inner.read().unwrap().list.len()
    }
    fn policies_json(list: &[(String, Policy)]) -> Value {
        let mut o = Map::new();
        for (id, p) in list {
            o.insert(id.clone(), json!({"quotaFamily":p.family,"antiTruncation":p.anti_truncation}));
        }
        Value::Object(o)
    }
    pub fn snapshot(&self) -> Value {
        let i = self.inner.read().unwrap();
        json!({"revision":i.revision,"policies":Self::policies_json(&i.list),"blocked":i.blocked})
    }
    pub fn set(&self, model: &str, family: &str, at: bool, revision: i64) -> R<Value> {
        {
            let mut i = self.inner.write().unwrap();
            if i.blocked {
                return Err(HttpErr::plain("Policy storage requires reconciliation"));
            }
            if revision != i.revision {
                return herr(409, "Policy revision changed; refresh first");
            }
            if !RE_ID.is_match(model) || !["flash", "pro", "ultra"].contains(&family) {
                return Err(HttpErr::plain("Invalid model policy"));
            }
            let mut next = i.list.clone();
            let p = Policy { family: family.into(), anti_truncation: at };
            match next.iter_mut().find(|(k, _)| k == model) {
                Some(e) => e.1 = p,
                None => next.push((model.into(), p)),
            }
            let data = json!({"version":2,"revision":i.revision+1,"policies":Self::policies_json(&next)});
            if write_atomic(&self.file, &js_bytes(&data), 0o600, true).is_err() {
                return Err(HttpErr::plain("Policy save not confirmed; refresh before retry"));
            }
            i.list = next;
            i.revision += 1;
        }
        Ok(self.snapshot())
    }
}