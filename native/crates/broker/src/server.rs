//! Socket server and the fixed method set (spec §12.2). Identity is the kernel peer UID plus the handshake binding;
//! writes additionally carry machineInstallId + workspaceIncarnation that must match the log.
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use crate::db;
use crate::exec;
use crate::policy;
use crate::state::*;
use agentos_protocol::dto::*;
use agentos_protocol::frame::{parse_strict, read_frame, write_frame, MAX_CONTROL_FRAME};
use agentos_protocol::peer::peer_cred;

pub const SOCKET_DIR: &str = "/run/agentos-broker";
pub const SOCKET_PATH: &str = "/run/agentos-broker/broker.sock";
const LOCK_PATH: &str = "/var/lib/agentos-broker/broker.lock";
const MAX_CONNECTIONS: usize = 16;

static CONNECTIONS: AtomicUsize = AtomicUsize::new(0);

pub fn serve() -> i32 {
    // Exclusive data-directory lock: one broker writer.
    let lockf = match std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(LOCK_PATH) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("agentos-broker: cannot open {LOCK_PATH}: {e}");
            return 1;
        }
    };
    if unsafe { libc::flock(lockf.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        eprintln!("agentos-broker: another broker holds the log lock");
        return 1;
    }
    let (pol, pver) = match policy::load(policy::POLICY_PATH, true) {
        Ok(x) => x,
        Err(e) => {
            eprintln!("agentos-broker: policy refused: {e}");
            return 1;
        }
    };
    let instance_id = format!("bi_{}", agentos_protocol::random_hex(8));
    let (conn, diag) = match db::open_existing(db::DB_PATH) {
        Ok(c) => {
            let id = db::meta(&c, "machine_install_id").unwrap_or_default();
            if id != pol.machine_install_id {
                (None, Some(format!("BROKER_IDENTITY_MISMATCH: log belongs to install {id}, policy names {}", pol.machine_install_id)))
            } else {
                (Some(c), None)
            }
        }
        Err(e) => (None, Some(e)),
    };
    if let Some(d) = &diag {
        eprintln!("agentos-broker: diagnostics-only mode: {d}");
    }
    let install_id = pol.machine_install_id.clone();
    let b: Shared = Arc::new(Broker { db: Mutex::new(conn), diag, policy: pol, policy_version: pver, instance_id, install_id, wake: (Mutex::new(false), Condvar::new()) });
    if b.diag.is_none() {
        {
            let g = b.db.lock().unwrap();
            let c = g.as_ref().unwrap();
            if let Err(e) = ensure_resource_rows(c, &b) {
                eprintln!("agentos-broker: resource rows: {e}");
                return 1;
            }
            let _ = db::audit(c, "broker_start", None, None, None, None, &json!({"instance": b.instance_id, "policyVersion": b.policy_version, "bootId": agentos_protocol::boot_id()}));
        }
        // Spec §12.3: before reconciling, make sure no worker from the previous broker instance can still write.
        exec::fence_workers(&b);
        exec::reconcile_all(&b);
        let eb = b.clone();
        std::thread::spawn(move || exec::executor_loop(eb));
    }
    let _ = std::fs::remove_file(SOCKET_PATH);
    let listener = match UnixListener::bind(SOCKET_PATH) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("agentos-broker: bind {SOCKET_PATH}: {e}");
            return 1;
        }
    };
    // Explicit owner (the registered host uid), group agentos-broker, mode 0660; SO_PEERCRED is checked anyway.
    let _ = std::fs::set_permissions(SOCKET_PATH, std::fs::Permissions::from_mode(0o660));
    let owner = b.policy.hosts.first().map(|h| h.uid).unwrap_or(0);
    let gid = group_id("agentos-broker").unwrap_or(0);
    let c = std::ffi::CString::new(SOCKET_PATH).unwrap();
    unsafe { libc::chown(c.as_ptr(), owner, gid) };
    let _ = SOCKET_DIR;
    notify_ready();
    for s in listener.incoming() {
        let Ok(s) = s else { continue };
        if CONNECTIONS.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
            drop(s);
            continue;
        }
        let bb = b.clone();
        CONNECTIONS.fetch_add(1, Ordering::SeqCst);
        std::thread::spawn(move || {
            handle_conn(&bb, s);
            CONNECTIONS.fetch_sub(1, Ordering::SeqCst);
        });
    }
    0
}

