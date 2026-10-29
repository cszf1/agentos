//! agentos-provider-user: unprivileged native reader started by the host as its own user (spec §12.3). It reads
//! registered import roots with the user's permissions (never through the broker), host network state via
//! rtnetlink, device metadata via udev, and catalog unit state via read-only systemd properties.
//!   serve : framed JSON requests on stdin, responses on stdout
//!   watch : inotify / D-Bus / udev event stream (framed JSON on stdout) for the configured resources
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::unix::io::AsRawFd;

use agentos_protocol::frame::{parse_strict, read_frame, write_frame, MAX_CONTROL_FRAME};
use agentos_protocol::fsutil;

mod watch;

fn err(code: &str, m: impl Into<String>) -> Value {
    json!({"code": code, "message": m.into()})
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "serve".into());
    if mode == "watch" {
        watch::run();
        return;
    }
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    loop {
        let body = match read_frame(&mut stdin, MAX_CONTROL_FRAME) {
            Ok(b) => b,
            Err(_) => return,
        };
        let (id, out) = match parse_strict(&body) {
            Err(e) => (Value::Null, Err(err("INVALID_SYSTEM_PLAN", e.to_string()))),
            Ok(v) => (v["id"].clone(), handle(&v)),
        };
        let resp = match out {
            Ok(r) => json!({"id": id, "ok": true, "result": r}),
            Err(e) => json!({"id": id, "ok": false, "error": e}),
        };
        let s = resp.to_string();
        let s = if s.len() > MAX_CONTROL_FRAME { json!({"id": id, "ok": false, "error": err("LIMIT_EXCEEDED", "response too large")}).to_string() } else { s };
        if write_frame(&mut stdout, s.as_bytes()).is_err() {
            return;
        }
    }
}

fn root_identity(st: &libc::stat) -> Value {
    json!({"dev": st.st_dev, "ino": st.st_ino, "uid": st.st_uid})
}

/// Open the registered root and verify it is still the same directory object (moved/replaced roots are refused).
fn open_checked(root: &Value) -> Result<std::os::unix::io::OwnedFd, Value> {
    let path = root["path"].as_str().ok_or_else(|| err("RESOURCE_NOT_BOUND", "root path missing"))?;
    let (fd, st) = fsutil::open_root(path).map_err(|e| err(if e.code == "RESOURCE_GONE" { "RESOURCE_GONE" } else { e.code }, e.message))?;
    let want = &root["identity"];
    if want["dev"].as_u64() != Some(st.st_dev) || want["ino"].as_u64() != Some(st.st_ino) {
        return Err(err("RESOURCE_GENERATION_STALE", "the registered directory was moved or replaced; register it again"));
    }
    Ok(fd)
}

fn handle(v: &Value) -> Result<Value, Value> {
    let p = &v["params"];
    match v["op"].as_str().unwrap_or("") {
        "register_root" => {
            let path = p["path"].as_str().ok_or_else(|| err("INVALID_SYSTEM_PLAN", "path"))?;
            if !path.starts_with('/') || path.contains('\0') || path.len() > 1024 || path.split('/').any(|s| s == ".." || s == ".") {
                return Err(err("PATH_SCOPE_VIOLATION", "an absolute, normalized directory path is required"));
            }
            let (fd, st) = fsutil::open_root(path).map_err(|e| err(e.code, e.message))?;
            if fsutil::kind_of(&st) != "dir" {
                return Err(err("UNSUPPORTED_FILE_TYPE", "not a directory"));
            }
            // Readability with the user's own permissions is the only access check (no privilege is involved).
            fsutil::list(fd.as_raw_fd(), "", None, 1).map_err(|e| err(e.code, format!("cannot read the directory: {}", e.message)))?;
            Ok(
                json!({"path": path, "identity": root_identity(&st), "mode": format!("{:o}", st.st_mode & 0o7777), "ownedByUser": st.st_uid == unsafe { libc::geteuid() }}),
            )
        }
        "observe_root" => {
            let fd = open_checked(&p["root"])?;
            let st = fsutil::fstat(fd.as_raw_fd()).map_err(|e| err(e.code, e.message))?;
            Ok(json!({"identity": root_identity(&st)}))
        }
        "file" => {
            let fd = open_checked(&p["root"])?;
            let cap = p["capabilityId"].as_str().unwrap_or("");
            let params = agentos_protocol::params::check_params(cap, &p["params"]).map_err(|m| match m.split_once(": ") {
                Some((c, msg)) => err(c, msg),
                None => err("INVALID_SYSTEM_PLAN", m),
            })?;
            fsutil::read_cap(fd.as_raw_fd(), cap, &params).map_err(|e| err(e.code, e.message))
        }
        "service" => {
            let unit = p["unit"].as_str().unwrap_or("");
            if !unit.starts_with("agentos-") || !unit.ends_with(".service") {
                return Err(err("SERVICE_TARGET_NOT_REGISTERED", "only catalog units"));
            }
            let c = agentos_protocol::sysd::system().map_err(|e| err("PROVIDER_UNAVAILABLE", e))?;
            let d = agentos_protocol::sysd::describe(&c, unit).map_err(|e| err("PROVIDER_UNAVAILABLE", e))?;
            if p["capabilityId"] == "service.metrics" {
                Ok(json!({"unit": unit, "activeState": d["activeState"], "metrics": agentos_protocol::sysd::metrics(&d)}))
            } else {
                Ok(d)
            }
        }
        "network_snapshot" => agentos_protocol::rtnl::snapshot().map_err(|e| err("PROVIDER_UNAVAILABLE", e)),
        "device_list" => Ok(json!({"devices": watch::list_devices()})),
        "probe" => {
            // native:doctor helper: report what this user-level process can reach.
            let openat2 = fsutil::open_root("/").and_then(|(fd, _)| fsutil::openat2(fd.as_raw_fd(), "etc", libc::O_RDONLY | libc::O_DIRECTORY, 0)).is_ok();
            let bus = agentos_protocol::sysd::system().and_then(|c| agentos_protocol::sysd::describe(&c, "dbus.service")).is_ok();
            Ok(
                json!({"openat2": openat2, "systemBus": bus, "rtnetlink": agentos_protocol::rtnl::snapshot().is_ok(), "udev": udev::Enumerator::new().is_ok(), "bootId": agentos_protocol::boot_id()}),
            )
        }
        o => Err(err("CAPABILITY_VERSION_UNSUPPORTED", format!("unknown op {o}"))),
    }
}

#[allow(dead_code)]
fn read_all(r: &mut impl Read) -> Vec<u8> {
    let mut v = Vec::new();
    let _ = r.read_to_end(&mut v);
    v
}

#[allow(dead_code)]
fn flush(w: &mut impl Write) {
    let _ = w.flush();
}
