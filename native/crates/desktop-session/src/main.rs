//! agentos-session-agent (spec §9.3, §11, §12.1, §18.2): lives inside the real logind graphical session (started from
//! the Sway session config, never as a detached user service). It owns the true lock state:
//!   - Lock requests (idle, user, PrepareForSleep) run swaylock (ext-session-lock); only after swaylock reports the
//!     session locked does it set logind LockedHint=true, which the gateway reads as the authority.
//!   - swaylock exiting 0 (PAM unlock) clears LockedHint; any abnormal swaylock/compositor end terminates the session
//!     so the user returns to the greeter instead of an unlocked desktop (V1-H03).
//!   - PrepareForSleep takes a bounded delay inhibitor, locks, then releases (V1-H06).
//!   - It supervises the Qt Shell with bounded restarts (≤5 s to a visible state, V1-D11).
//!   - It offers the current user's own session settings (volume/mute/output, display mode with 15 s revert,
//!     brightness via logind) on $XDG_RUNTIME_DIR/agentos-session.sock with fixed operations only.
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zbus::blocking::Connection;
use zbus::zvariant::{OwnedFd, OwnedObjectPath};

struct State {
    locked: bool,
    lock_child: Option<Child>,
    revert: Option<(Instant, Value)>,
    lock_minutes: u64,
}

fn session_path(c: &Connection) -> OwnedObjectPath {
    let pid = std::process::id();
    let r = c
        .call_method(Some("org.freedesktop.login1"), "/org/freedesktop/login1", Some("org.freedesktop.login1.Manager"), "GetSessionByPID", &(pid,))
        .expect("agentos-session-agent must run inside a logind session");
    r.body().deserialize().expect("session path")
}

fn set_locked_hint(c: &Connection, path: &OwnedObjectPath, v: bool) {
    let _ = c.call_method(Some("org.freedesktop.login1"), path.as_str(), Some("org.freedesktop.login1.Session"), "SetLockedHint", &(v,));
}

fn terminate(c: &Connection, path: &OwnedObjectPath) -> ! {
    eprintln!("agentos-session-agent: lock state unknown; ending the session");
    let _ = c.call_method(Some("org.freedesktop.login1"), path.as_str(), Some("org.freedesktop.login1.Session"), "Terminate", &());
    std::process::exit(1);
}

/// Start swaylock with a ready pipe; returns once the compositor confirmed the lock surface (or terminates).
fn lock(c: &Connection, path: &OwnedObjectPath, st: &Arc<Mutex<State>>) {
    if st.lock().unwrap().locked {
        return;
    }
    let mut fds = [0i32; 2];
    unsafe { libc::pipe(fds.as_mut_ptr()) };
    let child = Command::new("swaylock")
        .args(["--ready-fd", &fds[1].to_string(), "--show-failed-attempts", "--ignore-empty-password", "--color", "202020"])
        .stdin(Stdio::null())
        .spawn();
    unsafe { libc::close(fds[1]) };
    let mut child = match child {
        Ok(ch) => ch,
        Err(_) => terminate(c, path),
    };
    let mut buf = [0u8; 2];
    let mut f = unsafe { <std::fs::File as std::os::fd::FromRawFd>::from_raw_fd(fds[0]) };
    let n = f.read(&mut buf).unwrap_or(0);
    if n == 0 {
        let _ = child.kill();
        terminate(c, path);
    }
    // Sensitive UI state: clear the clipboard; the Shell drops prompts/notifications/unsent input on SESSION_LOCKED.
    let _ = Command::new("wl-copy").arg("--clear").status();
    set_locked_hint(c, path, true);
    let mut g = st.lock().unwrap();
    g.locked = true;
    g.lock_child = Some(child);
}

fn watch_lock(c: Connection, path: OwnedObjectPath, st: Arc<Mutex<State>>) {
    loop {
        std::thread::sleep(Duration::from_millis(200));
        let mut unlocked = false;
        let mut revert = None;
        {
            let mut g = st.lock().unwrap();
            if let Some(ch) = g.lock_child.as_mut() {
                match ch.try_wait() {
                    Ok(Some(status)) if status.success() => {
                        g.lock_child = None;
                        g.locked = false;
                        unlocked = true;
                    }
                    Ok(Some(_)) | Err(_) => terminate(&c, &path),
                    Ok(None) => {}
                }
            }
            if let Some((at, prev)) = g.revert.clone() {
                if Instant::now() >= at {
                    g.revert = None;
                    revert = Some(prev);
                }
            }
        }
        if unlocked {
            set_locked_hint(&c, &path, false);
        }
        if let Some(prev) = revert {
            let _ = apply_output(&prev);
        }
    }
}

