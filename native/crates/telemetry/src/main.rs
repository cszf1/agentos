//! agentos-telemetry: loads only the fixed BPF object whose SHA-256 is pinned in the root-owned config, attaches
//! the exec/exit tracepoints, filters by cgroups registered through the trusted registry and streams bounded events
//! with sourceEpoch/sourceSeq, kernel and user-space drop counters and explicit gaps (spec §18).
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::ffi::CString;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use agentos_protocol::frame::{parse_strict, read_frame, write_frame, MAX_CONTROL_FRAME};
use agentos_protocol::peer::peer_cred;

const CONFIG: &str = "/etc/agentos/telemetry.json";
const SOCKET: &str = "/run/agentos-telemetry/telemetry.sock";
const RETAIN: usize = 10_000;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    object_path: String,
    object_sha256: String,
    ring_bytes: u32,
    host_uids: Vec<u32>,
    allowed_cgroup_prefixes: Vec<String>,
    test_mode: bool,
}

#[repr(C)]
struct BpfObject {
    _p: [u8; 0],
}
#[repr(C)]
struct BpfMap {
    _p: [u8; 0],
}
#[repr(C)]
struct BpfProgram {
    _p: [u8; 0],
}
#[repr(C)]
struct BpfLink {
    _p: [u8; 0],
}
#[repr(C)]
struct RingBuffer {
    _p: [u8; 0],
}
type RbCb = extern "C" fn(ctx: *mut libc::c_void, data: *mut libc::c_void, size: libc::size_t) -> libc::c_int;
#[link(name = "bpf")]
extern "C" {
    fn bpf_object__open_file(path: *const libc::c_char, opts: *const libc::c_void) -> *mut BpfObject;
    fn bpf_object__load(obj: *mut BpfObject) -> libc::c_int;
    fn bpf_object__close(obj: *mut BpfObject);
    fn bpf_object__find_map_by_name(obj: *const BpfObject, name: *const libc::c_char) -> *mut BpfMap;
    fn bpf_object__find_program_by_name(obj: *const BpfObject, name: *const libc::c_char) -> *mut BpfProgram;
    fn bpf_map__set_max_entries(map: *mut BpfMap, max: u32) -> libc::c_int;
    fn bpf_map__fd(map: *const BpfMap) -> libc::c_int;
    fn bpf_program__attach(prog: *const BpfProgram) -> *mut BpfLink;
    fn bpf_link__destroy(link: *mut BpfLink) -> libc::c_int;
    fn ring_buffer__new(fd: libc::c_int, cb: RbCb, ctx: *mut libc::c_void, opts: *const libc::c_void) -> *mut RingBuffer;
    fn ring_buffer__poll(rb: *mut RingBuffer, timeout_ms: libc::c_int) -> libc::c_int;
    fn ring_buffer__free(rb: *mut RingBuffer);
    fn bpf_map_update_elem(fd: libc::c_int, key: *const libc::c_void, value: *const libc::c_void, flags: u64) -> libc::c_int;
    fn bpf_map_delete_elem(fd: libc::c_int, key: *const libc::c_void) -> libc::c_int;
    fn bpf_map_lookup_elem(fd: libc::c_int, key: *const libc::c_void, value: *mut libc::c_void) -> libc::c_int;
    fn libbpf_num_possible_cpus() -> libc::c_int;
}

#[repr(C)]
#[derive(Clone, Copy)]
struct RawEvent {
    boot_ns: u64,
    cgroup_id: u64,
    start_time: u64,
    slot: u32,
    pid: u32,
    tgid: u32,
    kind: u32,
    exit_code: i32,
    pad: u32,
}

#[derive(Clone)]
struct Workload {
    key: String,
    kind: String,
    cgroup_path: String,
    cgroup_id: u64,
    slot: u32,
    generation: u64,
}

struct St {
    cfg: Config,
    available: bool,
    reason: String,
    epoch: String,
    probe_instance: u64,
    seq: u64,
    kernel_drops: u64,
    user_drops: u64,
    unattributed: u64,
    events: VecDeque<Value>,
    workloads: HashMap<String, Workload>,
    by_cg: HashMap<u64, String>,
    next_slot: u32,
    gen_counter: u64,
    workloads_fd: i32,
    drops_fd: i32,
    paused_until: Option<std::time::Instant>,
    detach: bool,
    object_sha256: String,
}

