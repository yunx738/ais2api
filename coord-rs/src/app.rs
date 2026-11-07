// Coordinator (no-browser mode), Rust version. Same public API and state files as the Node/Go versions.
use crate::accounts::{mtime_ms, AccountSched, Accounts, Importer, AUTH_DIR};
use crate::at::AtPromptStore;
use crate::build_chan::{Build, Rotation};
use crate::console::{run, run_mode_status, ConsoleAuth, StreamMode};
use crate::history::{History, RecordHealth};
use crate::policy::PolicyStore;
use crate::prices::PriceStore;
use crate::sched::{Counts, Dispatch, Item, Routing, Ticket, SLOT};
use crate::state::{Core, READ_ONLY};
use crate::backend::Backend;
use crate::util::*;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::Duration;

pub struct St {
    pub core: Core,
    pub disp: Dispatch,
    pub queue: Vec<Item>,
    pub executing: HashMap<String, Ticket>,
    pub counts: Counts,
    pub closed: bool,
    pub pumping: bool,
    pub stopping: bool,
}

pub struct App {
    pub root: String,
    pub cfg: Map<String, Value>,
    pub keys: Vec<String>,
    st: Mutex<St>,
    pub epoch_id: String,
    pub acc: Arc<Accounts>,
    pub importer: Importer,
    pub sched: AccountSched,
    pub svc: &'static dyn Backend,
    pub routing: Routing,
    pub policies: PolicyStore,
    pub prices: PriceStore,
    pub hist: Arc<History>,
    pub health: RecordHealth,
    pub at_prompt: AtPromptStore,
    pub build: Build,
    pub rotation: Rotation,
    pub auth: ConsoleAuth,
    pub stream: StreamMode,
    per_acc: AtomicI64,
    pub cc_file: String,
    pub dis_file: String,
    pub renewing: Mutex<HashSet<i64>>,
    reload_pending: AtomicBool,
    me: OnceLock<Weak<App>>,
}