fn listen_signals(path: OwnedObjectPath, st: Arc<Mutex<State>>) {
    let c = Connection::system().expect("system bus");
    let c2 = c.clone();
    let p2 = path.clone();
    let st2 = st.clone();
    std::thread::spawn(move || {
        let proxy = zbus::blocking::Proxy::new(&c2, "org.freedesktop.login1", p2.as_str(), "org.freedesktop.login1.Session").unwrap();
        for _ in proxy.receive_signal("Lock").unwrap() {
            lock(&c2, &p2, &st2);
        }
    });
    let c3 = c.clone();
    let st3 = st.clone();
    let p3 = path.clone();
    std::thread::spawn(move || {
        let mgr = zbus::blocking::Proxy::new(&c3, "org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager").unwrap();
        let mut inhibit = take_inhibitor(&c3);
        for m in mgr.receive_signal("PrepareForSleep").unwrap() {
            let going: bool = m.body().deserialize().unwrap_or(false);
            if going {
                lock(&c3, &p3, &st3);
                drop(inhibit.take());
            } else {
                // Resume: the gateway sees a new bootless epoch through LockedHint; we re-arm the inhibitor.
                inhibit = take_inhibitor(&c3);
            }
        }
    });
}

fn take_inhibitor(c: &Connection) -> Option<OwnedFd> {
    c.call_method(Some("org.freedesktop.login1"), "/org/freedesktop/login1", Some("org.freedesktop.login1.Manager"), "Inhibit", &("sleep", "AgentOS", "lock the session before sleeping", "delay"))
        .ok()
        .and_then(|m| m.body().deserialize::<OwnedFd>().ok())
}

fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
    let o = Command::new(cmd).args(args).stdin(Stdio::null()).output().map_err(|e| format!("{cmd}: {e}"))?;
    if !o.status.success() {
        return Err(format!("{cmd} failed: {}", String::from_utf8_lossy(&o.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&o.stdout).to_string())
}

fn outputs() -> Result<Value, String> {
    let t = run("swaymsg", &["-t", "get_outputs", "-r"])?;
    let v: Value = serde_json::from_str(&t).map_err(|e| e.to_string())?;
    Ok(Value::Array(
        v.as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|o| {
                json!({ "name": o["name"], "active": o["active"], "scale": o["scale"], "current": o["current_mode"],
                    "modes": o["modes"].as_array().map(|m| m.iter().map(|x| json!({ "width": x["width"], "height": x["height"], "refresh": x["refresh"] })).collect::<Vec<_>>()).unwrap_or_default() })
            })
            .collect(),
    ))
}

fn apply_output(o: &Value) -> Result<(), String> {
    let name = o["name"].as_str().ok_or("name")?;
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("bad output".into());
    }
    let w = o["width"].as_u64().ok_or("width")?;
    let h = o["height"].as_u64().ok_or("height")?;
    let scale = o["scale"].as_f64().ok_or("scale")?;
    if scale != 1.0 && scale != 2.0 {
        return Err("only 100% and 200% scaling are supported".into());
    }
    run("swaymsg", &["output", name, "mode", &format!("{w}x{h}"), "scale", &format!("{scale}")]).map(|_| ())
}

fn audio() -> Value {
    match run("wpctl", &["get-volume", "@DEFAULT_AUDIO_SINK@"]) {
        Ok(t) => {
            let muted = t.contains("MUTED");
            let vol = t.split_whitespace().nth(1).and_then(|x| x.parse::<f64>().ok()).unwrap_or(0.0);
            json!({ "available": true, "volume": (vol * 100.0).round(), "muted": muted })
        }
        Err(e) => json!({ "available": false, "reason": e }),
    }
}

fn backlight() -> Option<String> {
    std::fs::read_dir("/sys/class/backlight").ok()?.flatten().next().map(|e| e.file_name().to_string_lossy().to_string())
}