type Shared = Arc<(Mutex<St>, Condvar)>;

fn push(st: &mut St, mut ev: Value) {
    st.seq += 1;
    ev["sourceEpoch"] = json!(st.epoch);
    ev["sourceSeq"] = json!(st.seq);
    ev["observedAtMs"] = json!(agentos_protocol::now_ms());
    st.events.push_back(ev);
    while st.events.len() > RETAIN {
        st.events.pop_front();
    }
}

fn gap(st: &mut St, reason: &str, extra: Value) {
    let mut v = json!({"type": "gap", "reason": reason, "kernelDrops": st.kernel_drops, "userDrops": st.user_drops, "unattributed": st.unattributed});
    if let Some(o) = extra.as_object() {
        for (k, x) in o {
            v[k] = x.clone();
        }
    }
    push(st, v);
}

extern "C" fn on_event(ctx: *mut libc::c_void, data: *mut libc::c_void, size: libc::size_t) -> libc::c_int {
    let sh = unsafe { &*(ctx as *const (Mutex<St>, Condvar)) };
    if size < std::mem::size_of::<RawEvent>() {
        return 0;
    }
    let e = unsafe { *(data as *const RawEvent) };
    let mut st = sh.0.lock().unwrap();
    // Attribution only through the current registry; a cgroup id we cannot map is never given an old label.
    let Some(key) = st.by_cg.get(&e.cgroup_id).cloned() else {
        st.unattributed += 1;
        gap(&mut st, "unattributed", json!({"cgroupId": e.cgroup_id}));
        sh.1.notify_all();
        return 0;
    };
    let w = st.workloads.get(&key).cloned().unwrap();
    if w.slot != e.slot {
        st.unattributed += 1;
        gap(&mut st, "slot_mismatch", json!({"workloadKey": key}));
        sh.1.notify_all();
        return 0;
    }
    let ev = json!({
        "type": "event", "kind": if e.kind == 1 { "exec" } else { "exit" }, "workloadKey": w.key, "workloadKind": w.kind,
        "workloadGeneration": w.generation, "cgroupId": e.cgroup_id, "pid": e.pid, "tgid": e.tgid,
        "procStartNs": e.start_time, "bootNs": e.boot_ns, "exitCode": if e.kind == 2 { json!(e.exit_code) } else { Value::Null },
    });
    push(&mut st, ev);
    sh.1.notify_all();
    0
}

fn sha256_file(p: &str) -> Option<String> {
    std::fs::read(p).ok().map(|b| agentos_protocol::sha256_hex(&b))
}

fn load_config() -> Result<Config, String> {
    let md = std::fs::metadata(CONFIG).map_err(|e| format!("config: {e}"))?;
    if md.uid() != 0 || md.mode() & 0o022 != 0 {
        return Err("config must be root-owned and not group/other writable".into());
    }
    serde_json::from_slice(&std::fs::read(CONFIG).map_err(|e| e.to_string())?).map_err(|e| format!("config: {e}"))
}

struct Loaded {
    obj: *mut BpfObject,
    links: Vec<*mut BpfLink>,
    rb: *mut RingBuffer,
}
unsafe impl Send for Loaded {}

