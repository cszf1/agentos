//! agentos-session-gateway (spec §9): the small trusted local proxy between native clients and workspace Hosts.
//! - Clients connect to /run/agentos/gateway.sock; identity = SO_PEERCRED + logind session facts, never JSON claims.
//! - Hosts connect to /run/agentos/gateway/host.sock (root-owned directory, so a Host knows it reached root);
//!   the gateway maps the Host's peer UID to its registered workspace through machined.
//! - Only registered route IDs are forwarded (docs/contracts/forward-routes.json); no URL/method/header/principal.
//! - Membership, session state and epochs are checked before forwarding; the Host re-checks at commit.
use agentos_machine::server::Client as MClient;
use agentos_protocol::peer::peer_cred;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub const MAX_FRAME: usize = 4 * 1024 * 1024;
pub const MAX_INFLIGHT: usize = 32;
pub const MAX_PENDING_SEND: usize = 8 * 1024 * 1024;
pub const SESSION_MAX: Duration = Duration::from_secs(12 * 3600);
pub const RPC_WAIT: Duration = Duration::from_secs(30);
pub const MACHINE_SCOPE: &str = "00000000-0000-0000-0000-000000000000";
pub const ROUTES_JSON: &str = include_str!("../../../../docs/contracts/forward-routes.json");

pub fn read_frame(r: &mut impl Read) -> std::io::Result<Vec<u8>> {
    let mut h = [0u8; 4];
    r.read_exact(&mut h)?;
    let n = u32::from_be_bytes(h) as usize;
    if n > MAX_FRAME {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame exceeds 4 MiB"));
    }
    let mut b = vec![0u8; n];
    r.read_exact(&mut b)?;
    Ok(b)
}

/// Client connections per peer UID and in total (spec §27.1, V1-O07): beyond these a new connection is closed at once.
pub const MAX_CONN_PER_UID: usize = 32;
pub const MAX_CONN_TOTAL: usize = 256;
/// Once the first byte of a frame arrived, the rest must arrive within this time (slow-client bound). An idle
/// connection between frames (event subscriptions) is not limited.
pub const FRAME_COMPLETE: Duration = Duration::from_secs(30);

static CONNS: std::sync::Mutex<Option<HashMap<u32, usize>>> = std::sync::Mutex::new(None);

pub struct ConnSlot(u32);

impl ConnSlot {
    pub fn take(uid: u32) -> Option<ConnSlot> {
        let mut g = CONNS.lock().unwrap();
        let m = g.get_or_insert_with(HashMap::new);
        let total: usize = m.values().sum();
        let mine = m.get(&uid).copied().unwrap_or(0);
        if mine >= MAX_CONN_PER_UID || total >= MAX_CONN_TOTAL {
            return None;
        }
        m.insert(uid, mine + 1);
        Some(ConnSlot(uid))
    }
}

impl Drop for ConnSlot {
    fn drop(&mut self) {
        let mut g = CONNS.lock().unwrap();
        if let Some(m) = g.as_mut() {
            if let Some(n) = m.get_mut(&self.0) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    m.remove(&self.0);
                }
            }
        }
    }
}

/// read_frame for client sockets: unlimited wait for the first byte, then FRAME_COMPLETE for the rest.
pub fn read_client_frame(s: &mut UnixStream) -> std::io::Result<Vec<u8>> {
    let mut first = [0u8; 1];
    s.set_read_timeout(None)?;
    s.read_exact(&mut first)?;
    s.set_read_timeout(Some(FRAME_COMPLETE))?;
    let mut rest = [0u8; 3];
    s.read_exact(&mut rest)?;
    let n = u32::from_be_bytes([first[0], rest[0], rest[1], rest[2]]) as usize;
    if n > MAX_FRAME {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame exceeds 4 MiB"));
    }
    let mut b = vec![0u8; n];
    s.read_exact(&mut b)?;
    s.set_read_timeout(None)?;
    Ok(b)
}

pub fn frame(body: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(body.len() + 4);
    v.extend_from_slice(&(body.len() as u32).to_be_bytes());
    v.extend_from_slice(body);
    v
}

fn err(code: &str, msg: &str) -> Value {
    json!({ "code": code, "message": msg })
}

#[derive(Clone)]
pub struct Route {
    pub method: String,
    pub path: String,
    pub write: bool,
}

pub fn routes() -> HashMap<String, Route> {
    let v: Value = serde_json::from_str(ROUTES_JSON).expect("forward routes");
    v.as_object()
        .unwrap()
        .iter()
        .map(|(k, r)| (k.clone(), Route { method: r["method"].as_str().unwrap().into(), path: r["path"].as_str().unwrap().into(), write: r["write"].as_bool().unwrap() }))
        .collect()
}

pub fn fill_path(r: &Route, params: &Map<String, Value>) -> Result<String, String> {
    let mut used = HashSet::new();
    let mut out = String::new();
    for seg in r.path.split('/') {
        if seg.is_empty() {
            continue;
        }
        out.push('/');
        if let Some(name) = seg.strip_prefix(':') {
            let v = params.get(name).and_then(|v| v.as_str()).ok_or(format!("path param {name} missing"))?;
            if v.is_empty() || v.len() > 128 || !v.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-.".contains(&c)) || v == "." || v == ".." {
                return Err(format!("path param {name} is invalid"));
            }
            used.insert(name.to_string());
            out.push_str(v);
        } else {
            out.push_str(seg);
        }
    }
    for k in params.keys() {
        if !used.contains(k) {
            return Err(format!("unknown path param {k}"));
        }
    }
    Ok(out)
}

pub struct Session {
    pub session_id: String,
    pub epoch: i64,
    pub user_id: String,
    pub login_uid: u32,
    pub admin: bool,
    pub logind_path: String,
    pub bound_at: Instant,
    pub boot_id: String,
}

/// Per-Host connection: a writer and the table of requests waiting for a response.
pub struct HostLink {
    pub workspace_id: String,
    pub store_uuid: String,
    pub client_epoch: Mutex<i64>,
    pub tx: mpsc::SyncSender<Vec<u8>>,
    pub pending: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
}

pub struct Subscriber {
    pub conn_id: u64,
    pub user_id: String,
    pub tx: ConnTx,
}

/// The one way bytes reach a client connection: replies and fanned-out events both count against the same pending
/// budget the writer drains. (Events used to go straight into the channel; the writer still subtracted their size,
/// the u64 budget wrapped, and from the first delivered event on every reply on that connection was silently
/// dropped as "over budget" — the Shell's requests then sat in flight forever, m13 D08/M06.)
#[derive(Clone)]
pub struct ConnTx {
    pub tx: mpsc::SyncSender<Vec<u8>>,
    pub pending: Arc<AtomicU64>,
}

