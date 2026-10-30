//! agentos-session-gateway entry point: client socket 0666 (identity from the kernel + logind), Host socket in a
//! root-only directory. No TCP listener exists.
use std::os::unix::fs::PermissionsExt;

fn arg(name: &str) -> Option<String> {
    let a: Vec<String> = std::env::args().collect();
    a.iter().position(|x| x == name).and_then(|i| a.get(i + 1).cloned())
}

fn bind(path: &str, mode: u32) -> std::os::unix::net::UnixListener {
    let p = std::path::Path::new(path);
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::remove_file(p);
    let l = std::os::unix::net::UnixListener::bind(p).unwrap_or_else(|e| {
        eprintln!("bind {path}: {e}");
        std::process::exit(1)
    });
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode));
    l
}

fn main() {
    if unsafe { libc::geteuid() } != 0 {
        eprintln!("agentos-session-gateway must run as root");
        std::process::exit(2);
    }
    let machine = arg("--machine-socket").unwrap_or_else(|| "/run/agentos/machine/machine.sock".into());
    let client = arg("--socket").unwrap_or_else(|| "/run/agentos/gateway.sock".into());
    let host = arg("--host-socket").unwrap_or_else(|| "/run/agentos/gateway/host.sock".into());
    let hd = std::path::Path::new(&host).parent().unwrap().to_path_buf();
    let _ = std::fs::create_dir_all(&hd);
    let _ = std::os::unix::fs::chown(&hd, Some(0), Some(0));
    let _ = std::fs::set_permissions(&hd, std::fs::Permissions::from_mode(0o755));
    let gw = agentos_session_gateway::gw::Gw::new(&machine);
    let cl = bind(&client, 0o666);
    let hl = bind(&host, 0o666);
    eprintln!("agentos-session-gateway ready");
    let _ = std::process::Command::new("systemd-notify").arg("--ready").status();
    agentos_session_gateway::gw::serve(gw, cl, hl);
}
