//! UDS control socket of machined (`/run/agentos/machine/machine.sock`, 0666). Authority comes from the kernel peer:
//! uid 0 → root clients (session-gateway, agentos-admin, fixed workers); uid == a registered executionUid → that
//! workspace's Host, limited to its own workspace; anything else is refused. JSON bodies never name the caller.
//! One core thread owns machine.sqlite (single writer); connection threads only parse frames and forward.
use crate::dir::Machine;
use crate::err::{MErr, R};
use crate::ops::{Executor, Principal};
use crate::permits::PermitRequest;
use agentos_protocol::frame::{json_depth, read_frame, write_frame};
use agentos_protocol::peer::peer_cred;
use serde_json::{json, Value};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::mpsc;

pub const MAX_FRAME: usize = 512 * 1024;

#[derive(Debug, Clone)]
pub enum Peer {
    Root { pid: i32 },
    Host { workspace_id: String, pid: i32 },
}

pub struct Job {
    pub peer: Peer,
    pub req: Value,
    pub reply: mpsc::Sender<Value>,
}

fn s<'a>(v: &'a Value, k: &str) -> R<&'a str> {
    v.get(k).and_then(|x| x.as_str()).ok_or_else(|| MErr::new("INVALID_REQUEST", format!("{k} is required")))
}
fn i(v: &Value, k: &str) -> R<i64> {
    v.get(k).and_then(|x| x.as_i64()).ok_or_else(|| MErr::new("INVALID_REQUEST", format!("{k} is required")))
}

fn principal(v: &Value) -> R<Principal> {
    let p = v.get("principal").ok_or_else(|| MErr::new("SESSION_REQUIRED", "principal is required"))?;
    Ok(Principal {
        user_id: s(p, "userId")?.to_string(),
        session_epoch: i(p, "sessionEpoch")?,
        admin: p.get("admin").and_then(|x| x.as_bool()).unwrap_or(false),
        locked: p.get("locked").and_then(|x| x.as_bool()).unwrap_or(true),
    })
}

