//! Health gate of a trial boot (spec §21.3, V1-U09): at most 180 s, all checks green continuously for 60 s.
//! No check depends on the model or a user password. A system that only answers SSH, a Shell that renders no
//! frame, or ANY registered workspace (stopped ones included) outside the release's schema range fails the gate.
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct Check {
    pub name: &'static str,
    pub ok: bool,
    pub detail: String,
}

pub const REQUIRED: &[&str] = &["disk_rw", "machine_identity", "broker_identity", "greeter_frame", "shell_canvas", "workspaces_compatible", "no_root_errors"];

/// Pure: evaluate one round. Missing checks count as failed (a probe that did not run is not a pass).
pub fn round_ok(checks: &[Check]) -> (bool, Vec<String>) {
    let mut bad = vec![];
    for r in REQUIRED {
        match checks.iter().find(|c| c.name == *r) {
            Some(c) if c.ok => {}
            Some(c) => bad.push(format!("{}: {}", c.name, c.detail)),
            None => bad.push(format!("{r}: not run")),
        }
    }
    (bad.is_empty(), bad)
}

/// Workspaces compatibility: every registered workspace's schema inside [min, max].
pub fn workspaces_compatible(wss: &[Value], range: (i64, i64)) -> Check {
    let bad: Vec<String> = wss
        .iter()
        // a workspace whose Host never created its store holds no data that could be incompatible
        .filter(|w| w["initialized"] != false)
        .filter(|w| w["schemaVersion"].as_i64().map(|s| s < range.0 || s > range.1).unwrap_or(true))
        .map(|w| format!("{} ({}) schema {}", w["workspaceId"].as_str().unwrap_or("?"), w["state"].as_str().unwrap_or("?"), w["schemaVersion"]))
        .collect();
    Check { name: "workspaces_compatible", ok: bad.is_empty(), detail: bad.join(", ") }
}

/// Gate over a sequence of rounds sampled every `step_s`: pass once 60 s of consecutive green rounds fit inside 180 s.
pub fn gate(rounds: &mut dyn FnMut(u64) -> Vec<Check>, step_s: u64) -> Value {
    let mut green_since: Option<u64> = None;
    let mut t = 0u64;
    let mut last_bad = vec![];
    while t <= 180 {
        let (ok, bad) = round_ok(&rounds(t));
        if ok {
            let s = *green_since.get_or_insert(t);
            if t - s >= 60 {
                return json!({ "healthy": true, "stableFrom": s, "at": t });
            }
        } else {
            green_since = None;
            last_bad = bad;
        }
        t += step_s;
    }
    json!({ "healthy": false, "failing": last_bad })
}

/// Broker readiness through its own protocol (review R2-2): the socket existing, or the unit being active, is not
/// readiness — a broker in diagnostics-only mode (lost or foreign log) keeps both. The reply must say brokerReady and
/// name the same machine install id machined reports.
pub fn broker_check(reply: Option<&Value>, machine_id: Option<&str>) -> Check {
    let bad = |d: String| Check { name: "broker_identity", ok: false, detail: d };
    let Some(r) = reply else { return bad("broker-health: no answer on /run/agentos-broker/broker.sock".into()) };
    if r["ok"] != true {
        return bad(format!("broker-health refused: {}", r["error"]));
    }
    let res = &r["result"];
    if res["brokerReady"] != true {
        return bad(format!("broker not ready (mode {}): {}", res["mode"], res["diagnostics"]));
    }
    match (res["machineInstallId"].as_str(), machine_id) {
        (Some(b), Some(m)) if b == m => Check { name: "broker_identity", ok: true, detail: String::new() },
        (b, m) => bad(format!("broker install id {:?} differs from machined's {:?}", b, m)),
    }
}

/// One logind session as read from `loginctl show-session` (key=value).
pub type Session = std::collections::HashMap<String, String>;

/// Graphical output check (review R2-2): a local, live session on seat0 (the greeter, or a logged-in user) whose
/// user has a Wayland compositor answering on its socket, and a display connector reported connected. `greetd`
/// being active alone (it can be active with its greeter crashed and nothing on screen) does not pass.
pub fn graphics_check(sessions: &[Session], wayland_live: &dyn Fn(&str) -> bool, connector_connected: bool) -> Check {
    let mut seen = vec![];
    for s in sessions {
        let g = |k: &str| s.get(k).map(|x| x.as_str()).unwrap_or("");
        let local = g("Seat") == "seat0" && g("Remote") == "no" && matches!(g("State"), "active" | "online") && matches!(g("Class"), "greeter" | "user");
        seen.push(format!("{}:{}/{}/{}", g("Id"), g("Class"), g("Seat"), g("State")));
        if local && wayland_live(g("User")) {
            if !connector_connected {
                return Check { name: "greeter_frame", ok: false, detail: "no display connector is connected".into() };
            }
            return Check { name: "greeter_frame", ok: true, detail: String::new() };
        }
    }
    Check { name: "greeter_frame", ok: false, detail: format!("no local seat0 greeter/user session with a live Wayland compositor (sessions: {})", seen.join(", ")) }
}