fn notify_ready() {
    if let Ok(p) = std::env::var("NOTIFY_SOCKET") {
        if let Ok(s) = std::os::unix::net::UnixDatagram::unbound() {
            let _ = s.send_to(b"READY=1", p);
        }
    }
}

fn group_id(name: &str) -> Option<u32> {
    let c = std::ffi::CString::new(name).ok()?;
    let g = unsafe { libc::getgrnam(c.as_ptr()) };
    if g.is_null() {
        None
    } else {
        Some(unsafe { (*g).gr_gid })
    }
}

pub struct Session {
    pub uid: u32,
    pub store: Option<String>,
}

fn handle_conn(b: &Shared, s: UnixStream) {
    let Ok(pc) = peer_cred(&s) else { return };
    // Only installed host UIDs may talk to the broker at all (the socket mode is a second layer).
    if !b.policy.hosts.iter().any(|h| h.uid == pc.uid) {
        let mut w = &s;
        let _ = write_frame(&mut w, json!({"v": 1, "id": "", "ok": false, "error": {"code": "BROKER_POLICY_DENIED", "message": "this uid is not registered with the broker"}}).to_string().as_bytes());
        return;
    }
    s.set_read_timeout(Some(Duration::from_secs(300))).ok();
    let mut sess = Session { uid: pc.uid, store: None };
    loop {
        let mut r = &s;
        let body = match read_frame(&mut r, MAX_CONTROL_FRAME) {
            Ok(b) => b,
            Err(agentos_protocol::frame::FrameError::TooLarge(n)) => {
                reply_err(&s, "", BErr::new("LIMIT_EXCEEDED", format!("frame of {n} bytes exceeds 512 KiB")));
                return;
            }
            Err(_) => return,
        };
        let v = match parse_strict(&body) {
            Ok(v) => v,
            Err(e) => {
                reply_err(&s, "", BErr::new("INVALID_SYSTEM_PLAN", e.to_string()));
                return;
            }
        };
        let req: Request = match serde_json::from_value(v) {
            Ok(r) => r,
            Err(e) => {
                reply_err(&s, "", BErr::new("INVALID_SYSTEM_PLAN", format!("request: {e}")));
                continue;
            }
        };
        // Protocol 1 methods keep v=1; protocol-2 (maintenance) methods require v=2 and are never served under v=1, so a
        // maintenance request cannot be downgraded to a user/action request (v0.4 spec §13.3, V4-B08).
        let is_v2 = METHODS_V2.contains(&req.method.as_str());
        if (is_v2 && req.v != PROTOCOL_V2) || (!is_v2 && req.v != PROTOCOL_VERSION) {
            reply_err(&s, &req.id, BErr::new("CAPABILITY_VERSION_UNSUPPORTED", format!("method {} is protocol {}", req.method, if is_v2 { PROTOCOL_V2 } else { PROTOCOL_VERSION })));
            continue;
        }
        let out = if is_v2 { crate::maintenance::dispatch(b, &mut sess, &req.method, &req.params) } else { dispatch(b, &mut sess, &req) };
        match out {
            Ok(result) => {
                let mut w = &s;
                let body = json!({"v": req.v, "id": req.id, "ok": true, "result": result}).to_string();
                if write_frame(&mut w, body.as_bytes()).is_err() {
                    return;
                }
                // Test installs: a fault after the broker committed a result but before the host receives it.
                if req.method == "operation-get" {
                    b.fault("broker.after_result_reply");
                }
            }
            Err(e) => reply_err(&s, &req.id, e),
        }
    }
}

fn reply_err(s: &UnixStream, id: &str, e: BErr) {
    let mut w = s;
    let mut err = json!({"code": e.code, "message": e.message});
    if let Some(d) = e.details {
        err["details"] = d;
    }
    let _ = write_frame(&mut w, json!({"v": 1, "id": id, "ok": false, "error": err}).to_string().as_bytes());
    let _ = w.flush();
}

fn p<T: serde::de::DeserializeOwned>(v: &Value) -> Result<T, BErr> {
    serde_json::from_value(v.clone()).map_err(|e| BErr::new("INVALID_SYSTEM_PLAN", format!("params: {e}")))
}