impl ConnTx {
    pub fn send_buf(&self, buf: Vec<u8>) -> bool {
        let n = buf.len() as u64;
        let mut cur = self.pending.load(Ordering::SeqCst);
        loop {
            if cur + n > MAX_PENDING_SEND as u64 {
                return false;
            }
            match self.pending.compare_exchange(cur, cur + n, Ordering::SeqCst, Ordering::SeqCst) {
                Ok(_) => break,
                Err(v) => cur = v,
            }
        }
        if self.tx.try_send(buf).is_ok() {
            true
        } else {
            self.pending.fetch_sub(n, Ordering::SeqCst);
            false
        }
    }
}

pub struct Gw {
    pub machine_sock: String,
    pub routes: HashMap<String, Route>,
    pub hosts: Mutex<HashMap<String, Arc<HostLink>>>,
    pub host_cv: Condvar,
    pub host_wait: Mutex<()>,
    pub subs: Mutex<HashMap<String, Vec<Subscriber>>>,
    pub sessions: Mutex<HashMap<u64, Session>>,
    pub next: AtomicU64,
    pub pam_service: String,
    pub epoch_seed: AtomicU64,
    /// Epoch per logind session object (spec §9.1, I10): every connection bound from the same unlocked logind
    /// session shares it, so a Shell reconnect keeps open plans; a lock, VT switch-away, close or expiry observed
    /// by the watcher (or by any request) retires it, so every plan, ticket and request of the old epoch is stale.
    pub lsess: Mutex<HashMap<String, LEpoch>>,
    /// Last membership machined confirmed per (userId, workspaceId): (members.check, workspaces.row). Used only while
    /// machined is unreachable, within MACHINE_READ_GRACE / MACHINE_WRITE_GRACE of the last successful contact
    /// (spec §13.2, V1-S08). Cleared by every revocation/disable/control-epoch message.
    pub mcache: Mutex<HashMap<(String, String), (Value, Value)>>,
    /// Last successful machined call and the start of the current outage (None while reachable).
    pub machine_ok: Mutex<Option<Instant>>,
    pub machine_down: Mutex<Option<Instant>>,
}

/// While machined is unreachable: business writes on a cached membership for at most 30 s after the last successful
/// contact (the gateway pulls revocations every 250 ms, so a revocation machined committed is normally applied long
/// before), reads for at most 10 minutes. After that the entry closes: membership cannot be confirmed.
pub const MACHINE_WRITE_GRACE: Duration = Duration::from_secs(30);
pub const MACHINE_READ_GRACE: Duration = Duration::from_secs(600);

pub fn machine_unreachable(e: &Value) -> bool {
    e["code"] == "STORE_UNAVAILABLE" && e["message"].as_str().map(|m| m.starts_with("machine service unreachable")).unwrap_or(false)
}

#[derive(Clone, Copy, Debug)]
pub struct LEpoch {
    pub epoch: i64,
    pub retired: bool,
}

impl Gw {
    pub fn new(machine_sock: &str) -> Arc<Gw> {
        Arc::new(Gw {
            machine_sock: machine_sock.into(),
            routes: routes(),
            hosts: Mutex::new(HashMap::new()),
            host_cv: Condvar::new(),
            host_wait: Mutex::new(()),
            subs: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            pam_service: "agentos-admin-auth".into(),
            epoch_seed: AtomicU64::new(1),
            lsess: Mutex::new(HashMap::new()),
            mcache: Mutex::new(HashMap::new()),
            machine_ok: Mutex::new(None),
            machine_down: Mutex::new(None),
        })
    }

    pub fn machine(&self, op: &str, args: Value) -> Result<Value, Value> {
        let mut c = match MClient::connect(&self.machine_sock) {
            Ok(c) => c,
            Err(e) => {
                self.machine_down.lock().unwrap().get_or_insert_with(Instant::now);
                return Err(err("STORE_UNAVAILABLE", &format!("machine service unreachable: {e}")));
            }
        };
        match c.call(op, args) {
            Err(e) if e.message.starts_with("machined unreachable") => {
                self.machine_down.lock().unwrap().get_or_insert_with(Instant::now);
                Err(err("STORE_UNAVAILABLE", &format!("machine service unreachable: {}", e.message)))
            }
            r => {
                *self.machine_ok.lock().unwrap() = Some(Instant::now());
                *self.machine_down.lock().unwrap() = None;
                r.map_err(|e| err(e.code, &e.message))
            }
        }
    }

    /// Time since the last successful machined call (None = never reached it in this process).
    pub fn since_machine_ok(&self) -> Option<Duration> {
        self.machine_ok.lock().unwrap().map(|t| t.elapsed())
    }

    /// Membership for one forward: machined when it answers; while it is unreachable, the last confirmation within
    /// the grace for this kind of request, otherwise a visible STORE_UNAVAILABLE (spec §13.2).
    pub fn membership(&self, user: &str, ws: &str, write: bool) -> Result<(Value, Value, bool), Value> {
        let key = (user.to_string(), ws.to_string());
        let live = self.machine("members.check", json!({ "userId": user, "workspaceId": ws })).and_then(|m| self.machine("workspaces.row", json!({ "workspaceId": ws })).map(|r| (m, r)));
        match live {
            Ok((m, r)) => {
                self.mcache.lock().unwrap().insert(key, (m.clone(), r.clone()));
                Ok((m, r, false))
            }
            Err(e) if machine_unreachable(&e) => {
                let cached = self.mcache.lock().unwrap().get(&key).cloned();
                let age = self.since_machine_ok();
                let grace = if write { MACHINE_WRITE_GRACE } else { MACHINE_READ_GRACE };
                match (cached, age) {
                    (Some((m, r)), Some(a)) if a <= grace => Ok((m, r, true)),
                    (Some(_), Some(a)) if write => Err(err(
                        "STORE_UNAVAILABLE",
                        &format!("machine service unreachable for {} s: membership cannot be confirmed, so writes are closed (reads continue for up to {} s)", a.as_secs(), MACHINE_READ_GRACE.as_secs()),
                    )),
                    _ => Err(err("STORE_UNAVAILABLE", "machine service unreachable: membership cannot be confirmed")),
                }
            }
            Err(e) => {
                if e["code"] == "NOT_FOUND_OR_FORBIDDEN" {
                    self.mcache.lock().unwrap().remove(&key);
                }
                Err(e)
            }
        }
    }