fn load_probe(sh: &Shared) -> Result<Loaded, String> {
    let cfg = sh.0.lock().unwrap().cfg.clone();
    let got = sha256_file(&cfg.object_path).ok_or("BPF object missing")?;
    if got != cfg.object_sha256 {
        return Err(format!("BPF object hash {got} does not match the pinned {}", cfg.object_sha256));
    }
    let md = std::fs::metadata(&cfg.object_path).map_err(|e| e.to_string())?;
    if md.uid() != 0 || md.mode() & 0o022 != 0 {
        return Err("BPF object must be root-owned".into());
    }
    if !std::path::Path::new("/sys/kernel/btf/vmlinux").exists() {
        return Err("kernel has no BTF (/sys/kernel/btf/vmlinux); CO-RE probe cannot be relocated".into());
    }
    unsafe {
        let p = CString::new(cfg.object_path.clone()).unwrap();
        let obj = bpf_object__open_file(p.as_ptr(), std::ptr::null());
        if obj.is_null() {
            return Err(format!("open object: {}", std::io::Error::last_os_error()));
        }
        let ev = CString::new("events").unwrap();
        let m = bpf_object__find_map_by_name(obj, ev.as_ptr());
        if m.is_null() || bpf_map__set_max_entries(m, cfg.ring_bytes) != 0 {
            bpf_object__close(obj);
            return Err("ring buffer map not found".into());
        }
        if bpf_object__load(obj) != 0 {
            let e = std::io::Error::last_os_error();
            bpf_object__close(obj);
            return Err(format!("load object: {e}"));
        }
        let mut links = Vec::new();
        for name in ["on_exec", "on_exit"] {
            let n = CString::new(name).unwrap();
            let prog = bpf_object__find_program_by_name(obj, n.as_ptr());
            let l = if prog.is_null() { std::ptr::null_mut() } else { bpf_program__attach(prog) };
            if l.is_null() {
                let e = std::io::Error::last_os_error();
                for l in links {
                    bpf_link__destroy(l);
                }
                bpf_object__close(obj);
                return Err(format!("attach {name}: {e} (tracepoints unavailable on this kernel?)"));
            }
            links.push(l);
        }
        let wn = CString::new("workloads").unwrap();
        let dn = CString::new("drops").unwrap();
        let wfd = bpf_map__fd(bpf_object__find_map_by_name(obj, wn.as_ptr()));
        let dfd = bpf_map__fd(bpf_object__find_map_by_name(obj, dn.as_ptr()));
        let rb = ring_buffer__new(bpf_map__fd(m), on_event, Arc::as_ptr(sh) as *mut libc::c_void, std::ptr::null());
        if rb.is_null() {
            bpf_object__close(obj);
            return Err("ring_buffer__new failed".into());
        }
        let mut st = sh.0.lock().unwrap();
        st.workloads_fd = wfd;
        st.drops_fd = dfd;
        st.probe_instance += 1;
        st.epoch = format!("t_{}_{}", agentos_protocol::boot_id().chars().take(8).collect::<String>(), st.probe_instance);
        st.available = true;
        st.reason = String::new();
        st.kernel_drops = 0;
        // Probe (re)load: every previous mapping is void; re-insert the registry into the new map.
        let ws: Vec<Workload> = st.workloads.values().cloned().collect();
        for w in ws {
            let _ = bpf_map_update_elem(wfd, &w.cgroup_id as *const u64 as *const libc::c_void, &w.slot as *const u32 as *const libc::c_void, 0);
        }
        gap(&mut st, "probe_loaded", json!({}));
        Ok(Loaded { obj, links, rb })
    }
}

fn kernel_drops(st: &St) -> u64 {
    if st.drops_fd <= 0 {
        return 0;
    }
    let n = unsafe { libbpf_num_possible_cpus() }.max(1) as usize;
    let mut vals = vec![0u64; n];
    let k: u32 = 0;
    if unsafe { bpf_map_lookup_elem(st.drops_fd, &k as *const u32 as *const libc::c_void, vals.as_mut_ptr() as *mut libc::c_void) } == 0 {
        vals.iter().sum()
    } else {
        0
    }
}

