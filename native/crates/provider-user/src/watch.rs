//! Event sources for observation refresh (spec §10, §18.1): inotify for import roots, D-Bus PropertiesChanged for
//! catalog units, udev for tty devices. Every source has its own epoch and sequence; overflow, disconnect or limits
//! produce a gap event so the host drops incremental assumptions and re-reads the resource.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::CString;
use std::sync::{Arc, Mutex};

use agentos_protocol::frame::{parse_strict, read_frame, write_frame, MAX_CONTROL_FRAME};

const MAX_DIRS: usize = 128;
const MAX_DEPTH: usize = 4;

struct Out {
    epoch: String,
    seqs: HashMap<String, u64>,
}

fn emit(out: &Arc<Mutex<Out>>, source: &str, mut ev: Value) {
    let mut g = out.lock().unwrap();
    let seq = {
        let s = g.seqs.entry(source.to_string()).or_insert(0);
        *s += 1;
        *s
    };
    ev["source"] = json!(source);
    ev["sourceEpoch"] = json!(g.epoch);
    ev["sourceSeq"] = json!(seq);
    ev["observedAtMs"] = json!(agentos_protocol::now_ms());
    let mut so = std::io::stdout().lock();
    let _ = write_frame(&mut so, ev.to_string().as_bytes());
}

pub fn run() {
    let mut stdin = std::io::stdin().lock();
    let cfg = match read_frame(&mut stdin, MAX_CONTROL_FRAME).ok().and_then(|b| parse_strict(&b).ok()) {
        Some(c) => c,
        None => return,
    };
    let out = Arc::new(Mutex::new(Out {
        epoch: format!("w_{}_{}", agentos_protocol::boot_id().chars().take(8).collect::<String>(), agentos_protocol::random_hex(4)),
        seqs: HashMap::new(),
    }));
    for src in ["inotify", "dbus", "udev"] {
        emit(&out, src, json!({"kind": "epoch_start", "gap": true}));
    }
    let roots = cfg["roots"].as_array().cloned().unwrap_or_default();
    let units = cfg["units"].as_array().cloned().unwrap_or_default();
    {
        let o = out.clone();
        std::thread::spawn(move || inotify_loop(o, roots));
    }
    {
        let o = out.clone();
        std::thread::spawn(move || dbus_loop(o, units));
    }
    {
        let o = out.clone();
        std::thread::spawn(move || udev_loop(o));
    }
    // Exit when the host closes stdin (it restarts the watcher with a new configuration).
    let _ = read_frame(&mut stdin, MAX_CONTROL_FRAME);
    std::process::exit(0);
}

fn add_tree(fd: i32, root_id: &str, base: &std::path::Path, depth: usize, map: &mut HashMap<i32, (String, String)>, rel: String) -> bool {
    if map.len() >= MAX_DIRS || depth > MAX_DEPTH {
        return false;
    }
    let c = CString::new(base.as_os_str().to_string_lossy().as_bytes()).unwrap();
    let mask = libc::IN_CREATE
        | libc::IN_DELETE
        | libc::IN_MODIFY
        | libc::IN_MOVED_FROM
        | libc::IN_MOVED_TO
        | libc::IN_CLOSE_WRITE
        | libc::IN_DELETE_SELF
        | libc::IN_MOVE_SELF
        | libc::IN_DONT_FOLLOW
        | libc::IN_ONLYDIR;
    let wd = unsafe { libc::inotify_add_watch(fd, c.as_ptr(), mask) };
    if wd < 0 {
        return true;
    }
    map.insert(wd, (root_id.to_string(), rel.clone()));
    let mut complete = true;
    if let Ok(rd) = std::fs::read_dir(base) {
        for e in rd.flatten() {
            if let Ok(ft) = e.file_type() {
                if ft.is_dir() && !ft.is_symlink() {
                    let r = if rel.is_empty() { e.file_name().to_string_lossy().to_string() } else { format!("{rel}/{}", e.file_name().to_string_lossy()) };
                    complete &= add_tree(fd, root_id, &e.path(), depth + 1, map, r);
                }
            }
        }
    }
    complete
}