    pub fn forget_user(&self, user: Option<&str>, ws: Option<&str>) {
        self.mcache.lock().unwrap().retain(|(u, w), _| !(user.map(|x| x == u).unwrap_or(true) && ws.map(|x| x == w).unwrap_or(true)));
    }

    /// Retire the epoch of a logind session (lock / inactive / closing); the next bind gets a fresh epoch.
    pub fn retire(&self, path: &str) {
        let mut m = self.lsess.lock().unwrap();
        if let Some(e) = m.get_mut(path) {
            if !e.retired {
                e.retired = true;
                e.epoch = self.epoch_seed.fetch_add(1, Ordering::SeqCst) as i64;
            }
        }
    }

    pub fn current_epoch(&self, path: &str) -> Option<LEpoch> {
        self.lsess.lock().unwrap().get(path).copied()
    }
}

/// Watch every bound logind session: a lock or loss of foreground retires its epoch even when no request
/// arrives between lock and unlock (spec §9.1: lock → unlock always yields a new sessionEpoch).
pub fn lock_watch(gw: Arc<Gw>) {
    let dbus = match zbus::blocking::Connection::system() {
        Ok(c) => c,
        Err(_) => return,
    };
    loop {
        std::thread::sleep(Duration::from_millis(250));
        let paths: Vec<String> = gw.lsess.lock().unwrap().iter().filter(|(_, e)| !e.retired).map(|(k, _)| k.clone()).collect();
        for p in paths {
            match crate::logind::facts(&dbus, &p) {
                Ok(f) if !f.locked && f.active && f.state != "closing" => {}
                _ => gw.retire(&p),
            }
        }
    }
}

/// Re-read the live logind state of the bound session; any change of active/locked/closing raises the epoch.
fn live(gw: &Gw, conn: u64, dbus: &zbus::blocking::Connection) -> Result<(bool, i64), Value> {
    let mut sessions = gw.sessions.lock().unwrap();
    let s = sessions.get_mut(&conn).ok_or_else(|| err("SESSION_REQUIRED", "call session.bind first"))?;
    if s.bound_at.elapsed() > SESSION_MAX || s.boot_id != agentos_machine::util::boot_id() {
        sessions.remove(&conn);
        return Err(err("SESSION_STALE", "the session expired; bind again"));
    }
    let f = crate::logind::facts(dbus, &s.logind_path).map_err(|_| err("SESSION_STALE", "the login session ended"))?;
    if f.state == "closing" || f.uid != s.login_uid || f.remote || f.seat != "seat0" {
        sessions.remove(&conn);
        return Err(err("SESSION_STALE", "the login session is no longer eligible"));
    }
    if f.locked || !f.active {
        let path = s.logind_path.clone();
        drop(sessions);
        gw.retire(&path);
        return Err(err("SESSION_LOCKED", "the session is locked or not in the foreground"));
    }
    match gw.current_epoch(&s.logind_path) {
        Some(e) if !e.retired && e.epoch == s.epoch => Ok((false, s.epoch)),
        _ => {
            sessions.remove(&conn);
            Err(err("SESSION_STALE", "the session was locked or changed since bind; bind again"))
        }
    }
}

pub fn handle_client(gw: Arc<Gw>, stream: UnixStream) {
    let cred = match peer_cred(&stream) {
        Ok(c) => c,
        Err(_) => return,
    };
    let _slot = match ConnSlot::take(cred.uid) {
        Some(s) => s,
        None => {
            let _ = stream.shutdown(std::net::Shutdown::Both);
            return;
        }
    };
    let conn = gw.next.fetch_add(1, Ordering::SeqCst);
    let dbus = match zbus::blocking::Connection::system() {
        Ok(c) => c,
        Err(_) => return,
    };
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(256);
    let mut w = match stream.try_clone() {
        Ok(w) => w,
        Err(_) => return,
    };
    // Writer: bounded pending bytes; a slow reader that lets 8 MiB pile up is disconnected (spec §27.1).
    let pending = Arc::new(AtomicU64::new(0));
    let pend_w = pending.clone();
    let writer = std::thread::spawn(move || {
        for buf in rx {
            let n = buf.len() as u64;
            if w.write_all(&buf).is_err() {
                break;
            }
            pend_w.fetch_sub(n, Ordering::SeqCst);
        }
        let _ = w.shutdown(std::net::Shutdown::Both);
    });
    let ctx = ConnTx { tx: tx.clone(), pending: pending.clone() };
    let send = {
        let ctx = ctx.clone();
        move |v: &Value| -> bool { ctx.send_buf(frame(&serde_json::to_vec(v).unwrap_or_default())) }
    };
    let inflight = Arc::new(AtomicU64::new(0));
    let mut r = stream;
    loop {
        let body = match read_client_frame(&mut r) {
            Ok(b) => b,
            Err(_) => break,
        };
        if inflight.load(Ordering::SeqCst) >= MAX_INFLIGHT as u64 {
            break; // over the in-flight limit: close the connection (spec §9.2)
        }
        let req = match std::str::from_utf8(&body).ok().and_then(|t| agentos_protocol::v1_json::parse_strict_json(t).ok()) {
            Some(v) => v,
            None => break,
        };
        let env = match parse_envelope(&req) {
            Ok(e) => e,
            Err(m) => {
                let rid = req.get("requestId").cloned().unwrap_or(Value::Null);
                if !send(&json!({ "requestId": rid, "status": 400, "error": err("INVALID_REQUEST", &m) })) {
                    break;
                }
                continue;
            }
        };
        inflight.fetch_add(1, Ordering::SeqCst);
        let gw2 = gw.clone();
        let inflight2 = inflight.clone();
        let send2 = send.clone();
        let tx2 = ctx.clone();
        let dbus2 = dbus.clone();
        std::thread::spawn(move || {
            let out = route(&gw2, conn, cred.uid, cred.pid as u32, &dbus2, &env, tx2);
            let mut resp = json!({ "requestId": env.request_id, "workspaceId": env.workspace_id, "clientEpoch": env.client_epoch });
            match out {
                Ok((status, body)) => {
                    resp["status"] = json!(status);
                    resp["body"] = body;
                }
                Err(e) => {
                    resp["status"] = json!(status_of(e["code"].as_str().unwrap_or("")));
                    resp["error"] = e;
                }
            }
            let _ = send2(&resp);
            inflight2.fetch_sub(1, Ordering::SeqCst);
        });
    }
    gw.sessions.lock().unwrap().remove(&conn);
    for list in gw.subs.lock().unwrap().values_mut() {
        list.retain(|s| s.conn_id != conn);
    }
    // Every sender must be gone before the writer can finish and shut the socket: `send` holds a clone of `tx`
    // (keeping it alive left a refused connection open until the client gave up, O07).
    drop(send);
    drop(ctx);
    drop(tx);
    let _ = writer.join();
}

