//! agentos-serial-sim <dir> <name>: PTY fixture implementing the device side of telemetry-echo-v1 for software
//! protocol tests (spec §16: PTY results are never reported as hardware verification). It publishes the slave as
//! <dir>/<name>, the connection generation in <dir>/<name>.gen, and accepts fault commands on <dir>/<name>.ctl:
//! drop-next | garbage-next | disconnect | reconnect | status.
use std::ffi::CStr;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct Ctl {
    drop_next: bool,
    garbage_next: bool,
    disconnect: bool,
    reconnect: bool,
    requests: u64,
    responses: u64,
    slave_opens: u64,
    last_req: String,
    connected: bool,
    generation: u64,
}

fn open_pty() -> (i32, String) {
    unsafe {
        let m = libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY);
        assert!(m >= 0, "posix_openpt");
        libc::grantpt(m);
        libc::unlockpt(m);
        let name = CStr::from_ptr(libc::ptsname(m)).to_string_lossy().to_string();
        let fl = libc::fcntl(m, libc::F_GETFL);
        libc::fcntl(m, libc::F_SETFL, fl | libc::O_NONBLOCK);
        (m, name)
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = args.get(1).cloned().unwrap_or_else(|| "/run/agentos-serial".into());
    let name = args.get(2).cloned().unwrap_or_else(|| "sim0".into());
    let link = format!("{dir}/{name}");
    let genf = format!("{dir}/{name}.gen");
    let ctlp = format!("{dir}/{name}.ctl");
    let ctl = Arc::new(Mutex::new(Ctl::default()));
    {
        let c = ctl.clone();
        let _ = std::fs::remove_file(&ctlp);
        let l = UnixListener::bind(&ctlp).expect("bind ctl");
        let _ = std::fs::set_permissions(&ctlp, std::fs::Permissions::from_mode(0o666));
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                let mut line = String::new();
                let mut r = BufReader::new(&s);
                if r.read_line(&mut line).is_err() {
                    continue;
                }
                let mut g = c.lock().unwrap();
                let reply = match line.trim() {
                    "drop-next" => { g.drop_next = true; "ok".to_string() }
                    "garbage-next" => { g.garbage_next = true; "ok".to_string() }
                    "disconnect" => { g.disconnect = true; "ok".to_string() }
                    "reconnect" => { g.reconnect = true; "ok".to_string() }
                    "status" => format!("{{\"requests\":{},\"responses\":{},\"slaveOpens\":{},\"lastReq\":\"{}\",\"connected\":{},\"generation\":{}}}", g.requests, g.responses, g.slave_opens, g.last_req, g.connected, g.generation),
                    _ => "unknown".to_string(),
                };
                let mut w = &s;
                let _ = w.write_all(format!("{reply}\n").as_bytes());
            }
        });
    }
    let mut generation: u64 = std::fs::read_to_string(&genf).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
    loop {
        generation += 1;
        let (m, slave) = open_pty();
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&slave, &link).expect("symlink");
        std::fs::write(&genf, format!("{generation}\n")).expect("gen");
        {
            let mut g = ctl.lock().unwrap();
            g.connected = true;
            g.generation = generation;
        }
        // Keep a slave fd open ourselves only to detect hangup transitions is not possible; track POLLHUP instead.
        let mut hup = true;
        let mut buf: Vec<u8> = Vec::new();
        loop {
            {
                let mut g = ctl.lock().unwrap();
                if g.disconnect || g.reconnect {
                    let again = g.reconnect;
                    g.disconnect = false;
                    g.reconnect = false;
                    g.connected = false;
                    drop(g);
                    let _ = std::fs::remove_file(&link);
                    unsafe { libc::close(m) };
                    if !again {
                        // Stay "unplugged" until a reconnect command arrives.
                        loop {
                            std::thread::sleep(Duration::from_millis(100));
                            let mut g = ctl.lock().unwrap();
                            if g.reconnect {
                                g.reconnect = false;
                                break;
                            }
                        }
                    }
                    break;
                }
            }
            let mut pfd = libc::pollfd { fd: m, events: libc::POLLIN, revents: 0 };
            unsafe { libc::poll(&mut pfd, 1, 100) };
            let now_hup = pfd.revents & libc::POLLHUP != 0;
            if hup && !now_hup {
                ctl.lock().unwrap().slave_opens += 1;
            }
            hup = now_hup;
            if pfd.revents & libc::POLLIN == 0 {
                if now_hup {
                    std::thread::sleep(Duration::from_millis(50));
                }
                continue;
            }
            let mut tmp = [0u8; 512];
            let n = unsafe { libc::read(m, tmp.as_mut_ptr() as *mut libc::c_void, tmp.len()) };
            if n <= 0 {
                continue;
            }
            buf.extend_from_slice(&tmp[..n as usize]);
            while let Some(i) = buf.iter().position(|b| *b == b'\n') {
                let line = String::from_utf8_lossy(&buf[..i]).to_string();
                buf.drain(..=i);
                let Some(rest) = line.strip_prefix('>') else { continue };
                let mut parts = rest.splitn(3, ':');
                let (id, cmd, arg) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
                let mut g = ctl.lock().unwrap();
                g.requests += 1;
                g.last_req = id.to_string();
                if g.drop_next {
                    g.drop_next = false;
                    continue;
                }
                let resp = if g.garbage_next {
                    g.garbage_next = false;
                    format!("<deadbeef:OK:stale\n")
                } else {
                    match cmd {
                        "SAMPLE" => {
                            let n: u64 = arg.parse().unwrap_or(1).clamp(1, 8);
                            let vals: Vec<String> = (0..n).map(|k| format!("{}", 200 + (g.requests * 7 + k * 3) % 50)).collect();
                            format!("<{id}:OK:{}\n", vals.join(","))
                        }
                        "ECHO" => format!("<{id}:OK:{arg}\n"),
                        _ => format!("<{id}:ERR:unknown-command\n"),
                    }
                };
                g.responses += 1;
                drop(g);
                unsafe { libc::write(m, resp.as_ptr() as *const libc::c_void, resp.len()) };
            }
        }
    }
}
