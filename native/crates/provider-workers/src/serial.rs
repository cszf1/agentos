//! Serial worker (spec §16): owns the registered device session; apps never get the FD. Protocol profile
//! telemetry-echo-v1 at 115200 8N1, one frame per dispatch, frame ≤256 B, response ≤4 KiB, 2 s total, no retry.
//! Frame: ">{reqId8}:{CMD}:{arg}\n"; response "<{reqId8}:OK:{data}\n" or "<{reqId8}:ERR:{code}\n".
use serde_json::{json, Value};
use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::{die, has_fault, Res, WErr};
use agentos_protocol::worker::WorkerRequest;

const IDLE_CLOSE: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct State {
    session: Option<Session>,
    samples: Vec<Value>,
}

struct Session {
    id: String,
    fd: OwnedFd,
    identity: Value,
    last_used: Instant,
    opened_at_ms: u64,
}

pub fn start_idle_reaper(st: Arc<Mutex<State>>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        let mut g = st.lock().unwrap();
        if g.session.as_ref().map(|s| s.last_used.elapsed() > IDLE_CLOSE).unwrap_or(false) {
            g.session = None;
        }
    });
}

/// Device identity: real device numbers and inode of the node, plus the connection generation (udev properties for
/// hardware; the fixture's generation file for PTYs). A path name alone is never the identity.
fn identity(t: &Value) -> Result<Value, WErr> {
    let path = t["path"].as_str().ok_or_else(|| WErr::none("RESOURCE_NOT_BOUND", "target.path missing"))?;
    let real = std::fs::canonicalize(path).map_err(|_| WErr::none("RESOURCE_GONE", "device is not connected"))?;
    let md = std::fs::metadata(&real).map_err(|_| WErr::none("RESOURCE_GONE", "device is not connected"))?;
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    if !md.file_type().is_char_device() {
        return Err(WErr::none("UNSUPPORTED_FILE_TYPE", "registered serial path is not a character device"));
    }
    let rdev = md.rdev();
    let (maj, min) = (libc::major(rdev), libc::minor(rdev));
    let kind = t["kind"].as_str().unwrap_or("");
    let generation = if kind == "pty-fixture" {
        std::fs::read_to_string(format!("{path}.gen")).map(|s| s.trim().to_string()).unwrap_or_default()
    } else {
        udev_props(&real).unwrap_or(Value::Null).to_string()
    };
    if kind == "udev" {
        if let Some(m) = t["udevMatch"].as_object() {
            let props = udev_props(&real).unwrap_or(Value::Null);
            for (k, v) in m {
                if props.get(k) != Some(v) {
                    return Err(WErr::none("RESOURCE_GENERATION_STALE", format!("udev property {k} does not match the registration")));
                }
            }
        }
    }
    Ok(json!({"kind": kind, "major": maj, "minor": min, "ino": md.ino(), "connection": generation, "profile": t["profile"]}))
}

fn udev_props(real: &std::path::Path) -> Option<Value> {
    let name = real.file_name()?.to_str()?.to_string();
    let dev = udev::Device::from_subsystem_sysname("tty".into(), name).ok()?;
    let mut m = serde_json::Map::new();
    for k in ["ID_VENDOR_ID", "ID_MODEL_ID", "ID_SERIAL_SHORT", "ID_PATH", "DEVNAME"] {
        if let Some(v) = dev.property_value(k) {
            m.insert(k.into(), json!(v.to_string_lossy()));
        }
    }
    Some(Value::Object(m))
}