fn broker_health_rpc() -> Option<Value> {
    use std::os::unix::net::UnixStream;
    let s = UnixStream::connect("/run/agentos-broker/broker.sock").ok()?;
    s.set_read_timeout(Some(std::time::Duration::from_secs(10))).ok()?;
    s.set_write_timeout(Some(std::time::Duration::from_secs(10))).ok()?;
    let mut w = &s;
    agentos_protocol::frame::write_frame(&mut w, json!({"v": 1, "id": "health", "method": "broker-health", "params": {}}).to_string().as_bytes()).ok()?;
    let mut r = &s;
    let body = agentos_protocol::frame::read_frame(&mut r, agentos_protocol::frame::MAX_CONTROL_FRAME).ok()?;
    serde_json::from_slice(&body).ok()
}

fn sessions() -> Vec<Session> {
    let out = std::process::Command::new("loginctl").args(["list-sessions", "--no-legend"]).output();
    let ids: Vec<String> = out.map(|o| String::from_utf8_lossy(&o.stdout).lines().filter_map(|l| l.split_whitespace().next().map(String::from)).collect()).unwrap_or_default();
    ids.iter()
        .filter_map(|id| {
            let o = std::process::Command::new("loginctl")
                .args(["show-session", id, "-p", "Id", "-p", "Seat", "-p", "Remote", "-p", "State", "-p", "Class", "-p", "User"])
                .output()
                .ok()?;
            Some(String::from_utf8_lossy(&o.stdout).lines().filter_map(|l| l.split_once('=').map(|(k, v)| (k.to_string(), v.to_string()))).collect())
        })
        .collect()
}

/// A compositor is live for this uid when some wayland-* socket in its runtime dir accepts a connection.
fn wayland_live(uid: &str) -> bool {
    let Ok(rd) = std::fs::read_dir(format!("/run/user/{uid}")) else { return false };
    rd.flatten().any(|e| {
        let n = e.file_name().to_string_lossy().to_string();
        n.starts_with("wayland-") && !n.ends_with(".lock") && std::os::unix::net::UnixStream::connect(e.path()).is_ok()
    })
}

fn connector_connected() -> bool {
    let Ok(rd) = std::fs::read_dir("/sys/class/drm") else { return false };
    rd.flatten().any(|e| std::fs::read_to_string(e.path().join("status")).map(|s| s.trim() == "connected").unwrap_or(false))
}

/// Real probes used on a booted system.
pub fn probe_system(state_dir: &str, compat: (i64, i64)) -> Vec<Check> {
    let mut v = vec![];
    let p = format!("{state_dir}/.health-probe");
    let ok = std::fs::write(&p, b"x").and_then(|_| std::fs::File::open(&p)?.sync_all()).is_ok() && std::fs::read(&p).map(|b| b == b"x").unwrap_or(false);
    let _ = std::fs::remove_file(&p);
    v.push(Check { name: "disk_rw", ok, detail: if ok { String::new() } else { "state dir not writable".into() } });
    let st = std::process::Command::new("agentosctl").arg("status").output();
    let stv: Value = st.ok().and_then(|o| serde_json::from_slice(&o.stdout).ok()).unwrap_or(Value::Null);
    v.push(Check { name: "machine_identity", ok: stv["meta"]["machineInstallId"].is_string(), detail: "agentosctl status".into() });
    v.push(broker_check(broker_health_rpc().as_ref(), stv["meta"]["machineInstallId"].as_str()));
    let greeter = std::process::Command::new("systemctl").args(["is-active", "greetd.service"]).output().map(|o| o.status.success()).unwrap_or(false);
    let g = graphics_check(&sessions(), &wayland_live, connector_connected());
    v.push(if greeter { g } else { Check { name: "greeter_frame", ok: false, detail: "greetd not active".into() } });
    let canvas = std::process::Command::new("agentos-shell").arg("--health-canvas").env("QT_QPA_PLATFORM", "offscreen").output().map(|o| o.status.success()).unwrap_or(false);
    v.push(Check { name: "shell_canvas", ok: canvas, detail: "agentos-shell --health-canvas".into() });
    // every registered workspace, stopped ones included (status.workspaceList; a missing list is not "all compatible")
    let wss: Vec<Value> = stv["workspaceList"].as_array().cloned().unwrap_or_else(|| vec![json!({ "workspaceId": "?", "state": "status unreadable", "schemaVersion": null })]);
    v.push(workspaces_compatible(&wss, compat));
    let failed = std::process::Command::new("systemctl").args(["--failed", "--no-legend", "agentos-*"]).output().map(|o| o.stdout.is_empty()).unwrap_or(false);
    v.push(Check { name: "no_root_errors", ok: failed, detail: "failed agentos units".into() });
    v
}