fn status_of(code: &str) -> u16 {
    match code {
        "NOT_FOUND_OR_FORBIDDEN" => 404,
        "SESSION_REQUIRED" | "SESSION_LOCKED" | "SESSION_STALE" => 401,
        "INVALID_REQUEST" => 400,
        "CONFLICT" | "PLAN_STALE" | "CLIENT_EPOCH_STALE" => 409,
        "MACHINE_CAPACITY" | "PERMIT_RECONCILING" => 429,
        "STORE_UNAVAILABLE" | "REGISTRY_NOT_SYNCED" => 503,
        _ => 422,
    }
}

pub struct Envelope {
    pub request_id: String,
    pub workspace_id: String,
    pub client_epoch: i64,
    pub session_epoch: i64,
    pub method: String,
    pub params: Value,
    pub body: Value,
    pub idem: Option<String>,
}

/// `workspace.forward` is not listed: the registered route decides (a write route needs a key, see `forward`).
const WRITE_METHODS: &[&str] = &[
    "session.end", "workspaces.create", "workspaces.start", "workspaces.stop", "workspaces.archive", "workspaces.attach", "members.setRole", "members.revoke",
    "members.transferOwner", "events.ack", "machine.actions.plan", "machine.actions.confirm", "machine.actions.cancel", "machine.users.create",
    "machine.users.disable", "updates.prepare", "updates.activate", "updates.cancel", "backups.create", "backups.export", "restores.plan", "restores.confirm", "diagnostics.collect",
];

pub fn parse_envelope(v: &Value) -> Result<Envelope, String> {
    let o = v.as_object().ok_or("request must be an object")?;
    for k in o.keys() {
        if !["requestId", "workspaceId", "clientEpoch", "sessionEpoch", "methodId", "params", "body", "idempotencyKey"].contains(&k.as_str()) {
            return Err(format!("unknown field {k}"));
        }
    }
    let uuid = |k: &str| -> Result<String, String> {
        o.get(k).and_then(|x| x.as_str()).filter(|s| agentos_machine::util::is_uuid(s) || *s == MACHINE_SCOPE).map(String::from).ok_or(format!("{k} must be a lowercase uuid"))
    };
    let pos = |k: &str| -> Result<i64, String> { o.get(k).and_then(|x| x.as_i64()).filter(|n| *n >= 1 && *n <= 9_007_199_254_740_991).ok_or(format!("{k} must be a positive integer")) };
    let method = o.get("methodId").and_then(|x| x.as_str()).ok_or("methodId")?.to_string();
    let idem = match o.get("idempotencyKey") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if !s.is_empty() && s.len() <= 200 => Some(s.clone()),
        _ => return Err("bad idempotency key".into()),
    };
    if WRITE_METHODS.contains(&method.as_str()) && idem.is_none() {
        return Err("write requires an idempotency key".into());
    }
    Ok(Envelope {
        request_id: uuid("requestId")?,
        workspace_id: uuid("workspaceId")?,
        client_epoch: pos("clientEpoch")?,
        session_epoch: pos("sessionEpoch")?,
        method,
        params: o.get("params").cloned().unwrap_or(Value::Null),
        body: o.get("body").cloned().unwrap_or(Value::Null),
        idem,
    })
}

fn obj(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

fn s<'a>(v: &'a Value, k: &str) -> Result<&'a str, Value> {
    v.get(k).and_then(|x| x.as_str()).ok_or_else(|| err("INVALID_REQUEST", &format!("{k} is required")))
}

