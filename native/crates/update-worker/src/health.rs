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
    let br = std::path::Path::new("/run/agentos-broker/broker.sock").exists();
    v.push(Check { name: "broker_identity", ok: br, detail: "broker socket".into() });
    let greeter = std::process::Command::new("systemctl").args(["is-active", "greetd.service"]).output().map(|o| o.status.success()).unwrap_or(false);
    v.push(Check { name: "greeter_frame", ok: greeter, detail: "greetd active".into() });
    let canvas = std::process::Command::new("agentos-shell").arg("--health-canvas").env("QT_QPA_PLATFORM", "offscreen").output().map(|o| o.status.success()).unwrap_or(false);
    v.push(Check { name: "shell_canvas", ok: canvas, detail: "agentos-shell --health-canvas".into() });
    // every registered workspace, stopped ones included (status.workspaceList; a missing list is not "all compatible")
    let wss: Vec<Value> = stv["workspaceList"].as_array().cloned().unwrap_or_else(|| vec![json!({ "workspaceId": "?", "state": "status unreadable", "schemaVersion": null })]);
    v.push(workspaces_compatible(&wss, compat));
    let failed = std::process::Command::new("systemctl").args(["--failed", "--no-legend", "agentos-*"]).output().map(|o| o.stdout.is_empty()).unwrap_or(false);
    v.push(Check { name: "no_root_errors", ok: failed, detail: "failed agentos units".into() });
    v
}