fn handle(c: &Connection, path: &OwnedObjectPath, st: &Arc<Mutex<State>>, req: &Value) -> Result<Value, String> {
    match req["op"].as_str().unwrap_or_default() {
        "status" => {
            let g = st.lock().unwrap();
            Ok(json!({ "locked": g.locked, "lockMinutes": g.lock_minutes, "audio": audio(), "outputs": outputs().unwrap_or(Value::Null), "backlight": backlight().is_some() }))
        }
        "lock" => {
            lock(c, path, st);
            Ok(json!({ "locked": true }))
        }
        // The user's logout from the Shell (review F02): end this logind session. greetd then shows the greeter again
        // and the gateway sees the session gone (its tickets end with it). Replied to first, ended shortly after.
        "logout" => {
            let (c, path) = (c.clone(), path.clone());
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                let _ = c.call_method(Some("org.freedesktop.login1"), path.as_str(), Some("org.freedesktop.login1.Session"), "Terminate", &());
                std::process::exit(0);
            });
            Ok(json!({ "loggingOut": true }))
        }
        "lock.setMinutes" => {
            let m = req["minutes"].as_u64().ok_or("minutes")?;
            if !(1..=30).contains(&m) {
                return Err("lock delay must be 1–30 minutes".into());
            }
            st.lock().unwrap().lock_minutes = m;
            let _ = run("pkill", &["-HUP", "-u", &unsafe { libc::getuid() }.to_string(), "swayidle"]);
            let dir = std::env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| format!("{}/.config", std::env::var("HOME").unwrap_or_default()));
            let _ = std::fs::create_dir_all(format!("{dir}/agentos"));
            let _ = std::fs::write(format!("{dir}/agentos/lock-minutes"), m.to_string());
            restart_idle(m);
            Ok(json!({ "lockMinutes": m }))
        }
        "audio.get" => Ok(audio()),
        "audio.setVolume" => {
            let v = req["percent"].as_u64().ok_or("percent")?.min(100);
            run("wpctl", &["set-volume", "@DEFAULT_AUDIO_SINK@", &format!("{}%", v)])?;
            Ok(audio())
        }
        "audio.setMute" => {
            run("wpctl", &["set-mute", "@DEFAULT_AUDIO_SINK@", if req["muted"].as_bool().unwrap_or(false) { "1" } else { "0" }])?;
            Ok(audio())
        }
        "display.list" => outputs(),
        "display.set" => {
            let all = outputs()?;
            let name = req["name"].as_str().ok_or("name")?;
            let cur = all.as_array().and_then(|a| a.iter().find(|o| o["name"] == name)).ok_or("unknown output")?.clone();
            let ok_mode = cur["modes"].as_array().map(|m| m.iter().any(|x| x["width"] == req["width"] && x["height"] == req["height"])).unwrap_or(false);
            if !ok_mode {
                return Err("mode is not offered by this output".into());
            }
            let prev = json!({ "name": name, "width": cur["current"]["width"], "height": cur["current"]["height"], "scale": cur["scale"] });
            apply_output(req)?;
            st.lock().unwrap().revert = Some((Instant::now() + Duration::from_secs(15), prev));
            Ok(json!({ "applied": true, "revertInSeconds": 15 }))
        }
        "display.keep" => {
            st.lock().unwrap().revert = None;
            Ok(json!({ "kept": true }))
        }
        "brightness.set" => {
            let dev = backlight().ok_or("no backlight device: brightness is unavailable")?;
            let pct = req["percent"].as_u64().ok_or("percent")?;
            if !(5..=100).contains(&pct) {
                return Err("brightness must be 5–100%".into());
            }
            let max: u32 = std::fs::read_to_string(format!("/sys/class/backlight/{dev}/max_brightness")).ok().and_then(|s| s.trim().parse().ok()).ok_or("max_brightness")?;
            let val = (max as u64 * pct / 100) as u32;
            c.call_method(Some("org.freedesktop.login1"), path.as_str(), Some("org.freedesktop.login1.Session"), "SetBrightness", &("backlight", dev.as_str(), val)).map_err(|e| e.to_string())?;
            Ok(json!({ "percent": pct }))
        }
        _ => Err("unknown operation".into()),
    }
}