pub fn route(gw: &Gw, conn: u64, uid: u32, pid: u32, dbus: &zbus::blocking::Connection, e: &Envelope, tx: ConnTx) -> Result<(u16, Value), Value> {
    if e.method == "session.bind" {
        return bind(gw, conn, uid, pid, dbus);
    }
    if e.method == "session.status" {
        let st = live(gw, conn, dbus);
        let sessions = gw.sessions.lock().unwrap();
        let s = sessions.get(&conn).ok_or_else(|| err("SESSION_REQUIRED", "not bound"))?;
        let down = gw.machine_down.lock().unwrap().map(|t| t.elapsed().as_secs());
        let since_ok = gw.since_machine_ok().map(|d| d.as_secs());
        let machine = match down {
            None => json!({ "reachable": true }),
            Some(d) => json!({ "reachable": false, "unreachableForS": d, "reason": "machine service unreachable: new model and build requests are paused; new sessions cannot be bound",
                "writesOpen": since_ok.map(|a| a <= MACHINE_WRITE_GRACE.as_secs()).unwrap_or(false), "readsOpen": since_ok.map(|a| a <= MACHINE_READ_GRACE.as_secs()).unwrap_or(false) }),
        };
        return Ok((200, json!({ "userId": s.user_id, "sessionEpoch": s.epoch, "admin": s.admin, "locked": matches!(&st, Err(x) if x["code"] == "SESSION_LOCKED"), "protocols": ["native-rpc/1"], "machine": machine })));
    }
    if e.method == "session.end" {
        gw.sessions.lock().unwrap().remove(&conn);
        return Ok((200, json!({ "ended": true })));
    }
    let (_, epoch) = live(gw, conn, dbus)?;
    if e.session_epoch != epoch {
        return Err(err("SESSION_STALE", "sessionEpoch is stale; bind again"));
    }
    let (user, admin, sess_id) = {
        let ss = gw.sessions.lock().unwrap();
        let s = ss.get(&conn).unwrap();
        (s.user_id.clone(), s.admin, s.session_id.clone())
    };
    let p = json!({ "userId": user, "sessionEpoch": epoch, "admin": admin, "locked": false });
    let ws = e.workspace_id.as_str();
    let a = |extra: Value| -> Value {
        let mut m = obj(&extra);
        m.insert("principal".into(), p.clone());
        Value::Object(m)
    };
    match e.method.as_str() {
        "workspaces.list" => gw.machine("workspaces.list", a(json!({}))).map(|v| (200, v)),
        "workspaces.get" => gw.machine("workspaces.get", a(json!({ "workspaceId": ws }))).map(|v| (200, redact_ws(v))),
        "workspaces.create" => gw.machine("workspaces.create", a(json!({ "createId": idem_uuid(e)?, "displayName": s(&e.body, "displayName")? }))).map(|v| (201, redact_ws(v))),
        "workspaces.start" => gw.machine("workspaces.start", a(json!({ "workspaceId": ws, "restoreArchived": true }))).map(|v| (202, redact_ws(v))),
        "workspaces.stop" => gw.machine("workspaces.stop", a(json!({ "workspaceId": ws }))).map(|v| (200, redact_ws(v))),
        "workspaces.archive" => gw.machine("workspaces.archive", a(json!({ "workspaceId": ws }))).map(|v| (200, redact_ws(v))),
        "workspaces.attach" => attach(gw, conn, &user, e, tx, &p),
        "members.list" => gw.machine("members.list", a(json!({ "workspaceId": ws }))).map(|v| (200, v)),
        "members.setRole" => gw.machine("members.setRole", a(json!({ "workspaceId": ws, "userId": s(&e.body, "userId")?, "role": s(&e.body, "role")?, "expectedMemberVersion": e.body.get("expectedMemberVersion") }))).map(|v| (200, v)),
        "members.revoke" => gw.machine("members.revoke", a(json!({ "workspaceId": ws, "userId": s(&e.body, "userId")?, "revocationId": idem_uuid(e)? }))).map(|v| (202, v)),
        "members.transferOwner" => match e.body.get("transferId").and_then(|x| x.as_str()) {
            Some(t) => gw.machine("members.transferConfirm", a(json!({ "transferId": t }))).map(|v| (200, v)),
            None => gw.machine("members.transferBegin", a(json!({ "workspaceId": ws, "toUserId": s(&e.body, "toUserId")?, "transferId": idem_uuid(e)? }))).map(|v| (202, v)),
        },
        "workspace.forward" => forward(gw, &user, &sess_id, epoch, e),
        "events.subscribe" => subscribe(gw, conn, &user, e, tx),
        "events.ack" => Ok((200, json!({ "acked": e.body.get("cursor") }))),
        "machine.status" => {
            let mut st = gw.machine("status", json!({}))?;
            if !admin {
                st = json!({ "meta": { "currentReleaseId": st["meta"]["currentReleaseId"], "restoreState": st["meta"]["restoreState"] }, "permits": st["permits"], "barrier": st["barrier"], "limits": st["limits"] });
            }
            Ok((200, st))
        }
        "machine.capabilities" => gw.machine("machine.capabilities", json!({})).map(|v| (200, v)),
        "machine.actions.plan" => gw.machine("ops.plan", a(json!({ "idempotencyKey": e.idem, "kind": s(&e.body, "kind")?, "params": e.body.get("params").cloned().unwrap_or(json!({})) }))).map(|v| (201, v)),
        "machine.actions.get" => gw.machine("ops.get", a(json!({ "operationId": s(&e.params, "operationId")? }))).map(|v| (200, v)),
        "machine.actions.cancel" => gw.machine("ops.cancel", a(json!({ "operationId": s(&e.body, "operationId")? }))).map(|v| (200, v)),
        "machine.actions.confirm" => confirm(gw, &p, &e.body),
        "machine.users.create" => {
            // Password goes to machined's in-memory secret store first; the plan carries only its reference.
            let mut pw = e.body.get("password").and_then(|x| x.as_str()).ok_or_else(|| err("INVALID_REQUEST", "password"))?.to_string();
            let r = gw.machine("secrets.put", json!({ "kind": "password", "value": pw }))?;
            unsafe { pw.as_bytes_mut().iter_mut().for_each(|b| *b = 0) };
            let params = json!({ "loginName": s(&e.body, "loginName")?, "role": e.body.get("role").and_then(|x| x.as_str()).unwrap_or("user"), "secretRef": r["secretRef"], "provisioningId": idem_uuid(e)? });
            gw.machine("ops.plan", a(json!({ "idempotencyKey": e.idem, "kind": "users.create", "params": params }))).map(|v| (201, v))
        }
        "machine.users.disable" => gw.machine("ops.plan", a(json!({ "idempotencyKey": e.idem, "kind": "users.disable", "params": { "userId": s(&e.body, "userId")? } }))).map(|v| (201, v)),
        "updates.check" | "updates.status" => gw.machine("updates.current", json!({})).and_then(|v| match v["updateId"].as_str() {
            Some(id) => gw.machine("updates.get", json!({ "updateId": id })).map(|u| (200, u)),
            None => Ok((200, json!({ "updateId": null, "state": "none" }))),
        }),
        "updates.prepare" | "updates.activate" | "updates.cancel" | "backups.create" | "backups.export" | "restores.plan" | "restores.confirm" => {
            if !admin && !e.method.starts_with("backups") {
                return Err(err("NOT_FOUND_OR_FORBIDDEN", "not found"));
            }
            crate::workers::call(gw, &p, &e.method, ws, &e.body, e.idem.as_deref())
        }
        "backups.list" | "backups.inspect" | "restores.status" => crate::workers::read(gw, &p, &e.method, ws, &e.params),
        "diagnostics.collect" => crate::workers::diagnostics(gw, &p, ws, &e.body),
        _ => Err(err("INVALID_REQUEST", "unknown method")),
    }
}

fn idem_uuid(e: &Envelope) -> Result<String, Value> {
    let k = e.idem.as_deref().unwrap_or_default();
    if agentos_machine::util::is_uuid(k) {
        Ok(k.to_string())
    } else {
        Err(err("INVALID_REQUEST", "idempotencyKey must be a lowercase uuid for this method"))
    }
}

fn redact_ws(mut v: Value) -> Value {
    if let Some(o) = v.as_object_mut() {
        for k in ["executionUid", "execLogin", "subuidStart", "rangeSize", "createId"] {
            o.remove(k);
        }
    }
    v
}

