//! Read-only rtnetlink dumps (spec §15): links, addresses and a route summary of the caller's network namespace.
//! Requests are built here from constants; no caller-supplied netlink message is ever sent.
use serde_json::{json, Value};
use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd};

const NETLINK_ROUTE: i32 = 0;
const RTM_GETLINK: u16 = 18;
const RTM_GETADDR: u16 = 22;
const RTM_GETROUTE: u16 = 26;
const NLM_F_REQUEST: u16 = 1;
const NLM_F_DUMP: u16 = 0x300;
const NLMSG_DONE: u16 = 3;
const NLMSG_ERROR: u16 = 2;

fn align(n: usize) -> usize {
    (n + 3) & !3
}

fn dump(msg_type: u16, family: u8, hdr_len: usize) -> Result<Vec<(u16, Vec<u8>)>, String> {
    let fd = unsafe { libc::socket(libc::AF_NETLINK, libc::SOCK_RAW | libc::SOCK_CLOEXEC, NETLINK_ROUTE) };
    if fd < 0 {
        return Err(format!("netlink socket: {}", std::io::Error::last_os_error()));
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let tv = libc::timeval { tv_sec: 2, tv_usec: 0 };
    unsafe {
        libc::setsockopt(
            fd.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_RCVTIMEO,
            &tv as *const _ as *const libc::c_void,
            std::mem::size_of::<libc::timeval>() as u32,
        )
    };
    let total = 16 + align(hdr_len);
    let mut req = vec![0u8; total];
    req[0..4].copy_from_slice(&(total as u32).to_ne_bytes());
    req[4..6].copy_from_slice(&msg_type.to_ne_bytes());
    req[6..8].copy_from_slice(&(NLM_F_REQUEST | NLM_F_DUMP).to_ne_bytes());
    req[8..12].copy_from_slice(&1u32.to_ne_bytes());
    req[16] = family;
    if unsafe { libc::send(fd.as_raw_fd(), req.as_ptr() as *const libc::c_void, req.len(), 0) } < 0 {
        return Err(format!("netlink send: {}", std::io::Error::last_os_error()));
    }
    let mut out = Vec::new();
    let mut buf = vec![0u8; 65536];
    loop {
        let n = unsafe { libc::recv(fd.as_raw_fd(), buf.as_mut_ptr() as *mut libc::c_void, buf.len(), 0) };
        if n <= 0 {
            return Err(format!("netlink recv: {}", std::io::Error::last_os_error()));
        }
        let n = n as usize;
        let mut off = 0;
        while off + 16 <= n {
            let len = u32::from_ne_bytes(buf[off..off + 4].try_into().unwrap()) as usize;
            let ty = u16::from_ne_bytes(buf[off + 4..off + 6].try_into().unwrap());
            if len < 16 || off + len > n {
                return Ok(out);
            }
            if ty == NLMSG_DONE {
                return Ok(out);
            }
            if ty == NLMSG_ERROR {
                return Err("netlink error reply".into());
            }
            out.push((ty, buf[off + 16..off + len].to_vec()));
            off += align(len);
            if out.len() > 4096 {
                return Ok(out);
            }
        }
    }
}

fn attrs(b: &[u8]) -> Vec<(u16, &[u8])> {
    let mut v = Vec::new();
    let mut off = 0;
    while off + 4 <= b.len() {
        let len = u16::from_ne_bytes([b[off], b[off + 1]]) as usize;
        let ty = u16::from_ne_bytes([b[off + 2], b[off + 3]]) & 0x3fff;
        if len < 4 || off + len > b.len() {
            break;
        }
        v.push((ty, &b[off + 4..off + len]));
        off += align(len);
    }
    v
}

fn ip(family: u8, b: &[u8]) -> String {
    if family == libc::AF_INET as u8 && b.len() >= 4 {
        format!("{}.{}.{}.{}", b[0], b[1], b[2], b[3])
    } else if b.len() >= 16 {
        let segs: Vec<String> = (0..8).map(|i| format!("{:x}", u16::from_be_bytes([b[2 * i], b[2 * i + 1]]))).collect();
        segs.join(":")
    } else {
        String::new()
    }
}

pub fn snapshot() -> Result<Value, String> {
    let mut links = Vec::new();
    for (_, m) in dump(RTM_GETLINK, 0, 16)? {
        if m.len() < 16 {
            continue;
        }
        let index = i32::from_ne_bytes(m[4..8].try_into().unwrap());
        let flags = u32::from_ne_bytes(m[8..12].try_into().unwrap());
        let mut name = String::new();
        let mut mtu = 0u32;
        let mut oper = 0u8;
        for (t, d) in attrs(&m[16..]) {
            match t {
                3 => name = String::from_utf8_lossy(d.split(|c| *c == 0).next().unwrap_or(&[])).to_string(),
                4 if d.len() >= 4 => mtu = u32::from_ne_bytes(d[0..4].try_into().unwrap()),
                16 if !d.is_empty() => oper = d[0],
                _ => {}
            }
        }
        links.push(json!({"ifindex": index, "name": name, "up": flags & 1 != 0, "mtu": mtu, "operState": oper}));
    }
    let mut addrs = Vec::new();
    for (_, m) in dump(RTM_GETADDR, 0, 8)? {
        if m.len() < 8 {
            continue;
        }
        let family = m[0];
        let plen = m[1];
        let index = u32::from_ne_bytes(m[4..8].try_into().unwrap());
        for (t, d) in attrs(&m[8..]) {
            if t == 1 {
                addrs.push(
                    json!({"ifindex": index, "family": if family == libc::AF_INET as u8 { "inet" } else { "inet6" }, "address": ip(family, d), "prefix": plen}),
                );
            }
        }
    }
    let mut routes = Vec::new();
    for (_, m) in dump(RTM_GETROUTE, libc::AF_INET as u8, 12)? {
        if m.len() < 12 {
            continue;
        }
        let dlen = m[1];
        let table = m[4];
        if table != 254 {
            continue;
        }
        let (mut dst, mut gw, mut oif) = (String::from("default"), String::new(), 0u32);
        for (t, d) in attrs(&m[12..]) {
            match t {
                1 => dst = format!("{}/{}", ip(libc::AF_INET as u8, d), dlen),
                5 => gw = ip(libc::AF_INET as u8, d),
                4 if d.len() >= 4 => oif = u32::from_ne_bytes(d[0..4].try_into().unwrap()),
                _ => {}
            }
        }
        routes.push(json!({"dst": dst, "gateway": gw, "oif": oif}));
        if routes.len() >= 64 {
            break;
        }
    }
    Ok(json!({"links": links, "addresses": addrs, "routes": routes}))
}
