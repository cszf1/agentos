//! agentos-worker <file|service|network|serial> <socket>: fixed provider workers started by systemd with their own
//! UID, capabilities and namespaces (spec §12.3). They accept requests only from the root broker (peer uid 0) and
//! only the operations of their role; targets come from the broker's root-owned catalog.
mod file;
mod network;
mod serial;
mod service;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use agentos_protocol::frame::{parse_strict, read_frame, write_frame, MAX_CONTROL_FRAME};
use agentos_protocol::peer::peer_cred;
use agentos_protocol::worker::{WorkerError, WorkerRequest, WorkerResponse};

pub static ACTIVE: AtomicUsize = AtomicUsize::new(0);

pub struct WErr {
    pub code: String,
    pub message: String,
    pub effect: &'static str,
}

impl WErr {
    pub fn none(code: &str, m: impl Into<String>) -> Self {
        WErr { code: code.into(), message: m.into(), effect: "none" }
    }
    pub fn unknown(code: &str, m: impl Into<String>) -> Self {
        WErr { code: code.into(), message: m.into(), effect: "unknown" }
    }
}

impl From<agentos_protocol::fsutil::FsError> for WErr {
    fn from(e: agentos_protocol::fsutil::FsError) -> Self {
        WErr::none(e.code, e.message)
    }
}

pub type Res = Result<Value, WErr>;

fn main() {
    for (k, _) in std::env::vars_os() {
        let k = k.to_string_lossy().to_string();
        if k != "NOTIFY_SOCKET" && k != "INVOCATION_ID" {
            std::env::remove_var(&k);
        }
    }
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: agentos-worker <file|service|network|serial> <socket>");
        std::process::exit(2);
    }
    let role = args[1].clone();
    let sock = args[2].clone();
    let _ = std::fs::remove_file(&sock);
    let l = UnixListener::bind(&sock).unwrap_or_else(|e| {
        eprintln!("bind {sock}: {e}");
        std::process::exit(1)
    });
    let _ = std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600));
    let serial_state = Arc::new(Mutex::new(serial::State::default()));
    // Deduplicate retransmits of the same dispatch (operationId + dispatchNonce + brokerInstanceId + op).
    let seen: Arc<Mutex<HashMap<String, Value>>> = Arc::new(Mutex::new(HashMap::new()));
    if let Ok(p) = std::env::var("NOTIFY_SOCKET") {
        if let Ok(s) = std::os::unix::net::UnixDatagram::unbound() {
            let _ = s.send_to(b"READY=1", p);
        }
    }
    if role == "serial" {
        serial::start_idle_reaper(serial_state.clone());
    }
    for s in l.incoming() {
        let Ok(s) = s else { continue };
        let role = role.clone();
        let st = serial_state.clone();
        let seen = seen.clone();
        std::thread::spawn(move || handle(&role, s, st, seen));
    }
}

fn handle(role: &str, s: UnixStream, st: Arc<Mutex<serial::State>>, seen: Arc<Mutex<HashMap<String, Value>>>) {
    match peer_cred(&s) {
        Ok(pc) if pc.uid == 0 => {}
        _ => return,
    }
    let mut r = &s;
    let Ok(body) = read_frame(&mut r, MAX_CONTROL_FRAME) else { return };
    let resp = match parse_strict(&body).map_err(|e| e.to_string()).and_then(|v| serde_json::from_value::<WorkerRequest>(v).map_err(|e| e.to_string())) {
        Err(e) => {
            WorkerResponse { ok: false, result: None, error: Some(WorkerError { code: "INVALID_SYSTEM_PLAN".into(), message: e, effect: "none".into() }) }
        }
        Ok(req) => {
            let key = req.operation_id.as_ref().zip(req.dispatch_nonce.as_ref()).map(|(o, n)| format!("{}|{}|{}|{}", req.broker_instance_id, o, n, req.op));
            if let Some(k) = &key {
                if let Some(v) = seen.lock().unwrap().get(k) {
                    let mut w = &s;
                    let _ = write_frame(&mut w, v.to_string().as_bytes());
                    return;
                }
            }
            ACTIVE.fetch_add(1, Ordering::SeqCst);
            let out = if req.op == "status" {
                Ok(json!({"role": role, "active": ACTIVE.load(Ordering::SeqCst) - 1, "pid": std::process::id()}))
            } else {
                match role {
                    "file" => file::handle(&req),
                    "service" => service::handle(&req),
                    "network" => network::handle(&req),
                    "serial" => serial::handle(&req, &st),
                    _ => Err(WErr::none("PROVIDER_UNAVAILABLE", "unknown role")),
                }
            };
            ACTIVE.fetch_sub(1, Ordering::SeqCst);
            let resp = match out {
                Ok(v) => WorkerResponse { ok: true, result: Some(v), error: None },
                Err(e) => WorkerResponse { ok: false, result: None, error: Some(WorkerError { code: e.code, message: e.message, effect: e.effect.into() }) },
            };
            if let Some(k) = key {
                let mut m = seen.lock().unwrap();
                if m.len() > 1000 {
                    m.clear();
                }
                m.insert(k, serde_json::to_value(&resp).unwrap());
            }
            resp
        }
    };
    let mut w = &s;
    let _ = write_frame(&mut w, serde_json::to_string(&resp).unwrap().as_bytes());
}

pub fn has_fault(req: &WorkerRequest, name: &str) -> bool {
    req.faults.iter().any(|f| f == name)
}

pub fn die(why: &str) -> ! {
    eprintln!("agentos-worker: fault point {why}: exiting");
    std::process::exit(1)
}