impl App {
    pub fn lock(&self) -> MutexGuard<'_, St> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn per_account(&self) -> i64 {
        self.per_acc.load(Ordering::Relaxed)
    }
    pub fn set_per_account(&self, n: i64) {
        self.per_acc.store(n, Ordering::Relaxed)
    }
    pub fn epoch(&self) -> String {
        self.epoch_id.clone()
    }
    pub fn me(&self) -> Option<Arc<App>> {
        self.me.get().and_then(|w| w.upgrade())
    }
    pub fn live_ids(&self, st: &St) -> Vec<i64> {
        st.core.ids.iter().copied().filter(|&id| !st.core.deleted(id)).collect()
    }

    pub fn start() -> Result<Arc<App>, String> {
        let root = dual_root();
        let cfg = read_json(&format!("{}/coordinator.json", root)).map_err(|e| e.to_string())?.as_object().cloned().ok_or("coordinator.json invalid")?;
        let keys: Vec<String> = cfg.a("apiKeys").iter().filter_map(|k| k.as_str()).filter(|s| !s.is_empty()).map(String::from).collect();
        if keys.is_empty() {
            return Err("API keys required".into());
        }
        let (mut core, missing) = Core::load(&format!("{}/state.json", root))?;
        let acc = Arc::new(Accounts::new(AUTH_DIR, &format!("{}/ultra-mode.json", root)));
        let a2 = acc.clone();
        core.tier_of = Box::new(move |id| a2.tier(id));
        if !missing.is_empty() {
            core.checkpoint();
        }
        let svc = crate::backend::select()?;
        let cc_file = format!("{}/headless-concurrency.json", root);
        let mut per = std::env::var("HEADLESS_PER_ACCOUNT").ok().and_then(|v| v.parse::<i64>().ok()).filter(|n| *n > 0).unwrap_or(2);
        if let Some(n) = read_json(&cc_file).ok().and_then(|v| as_safe_int(v.g("perAccount"))).filter(|n| (1..=10).contains(n)) {
            per = n;
        }
        let mut disp = Dispatch::new();
        let dis_file = format!("{}/headless-disabled.json", root);
        if let Ok(Value::Array(a)) = read_json(&dis_file) {
            for x in a {
                if let Some(n) = as_safe_int(&x) {
                    disp.disabled.insert(n);
                }
            }
        }
        let epoch_id = disp.epoch.clone();
        let defaults = std::env::var("AT_DEFAULTS").unwrap_or_else(|_| format!("{}/refactor/at-prompt-defaults.json", root));
        let app = Arc::new(App {
            cfg: cfg.clone(),
            st: Mutex::new(St { core, disp, queue: vec![], executing: HashMap::new(), counts: Counts::default(), closed: false, pumping: false, stopping: false }),
            epoch_id,
            importer: Importer::new("/opt/as2a-nb/auth", "/opt/as2a-nb/import-state.json"),
            sched: AccountSched::open(&format!("{}/account-schedule.json", root)),
            svc,
            routing: Routing::new(),
            policies: PolicyStore::open(&format!("{}/model-policies.json", root), cfg.o("modelPolicies"))?,
            prices: PriceStore::open(&format!("{}/model-prices.json", root))?,
            hist: History::open(&format!("{}/request-history", root)),
            health: RecordHealth::new(&format!("{}/usage-missing.jsonl", root)),
            at_prompt: AtPromptStore::open(&format!("{}/at-prompt.json", root), &defaults)?,
            build: Build::new(&root),
            rotation: Rotation::new(&format!("{}/build-applet-rotation.json", root)),
            auth: ConsoleAuth::open(&format!("{}/console-auth.json", root), &keys[0])?,
            stream: StreamMode::open(&format!("{}/stream-mode.json", root)),
            per_acc: AtomicI64::new(per),
            cc_file,
            dis_file,
            renewing: Mutex::new(HashSet::new()),
            reload_pending: AtomicBool::new(false),
            me: OnceLock::new(),
            acc,
            keys,
            root,
        });
        let _ = app.me.set(Arc::downgrade(&app));
        if !ro() {
            app.sync_import();
        }
        Ok(app)
    }

    /// background jobs (same periods as the Go version)
    pub fn start_jobs(self: &Arc<Self>) {
        let a = self.clone();
        tokio::spawn(async move {
            loop {
                a.routing.refresh(&a).await;
                tokio::time::sleep(Duration::from_secs(600)).await;
            }
        });
        let a = self.clone();
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(Duration::from_secs(1));
            let mut n = 0u64;
            loop {
                iv.tick().await;
                a.tick();
                n += 1;
                if n % 30 == 0 {
                    trim_heap();
                }
            }
        });
        if ro() {
            return;
        }
        let a = self.clone();
        tokio::spawn(async move { a.stop_browser_workers().await });
        let a = self.clone();
        every(Duration::from_secs(300), true, move || {
            let h = a.hist.clone();
            async move {
                h.expire_stale(900_000);
            }
        });
        let a = self.clone();
        every(Duration::from_secs(600), false, move || {
            let a = a.clone();
            async move {
                let r = a.rotation.tick(&a, false, 0).await;
                if r.get("skipped").is_none() {
                    log(format!("[BuildRotation] {}", js(&r)));
                }
            }
        });
        let a = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(15)).await;
            loop {
                a.provision();
                tokio::time::sleep(Duration::from_secs(300)).await;
            }
        });
        let a = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            loop {
                a.write_back();
                tokio::time::sleep(Duration::from_secs(600)).await;
            }
        });
        let a = self.clone();
        every(Duration::from_secs(60), false, move || {
            let a = a.clone();
            async move {
                if let Ok(r) = a.sync_accounts() {
                    if !r.a("added").is_empty() || !r.a("removed").is_empty() {
                        log(format!("[Accounts] synced {}", js(&json!({"added":r.g("added"),"removed":r.g("removed")}))));
                    }
                }
            }
        });
        let a = self.clone();
        every(Duration::from_secs(30), false, move || {
            let a = a.clone();
            async move {
                let mut st = a.lock();
                if !st.stopping && st.core.try_resume() {
                    elog("[Coordinator] state checkpoint succeeded again; dispatch resumed");
                }
            }
        });
    }

    async fn stop_browser_workers(&self) {
        let Ok(out) = run(Duration::from_secs(15), "docker", &["ps", "-q", "--filter", "label=operit.project=ais2api-dual", "--filter", "name=^ais2api-dual-[ab]$"]).await else { return };
        let ids: Vec<&str> = out.split_whitespace().collect();
        if ids.is_empty() {
            return;
        }
        let mut args = vec!["stop", "-t", "20"];
        args.extend(ids.iter());
        match run(Duration::from_secs(90), "docker", &args).await {
            Err(e) => log(format!("[Coordinator] browser workers stop failed: {}", e)),
            Ok(_) => log(format!("[Coordinator] browser workers stopped ({})", ids.len())),
        }
    }

    pub fn sync_import(&self) -> Value {
        let ids = {
            let st = self.lock();
            self.live_ids(&st)
        };
        let (added, changed, skipped) = self.importer.sync(&self.acc, &ids);
        let res = json!({"changed":changed,"added":added,"skipped":skipped});
        if !added.is_empty() || !changed.is_empty() {
            log(format!("[Headless] imported {}", js(&res)));
        }
        res
    }
    fn provision(self: &Arc<Self>) {
        if self.cfg.get("buildAutoProvision") == Some(&Value::Bool(false)) {
            return;
        }
        let todo: Vec<i64> = {
            let st = self.lock();
            self.live_ids(&st).into_iter().filter(|&id| st.core.flag(id).is_none()).collect()
        };
        for id in todo {
            if !self.importer.has(&self.acc, id) || !self.build.app_for(id).is_empty() || (self.build.premium_only() && !self.acc.is_premium(id)) {
                continue;
            }
            let a = self.clone();
            tokio::spawn(async move {
                let r = a.rotation.ensure(&a, id, &a.acc.email(id)).await;
                if !["present", "busy", "backoff"].contains(&r.as_str()) {
                    log(format!("[BuildProvision] #{} {}", id, r));
                }
            });
        }
    }
    pub fn write_back(&self) -> Value {
        let ids = {
            let st = self.lock();
            self.live_ids(&st)
        };
        let r = self.importer.write_back(&self.acc, &ids);
        if !r.a("written").is_empty() {
            log(format!("[Headless] cookies written back {}", js(r.g("written"))));
        }
        r
    }
    /// the service reads account directories at start-up: restart it once nothing runs on it
    pub fn reload_soon(self: &Arc<Self>) {
        if ro() || self.reload_pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let a = self.clone();
        tokio::spawn(async move {
            let mut n = 0;
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let busy = {
                    let st = a.lock();
                    st.disp.active > 0 || st.core.ids.iter().any(|&id| a.build.busy(id) > 0)
                };
                if busy && n < 120 {
                    n += 1;
                    continue;
                }
                break;
            }
            a.reload_pending.store(false, Ordering::SeqCst);
            match a.svc.reload().await {
                Err(e) => elog(format!("[Headless] reload failed {}", e)),
                Ok(_) => log("[Headless] service reloaded for account changes"),
            }
        });
    }
    pub fn sync_accounts(self: &Arc<Self>) -> R<Value> {
        let (added, removed, pool) = {
            let mut st = self.lock();
            if st.stopping {
                return Ok(json!({"added":[],"reason":"coordinator_stopping"}));
            }
            let ents = std::fs::read_dir(AUTH_DIR).map_err(|e| HttpErr::plain(e.to_string()))?;
            let mut fl: Vec<i64> = ents.filter_map(|e| e.ok()).filter_map(|e| {
                let n = e.file_name().to_string_lossy().into_owned();
                let id = n.strip_prefix("auth-")?.strip_suffix(".json")?;
                (!id.starts_with('0') && !id.is_empty() && id.bytes().all(|c| c.is_ascii_digit())).then(|| id.parse().ok()).flatten()
            }).collect();
            fl.sort();
            let files: HashSet<i64> = fl.iter().copied().collect();
            let (mut added, mut removed) = (vec![], vec![]);
            for &id in &fl {
                if st.core.deleted(id) && st.disp.busy(id) == 0 {
                    let f = st.core.flag(id).cloned().unwrap_or_default();
                    let mut mark = as_num(f.g("deletedAt")).unwrap_or(0.0) as i64;
                    if mark == 0 {
                        mark = as_num(f.g("at")).unwrap_or(0.0) as i64;
                    }
                    if let Ok(m) = std::fs::metadata(self.acc.file(id)) {
                        if mtime_ms(&m) > mark as f64 {
                            st.core.set_flag(id, None);
                            st.core.clear_cooldown(id);
                            st.core.auth_saves.shift_remove(&id.to_string());
                            added.push(id);
                        }
                    }
                }
                if st.core.in_pool(id) {
                    continue;
                }
                st.core.add_account(id);
                added.push(id);
            }
            for id in st.core.ids.clone() {
                if files.contains(&id) || st.core.deleted(id) || st.disp.busy(id) > 0 {
                    continue;
                }
                st.core.set_flag(id, Some(json!({"status":"deleted","reason":"login_required","at":now_ms(),"deletedAt":now_ms()})));
                removed.push(id);
            }
            if !added.is_empty() || !removed.is_empty() {
                st.core.checkpoint();
            }
            (added, removed, st.core.ids.clone())
        };
        self.prune_build();
        let imp = self.sync_import();
        if !removed.is_empty() || !imp.a("added").is_empty() || !imp.a("changed").is_empty() {
            self.reload_soon();
        }
        Ok(json!({"added":added,"removed":removed,"pool":pool,"imported":imp}))
    }

    /// Build projects of accounts that are deleted or gone from the pool are dropped from the channel
    pub fn prune_build(&self) {
        let gone: Vec<i64> = {
            let st = self.lock();
            self.build.apps().into_iter().map(|(id, _)| id).filter(|&id| !st.core.in_pool(id) || st.core.deleted(id)).collect()
        };
        for id in gone {
            if ro() {
                continue;
            }
            self.build.forget(id);
            self.rotation.forget(id);
            log(format!("[Build] #{} removed from the Build channel (account deleted)", id));
        }
    }

    // ---------------- status ----------------
    fn cookie_status(&self, st: &St, id: i64) -> Value {
        let info = self.acc.file_info(id);
        let login = if ["invalid", "deleting", "deleted"].contains(&st.core.flag_status(id)) && st.core.flag(id).is_some() {
            "invalid"
        } else if self.importer.has(&self.acc, id) {
            "online"
        } else {
            "unverified"
        };
        let (exp, expired) = match as_num(info.g("expiresAt")) {
            Some(e) => (json!(e as i64), (e as i64) <= now_ms()),
            None => (Value::Null, false),
        };
        let mods = if truthy(info.g("modifiedAt")) { info.g("modifiedAt").clone() } else { Value::Null };
        let save = st.core.auth_saves.get(&id.to_string()).cloned().unwrap_or(Value::Null);
        json!({"login":login,"file":info.g("state"),"keyCookies":num(as_num(info.g("keyCookies")).unwrap_or(0.0)),"expiresAt":exp,
            "session":info.g("session") == &Value::Bool(true),"expired":expired,"modifiedAt":mods,"save":save})
    }
    pub fn status(&self) -> Value {
        let st = self.lock();
        let c = &st.core;
        let execs: Vec<Value> = st.disp.executions.values().map(|t| json!({"id":t.id,"phase":t.phase,"createdAt":t.created_at,"account":t.account})).collect();
        let per = self.per_account();
        let mut accs = vec![];
        for id in self.live_ids(&st) {
            let (alias, name) = self.acc.names(id);
            let disp = if !alias.is_empty() { alias.clone() } else if !name.is_empty() { name.clone() } else { "N/A (未命名)".to_string() };
            let busy = st.disp.busy(id);
            let mut o = Map::new();
            o.insert("cookie".into(), self.cookie_status(&st, id));
            o.insert("authStatus".into(), json!(c.flag(id).map(|f| f.s("status").to_string()).unwrap_or_else(|| "unknown".into())));
            if let Some(f) = c.flag(id) {
                o.insert("invalidReason".into(), f.g("reason").clone());
                o.insert("invalidAt".into(), f.g("at").clone());
            }
            let se = self.sched.get(id);
            for (k, v) in [("canDelete", json!(busy == 0)), ("id", json!(id)), ("name", json!(disp)), ("alias", json!(alias)), ("accountName", json!(name)),
                ("tier", json!(self.acc.tier(id))), ("owner", if busy > 0 { json!(SLOT) } else { Value::Null }), ("busy", json!(busy)),
                ("headless", json!(self.importer.has(&self.acc, id))), ("disabled", json!(st.disp.disabled.contains(&id))), ("groups", json!(se.groups)),
                ("priority", json!(se.priority)), ("cooldownUntil", json!(c.cooldown_of(id))), ("quota", c.summary(id, &self.policies))] {
                o.insert(k.into(), v);
            }
            accs.push(Value::Object(o));
        }
        let cand: Vec<Value> = self.candidates(&st).into_iter().map(|id| json!({"id":id,"busy":st.disp.busy(id),"limit":per})).collect();
        json!({"halted":c.halted,"paused":st.disp.paused,"queue":st.queue.len(),"scheduling":self.sched_status(&st),"runMode":run_mode_status(),
            "headless":{"epoch":st.disp.epoch,"active":st.disp.active,"accounts":cand,"models":self.routing.size(),"modelsAt":self.routing.at()},
            "streamingMode":self.stream.get(),"implementation":"rust","ultra":self.acc.status(&c.ids),"analytics":self.health.json(&self.hist),
            "gatewayRepair":crate::http::sanitize_stats(),"quotaMode":"per-account-per-model","quotaLimits":crate::state::tier_limits_json(),
            "slots":{SLOT:{"account":null,"active":st.disp.active,"ready":true,"headless":true,"pendingRetirements":0,"pendingExecutions":execs}},
            "accounts":accs,"groups":self.sched.all_groups()})
    }
    pub fn ops_status(&self) -> Value {
        let st = self.lock();
        let mut ts: Vec<&Ticket> = st.disp.executions.values().collect();
        ts.sort_by_key(|t| t.created_at);
        let running: Vec<Value> = ts.iter().map(|t| json!({"id":t.id,"account":t.account,"model":t.model,"kind":t.kind,"phase":t.phase,"createdAt":t.created_at,
            "cancellable":st.disp.live.contains_key(&t.id)})).collect();
        let per = self.per_account();
        let accs: Vec<Value> = self.live_ids(&st).into_iter().map(|id| {
            let se = self.sched.get(id);
            let e = self.acc.email(id);
            json!({"id":id,"email":if e.is_empty() { Value::Null } else { json!(e) },"imported":self.importer.has(&self.acc, id),"busy":st.disp.busy(id),
                "limit":per,"disabled":st.disp.disabled.contains(&id),"cooldownUntil":st.core.cooldown_of(id),
                "flag":st.core.flag(id).map(|f| json!(f.s("status"))).unwrap_or(Value::Null),"tier":self.acc.tier(id),"groups":se.groups,"priority":se.priority,
                "modelCooldowns":st.core.model_cooldowns(id)})
        }).collect();
        json!({"mode":"headless","perAccount":per,"active":st.disp.active,"queue":st.queue.len(),"halted":st.core.halted,"paused":st.disp.paused,
            "streamingMode":self.stream.get(),"running":running,"accounts":accs,"groups":self.sched.all_groups()})
    }

    /// graceful stop: no new admissions, wait for running executions, final checkpoint
    pub async fn shutdown(&self) {
        self.lock().stopping = true;
        self.close_scheduler();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(620);
        while tokio::time::Instant::now() < deadline {
            if self.lock().disp.active == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        self.lock().core.checkpoint();
    }
}

pub fn ro() -> bool {
    READ_ONLY.load(Ordering::Relaxed)
}
fn every<F, Fut>(d: Duration, now: bool, f: F)
where
    F: Fn() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    tokio::spawn(async move {
        if now {
            f().await;
        }
        let mut iv = tokio::time::interval_at(tokio::time::Instant::now() + d, d);
        loop {
            iv.tick().await;
            f().await;
        }
    });
}