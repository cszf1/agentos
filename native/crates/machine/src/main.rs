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