fn bind(gw: &Gw, conn: u64, uid: u32, pid: u32, dbus: &zbus::blocking::Connection) -> Result<(u16, Value), Value> {
    let path = crate::logind::session_path_of_pid(dbus, pid).map_err(|_| err("SESSION_REQUIRED", "this process is not in a login session"))?;
    let f = crate::logind::facts(dbus, path.as_str()).map_err(|_| err("SESSION_REQUIRED", "login session unreadable"))?;
    f.eligible(uid).map_err(|m| err("SESSION_REQUIRED", m))?;
    if f.locked {
        return Err(err("SESSION_LOCKED", "unlock first"));
    }
    let u = gw.machine("users.byUid", json!({ "uid": uid }))?;
    if u.is_null() || u["state"] != "active" {
        return Err(err("SESSION_REQUIRED", "this account is not an active AgentOS user"));
    }
    let sid = agentos_machine::util::session_id();
    let epoch = {
        let mut m = gw.lsess.lock().unwrap();
        match m.get(path.as_str()) {
            Some(e) if !e.retired => e.epoch,
            _ => {
                let e = gw.epoch_seed.fetch_add(1, Ordering::SeqCst) as i64;
                m.insert(path.as_str().to_string(), LEpoch { epoch: e, retired: false });
                e
            }
        }
    };
    let s = Session {
        session_id: sid.clone(),
        epoch,
        user_id: u["userId"].as_str().unwrap_or_default().into(),
        login_uid: uid,
        admin: u["role"] == "admin",
        logind_path: path.as_str().into(),
        bound_at: Instant::now(),
        boot_id: agentos_machine::util::boot_id(),
    };
    let out = json!({ "sessionId": sid, "sessionEpoch": epoch, "userId": s.user_id, "role": u["role"], "loginName": u["loginName"], "protocols": ["native-rpc/1"], "logindSession": f.id, "expiresInMs": SESSION_MAX.as_millis() as i64 });
    gw.sessions.lock().unwrap().insert(conn, s);
    Ok((200, out))
}

fn confirm(gw: &Gw, p: &Value, body: &Value) -> Result<(u16, Value), Value> {
    let op = s(body, "operationId")?;
    let plan_hash = s(body, "planHash")?;
    let cur = gw.machine("ops.get", json!({ "principal": p, "operationId": op }))?;
    let admin_kind = agentos_machine::ops::kind_admin(cur["kind"].as_str().unwrap_or_default()).unwrap_or(true);
    let mut authenticated = false;
    if admin_kind {
        let mut pw = body.get("password").and_then(|x| x.as_str()).ok_or_else(|| err("SESSION_REQUIRED", "administrator password is required"))?.as_bytes().to_vec();
        let u = gw.machine("users.get", json!({ "userId": p["userId"] }))?;
        authenticated = crate::pam::authenticate(&gw.pam_service, u["loginName"].as_str().unwrap_or_default(), &mut pw);
        if !authenticated {
            return Err(err("SESSION_REQUIRED", "authentication failed"));
        }
    }
    let t = gw.machine("ops.ticket", json!({ "principal": p, "operationId": op, "planHash": plan_hash, "authenticated": authenticated }))?;
    gw.machine("ops.confirm", json!({ "principal": p, "operationId": op, "planHash": plan_hash, "ticket": t["ticket"] })).map(|v| (200, v))
}

fn host_for(gw: &Gw, ws: &str, wait: Duration) -> Option<Arc<HostLink>> {
    let deadline = Instant::now() + wait;
    loop {
        if let Some(h) = gw.hosts.lock().unwrap().get(ws).cloned() {
            return Some(h);
        }
        if Instant::now() >= deadline {
            return None;
        }
        let g = gw.host_wait.lock().unwrap();
        let _ = gw.host_cv.wait_timeout(g, Duration::from_millis(200));
    }
}

fn host_call(h: &HostLink, req: Value) -> Result<Value, Value> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel();
    h.pending.lock().unwrap().insert(id, tx);
    let mut m = obj(&req);
    m.insert("t".into(), json!("req"));
    m.insert("id".into(), json!(id));
    let buf = frame(&serde_json::to_vec(&Value::Object(m)).unwrap_or_default());
    if h.tx.try_send(buf).is_err() {
        h.pending.lock().unwrap().remove(&id);
        return Err(err("STORE_UNAVAILABLE", "workspace host is not reachable"));
    }
    match rx.recv_timeout(RPC_WAIT) {
        Ok(v) => Ok(v),
        Err(_) => {
            h.pending.lock().unwrap().remove(&id);
            // A timeout proves nothing about commit: the client queries by requestId (spec §9.3).
            Err(err("EFFECT_UNKNOWN", "no answer within 30 s; query the request by its id"))
        }
    }
}

fn principal_envelope(gw: &Gw, user: &str, sess_id: &str, epoch: i64, ws: &str, write: bool) -> Result<(Value, Value), Value> {
    let (m, row, _degraded) = gw.membership(user, ws, write)?;
    let sid_digest = agentos_machine::util::sha256(sess_id.as_bytes());
    Ok((
        json!({ "kind": "user", "userId": user, "workspaceId": ws, "storeUUID": row["storeUUID"], "memberVersion": m["memberVersion"], "role": m["role"],
            "sessionId": sid_digest, "sessionEpoch": epoch, "workspaceIncarnation": row["workspaceIncarnation"] }),
        m,
    ))
}

fn forward(gw: &Gw, user: &str, sess_id: &str, epoch: i64, e: &Envelope) -> Result<(u16, Value), Value> {
    let b = e.body.as_object().ok_or_else(|| err("INVALID_REQUEST", "forward body must be an object"))?;
    for k in b.keys() {
        if !["routeId", "params", "body"].contains(&k.as_str()) {
            return Err(err("INVALID_REQUEST", &format!("forward cannot carry {k}")));
        }
    }
    let rid = b.get("routeId").and_then(|x| x.as_str()).ok_or_else(|| err("INVALID_REQUEST", "routeId"))?;
    let route = gw.routes.get(rid).ok_or_else(|| err("INVALID_REQUEST", "routeId is not registered"))?;
    let params = b.get("params").and_then(|x| x.as_object()).cloned().unwrap_or_default();
    let path = fill_path(route, &params).map_err(|m| err("INVALID_REQUEST", &m))?;
    let (pe, m) = principal_envelope(gw, user, sess_id, epoch, &e.workspace_id, route.write)?;
    if route.write && m["role"] == "viewer" {
        return Err(err("NOT_FOUND_OR_FORBIDDEN", "not found"));
    }
    if route.write && e.idem.is_none() {
        return Err(err("INVALID_REQUEST", "write requires an idempotency key"));
    }
    let h = host_for(gw, &e.workspace_id, Duration::from_secs(10)).ok_or_else(|| err("STORE_UNAVAILABLE", "workspace is not running"))?;
    let query = b.get("body").filter(|_| route.method == "GET").cloned();
    let resp = host_call(&h, json!({ "requestId": e.request_id, "method": route.method, "path": path, "query": query, "body": if route.method == "GET" { Value::Null } else { b.get("body").cloned().unwrap_or(Value::Null) }, "idempotencyKey": e.idem, "clientEpoch": e.client_epoch, "principal": pe }))?;
    let status = resp["status"].as_u64().unwrap_or(502) as u16;
    Ok((status, resp["body"].clone()))
}