fn inotify_loop(out: Arc<Mutex<Out>>, roots: Vec<Value>) {
    loop {
        let fd = unsafe { libc::inotify_init1(libc::IN_CLOEXEC) };
        if fd < 0 {
            emit(&out, "inotify", json!({"kind": "unavailable", "gap": true}));
            return;
        }
        let mut map = HashMap::new();
        for r in &roots {
            let id = r["resourceId"].as_str().unwrap_or("").to_string();
            let path = r["path"].as_str().unwrap_or("");
            if !add_tree(fd, &id, std::path::Path::new(path), 0, &mut map, String::new()) {
                emit(
                    &out,
                    "inotify",
                    json!({"kind": "watch_limit", "resourceId": id, "gap": true, "detail": format!("more than {MAX_DIRS} directories or depth > {MAX_DEPTH}; changes beyond the limit need a rescan")}),
                );
            }
        }
        let mut buf = vec![0u8; 64 * 1024];
        'read: loop {
            let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
            if n <= 0 {
                break;
            }
            let mut off = 0usize;
            while off + 16 <= n as usize {
                let ev = unsafe { &*(buf.as_ptr().add(off) as *const libc::inotify_event) };
                let len = ev.len as usize;
                let name = if len > 0 {
                    let raw = &buf[off + 16..off + 16 + len];
                    String::from_utf8_lossy(raw.split(|b| *b == 0).next().unwrap_or(&[])).to_string()
                } else {
                    String::new()
                };
                off += 16 + len;
                if ev.mask & libc::IN_Q_OVERFLOW != 0 {
                    emit(&out, "inotify", json!({"kind": "overflow", "gap": true}));
                    break 'read; // rescan: rebuild every watch
                }
                let Some((rid, rel)) = map.get(&ev.wd).cloned() else { continue };
                if ev.mask & (libc::IN_DELETE_SELF | libc::IN_MOVE_SELF) != 0 && rel.is_empty() {
                    emit(&out, "inotify", json!({"kind": "root_gone", "resourceId": rid, "gap": true}));
                    continue;
                }
                if name.starts_with(".aos-tmp-") {
                    continue;
                }
                let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
                emit(&out, "inotify", json!({"kind": "file_changed", "resourceId": rid, "path": path, "mask": ev.mask}));
            }
        }
        unsafe { libc::close(fd) };
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

fn dbus_loop(out: Arc<Mutex<Out>>, units: Vec<Value>) {
    loop {
        let Ok(c) = agentos_protocol::sysd::system() else {
            emit(&out, "dbus", json!({"kind": "unavailable", "gap": true}));
            std::thread::sleep(std::time::Duration::from_secs(5));
            continue;
        };
        let mut paths = HashMap::new();
        for u in &units {
            let name = u["unit"].as_str().unwrap_or("");
            if let Ok(p) = agentos_protocol::sysd::load_unit(&c, name) {
                paths.insert(p.as_str().to_string(), (u["resourceId"].as_str().unwrap_or("").to_string(), name.to_string()));
            }
        }
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface("org.freedesktop.DBus.Properties")
            .unwrap()
            .member("PropertiesChanged")
            .unwrap()
            .build();
        let Ok(it) = zbus::blocking::MessageIterator::for_match_rule(rule, &c, Some(256)) else {
            emit(&out, "dbus", json!({"kind": "unavailable", "gap": true}));
            std::thread::sleep(std::time::Duration::from_secs(5));
            continue;
        };
        for m in it {
            let Ok(m) = m else { break };
            let path = m.header().path().map(|p| p.as_str().to_string()).unwrap_or_default();
            if let Some((rid, unit)) = paths.get(&path) {
                let state = agentos_protocol::sysd::describe(&c, unit).ok();
                emit(
                    &out,
                    "dbus",
                    json!({"kind": "service_changed", "resourceId": rid, "activeState": state.as_ref().map(|s| s["activeState"].clone()), "invocationId": state.as_ref().map(|s| s["invocationId"].clone())}),
                );
            }
        }
        // The bus connection ended: anything in between is unknown.
        emit(&out, "dbus", json!({"kind": "disconnected", "gap": true}));
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}

fn udev_loop(out: Arc<Mutex<Out>>) {
    let sock = match udev::MonitorBuilder::new().and_then(|b| b.match_subsystem("tty")).and_then(|b| b.listen()) {
        Ok(s) => s,
        Err(_) => {
            emit(&out, "udev", json!({"kind": "unavailable", "gap": true}));
            return;
        }
    };
    use std::os::unix::io::AsRawFd;
    let fd = sock.as_raw_fd();
    loop {
        let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        if unsafe { libc::poll(&mut pfd, 1, 1000) } <= 0 {
            continue;
        }
        for ev in sock.iter() {
            emit(
                &out,
                "udev",
                json!({"kind": format!("device_{:?}", ev.event_type()).to_lowercase(), "devnode": ev.devnode().map(|p| p.display().to_string())}),
            );
        }
    }
}

pub fn list_devices() -> Value {
    let mut out = Vec::new();
    if let Ok(mut e) = udev::Enumerator::new() {
        let _ = e.match_subsystem("tty");
        if let Ok(devs) = e.scan_devices() {
            for d in devs {
                let props = |k: &str| d.property_value(k).map(|v| v.to_string_lossy().to_string());
                if props("ID_BUS").is_none() && props("ID_PATH").is_none() {
                    continue;
                }
                out.push(json!({"devnode": d.devnode().map(|p| p.display().to_string()), "vendor": props("ID_VENDOR_ID"), "model": props("ID_MODEL_ID"), "serial": props("ID_SERIAL_SHORT"), "bus": props("ID_BUS")}));
                if out.len() >= 32 {
                    break;
                }
            }
        }
    }
    json!(out)
}