fn restart_idle(minutes: u64) {
    let _ = Command::new("pkill").args(["-x", "swayidle"]).status();
    let _ = Command::new("swayidle").args(["-w", "timeout", &(minutes * 60).to_string(), "loginctl lock-session", "before-sleep", "loginctl lock-session"]).spawn();
}

fn serve(c: Connection, path: OwnedObjectPath, st: Arc<Mutex<State>>) {
    let rt = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| format!("/run/user/{}", unsafe { libc::getuid() }));
    let sock = format!("{rt}/agentos-session.sock");
    let _ = std::fs::remove_file(&sock);
    let l = UnixListener::bind(&sock).expect("bind session socket");
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600));
    for s in l.incoming().flatten() {
        let (c, path, st) = (c.clone(), path.clone(), st.clone());
        std::thread::spawn(move || conn(s, &c, &path, &st));
    }
}

fn conn(mut s: UnixStream, c: &Connection, path: &OwnedObjectPath, st: &Arc<Mutex<State>>) {
    let me = unsafe { libc::getuid() };
    match agentos_protocol::peer::peer_cred(&s) {
        Ok(p) if p.uid == me => {}
        _ => return,
    }
    loop {
        let mut h = [0u8; 4];
        if s.read_exact(&mut h).is_err() {
            return;
        }
        let n = u32::from_be_bytes(h) as usize;
        if n > 64 * 1024 {
            return;
        }
        let mut b = vec![0u8; n];
        if s.read_exact(&mut b).is_err() {
            return;
        }
        let req: Value = serde_json::from_slice(&b).unwrap_or(Value::Null);
        let out = match handle(c, path, st, &req) {
            Ok(v) => json!({ "ok": true, "data": v }),
            Err(e) => json!({ "ok": false, "error": { "code": "HARDWARE_UNSUPPORTED", "message": e } }),
        };
        let body = serde_json::to_vec(&out).unwrap_or_default();
        let mut f = (body.len() as u32).to_be_bytes().to_vec();
        f.extend_from_slice(&body);
        if s.write_all(&f).is_err() {
            return;
        }
    }
}

/// Bounded Shell supervision: restart after a crash, at most 5 times in 60 s, then end the session.
fn supervise_shell(c: Connection, path: OwnedObjectPath) {
    let shell = std::env::var("AGENTOS_SHELL").unwrap_or_else(|_| "agentos-shell".into());
    let mut starts: Vec<Instant> = vec![];
    loop {
        starts.retain(|t| t.elapsed() < Duration::from_secs(60));
        if starts.len() >= 5 {
            terminate(&c, &path);
        }
        starts.push(Instant::now());
        let status = Command::new(&shell).status();
        match status {
            Ok(s) if s.success() => {
                // A clean Shell exit is the user's logout.
                let _ = c.call_method(Some("org.freedesktop.login1"), path.as_str(), Some("org.freedesktop.login1.Session"), "Terminate", &());
                std::process::exit(0);
            }
            _ => std::thread::sleep(Duration::from_millis(300)),
        }
    }
}

fn main() {
    let c = Connection::system().expect("system bus");
    let path = session_path(&c);
    let dir = std::env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| format!("{}/.config", std::env::var("HOME").unwrap_or_default()));
    let minutes = std::fs::read_to_string(format!("{dir}/agentos/lock-minutes")).ok().and_then(|s| s.trim().parse::<u64>().ok()).filter(|m| (1..=30).contains(m)).unwrap_or(5);
    set_locked_hint(&c, &path, false);
    let st = Arc::new(Mutex::new(State { locked: false, lock_child: None, revert: None, lock_minutes: minutes }));
    restart_idle(minutes);
    listen_signals(path.clone(), st.clone());
    {
        let (c, p, s) = (c.clone(), path.clone(), st.clone());
        std::thread::spawn(move || watch_lock(c, p, s));
    }
    {
        let (c, p, s) = (c.clone(), path.clone(), st.clone());
        std::thread::spawn(move || serve(c, p, s));
    }
    if std::env::args().any(|a| a == "--no-shell") {
        loop {
            std::thread::sleep(Duration::from_secs(3600));
        }
    }
    supervise_shell(c, path);
}