fn attach(gw: &Gw, conn: u64, user: &str, e: &Envelope, tx: ConnTx, p: &Value) -> Result<(u16, Value), Value> {
    let ws = &e.workspace_id;
    let row = gw.machine("workspaces.get", json!({ "principal": p, "workspaceId": ws }))?;
    if row["state"] != "running" {
        gw.machine("workspaces.start", json!({ "principal": p, "workspaceId": ws }))?;
    }
    let h = host_for(gw, ws, Duration::from_secs(20)).ok_or_else(|| err("STORE_UNAVAILABLE", "workspace host did not come up"))?;
    let ce = *h.client_epoch.lock().unwrap();
    if let Some(exp) = e.body.get("expectedClientEpoch").and_then(|x| x.as_i64()) {
        if exp != ce {
            return Err(err("CLIENT_EPOCH_STALE", "workspace state changed; reload"));
        }
    }
    let cursor = subscribe_inner(gw, conn, user, ws, tx);
    Ok((200, json!({ "workspaceId": ws, "storeUUID": h.store_uuid, "clientEpoch": ce, "role": row["role"], "memberVersion": row["memberVersion"], "eventCursor": cursor, "displayName": row["displayName"],
        "capabilities": { "rendererCapabilities": ["slot-tree-v1", "slot-tree-v2", "records-v1"], "formatVersions": [1, 2, 3], "abi": [1, 2] } })))
}

fn subscribe(gw: &Gw, conn: u64, user: &str, e: &Envelope, tx: ConnTx) -> Result<(u16, Value), Value> {
    gw.machine("members.check", json!({ "userId": user, "workspaceId": e.workspace_id }))?;
    let h = host_for(gw, &e.workspace_id, Duration::from_secs(2)).ok_or_else(|| err("STORE_UNAVAILABLE", "workspace is not running"))?;
    let from = e.body.get("cursor").and_then(|x| x.as_i64());
    let cursor = subscribe_inner(gw, conn, user, &e.workspace_id, tx);
    if let Some(c) = from {
        // Ask the Host to replay from the client's last confirmed cursor; a gap answers EVENT_GAP.
        let r = host_call(&h, json!({ "method": "EVENTS", "path": "/replay", "body": { "after": c }, "principal": { "kind": "gateway" } }))?;
        if r["status"] == 410 {
            return Err(err("EVENT_GAP", "events before the cursor are gone; load a full snapshot first"));
        }
    }
    Ok((200, json!({ "cursor": cursor })))
}

fn subscribe_inner(gw: &Gw, conn: u64, user: &str, ws: &str, tx: ConnTx) -> i64 {
    let mut subs = gw.subs.lock().unwrap();
    let list = subs.entry(ws.to_string()).or_default();
    list.retain(|s| s.conn_id != conn);
    list.push(Subscriber { conn_id: conn, user_id: user.into(), tx });
    0
}

/// Registry messages for the gateway: a revocation drops every event subscription of that user at once and acks.
pub fn registry_loop(gw: Arc<Gw>) {
    loop {
        match gw.machine("registry.pull", json!({ "target": "gateway" })) {
            Ok(v) => {
                let mut last = None;
                for m in v["messages"].as_array().cloned().unwrap_or_default() {
                    let kind = m["kind"].as_str().unwrap_or_default();
                    let body = &m["body"];
                    match kind {
                        "member.revoking" => {
                            gw.forget_user(body["revokedUserId"].as_str(), body["workspaceId"].as_str());
                            drop_subs(&gw, body["workspaceId"].as_str(), body["revokedUserId"].as_str());
                        }
                        "user.disabled" => {
                            let u = body["userId"].as_str();
                            gw.forget_user(u, None);
                            drop_subs(&gw, None, u);
                            gw.sessions.lock().unwrap().retain(|_, s| Some(s.user_id.as_str()) != u);
                        }
                        "machine.control_epoch" | "restore.started" => {
                            gw.mcache.lock().unwrap().clear();
                            gw.sessions.lock().unwrap().clear();
                            gw.subs.lock().unwrap().clear();
                        }
                        _ => {}
                    }
                    last = m["registrySeq"].as_i64();
                }
                if let Some(seq) = last {
                    let _ = gw.machine("registry.ack", json!({ "target": "gateway", "registrySeq": seq }));
                }
            }
            Err(_) => {}
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn drop_subs(gw: &Gw, ws: Option<&str>, user: Option<&str>) {
    let mut subs = gw.subs.lock().unwrap();
    for (w, list) in subs.iter_mut() {
        if ws.map(|x| x == w).unwrap_or(true) {
            list.retain(|s| Some(s.user_id.as_str()) != user);
        }
    }
}

/// Host side: one connection per running workspace, authenticated by its execution UID.
pub fn handle_host(gw: Arc<Gw>, stream: UnixStream) {
    let cred = match peer_cred(&stream) {
        Ok(c) => c,
        Err(_) => return,
    };
    let ws = match gw.machine("workspaces.byExecUid", json!({ "uid": cred.uid })) {
        Ok(v) => match v["workspaceId"].as_str() {
            Some(w) => w.to_string(),
            None => return,
        },
        Err(_) => return,
    };
    let mut r = stream.try_clone().unwrap();
    let hello = match read_frame(&mut r).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
        Some(v) if v["t"] == "hello" => v,
        _ => return,
    };
    let row = match gw.machine("workspaces.row", json!({ "workspaceId": ws })) {
        Ok(r) => r,
        Err(_) => return,
    };
    if hello["storeUUID"] != row["storeUUID"] || hello["workspaceId"] != ws.as_str() {
        return; // A Host of another store under this UID is never accepted (V1-B05).
    }
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(1024);
    let link = Arc::new(HostLink {
        workspace_id: ws.clone(),
        store_uuid: row["storeUUID"].as_str().unwrap_or_default().into(),
        client_epoch: Mutex::new(hello["clientEpoch"].as_i64().unwrap_or(1)),
        tx,
        pending: Mutex::new(HashMap::new()),
    });
    let mut w = stream;
    std::thread::spawn(move || {
        for b in rx {
            if w.write_all(&b).is_err() {
                break;
            }
        }
    });
    gw.hosts.lock().unwrap().insert(ws.clone(), link.clone());
    gw.host_cv.notify_all();
    loop {
        let v = match read_frame(&mut r).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
            Some(v) => v,
            None => break,
        };
        if let Some(ce) = v["clientEpoch"].as_i64() {
            *link.client_epoch.lock().unwrap() = ce;
        }
        match v["t"].as_str() {
            Some("res") => {
                if let Some(id) = v["id"].as_u64() {
                    if let Some(tx) = link.pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(v);
                    }
                }
            }
            Some("evt") => fanout(&gw, &ws, &link.store_uuid, &v),
            _ => {}
        }
    }
    let mut hosts = gw.hosts.lock().unwrap();
    if hosts.get(&ws).map(|h| Arc::ptr_eq(h, &link)).unwrap_or(false) {
        hosts.remove(&ws);
    }
}