/// Route one request. Root requests from the gateway carry the principal the gateway proved from the kernel peer
/// and logind; the Host path never accepts a principal at all.
pub fn dispatch(m: &mut Machine, ex: &mut dyn Executor, secrets: &std::sync::Mutex<crate::backends::SecretStore>, peer: &Peer, req: &Value) -> R<Value> {
    let op = s(req, "op")?;
    let a = req.get("args").cloned().unwrap_or(Value::Null);
    match peer {
        Peer::Host { workspace_id, pid } => {
            let ws = workspace_id.as_str();
            match op {
                // Asked before the Host opens any database (spec §23.2): under a barrier or restore it must not
                // become a writer of the workspace it would snapshot.
                "host.precheck" => m.require_no_barrier().map(|_| json!({ "workspaceId": ws })),
                "host.hello" => m.host_hello(ws, s(&a, "instanceId")?, *pid, s(&a, "bootId")?),
                "host.bye" => m.host_gone(ws, s(&a, "instanceId")?).map(|_| json!({})),
                "registry.pull" => Ok(json!({ "messages": m.pending_outbox("host", ws, 64)? })),
                "registry.ack" => Ok(json!({ "acked": m.ack_outbox("host", ws, i(&a, "registrySeq")?)? })),
                "permits.request" => {
                    let rq = PermitRequest {
                        workspace_id: s(&a, "workspaceId")?.into(),
                        execution_epoch: i(&a, "executionEpoch")?,
                        owner_kind: s(&a, "ownerKind")?.into(),
                        owner_id: s(&a, "ownerId")?.into(),
                        attempt_id: s(&a, "attemptId")?.into(),
                        resource_class: s(&a, "resourceClass")?.into(),
                        background: a.get("background").and_then(|x| x.as_bool()).unwrap_or(false),
                        body_hash: s(&a, "bodyHash")?.into(),
                        member_version: i(&a, "memberVersion")?,
                        user_id: a.get("userId").and_then(|x| x.as_str()).map(String::from),
                        instance_id: s(&a, "instanceId")?.into(),
                        deadline_ms: a.get("deadlineMs").and_then(|x| x.as_i64()),
                    };
                    m.request_permit(ws, &rq)
                }
                "permits.get" => {
                    let p = m.permit(s(&a, "permitId")?)?;
                    if p["workspaceId"] != ws {
                        return Err(MErr::hidden());
                    }
                    Ok(p)
                }
                "permits.use" => m.use_permit(ws, s(&a, "permitId")?, i(&a, "memberVersion")?),
                "permits.release" => m.release_permit(ws, s(&a, "permitId")?, s(&a, "usage")?, a.get("usage_json")),
                "permits.report" => m.report_permit(ws, s(&a, "permitId")?, s(&a, "holderState")?),
                "permits.list" => Ok(json!({ "permits": m.permits_of(ws)? })),
                "workspace.self" => m.ws_row(ws),
                _ => Err(MErr::new("INVALID_REQUEST", "unknown host operation")),
            }
        }
        Peer::Root { .. } => match op {
            "install.ensure" => m.ensure_install(s(&a, "firstBootId")?),
            "install.closeFirstBoot" => m.close_first_boot().map(|_| json!({ "firstBootState": "closed" })),
            "status" => {
                let mut st = m.status()?;
                st["permits"] = m.permit_summary()?;
                st["barrierHeld"] = m.held_barrier()?.unwrap_or(Value::Null);
                Ok(st)
            }
            "users.provision" => m.provision_user(s(&a, "provisioningId")?, s(&a, "loginName")?, s(&a, "role")?),
            "users.setPassword" => {
                // The password itself arrives in a separate secret frame and is referenced here only by id.
                let pw = secrets.lock().unwrap().take(s(&a, "secretRef")?)?;
                m.set_password(s(&a, "userId")?, &pw).map(|_| json!({ "ok": true }))
            }
            "users.byUid" => Ok(m.user_by_uid(i(&a, "uid")? as u32)?.unwrap_or(Value::Null)),
            "users.get" => m.user(s(&a, "userId")?),
            "users.list" => Ok(json!({ "users": m.users()? })),
            "users.disable" => m.disable_user(s(&a, "userId")?, s(&a, "revocationId")?),
            "secrets.put" => {
                let id = secrets.lock().unwrap().put(s(&a, "kind")?, a.get("value").and_then(|v| v.as_str()).unwrap_or_default().as_bytes())?;
                Ok(json!({ "secretRef": id }))
            }
            "workspaces.create" => {
                let p = principal(&a)?;
                m.create_workspace(s(&a, "createId")?, &p.user_id, s(&a, "displayName")?, None, "created")
            }
            "workspaces.createFor" => m.create_workspace(s(&a, "createId")?, s(&a, "ownerUserId")?, s(&a, "displayName")?, a.get("storeUUID").and_then(|v| v.as_str()), a.get("origin").and_then(|v| v.as_str()).unwrap_or("created")),
            "workspaces.list" => Ok(json!({ "workspaces": m.list_visible(&principal(&a)?.user_id)? })),
            "workspaces.get" => {
                let p = principal(&a)?;
                let ws = s(&a, "workspaceId")?;
                let (role, mv) = m.membership(&p.user_id, ws)?;
                let mut row = m.ws_row(ws)?;
                row["role"] = json!(role.as_str());
                row["memberVersion"] = json!(mv);
                Ok(row)
            }
            "workspaces.start" => {
                let p = principal(&a)?;
                let ws = s(&a, "workspaceId")?;
                m.membership(&p.user_id, ws)?;
                m.start_workspace(ws)
            }
            "workspaces.stop" => {
                let p = principal(&a)?;
                let ws = s(&a, "workspaceId")?;
                let (role, _) = m.membership(&p.user_id, ws)?;
                if role == crate::dir::Role::Viewer {
                    return Err(MErr::hidden());
                }
                m.stop_workspace(ws)
            }
            "workspaces.archive" => m.archive_workspace(&principal(&a)?.user_id, s(&a, "workspaceId")?),
            "workspaces.unarchive" => m.unarchive_workspace(&principal(&a)?.user_id, s(&a, "workspaceId")?),
            "workspaces.setRunWhenLoggedOut" => m.set_run_when_logged_out(&principal(&a)?.user_id, s(&a, "workspaceId")?, a.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false)).map(|_| json!({})),
            "workspaces.row" => m.ws_row(s(&a, "workspaceId")?),
            "workspaces.all" => Ok(json!({ "workspaces": m.all_workspaces()? })),
            "workspaces.rootStop" => m.stop_workspace(s(&a, "workspaceId")?),
            "workspaces.rootStart" => m.start_workspace(s(&a, "workspaceId")?),
            "workspaces.memberSnapshot" => crate::dir::Machine::member_snapshot(&m.c, s(&a, "workspaceId")?),
            "workspaces.byExecUid" => Ok(json!({ "workspaceId": m.ws_by_exec_uid(i(&a, "uid")? as u32)? })),
            "workspaces.resume" => Ok(json!({ "resumed": m.resume_creations()? })),
            "members.check" => {
                let (role, mv) = m.membership(s(&a, "userId")?, s(&a, "workspaceId")?)?;
                Ok(json!({ "role": role.as_str(), "memberVersion": mv }))
            }
            "members.list" => Ok(json!({ "members": m.members(&principal(&a)?.user_id, s(&a, "workspaceId")?)? })),
            "members.setRole" => m.set_role(&principal(&a)?.user_id, s(&a, "workspaceId")?, s(&a, "userId")?, s(&a, "role")?, a.get("expectedMemberVersion").and_then(|x| x.as_i64())),
            "members.revoke" => m.revoke_member(&principal(&a)?.user_id, s(&a, "revocationId")?, s(&a, "workspaceId")?, s(&a, "userId")?),
            "members.transferBegin" => m.begin_transfer(&principal(&a)?.user_id, s(&a, "transferId")?, s(&a, "workspaceId")?, s(&a, "toUserId")?),
            "members.transferConfirm" => m.confirm_transfer(&principal(&a)?.user_id, s(&a, "transferId")?),
            "revocations.get" => m.revocation(s(&a, "revocationId")?),
            "registry.pull" => Ok(json!({ "messages": m.pending_outbox(s(&a, "target")?, "*", 64)? })),
            "registry.ack" => Ok(json!({ "acked": m.ack_outbox(s(&a, "target")?, "*", i(&a, "registrySeq")?)? })),
            "ops.plan" => {
                let p = principal(&a)?;
                m.plan_operation(ex, &p, s(&a, "idempotencyKey")?, s(&a, "kind")?, a.get("params").unwrap_or(&Value::Null))
            }
            "ops.ticket" => {
                let p = principal(&a)?;
                let t = m.issue_ticket(&p, s(&a, "operationId")?, s(&a, "planHash")?, a.get("authenticated").and_then(|x| x.as_bool()).unwrap_or(false))?;
                Ok(json!({ "ticket": t, "expiresInMs": crate::ops::TICKET_MS }))
            }
            "ops.confirm" => {
                let p = principal(&a)?;
                m.confirm_operation(ex, &p, s(&a, "operationId")?, s(&a, "planHash")?, s(&a, "ticket")?)
            }
            "ops.get" => m.operation(&principal(&a)?, s(&a, "operationId")?),
            "ops.cancel" => m.cancel_operation(&principal(&a)?, s(&a, "operationId")?),
            "releases.addKey" => m.add_trusted_key(s(&a, "keyId")?, s(&a, "publicKey")?, "admin").map(|_| json!({})),
            "releases.rotateKey" => m.rotate_key(a.get("statement").unwrap_or(&Value::Null), s(&a, "signedBy")?, s(&a, "signature")?).map(|_| json!({})),
            "releases.verify" => m.verify_release(a.get("manifest").unwrap_or(&Value::Null), s(&a, "signature")?, a.get("trustedTime").and_then(|x| x.as_bool()).unwrap_or(false)),
            "releases.register" => m.register_release(a.get("manifest").unwrap_or(&Value::Null), s(&a, "signature")?, a.get("trustedTime").and_then(|x| x.as_bool()).unwrap_or(false)),
            "releases.adoptBase" => m.adopt_base_release(a.get("manifest").unwrap_or(&Value::Null), s(&a, "signature")?, a.get("trustedTime").and_then(|x| x.as_bool()).unwrap_or(false)),
            "releases.get" => m.release(s(&a, "releaseId")?),
            "releases.setCurrent" => m.set_current_release(s(&a, "releaseId")?, a.get("knownGood").and_then(|x| x.as_bool()).unwrap_or(false)).map(|_| json!({})),
            "updates.open" => m.open_update(s(&a, "updateId")?, s(&a, "toReleaseId")?, a.get("plan").unwrap_or(&Value::Null)),
            "updates.get" => m.update(s(&a, "updateId")?),
            "updates.current" => Ok(json!({ "updateId": m.open_update_id()? })),
            "updates.advance" => m.advance_update(s(&a, "updateId")?, s(&a, "to")?, a.get("fields").unwrap_or(&json!({}))),
            "barrier.hold" => Ok(json!({ "barrierId": m.hold_barrier(s(&a, "ownerKind")?, s(&a, "ownerId")?, a.get("scope").unwrap_or(&json!({})))? })),
            "barrier.release" => m.release_barrier(s(&a, "barrierId")?).map(|_| json!({})),
            "barrier.get" => Ok(m.held_barrier()?.unwrap_or(Value::Null)),
            "checkpoints.begin" => m.begin_checkpoint(s(&a, "setId")?, s(&a, "scope")?, s(&a, "barrierId")?),
            "checkpoints.complete" => m.complete_checkpoint(s(&a, "setId")?, s(&a, "manifestHash")?, a.get("pinned").and_then(|x| x.as_bool()).unwrap_or(false)),
            "checkpoints.abandon" => m.abandon_checkpoint(s(&a, "setId")?).map(|_| json!({})),
            "checkpoints.get" => m.checkpoint(s(&a, "setId")?),
            "checkpoints.list" => Ok(json!({ "sets": m.checkpoints()?, "prunable": m.prunable_checkpoints()? })),
            "checkpoints.exportState" => m.set_export_state(s(&a, "setId")?, s(&a, "state")?).map(|_| json!({})),
            "restores.plan" => m.plan_restore(s(&a, "restoreId")?, s(&a, "setId")?, s(&a, "mode")?),
            "restores.get" => m.restore(s(&a, "restoreId")?),
            "restores.advance" => m.advance_restore(s(&a, "restoreId")?, s(&a, "to")?, a.get("cursor").and_then(|x| x.as_str())),
            "restores.bumpIncarnation" => Ok(json!({ "workspaceIncarnation": m.bump_incarnation(s(&a, "workspaceId")?, s(&a, "restoreId")?)? })),
            "restores.reconcileMembers" => m.reconcile_member_snapshot(s(&a, "workspaceId")?, a.get("members").and_then(|v| v.as_array()).map(|v| v.as_slice()).unwrap_or(&[])),
            "permits.reconcile" => m.reconcile_permits(),
            "permits.summary" => m.permit_summary(),
            "machine.capabilities" => Ok(crate::backends::capabilities()),
            "audit.tail" => {
                let mut st = m.c.prepare("SELECT seq, operation_id, actor_id, kind, scope_id, outcome, timestamp FROM root_audit ORDER BY seq DESC LIMIT ?1")?;
                let rows = st
                    .query_map([a.get("limit").and_then(|x| x.as_i64()).unwrap_or(50).min(500)], |r| {
                        Ok(json!({ "seq": r.get::<_, i64>(0)?, "operationId": r.get::<_, Option<String>>(1)?, "actorId": r.get::<_, String>(2)?, "kind": r.get::<_, String>(3)?, "scopeId": r.get::<_, Option<String>>(4)?, "outcome": r.get::<_, String>(5)?, "timestamp": r.get::<_, i64>(6)? }))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(json!({ "audit": rows }))
            }
            _ => Err(MErr::new("INVALID_REQUEST", "unknown operation")),
        },
    }
}

/// Map a kernel peer to its authority. A Host of an archived or unknown workspace is refused.
pub fn classify(m: &Machine, uid: u32, pid: i32) -> Option<Peer> {
    if uid == 0 {
        return Some(Peer::Root { pid });
    }
    m.ws_by_exec_uid(uid).ok().flatten().map(|workspace_id| Peer::Host { workspace_id, pid })
}

pub fn serve_conn(mut stream: UnixStream, tx: mpsc::Sender<(u32, i32, Value, mpsc::Sender<Value>)>) {
    let cred = match peer_cred(&stream) {
        Ok(c) => c,
        Err(_) => return,
    };
    loop {
        let body = match read_frame(&mut stream, MAX_FRAME) {
            Ok(b) => b,
            Err(_) => return,
        };
        let reply = if json_depth(&body) > 16 {
            json!({ "ok": false, "error": MErr::new("INVALID_REQUEST", "frame nests too deeply").json() })
        } else {
            match std::str::from_utf8(&body).ok().and_then(|t| agentos_protocol::v1_json::parse_strict_json(t).ok()) {
                None => json!({ "ok": false, "error": MErr::new("INVALID_REQUEST", "frame is not strict JSON").json() }),
                Some(req) => {
                    let (rtx, rrx) = mpsc::channel();
                    if tx.send((cred.uid, cred.pid, req, rtx)).is_err() {
                        return;
                    }
                    match rrx.recv() {
                        Ok(v) => v,
                        Err(_) => return,
                    }
                }
            }
        };
        let text = serde_json::to_vec(&reply).unwrap_or_default();
        if write_frame(&mut stream, &text).is_err() {
            return;
        }
    }
}

pub fn run(listener: UnixListener, mut m: Machine, mut ex: Box<dyn Executor + Send>, secrets: std::sync::Arc<std::sync::Mutex<crate::backends::SecretStore>>) -> ! {
    let (tx, rx) = mpsc::channel::<(u32, i32, Value, mpsc::Sender<Value>)>();
    std::thread::spawn(move || {
        for s in listener.incoming().flatten() {
            let tx = tx.clone();
            std::thread::spawn(move || serve_conn(s, tx));
        }
    });
    loop {
        let (uid, pid, req, reply) = match rx.recv_timeout(std::time::Duration::from_secs(2)) {
            Ok(v) => v,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let _ = m.schedule();
                secrets.lock().unwrap().expire();
                continue;
            }
            Err(_) => std::process::exit(1),
        };
        let out = match classify(&m, uid, pid) {
            None => json!({ "ok": false, "error": MErr::new("NOT_FOUND_OR_FORBIDDEN", "peer is not a machine client").json() }),
            Some(peer) => match dispatch(&mut m, ex.as_mut(), &secrets, &peer, &req) {
                Ok(v) => json!({ "ok": true, "data": v }),
                Err(e) => json!({ "ok": false, "error": e.json() }),
            },
        };
        let _ = reply.send(out);
    }
}

/// Small blocking client used by gateway, admin CLI, workers and tests.
pub struct Client {
    s: UnixStream,
}

impl Client {
    pub fn connect(path: &str) -> std::io::Result<Client> {
        Ok(Client { s: UnixStream::connect(path)? })
    }
    pub fn call(&mut self, op: &str, args: Value) -> R<Value> {
        let body = serde_json::to_vec(&json!({ "op": op, "args": args })).map_err(|e| MErr::new("INTERNAL", e.to_string()))?;
        write_frame(&mut self.s, &body).map_err(|e| MErr::new("STORE_UNAVAILABLE", format!("machined unreachable: {e}")))?;
        let resp = read_frame(&mut self.s, MAX_FRAME).map_err(|e| MErr::new("STORE_UNAVAILABLE", format!("machined unreachable: {e}")))?;
        let v: Value = serde_json::from_slice(&resp).map_err(|e| MErr::new("INTERNAL", e.to_string()))?;
        if v["ok"] == true {
            Ok(v["data"].clone())
        } else {
            let code = v["error"]["code"].as_str().unwrap_or("INTERNAL").to_string();
            Err(MErr { code: crate::backends::static_code(&code), message: v["error"]["message"].as_str().unwrap_or_default().to_string() })
        }
    }
}
