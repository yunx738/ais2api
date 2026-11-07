// Coordinator, Rust version. Flags: -addr (default 127.0.0.1:8890), -readonly (never write shared state).
mod accounts;
mod app;
mod backend;
mod at;
mod build_chan;
mod build_ctx;
mod build_presets;
mod build_resp;
mod build_tools;
mod console;
mod forward;
mod history;
mod http;
mod login_acc;
mod login_jobs;
mod login_nightly;
mod login_http;
mod login_srv;
mod login_store;
mod login_ws;
mod metrics;
mod policy;
mod prices;
mod resp;
mod sanitize;
mod sched;
mod state;
mod svc;
mod util;

use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use std::sync::atomic::Ordering;
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("--selftest-login") {
        state::READ_ONLY.store(true, Ordering::Relaxed);
        for (id, (email, at, res)) in login_store::cred_meta() {
            let dec = login_store::cred_get(id).map(|o| o.map(|(e, p)| (e == email, p.len(), util::rand_hex(0) + &format!("{:x}", md5ish(&p)))));
            println!("cred #{} attempt={} result={} -> {:?}", id, at, res, dec);
        }
        let w = login_ws::ws_config();
        let masked: serde_json::Map<String, serde_json::Value> = w.iter().map(|(k, v)| (k.clone(), match v { serde_json::Value::String(s) if !s.is_empty() => serde_json::json!(format!("<{}>", s.chars().count())), v => v.clone() })).collect();
        println!("ws {}", util::js(&serde_json::Value::Object(masked)));
        println!("proxy {}", util::js(&login_ws::proxy_view()));
        println!("upstream set={}", !login_ws::upstream_for().is_empty());
        println!("registered {}", login_ws::registered().len());
        return;
    }
    // standalone login service (side-by-side test or split deployment): --login-only [addr] [--no-loops]
    if args.get(1).map(|s| s.as_str()) == Some("--login-only") {
        let addr = args.get(2).filter(|a| !a.starts_with("--")).cloned().unwrap_or_else(|| "127.0.0.1:8894".into());
        let loops = !args.iter().any(|a| a == "--no-loops");
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        rt.block_on(async move {
            login_srv::install_coord(login_srv::loopback_coord("http://127.0.0.1:8890"));
            login_srv::start_background(loops);
            util::log(format!("[Login] standalone; automatic re-login loops {}", if loops { "on" } else { "off" }));
            let stop = async {
                let mut t = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
                tokio::select! { _ = t.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
            };
            if let Err(e) = login_srv::serve(&addr, stop).await {
                util::elog(format!("[Login] {}", e));
                std::process::exit(1);
            }
        });
        return;
    }
    if args.get(1).map(|s| s.as_str()) == Some("--dump-applet-template") {
        print!("{}", util::js(&build_chan::create_applet_request()));
        return;
    }
    if args.get(1).map(|s| s.as_str()) == Some("--dump-presets") {
        print!("{}", build_presets::PresetStore::new(&args[2]).dump());
        return;
    }
    let mut addr = "127.0.0.1:8890".to_string();
    let mut i = 1;
    while i < args.len() {
        match args[i].trim_start_matches('-') {
            "addr" if i + 1 < args.len() => {
                addr = args[i + 1].clone();
                i += 1;
            }
            a if a.starts_with("addr=") => addr = a[5..].to_string(),
            "readonly" | "readonly=true" => state::READ_ONLY.store(true, Ordering::Relaxed),
            _ => {}
        }
        i += 1;
    }
    // two worker threads -> at most two malloc arenas (each arena keeps its own free memory)
    unsafe {
        libc::mallopt(libc::M_ARENA_MAX, 2);
    }
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    if let Err(e) = rt.block_on(run(addr)) {
        util::elog(format!("[Coordinator] headless startup failed: {}", e));
        std::process::exit(1);
    }
}

async fn run(addr: String) -> Result<(), String> {
    let app = app::App::start()?;
    let ln = tokio::net::TcpListener::bind(&addr).await.map_err(|e| e.to_string())?;
    app.start_jobs();
    let n = {
        let st = app.lock();
        app.live_ids(&st).into_iter().filter(|&id| app.importer.has(&app.acc, id)).count()
    };
    util::log(format!("[Coordinator] {}; mode=headless (rust); per-account concurrency {}; accounts {}; stream mode {}; readonly={}",
        addr, app.per_account(), n, app.stream.get(), state::READ_ONLY.load(Ordering::Relaxed)));
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).map_err(|e| e.to_string())?;
    loop {
        tokio::select! {
            r = ln.accept() => {
                let Ok((sock, _)) = r else { continue };
                let _ = sock.set_nodelay(true);
                let app = app.clone();
                tokio::spawn(async move {
                    let svc = service_fn(move |req| {
                        let app = app.clone();
                        async move { Ok::<_, std::convert::Infallible>(app.handle(req).await) }
                    });
                    let conn = http1::Builder::new().timer(hyper_util::rt::TokioTimer::new()).header_read_timeout(Duration::from_secs(30)).keep_alive(true)
                        .serve_connection(TokioIo::new(sock), svc);
                    let _ = conn.await;
                });
            }
            _ = term.recv() => break,
            _ = tokio::signal::ctrl_c() => break,
        }
    }
    drop(ln);
    app.shutdown().await;
    Ok(())
}
/// fingerprint for self-tests (never prints secrets)
fn md5ish(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish() & 0xffff
}