fn main() {
    for (k, _) in std::env::vars_os() {
        let k = k.to_string_lossy().to_string();
        if k != "NOTIFY_SOCKET" && k != "INVOCATION_ID" {
            std::env::remove_var(&k);
        }
    }
    let cfg = match load_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("agentos-telemetry: {e}");
            std::process::exit(1);
        }
    };
    let st = St {
        object_sha256: cfg.object_sha256.clone(),
        cfg,
        available: false,
        reason: "not loaded".into(),
        epoch: format!("t_{}_0", agentos_protocol::boot_id().chars().take(8).collect::<String>()),
        probe_instance: 0,
        seq: 0,
        kernel_drops: 0,
        user_drops: 0,
        unattributed: 0,
        events: VecDeque::new(),
        workloads: HashMap::new(),
        by_cg: HashMap::new(),
        next_slot: 1,
        gen_counter: 0,
        workloads_fd: -1,
        drops_fd: -1,
        paused_until: None,
        detach: false,
    };
    let sh: Shared = Arc::new((Mutex::new(st), Condvar::new()));
    {
        let sh = sh.clone();
        std::thread::spawn(move || probe_loop(sh));
    }
    {
        let sh = sh.clone();
        std::thread::spawn(move || liveness_loop(sh));
    }
    let _ = std::fs::remove_file(SOCKET);
    let l = UnixListener::bind(SOCKET).unwrap_or_else(|e| {
        eprintln!("bind: {e}");
        std::process::exit(1)
    });
    let _ = std::fs::set_permissions(SOCKET, std::fs::Permissions::from_mode(0o600));
    {
        let owner = sh.0.lock().unwrap().cfg.host_uids.first().copied().unwrap_or(0);
        let c = CString::new(SOCKET).unwrap();
        unsafe { libc::chown(c.as_ptr(), owner, 0) };
    }
    if let Ok(p) = std::env::var("NOTIFY_SOCKET") {
        if let Ok(s) = std::os::unix::net::UnixDatagram::unbound() {
            let _ = s.send_to(b"READY=1", p);
        }
    }
    for s in l.incoming().flatten() {
        let sh = sh.clone();
        std::thread::spawn(move || client(sh, s));
    }
}