fn bound<'a>(sess: &'a Session, store: &str) -> Result<(), BErr> {
    match &sess.store {
        Some(s) if s == store => Ok(()),
        _ => Err(BErr::new("BROKER_IDENTITY_MISMATCH", "this connection is not bound to that workspace; handshake first")),
    }
}

/// Identity checks that precede any result (spec §12.2): installed host uid for the store, matching install id,
/// current incarnation (unless `any_incarnation`).
pub fn check_identity_db(b: &Broker, c: &rusqlite::Connection, sess: &Session, id: &Identity, any_incarnation: bool) -> Result<(String, i64), BErr> {
    check_identity(id).map_err(|m| BErr::new("INVALID_SYSTEM_PLAN", m))?;
    bound(sess, &id.store_uuid)?;
    if id.machine_install_id != b.install_id {
        return Err(BErr::new("BROKER_IDENTITY_MISMATCH", "machineInstallId does not match this broker's log").with(json!({"machineInstallId": b.install_id})));
    }
    let row: Option<(i64, String, i64)> = c
        .query_row("SELECT incarnation, state, allowed_uid FROM workspace_bindings WHERE store_uuid=?1", params![id.store_uuid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?;
    let Some((inc, state, uid)) = row else { return Err(BErr::new("BROKER_POLICY_DENIED", "workspace is not registered")) };
    if uid as u32 != sess.uid {
        return Err(BErr::new("BROKER_IDENTITY_MISMATCH", "peer uid is not the registered host for this workspace"));
    }
    if !any_incarnation && inc as u64 != id.workspace_incarnation {
        return Err(BErr::new("WORKSPACE_FENCED", format!("workspace incarnation {} is current; request carries {}", inc, id.workspace_incarnation)).with(json!({"workspaceIncarnation": inc})));
    }
    Ok((state, inc))
}

fn dispatch(b: &Shared, sess: &mut Session, req: &Request) -> Result<Value, BErr> {
    match req.method.as_str() {
        "handshake" => handshake(b, sess, &req.params),
        "describe" => describe(b, sess, &req.params),
        "read" => exec::read(b, sess.uid, sess.store.as_deref(), &p::<ReadParams>(&req.params)?, |c, id| check_identity_db(b, c, sess, id, false)),
        "grant-sync" => grant_sync(b, sess, &p(&req.params)?),
        "grant-revoke" => grant_revoke(b, sess, &p(&req.params)?),
        "submit" => exec::submit(b, &p(&req.params)?, |c, id| check_identity_db(b, c, sess, id, false)),
        "operation-get" => {
            let r: OperationRef = p(&req.params)?;
            let mut g = b.db.lock().unwrap();
            let c = db_or_diag(b, &mut g)?;
            let (_, inc) = check_identity_db(b, c, sess, &r.identity, false)?;
            op_view(c, &b.install_id, &r.identity.store_uuid, inc, &r.operation_id)?.ok_or_else(|| BErr::new("NOT_FOUND", "no such operation in this incarnation"))
        }
        "operation-cancel" => exec::cancel(b, &p(&req.params)?, |c, id| check_identity_db(b, c, sess, id, false)),
        "operation-resolve" => exec::resolve(b, &p(&req.params)?, |c, id| check_identity_db(b, c, sess, id, false)),
        "history-sync" => history(b, sess, &p(&req.params)?),
        "workspace-quiesce" => exec::quiesce(b, &p(&req.params)?, |c, id| check_identity_db(b, c, sess, id, false)),
        "workspace-resume" => {
            let r: ResumeParams = p(&req.params)?;
            let g = b.db.lock().unwrap();
            let c = g.as_ref().ok_or_else(|| BErr::new("BROKER_HISTORY_MISSING", "log unavailable"))?;
            let (state, inc) = check_identity_db(b, c, sess, &r.identity, false)?;
            if state == "restoring" {
                return Err(BErr::new("RECONCILIATION_REQUIRED", "a restore is in progress; complete it first"));
            }
            c.execute("UPDATE workspace_bindings SET state='active', updated_at=?2 WHERE store_uuid=?1", params![r.identity.store_uuid, now()])?;
            let seq = db::audit(c, "workspace_resume", Some(&r.identity.store_uuid), Some(inc), None, None, &json!({}))?;
            drop(g);
            b.kick();
            Ok(json!({"state": "active", "seq": seq}))
        }
        "restore-begin" => exec::restore_begin(b, sess.uid, sess.store.as_deref(), &p(&req.params)?),
        "restore-status" => exec::restore_status(b, sess.store.as_deref(), &p(&req.params)?),
        "restore-complete" => exec::restore_complete(b, sess.store.as_deref(), &p(&req.params)?),
        m => Err(BErr::new("CAPABILITY_VERSION_UNSUPPORTED", format!("unknown method {m}"))),
    }
}

fn handshake(b: &Shared, sess: &mut Session, v: &Value) -> Result<Value, BErr> {
    let h: HandshakeParams = p(v)?;
    if h.protocol_version != PROTOCOL_VERSION {
        return Err(BErr::new("CAPABILITY_VERSION_UNSUPPORTED", format!("broker speaks protocol {PROTOCOL_VERSION}")));
    }
    if !token_ok(&h.store_uuid, 64) || !token_ok(&h.client_nonce, 64) {
        return Err(BErr::new("INVALID_SYSTEM_PLAN", "malformed handshake"));
    }
    let host = b.policy.hosts.iter().find(|x| x.uid == sess.uid && x.store_uuid == h.store_uuid);
    if host.is_none() {
        return Err(BErr::new("BROKER_POLICY_DENIED", "this uid is not registered for that workspace"));
    }
    let base = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "supportedProtocols": SUPPORTED_PROTOCOLS,
        "brokerInstanceId": b.instance_id,
        "machineInstallId": b.install_id,
        "policyVersion": b.policy_version,
        "bootId": agentos_protocol::boot_id(),
        "testMode": b.policy.test_mode,
    });
    let g = b.db.lock().unwrap();
    let Some(c) = g.as_ref() else {
        let mut out = base;
        out["brokerReady"] = json!(false);
        out["diagnostic"] = json!(b.diag);
        out["workspaceIncarnation"] = Value::Null;
        out["workspaceState"] = json!("unavailable");
        sess.store = Some(h.store_uuid);
        return Ok(out);
    };
    let row: Option<(i64, String)> = c.query_row("SELECT incarnation, state FROM workspace_bindings WHERE store_uuid=?1", params![h.store_uuid], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    let (inc, state) = match row {
        Some(x) => x,
        None => {
            // First pairing of an installed workspace: incarnation 1.
            let hh = host.unwrap();
            c.execute(
                "INSERT INTO workspace_bindings(store_uuid, allowed_uid, workspace_path_id, incarnation, state, policy_version, updated_at) VALUES (?1,?2,?3,1,'active',?4,?5)",
                params![h.store_uuid, hh.uid as i64, hh.workspace_path_id, b.policy_version, now()],
            )?;
            db::audit(c, "workspace_paired", Some(&h.store_uuid), Some(1), None, None, &json!({"uid": hh.uid}))?;
            (1, "active".to_string())
        }
    };
    sess.store = Some(h.store_uuid.clone());
    let mut out = base;
    out["brokerReady"] = json!(true);
    out["workspaceIncarnation"] = json!(inc);
    out["workspaceState"] = json!(state);
    let mut problems = vec![];
    if let Some(mi) = &h.machine_install_id {
        if mi != &b.install_id {
            problems.push("machineInstallId");
        }
    }
    if let Some(wi) = h.workspace_incarnation {
        if wi as i64 != inc {
            problems.push("workspaceIncarnation");
        }
    }
    out["identityMismatch"] = json!(problems);
    Ok(out)
}

fn describe(b: &Shared, sess: &mut Session, v: &Value) -> Result<Value, BErr> {
    let d: DescribeParams = p(v)?;
    {
        let mut g = b.db.lock().unwrap();
        let c = db_or_diag(b, &mut g)?;
        check_identity_db(b, c, sess, &d.identity, false)?;
    }
    let store = d.identity.store_uuid.clone();
    let mut out = Vec::new();
    for r in b.catalog(&store) {
        let obs = exec::observe(b, &r);
        let g = b.db.lock().unwrap();
        let c = g.as_ref().unwrap();
        let (gen, status, quarantine) = exec::apply_observation(c, &r, &obs)?;
        out.push(json!({
            "resourceId": r.resource_id, "kind": r.kind, "catalogKey": r.key, "displayName": r.display_name,
            "generation": gen, "status": status, "identityDigest": obs.as_ref().ok().map(|o| o.digest.clone()),
            "version": obs.as_ref().ok().map(|o| o.version.clone()), "details": obs.as_ref().ok().map(|o| o.details.clone()),
            "limits": r.caps, "quarantineOperationId": quarantine,
            "error": obs.as_ref().err().map(|e| json!({"code": e.code, "message": e.message})),
        }));
    }
    Ok(json!({"resources": out, "policyVersion": b.policy_version, "machineInstallId": b.install_id}))
}

fn grant_sync(b: &Shared, sess: &mut Session, g: &GrantSyncParams) -> Result<Value, BErr> {
    let mut guard = b.db.lock().unwrap();
    let c = db_or_diag(b, &mut guard)?;
    let (_, inc) = check_identity_db(b, c, sess, &g.identity, false)?;
    let want = agentos_protocol::domain_hash("agentos.broker.grant.v1", &g.hash_body()).map_err(|e| BErr::new("INVALID_SYSTEM_PLAN", e.0))?;
    if want != g.request_hash {
        return Err(BErr::new("PLAN_HASH_MISMATCH", "grant request hash does not match its body"));
    }
    if !token_ok(&g.grant_id, 64) || !safe_u64(g.grant_version) || !safe_u64(g.expires_at_ms) || !g.limits.is_object() {
        return Err(BErr::new("INVALID_SYSTEM_PLAN", "malformed grant"));
    }
    match g.principal.kind.as_str() {
        "app" if g.principal.app_id.is_some() && g.principal.revision_id.is_some() => {}
        "system_action" if g.principal.action_id.is_some() => {}
        "run" if g.principal.run_id.is_some() => {}
        _ => return Err(BErr::new("INVALID_SYSTEM_PLAN", "unsupported grant principal")),
    }
    let existing: Option<(String, Option<i64>)> = c
        .query_row("SELECT request_hash, revoked_seq FROM broker_grants WHERE grant_id=?1 AND grant_version=?2", params![g.grant_id, g.grant_version as i64], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    if let Some((h, revoked)) = existing {
        if h != g.request_hash {
            return Err(BErr::new("OPERATION_CONFLICT", "same grant id/version with a different body"));
        }
        return Ok(json!({"grantId": g.grant_id, "grantVersion": g.grant_version, "state": if revoked.is_some() { "revoked" } else { "active" }, "replayed": true}));
    }
    let res = b.find_res(&g.identity.store_uuid, &g.resource_id).ok_or_else(|| BErr::new("RESOURCE_NOT_BOUND", "resource is not in this workspace's installed catalog"))?;
    let cap = agentos_protocol::params::capability(&g.capability_id).ok_or_else(|| BErr::new("CAPABILITY_VERSION_UNSUPPORTED", "unknown capability"))?;
    if g.contract_version != 1 {
        return Err(BErr::new("CAPABILITY_VERSION_UNSUPPORTED", "contract version"));
    }
    if !cap.kinds.contains(&res.kind) {
        return Err(BErr::new("BROKER_POLICY_DENIED", format!("{} does not apply to {}", g.capability_id, res.kind)));
    }
    exec::check_limits_within_policy(&g.capability_id, &g.limits, &res.caps)?;
    let gen: i64 = c.query_row("SELECT generation FROM resource_state WHERE resource_id=?1", params![g.resource_id], |r| r.get(0))?;
    if gen as u64 != g.resource_generation {
        return Err(BErr::new("RESOURCE_GENERATION_STALE", format!("resource generation is {gen}")).with(json!({"generation": gen})));
    }
    let tx = c.unchecked_transaction()?;
    let seq = db::audit(&tx, "grant_sync", Some(&g.identity.store_uuid), Some(inc), None, Some(&g.grant_id), &json!({"capability": g.capability_id, "resource": g.resource_id, "principal": g.principal}))?;
    tx.execute(
        "INSERT INTO broker_grants(grant_id, grant_version, store_uuid, incarnation, principal_json, capability_id, contract_version, resource_id, resource_generation, limits_json, params_hash, expires_at, request_hash, created_seq) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![g.grant_id, g.grant_version as i64, g.identity.store_uuid, inc, serde_json::to_string(&g.principal).unwrap(), g.capability_id, g.contract_version, g.resource_id, gen, g.limits.to_string(), g.params_hash, g.expires_at_ms as i64, g.request_hash, seq],
    )?;
    tx.commit()?;
    Ok(json!({"grantId": g.grant_id, "grantVersion": g.grant_version, "state": "active", "seq": seq}))
}

fn grant_revoke(b: &Shared, sess: &mut Session, g: &GrantRevokeParams) -> Result<Value, BErr> {
    let mut guard = b.db.lock().unwrap();
    let c = db_or_diag(b, &mut guard)?;
    let (_, inc) = check_identity_db(b, c, sess, &g.identity, true)?;
    // Same write lock as execution admission: whichever commits first wins (spec §8.3, §17.2).
    let tx = c.unchecked_transaction()?;
    let row: Option<Option<i64>> = tx.query_row("SELECT revoked_seq FROM broker_grants WHERE grant_id=?1 AND grant_version=?2 AND store_uuid=?3", params![g.grant_id, g.grant_version as i64, g.identity.store_uuid], |r| r.get(0)).optional()?;
    let seq = match row {
        None => {
            // Unknown grant: record a revoked tombstone so a late grant-sync cannot activate it.
            let seq = db::audit(&tx, "grant_revoke_tombstone", Some(&g.identity.store_uuid), Some(inc), None, Some(&g.grant_id), &json!({}))?;
            tx.execute(
                "INSERT INTO broker_grants(grant_id, grant_version, store_uuid, incarnation, principal_json, capability_id, contract_version, resource_id, resource_generation, limits_json, params_hash, expires_at, request_hash, created_seq, revoked_seq, revoked_at) VALUES (?1,?2,?3,?4,'{}','',0,'',0,'{}',NULL,0,'tombstone',?5,?5,?6)",
                params![g.grant_id, g.grant_version as i64, g.identity.store_uuid, inc, seq, now()],
            )?;
            seq
        }
        Some(Some(s)) => s,
        Some(None) => {
            let seq = db::audit(&tx, "grant_revoke", Some(&g.identity.store_uuid), Some(inc), None, Some(&g.grant_id), &json!({}))?;
            tx.execute("UPDATE broker_grants SET revoked_seq=?3, revoked_at=?4 WHERE grant_id=?1 AND grant_version=?2", params![g.grant_id, g.grant_version as i64, seq, now()])?;
            seq
        }
    };
    tx.commit()?;
    b.fault("broker.after_revoke_commit");
    Ok(json!({"grantId": g.grant_id, "grantVersion": g.grant_version, "state": "revoked", "revokedSeq": seq}))
}

fn history(b: &Shared, sess: &mut Session, h: &HistoryParams) -> Result<Value, BErr> {
    let mut guard = b.db.lock().unwrap();
    let c = db_or_diag(b, &mut guard)?;
    bound(sess, &h.store_uuid)?;
    if h.machine_install_id != b.install_id {
        return Err(BErr::new("BROKER_IDENTITY_MISMATCH", "machineInstallId does not match"));
    }
    let uid: Option<i64> = c.query_row("SELECT allowed_uid FROM workspace_bindings WHERE store_uuid=?1", params![h.store_uuid], |r| r.get(0)).optional()?;
    if uid.map(|u| u as u32) != Some(sess.uid) {
        return Err(BErr::new("BROKER_IDENTITY_MISMATCH", "peer uid is not the registered host for this workspace"));
    }
    let limit = h.limit.clamp(1, 500) as i64;
    let mut st = c.prepare(
        "SELECT operation_id, action_id, incarnation, state, completion_kind, effect_certainty, evidence_kind, evidence_json, result_json, error_code, error_message, resolution_json, capability_id, resource_id, resource_generation, accepted_seq, updated_seq, request_hash, plan_hash, compensates_operation_id, deadline_ms, cancel_requested, reconcile_attempts, external_ref, maintenance_json
         FROM effect_operations WHERE machine_install_id=?1 AND store_uuid=?2 AND updated_seq > ?3 ORDER BY updated_seq LIMIT ?4",
    )?;
    let ops: Vec<Value> = st.query_map(params![b.install_id, h.store_uuid, h.since_seq as i64, limit], |r| row_view(r))?.filter_map(|x| x.ok()).collect();
    let last: i64 = db::meta(c, "seq").and_then(|s| s.parse().ok()).unwrap_or(0);
    Ok(json!({"operations": ops, "lastSeq": last}))
}