pub fn list_devices() -> Value {
    let mut out = Vec::new();
    if let Ok(mut e) = udev::Enumerator::new() {
        let _ = e.match_subsystem("tty");
        if let Ok(devs) = e.scan_devices() {
            for d in devs {
                let props = |k: &str| d.property_value(k).map(|v| v.to_string_lossy().to_string());
                if props("ID_BUS").is_none() && props("ID_PATH").is_none() {
                    continue; // virtual consoles and ptys carry no hardware identity
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

fn open_port(path: &str) -> Result<OwnedFd, WErr> {
    let c = std::ffi::CString::new(path).unwrap();
    let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDWR | libc::O_NOCTTY | libc::O_NONBLOCK | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(WErr::unknown("DEVICE_DISCONNECTED", format!("open: {}", std::io::Error::last_os_error())));
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let mut tio: libc::termios = unsafe { std::mem::zeroed() };
    unsafe {
        if libc::tcgetattr(fd.as_raw_fd(), &mut tio) != 0 {
            return Err(WErr::unknown("DEVICE_DISCONNECTED", "tcgetattr failed"));
        }
        libc::cfmakeraw(&mut tio);
        libc::cfsetispeed(&mut tio, libc::B115200);
        libc::cfsetospeed(&mut tio, libc::B115200);
        tio.c_cflag &= !(libc::CSTOPB | libc::PARENB | libc::CSIZE);
        tio.c_cflag |= libc::CS8 | libc::CLOCAL | libc::CREAD;
        if libc::tcsetattr(fd.as_raw_fd(), libc::TCSANOW, &tio) != 0 {
            return Err(WErr::unknown("DEVICE_DISCONNECTED", "tcsetattr failed"));
        }
        libc::tcflush(fd.as_raw_fd(), libc::TCIFLUSH);
    }
    Ok(fd)
}

fn frame(req_id: &str, p: &Value) -> Result<String, WErr> {
    let f = match p["command"].as_str() {
        Some("SAMPLE") => format!(">{req_id}:SAMPLE:{}\n", p["count"].as_u64().unwrap_or(1)),
        Some("ECHO") => format!(">{req_id}:ECHO:{}\n", p["text"].as_str().unwrap_or("")),
        _ => return Err(WErr::none("INVALID_SYSTEM_PLAN", "unknown command")),
    };
    if f.len() > agentos_protocol::params::SERIAL_FRAME_MAX {
        return Err(WErr::none("LIMIT_EXCEEDED", "frame exceeds 256 bytes"));
    }
    Ok(f)
}

pub fn handle(req: &WorkerRequest, st: &Arc<Mutex<State>>) -> Res {
    let t = &req.target;
    match req.op.as_str() {
        "observe" => {
            let id = identity(t)?;
            let g = st.lock().unwrap();
            Ok(
                json!({"identity": id, "version": agentos_protocol::domain_hash("agentos.serial-identity.v1", &id).unwrap_or_default(), "details": {"session": g.session.as_ref().map(|s| json!({"sessionId": s.id, "openedAtMs": s.opened_at_ms}))}}),
            )
        }
        "read" => match req.params["capabilityId"].as_str() {
            // Status never opens the port: udev metadata plus the cached session state only (spec §16).
            Some("serial.status") => {
                let id = identity(t).ok();
                let g = st.lock().unwrap();
                Ok(
                    json!({"connected": id.is_some(), "identity": id, "session": g.session.as_ref().map(|s| json!({"sessionId": s.id, "openedAtMs": s.opened_at_ms, "idleMs": s.last_used.elapsed().as_millis() as u64})), "samples": g.samples}),
                )
            }
            Some("device.list") => Ok(json!({"devices": list_devices()})),
            _ => Err(WErr::none("CAPABILITY_VERSION_UNSUPPORTED", "unsupported serial read")),
        },
        "exchange" => {
            let path = t["path"].as_str().unwrap_or("").to_string();
            let id = identity(t)?;
            let req_id = req.params["reqId"].as_str().unwrap_or("");
            if req_id.len() != 8 || !req_id.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(WErr::none("INVALID_SYSTEM_PLAN", "reqId"));
            }
            let f = frame(req_id, &req.params["params"])?;
            let mut g = st.lock().unwrap();
            // A different device identity ends the old session (reconnect = new generation, spec §16).
            if g.session.as_ref().map(|s| s.identity != id).unwrap_or(false) {
                g.session = None;
            }
            if g.session.is_none() {
                let fd = open_port(&path)?;
                g.session = Some(Session {
                    id: format!("ss_{}", agentos_protocol::random_hex(6)),
                    fd,
                    identity: id.clone(),
                    last_used: Instant::now(),
                    opened_at_ms: agentos_protocol::now_ms(),
                });
            }
            let mut sess = g.session.take().unwrap();
            let fd = sess.fd.as_raw_fd();
            let bytes = f.as_bytes();
            let deadline = Instant::now() + Duration::from_millis(2000);
            let to_write = if has_fault(req, "serial.partial_write") { &bytes[..bytes.len() / 2] } else { bytes };
            let mut written = 0usize;
            while written < to_write.len() {
                let n = unsafe { libc::write(fd, to_write[written..].as_ptr() as *const libc::c_void, to_write.len() - written) };
                if n < 0 {
                    let e = std::io::Error::last_os_error();
                    if e.raw_os_error() == Some(libc::EAGAIN) && Instant::now() < deadline {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    return Err(WErr::unknown("SERIAL_DELIVERY_UNKNOWN", format!("write failed after {written} bytes: {e}")));
                }
                written += n as usize;
            }
            if has_fault(req, "serial.partial_write") {
                die("serial.partial_write");
            }
            unsafe { libc::tcdrain(fd) };
            if has_fault(req, "serial.die_after_send") {
                die("serial.die_after_send");
            }
            let prefix = format!("<{req_id}:");
            let mut buf: Vec<u8> = Vec::new();
            loop {
                if Instant::now() >= deadline {
                    sess.last_used = Instant::now();
                    g.session = Some(sess);
                    return Err(WErr::unknown("SERIAL_DELIVERY_UNKNOWN", "no matching response within 2 s; the frame may have been delivered"));
                }
                let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
                let left = deadline.saturating_duration_since(Instant::now()).as_millis() as i32;
                let r = unsafe { libc::poll(&mut pfd, 1, left.max(1)) };
                if r > 0 && pfd.revents & (libc::POLLHUP | libc::POLLERR) != 0 && pfd.revents & libc::POLLIN == 0 {
                    return Err(WErr::unknown("SERIAL_DELIVERY_UNKNOWN", "device hung up after the frame was sent"));
                }
                if r <= 0 {
                    continue;
                }
                let mut tmp = [0u8; 512];
                let n = unsafe { libc::read(fd, tmp.as_mut_ptr() as *mut libc::c_void, tmp.len()) };
                if n <= 0 {
                    continue;
                }
                buf.extend_from_slice(&tmp[..n as usize]);
                if buf.len() > agentos_protocol::params::SERIAL_RESPONSE_MAX {
                    return Err(WErr::unknown("SERIAL_DELIVERY_UNKNOWN", "response exceeds 4 KiB"));
                }
                while let Some(i) = buf.iter().position(|b| *b == b'\n') {
                    let line = String::from_utf8_lossy(&buf[..i]).to_string();
                    buf.drain(..=i);
                    if let Some(rest) = line.strip_prefix(&prefix) {
                        sess.last_used = Instant::now();
                        let session_id = sess.id.clone();
                        let (status, data) = rest.split_once(':').unwrap_or((rest, ""));
                        if status != "OK" {
                            g.session = Some(sess);
                            return Err(WErr::none("INVALID_SYSTEM_PLAN", format!("device rejected the request: {data}")));
                        }
                        let fields: Vec<&str> = data.split(',').collect();
                        let resp = json!({"reqId": req_id, "status": status, "data": data, "atMs": agentos_protocol::now_ms()});
                        g.samples.push(resp.clone());
                        if g.samples.len() > 20 {
                            g.samples.remove(0);
                        }
                        g.session = Some(sess);
                        return Ok(json!({"response": resp, "fields": fields, "bytesWritten": written, "sessionId": session_id}));
                    }
                    // A line for another request id (stale) is ignored, never matched to this request.
                }
            }
        }
        _ => Err(WErr::none("INVALID_SYSTEM_PLAN", "unknown serial op")),
    }
}