fn probe_loop(sh: Shared) {
    loop {
        match load_probe(&sh) {
            Err(e) => {
                let mut st = sh.0.lock().unwrap();
                if st.available || st.reason != e {
                    st.available = false;
                    st.reason = e.clone();
                    gap(&mut st, "telemetry_unavailable", json!({"detail": e}));
                    sh.1.notify_all();
                }
                drop(st);
                std::thread::sleep(Duration::from_secs(10));
            }
            Ok(loaded) => {
                loop {
                    {
                        let mut st = sh.0.lock().unwrap();
                        if st.detach {
                            st.detach = false;
                            st.available = false;
                            st.reason = "probe detached".into();
                            gap(&mut st, "probe_lost", json!({}));
                            sh.1.notify_all();
                            break;
                        }
                        if let Some(t) = st.paused_until {
                            if std::time::Instant::now() < t {
                                drop(st);
                                std::thread::sleep(Duration::from_millis(50));
                                continue;
                            }
                            st.paused_until = None;
                        }
                        let kd = kernel_drops(&st);
                        if kd > st.kernel_drops {
                            st.kernel_drops = kd;
                            gap(&mut st, "kernel_ring_drop", json!({}));
                            sh.1.notify_all();
                        }
                    }
                    let r = unsafe { ring_buffer__poll(loaded.rb, 200) };
                    if r < 0 && r != -libc::EINTR {
                        let mut st = sh.0.lock().unwrap();
                        st.available = false;
                        st.reason = format!("ring poll error {r}");
                        gap(&mut st, "probe_lost", json!({}));
                        break;
                    }
                }
                unsafe {
                    ring_buffer__free(loaded.rb);
                    for l in &loaded.links {
                        bpf_link__destroy(*l);
                    }
                    bpf_object__close(loaded.obj);
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    }
}

/// Registered cgroups must still exist with the same id; deletion or reuse ends the mapping (spec §18.2).
fn liveness_loop(sh: Shared) {
    loop {
        std::thread::sleep(Duration::from_millis(500));
        let mut st = sh.0.lock().unwrap();
        let ws: Vec<Workload> = st.workloads.values().cloned().collect();
        for w in ws {
            let now = std::fs::metadata(&w.cgroup_path).map(|m| m.ino()).ok();
            if now != Some(w.cgroup_id) {
                let fd = st.workloads_fd;
                if fd > 0 {
                    unsafe { bpf_map_delete_elem(fd, &w.cgroup_id as *const u64 as *const libc::c_void) };
                }
                st.workloads.remove(&w.key);
                st.by_cg.remove(&w.cgroup_id);
                let reason = if now.is_some() { "cgroup_reused" } else { "cgroup_removed" };
                gap(&mut st, reason, json!({"workloadKey": w.key, "workloadGeneration": w.generation}));
                sh.1.notify_all();
            }
        }
    }
}

fn status(st: &St) -> Value {
    json!({
        "available": st.available, "reason": st.reason, "sourceEpoch": st.epoch, "lastSeq": st.seq,
        "kernelDrops": st.kernel_drops, "userDrops": st.user_drops, "unattributed": st.unattributed,
        "objectSha256": st.object_sha256, "ringBytes": st.cfg.ring_bytes, "bootId": agentos_protocol::boot_id(),
        "workloads": st.workloads.values().map(|w| json!({"workloadKey": w.key, "kind": w.kind, "cgroupId": w.cgroup_id, "generation": w.generation})).collect::<Vec<_>>(),
        "testMode": st.cfg.test_mode,
    })
}

fn client(sh: Shared, s: UnixStream) {
    let Ok(pc) = peer_cred(&s) else { return };
    {
        let st = sh.0.lock().unwrap();
        if pc.uid != 0 && !st.cfg.host_uids.contains(&pc.uid) {
            return;
        }
    }
    loop {
        let mut r = &s;
        let Ok(body) = read_frame(&mut r, MAX_CONTROL_FRAME) else { return };
        let Ok(req) = parse_strict(&body) else { return };
        let reply = |v: Value| {
            let mut w = &s;
            write_frame(&mut w, v.to_string().as_bytes()).is_ok()
        };
        match req["op"].as_str().unwrap_or("") {
            "status" => {
                let st = sh.0.lock().unwrap();
                if !reply(json!({"ok": true, "result": status(&st)})) {
                    return;
                }
            }
            "register" => {
                let key = req["workloadKey"].as_str().unwrap_or("").to_string();
                let path = req["cgroupPath"].as_str().unwrap_or("").to_string();
                let kind = req["kind"].as_str().unwrap_or("").to_string();
                let mut st = sh.0.lock().unwrap();
                let allowed = st.cfg.allowed_cgroup_prefixes.iter().any(|p| path.starts_with(p.as_str())) && !path.contains("..") && path.starts_with("/sys/fs/cgroup/");
                let res = if key.is_empty() || key.len() > 96 || !allowed {
                    json!({"ok": false, "error": {"code": "BROKER_POLICY_DENIED", "message": "cgroup outside the registered workload scope"}})
                } else if st.workloads.len() >= 200 {
                    json!({"ok": false, "error": {"code": "LIMIT_EXCEEDED", "message": "workload map full"}})
                } else {
                    match std::fs::metadata(&path) {
                        Err(_) => json!({"ok": false, "error": {"code": "RESOURCE_GONE", "message": "cgroup does not exist"}}),
                        Ok(md) => {
                            let cg = md.ino();
                            if let Some(old) = st.workloads.remove(&key) {
                                st.by_cg.remove(&old.cgroup_id);
                                if st.workloads_fd > 0 {
                                    unsafe { bpf_map_delete_elem(st.workloads_fd, &old.cgroup_id as *const u64 as *const libc::c_void) };
                                }
                            }
                            st.gen_counter += 1;
                            let slot = st.next_slot;
                            st.next_slot = st.next_slot.wrapping_add(1).max(1);
                            let w = Workload { key: key.clone(), kind, cgroup_path: path, cgroup_id: cg, slot, generation: st.gen_counter };
                            if st.workloads_fd > 0 {
                                unsafe { bpf_map_update_elem(st.workloads_fd, &cg as *const u64 as *const libc::c_void, &slot as *const u32 as *const libc::c_void, 0) };
                            }
                            st.by_cg.insert(cg, key.clone());
                            st.workloads.insert(key.clone(), w.clone());
                            json!({"ok": true, "result": {"workloadKey": key, "cgroupId": cg, "workloadGeneration": w.generation, "available": st.available}})
                        }
                    }
                };
                drop(st);
                if !reply(res) {
                    return;
                }
            }
            "unregister" => {
                let key = req["workloadKey"].as_str().unwrap_or("");
                let mut st = sh.0.lock().unwrap();
                if let Some(w) = st.workloads.remove(key) {
                    st.by_cg.remove(&w.cgroup_id);
                    if st.workloads_fd > 0 {
                        unsafe { bpf_map_delete_elem(st.workloads_fd, &w.cgroup_id as *const u64 as *const libc::c_void) };
                    }
                }
                drop(st);
                if !reply(json!({"ok": true, "result": {}})) {
                    return;
                }
            }
            "test-pause" | "test-detach" => {
                let mut st = sh.0.lock().unwrap();
                if !st.cfg.test_mode {
                    drop(st);
                    let _ = reply(json!({"ok": false, "error": {"code": "BROKER_POLICY_DENIED", "message": "test controls are disabled"}}));
                    continue;
                }
                if req["op"] == "test-pause" {
                    st.paused_until = Some(std::time::Instant::now() + Duration::from_millis(req["ms"].as_u64().unwrap_or(1000).min(60_000)));
                } else {
                    st.detach = true;
                }
                drop(st);
                let _ = reply(json!({"ok": true, "result": {}}));
            }
            "subscribe" => {
                let mut since = req["sinceSeq"].as_u64().unwrap_or(0);
                let epoch = req["sourceEpoch"].as_str().map(String::from);
                {
                    let mut st = sh.0.lock().unwrap();
                    let oldest = st.events.front().and_then(|e| e["sourceSeq"].as_u64()).unwrap_or(st.seq + 1);
                    // A resume from another epoch or from before the retained window is a gap.
                    if epoch.as_deref().map_or(false, |e| e != st.epoch) || (since > 0 && since + 1 < oldest) {
                        let ev = json!({"type": "gap", "reason": "resume_outside_window", "sourceEpoch": st.epoch, "sourceSeq": st.seq, "kernelDrops": st.kernel_drops, "userDrops": st.user_drops});
                        drop(st);
                        if !reply(ev) {
                            return;
                        }
                        let st = sh.0.lock().unwrap();
                        since = st.seq;
                    } else if since == 0 {
                        since = st.seq;
                        let _ = &mut st;
                    }
                }
                let mut last_status = std::time::Instant::now() - Duration::from_secs(5);
                loop {
                    let (batch, stat) = {
                        let st = sh.0.lock().unwrap();
                        let mut st = sh.1.wait_timeout_while(st, Duration::from_millis(500), |st| st.seq <= since).unwrap().0;
                        // The consumer fell behind the retained window: user-space loss, visible as a gap.
                        let oldest = st.events.front().and_then(|e| e["sourceSeq"].as_u64()).unwrap_or(st.seq + 1);
                        if since + 1 < oldest {
                            st.user_drops += oldest - since - 1;
                            let g = json!({"type": "gap", "reason": "consumer_lag", "sourceEpoch": st.epoch, "sourceSeq": oldest - 1, "kernelDrops": st.kernel_drops, "userDrops": st.user_drops});
                            since = oldest - 1;
                            drop(st);
                            if !reply(g) {
                                return;
                            }
                            continue;
                        }
                        let batch: Vec<Value> = st.events.iter().filter(|e| e["sourceSeq"].as_u64().unwrap_or(0) > since).take(256).cloned().collect();
                        let stat = if last_status.elapsed() > Duration::from_secs(1) { Some(status(&st)) } else { None };
                        (batch, stat)
                    };
                    for e in &batch {
                        since = e["sourceSeq"].as_u64().unwrap_or(since);
                        if !reply(e.clone()) {
                            let mut st = sh.0.lock().unwrap();
                            st.user_drops += 1;
                            return;
                        }
                    }
                    if let Some(s) = stat {
                        last_status = std::time::Instant::now();
                        if !reply(json!({"type": "status", "status": s})) {
                            return;
                        }
                    }
                }
            }
            _ => {
                if !reply(json!({"ok": false, "error": {"code": "CAPABILITY_VERSION_UNSUPPORTED", "message": "unknown op"}})) {
                    return;
                }
            }
        }
    }
}