/// Events carry workspaceId/storeUUID/clientEpoch; every delivery re-checks membership (an event is not a grant).
fn fanout(gw: &Gw, ws: &str, store: &str, v: &Value) {
    let ev = json!({ "type": "event", "workspaceId": ws, "storeUUID": store, "clientEpoch": v["clientEpoch"], "eventSeq": v["seq"], "kind": v["kind"], "data": v["data"] });
    let buf = frame(&serde_json::to_vec(&ev).unwrap_or_default());
    let mut subs = gw.subs.lock().unwrap();
    if let Some(list) = subs.get_mut(ws) {
        let mut keep = vec![];
        for s in list.drain(..) {
            let ok = gw.machine("members.check", json!({ "userId": s.user_id, "workspaceId": ws })).is_ok();
            if ok && s.tx.send_buf(buf.clone()) {
                keep.push(s);
            } else if ok {
                // Slow reader: tell it to resync from a snapshot rather than silently dropping events.
                let _ = s.tx.send_buf(frame(&serde_json::to_vec(&json!({ "type": "event", "workspaceId": ws, "kind": "event.gap", "eventSeq": 0 })).unwrap_or_default()));
            }
        }
        *list = keep;
    }
}

pub fn serve(gw: Arc<Gw>, client: UnixListener, host: UnixListener) -> ! {
    let g = gw.clone();
    std::thread::spawn(move || registry_loop(g));
    let g = gw.clone();
    std::thread::spawn(move || lock_watch(g));
    let g = gw.clone();
    std::thread::spawn(move || {
        for s in host.incoming().flatten() {
            let g = g.clone();
            std::thread::spawn(move || handle_host(g, s));
        }
    });
    for s in client.incoming().flatten() {
        let g = gw.clone();
        std::thread::spawn(move || handle_client(g, s));
    }
    std::process::exit(1)
}

#[cfg(test)]
mod o07_tests {
    use super::*;

    #[test]
    fn s08_cached_membership_serves_reads_and_briefly_writes_while_machined_is_unreachable() {
        let gw = Gw::new("/nonexistent/agentos-test-machine.sock");
        let k = ("u1".to_string(), "w1".to_string());
        // never confirmed: nothing to fall back on
        let e = gw.membership("u1", "w1", false).unwrap_err();
        assert!(machine_unreachable(&e), "{e}");
        gw.mcache.lock().unwrap().insert(k.clone(), (json!({ "role": "editor", "memberVersion": 3 }), json!({ "storeUUID": "s" })));
        *gw.machine_ok.lock().unwrap() = Some(Instant::now());
        let (m, _, degraded) = gw.membership("u1", "w1", true).expect("write within the grace");
        assert!(degraded && m["role"] == "editor");
        assert!(gw.machine_down.lock().unwrap().is_some(), "the outage is recorded");
        // 31 s after the last contact: writes close with a visible reason, reads continue
        *gw.machine_ok.lock().unwrap() = Some(Instant::now() - Duration::from_secs(31));
        let e = gw.membership("u1", "w1", true).unwrap_err();
        assert_eq!(e["code"], "STORE_UNAVAILABLE");
        assert!(e["message"].as_str().unwrap().contains("writes are closed"), "{e}");
        assert!(gw.membership("u1", "w1", false).is_ok(), "reads continue");
        // past the read grace everything closes
        *gw.machine_ok.lock().unwrap() = Some(Instant::now() - Duration::from_secs(601));
        assert!(gw.membership("u1", "w1", false).is_err());
        // a revocation clears the cache at once
        *gw.machine_ok.lock().unwrap() = Some(Instant::now());
        gw.forget_user(Some("u1"), Some("w1"));
        assert!(gw.membership("u1", "w1", false).is_err(), "revoked membership is never served from cache");
        // another user's entry is not served for u2
        gw.mcache.lock().unwrap().insert(k, (json!({ "role": "owner" }), json!({})));
        assert!(gw.membership("u2", "w1", false).is_err());
    }

    #[test]
    fn events_and_replies_share_one_pending_budget_that_never_wraps() {
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(8);
        let ctx = ConnTx { tx, pending: Arc::new(AtomicU64::new(0)) };
        let ev = ctx.clone(); // a subscriber's copy, as fanout holds it
        assert!(ev.send_buf(vec![0u8; 100]), "event accepted");
        assert_eq!(ctx.pending.load(Ordering::SeqCst), 100, "events are counted");
        // writer drains it
        let b = rx.recv().unwrap();
        ctx.pending.fetch_sub(b.len() as u64, Ordering::SeqCst);
        assert_eq!(ctx.pending.load(Ordering::SeqCst), 0, "no wrap-around after an event is written");
        assert!(ctx.send_buf(vec![0u8; 10]), "a reply after an event still goes out");
        assert!(!ctx.send_buf(vec![0u8; MAX_PENDING_SEND]), "over budget is refused");
        assert_eq!(ctx.pending.load(Ordering::SeqCst), 10, "a refused buffer is not counted");
    }

    #[test]
    fn o07_connection_slots_are_bounded_per_uid_and_released() {
        let uid = 4_000_123;
        let held: Vec<ConnSlot> = (0..MAX_CONN_PER_UID).map(|_| ConnSlot::take(uid).expect("slot")).collect();
        assert!(ConnSlot::take(uid).is_none(), "one uid cannot exceed its connection bound");
        assert!(ConnSlot::take(uid + 1).is_some(), "another uid is still served");
        drop(held);
        assert!(ConnSlot::take(uid).is_some(), "slots come back when connections end");
    }

    #[test]
    fn o07_a_started_frame_must_complete_in_time_but_idle_is_unbounded() {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        std::io::Write::write_all(&mut b, &frame(b"{\"x\":1}")).unwrap();
        assert_eq!(read_client_frame(&mut a).unwrap(), b"{\"x\":1}".to_vec());
        assert_eq!(a.read_timeout().unwrap(), None, "between frames the connection may stay idle");
        let big = (MAX_FRAME as u32 + 1).to_be_bytes();
        std::io::Write::write_all(&mut b, &big).unwrap();
        assert!(read_client_frame(&mut a).is_err(), "oversized frame refused before reading its body");
    }
}
