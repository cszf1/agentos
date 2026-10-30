//! agentos-machined entry point. Start order (spec §17.1 step 3): open machine.sqlite, resume half-done provisioning,
//! reconcile permits and machine operations against real executors, then accept clients. Business scheduling stays
//! closed while a restore is in progress.
use agentos_machine::backends::{RealExecutor, SecretStore};
use agentos_machine::dir::Machine;
use agentos_machine::err::MErr;
use agentos_machine::sys::{HostSystem, Paths};
use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Mutex};

fn arg(name: &str) -> Option<String> {
    let a: Vec<String> = std::env::args().collect();
    a.iter().position(|x| x == name).and_then(|i| a.get(i + 1).cloned())
}

fn main() {
    if unsafe { libc::geteuid() } != 0 {
        eprintln!("agentos-machined must run as root");
        std::process::exit(2);
    }
    let mut paths = Paths::default();
    if let Some(d) = arg("--state-dir") {
        paths.machine_dir = d.into();
    }
    let socket = arg("--socket").unwrap_or_else(|| "/run/agentos/machine/machine.sock".into());
    // V1-R11: the machine directory is gone but this machine was in use. Never answer with an empty directory (that
    // would reopen first boot and let old work replay): stay in recovery mode, without a socket, until the local
    // administrator accepts a new installation identity (`agentosctl recover --new-identity`).
    if let Some(code) = recovery_gate(&paths, &socket) {
        std::process::exit(code);
    }
    let init = arg("--init-program").unwrap_or_else(|| "/run/current-system/sw/bin/agentos-admin".into());
    let sys = Box::new(HostSystem { init_program: init.into() });
    let mut m = match Machine::open(paths, sys) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("machine.sqlite: {e}");
            std::process::exit(1);
        }
    };
    let secrets = Arc::new(Mutex::new(SecretStore::default()));
    let mut ex = RealExecutor {
        secrets: secrets.clone(),
        drain: Box::new(|m: &mut Machine, _force: bool| {
            // Quiesce every running workspace through its own shutdown order; blocked = something did not exit.
            let mut st = m.c.prepare("SELECT workspace_id FROM workspaces WHERE state IN ('starting','running','quiescing')").map_err(MErr::from)?;
            let wss: Vec<String> = st.query_map([], |r| r.get(0)).map_err(MErr::from)?.collect::<Result<_, _>>().map_err(MErr::from)?;
            drop(st);
            let mut blocked = vec![];
            for w in wss {
                if let Err(e) = m.stop_workspace(&w) {
                    blocked.push(json!({ "workspaceId": w, "reason": e.code }));
                }
            }
            Ok(json!({ "blocked": !blocked.is_empty(), "reason": blocked }))
        }),
    };
    if m.installed().unwrap_or(false) {
        match m.resume_creations() {
            Ok(v) if !v.is_empty() => eprintln!("resumed {} workspace creations", v.len()),
            _ => {}
        }
        match m.reconcile_boot() {
            Ok(n) if n > 0 => eprintln!("{n} workspaces had no Host on this boot: marked stopped"),
            Err(e) => eprintln!("boot reconcile: {e}"),
            _ => {}
        }
        match m.resume_deletions() {
            Ok(n) if n > 0 => eprintln!("re-asked the broker about {n} pending workspace deletions"),
            Err(e) => eprintln!("deletion resume: {e}"),
            _ => {}
        }
        match m.reconcile_permits() {
            Ok(v) => eprintln!("permits reconciled: {v}"),
            Err(e) => eprintln!("permit reconcile: {e}"),
        }
        if let Err(e) = m.reconcile_operations(&mut ex) {
            eprintln!("operation reconcile: {e}");
        }
    }
    let dir = std::path::Path::new(&socket).parent().unwrap().to_path_buf();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755));
    let _ = std::fs::remove_file(&socket);
    let listener = match std::os::unix::net::UnixListener::bind(&socket) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("bind {socket}: {e}");
            std::process::exit(1);
        }
    };
    let _ = std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o666));
    eprintln!("agentos-machined ready on {socket}");
    let _ = std::process::Command::new("systemd-notify").arg("--ready").status();
    agentos_machine::server::run(listener, m, Box::new(ex), secrets);
}

/// Remains of an earlier installation that make a missing machine.sqlite a loss, not a fresh machine.
fn remnants(paths: &Paths) -> Vec<String> {
    let mut out = vec![];
    for f in ["machine.secret", "first-boot-id", "machine.sqlite-wal", "machine.sqlite-journal"] {
        if paths.machine_dir.join(f).exists() {
            out.push(format!("machine:{f}"));
        }
    }
    if std::fs::read_dir(&paths.workspaces_dir).map(|mut d| d.next().is_some()).unwrap_or(false) {
        out.push("workspaces".into());
    }
    if std::path::Path::new("/var/lib/agentos-broker/broker.sqlite").exists() {
        out.push("broker:log".into());
    }
    out
}

fn recovery_gate(paths: &Paths, socket: &str) -> Option<i32> {
    let db = paths.machine_dir.join("machine.sqlite");
    let required = paths.machine_dir.join("recovery-required");
    let accepted = paths.machine_dir.join("recovery-accepted");
    if db.exists() {
        return None;
    }
    let rem = remnants(paths);
    if rem.is_empty() {
        let _ = std::fs::remove_file(&required);
        return None;
    }
    if accepted.exists() {
        // New installation identity: keep every remnant as evidence (never replayed), then start empty.
        let lost = paths.machine_dir.join(format!("lost-{}", agentos_machine::util::now_ms()));
        let _ = std::fs::create_dir_all(lost.join("broker"));
        let _ = std::fs::set_permissions(&lost, std::fs::Permissions::from_mode(0o700));
        if let Ok(rd) = std::fs::read_dir(&paths.machine_dir) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n.starts_with("lost-") || n == "recovery-accepted" {
                    continue;
                }
                let _ = std::fs::rename(e.path(), lost.join(&n));
            }
        }
        for f in ["broker.sqlite", "broker.sqlite-wal", "broker.sqlite-shm"] {
            let src = std::path::Path::new("/var/lib/agentos-broker").join(f);
            if src.exists() {
                let _ = std::fs::rename(&src, lost.join("broker").join(f));
            }
        }
        let _ = std::fs::write(lost.join("README"), format!("Remains of the installation before {} (V1-R11). Evidence only; nothing here is replayed. Old workspace trees stay under /var/lib/agentos/workspaces and need an explicit import.\n", agentos_machine::util::now_ms()));
        let _ = std::fs::remove_file(&accepted);
        eprintln!("agentos-machined: recovery accepted; previous state kept in {}", lost.display());
        return None;
    }
    // A socket file left by the previous instance would look like a live machined to clients and checks: remove it,
    // so "no socket" is literally true while recovery is pending.
    let _ = std::fs::remove_file(socket);
    let body = json!({ "state": "recovery_required", "reason": "MACHINE_DIRECTORY_MISSING", "remnants": rem });
    let _ = agentos_machine::dir::write_private(&required, body.to_string().as_bytes());
    eprintln!("agentos-machined: MACHINE_DIRECTORY_MISSING: machine.sqlite is gone but {rem:?} remain; recovery mode (no socket). Run `agentosctl recover --new-identity` as root.");
    let _ = std::process::Command::new("systemd-notify").args(["--ready", "--status=recovery required: machine directory missing"]).status();
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}
