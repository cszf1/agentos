//! v1.0 root-side directory sync (spec §14.2, §14.3, §15.3): the broker pulls its registry messages from
//! agentos-machined (it connects as root; machined maps uid 0 to the root role), applies them in broker.sqlite in
//! one transaction per batch, then acks the last sequence. Workspace hosts registered there may connect with their
//! execution UID; protocol-3 writes are checked against these rows, never against what a Host claims.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use crate::state::{BErr, Shared};

pub const MACHINE_SOCKET: &str = "/run/agentos/machine/machine.sock";
pub const MACHINE_REGISTRY_ID: &str = "machine-registry";
pub const V3_DOMAIN: &str = "agentos.broker.workspace-write.v3";
pub const PROTOCOL_V3: u32 = 3;
pub const METHODS_V3: &[&str] = &["grant-sync", "grant-revoke", "submit", "operation-cancel", "operation-resolve", "maintenance-policy-sync", "maintenance-policy-revoke", "maintenance-control", "maintenance-submit"];

pub const SCHEMA_V5: &str = r#"
CREATE TABLE IF NOT EXISTS machine_hosts (
  store_uuid TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE,
  execution_uid INTEGER NOT NULL UNIQUE,
  workspace_incarnation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','archived')),
  registry_seq INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS machine_members (
  store_uuid TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  member_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','revoking','revoked')),
  registry_seq INTEGER NOT NULL,
  PRIMARY KEY (store_uuid, user_id)
) STRICT;
"#;

fn call(s: &mut UnixStream, op: &str, args: Value) -> Result<Value, String> {
    let body = serde_json::to_vec(&json!({ "op": op, "args": args })).map_err(|e| e.to_string())?;
    let mut f = (body.len() as u32).to_be_bytes().to_vec();
    f.extend_from_slice(&body);
    s.write_all(&f).map_err(|e| e.to_string())?;
    let mut h = [0u8; 4];
    s.read_exact(&mut h).map_err(|e| e.to_string())?;
    let n = u32::from_be_bytes(h) as usize;
    if n > 512 * 1024 {
        return Err("reply too large".into());
    }
    let mut b = vec![0u8; n];
    s.read_exact(&mut b).map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_slice(&b).map_err(|e| e.to_string())?;
    if v["ok"] == true {
        Ok(v["data"].clone())
    } else {
        Err(format!("{}: {}", v["error"]["code"], v["error"]["message"]))
    }
}

pub fn connect() -> Result<UnixStream, String> {
    let s = UnixStream::connect(MACHINE_SOCKET).map_err(|e| format!("machined: {e}"))?;
    s.set_read_timeout(Some(Duration::from_secs(10))).ok();
    Ok(s)
}

/// Wait until machined has a machine identity (first boot may still be running) and return it.
/// (machineInstallId, highest registry seq the broker ever acknowledged) from machined; waits until the machine has an identity.
pub fn machine_meta() -> (String, i64) {
    loop {
        if let Ok(mut s) = connect() {
            if let Ok(v) = call(&mut s, "status", json!({})) {
                if let Some(id) = v["meta"]["machineInstallId"].as_str() {
                    return (id.to_string(), v["meta"]["brokerAckedSeq"].as_i64().unwrap_or(0));
                }
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

pub fn ensure_schema(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch(SCHEMA_V5)
}

fn apply(c: &Connection, m: &Value) -> rusqlite::Result<()> {
    let seq = m["registrySeq"].as_i64().unwrap_or(0);
    let b = &m["body"];
    let store_of = |c: &Connection, ws: &str| -> rusqlite::Result<Option<String>> {
        c.query_row("SELECT store_uuid FROM machine_hosts WHERE workspace_id = ?1", [ws], |r| r.get(0)).optional()
    };
    let members = |c: &Connection, store: &str| -> rusqlite::Result<()> {
        for x in b["members"].as_array().cloned().unwrap_or_default() {
            c.execute(
                "INSERT INTO machine_members (store_uuid, user_id, role, member_version, state, registry_seq) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(store_uuid, user_id) DO UPDATE SET role=excluded.role, member_version=excluded.member_version, state=excluded.state, registry_seq=excluded.registry_seq WHERE excluded.registry_seq >= machine_members.registry_seq",
                params![store, x["userId"].as_str(), x["role"].as_str(), x["memberVersion"].as_i64(), x["state"].as_str(), seq],
            )?;
        }
        if let Some(inc) = b["workspaceIncarnation"].as_i64() {
            c.execute("UPDATE machine_hosts SET workspace_incarnation = ?2 WHERE store_uuid = ?1", params![store, inc])?;
        }
        if let Some(e) = b["machineControlEpoch"].as_i64() {
            c.execute("INSERT INTO broker_meta(key,value) VALUES ('machine_control_epoch', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [e.to_string()])?;
        }
        Ok(())
    };
    match m["kind"].as_str().unwrap_or_default() {
        "workspace.registered" => {
            let store = b["storeUUID"].as_str().unwrap_or_default();
            c.execute(
                "INSERT INTO machine_hosts (store_uuid, workspace_id, execution_uid, workspace_incarnation, state, registry_seq) VALUES (?1,?2,?3,?4,'active',?5) ON CONFLICT(store_uuid) DO UPDATE SET state='active', registry_seq=excluded.registry_seq",
                params![store, b["workspaceId"].as_str(), b["executionUid"].as_i64(), b["workspaceIncarnation"].as_i64().unwrap_or(1), seq],
            )?;
            // From registration on, this store accepts only protocol-3 writes (spec §14.3 minWriteProtocol).
            c.execute(
                "INSERT INTO workspace_protocol (store_uuid, min_write_protocol, registry_seq, revocation_high_water) VALUES (?1, 3, ?2, 0) ON CONFLICT(store_uuid) DO UPDATE SET min_write_protocol = MAX(min_write_protocol, 3), registry_seq = excluded.registry_seq",
                params![store, seq],
            )?;
        }
        "workspace.archived" => {
            c.execute("UPDATE machine_hosts SET state = 'archived', registry_seq = ?2 WHERE workspace_id = ?1", params![b["workspaceId"].as_str(), seq])?;
        }
        "members.snapshot" | "owner.changed" | "workspace.incarnation" | "member.revoking" => {
            if let Some(store) = store_of(c, b["workspaceId"].as_str().unwrap_or_default())? {
                members(c, &store)?;
                if m["kind"] == "member.revoking" {
                    c.execute("UPDATE workspace_protocol SET revocation_high_water = MAX(revocation_high_water, ?2) WHERE store_uuid = ?1", params![store, seq])?;
                }
            }
        }
        "user.disabled" => {
            c.execute("UPDATE machine_members SET state = 'revoked', registry_seq = ?2 WHERE user_id = ?1", params![b["userId"].as_str(), seq])?;
            c.execute("UPDATE workspace_protocol SET revocation_high_water = MAX(revocation_high_water, ?1)", params![seq])?;
        }
        "machine.control_epoch" => {
            if let Some(e) = b["machineControlEpoch"].as_i64() {
                c.execute("INSERT INTO broker_meta(key,value) VALUES ('machine_control_epoch', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [e.to_string()])?;
            }
        }
        "barrier.held" => {
            c.execute("INSERT INTO broker_meta(key,value) VALUES ('machine_barrier', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [b["barrierId"].as_str().unwrap_or("")])?;
        }
        "barrier.released" => {
            c.execute("DELETE FROM broker_meta WHERE key = 'machine_barrier'", [])?;
        }
        _ => {}
    }
    c.execute("INSERT INTO broker_meta(key,value) VALUES ('machine_registry_seq', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(excluded.value AS INTEGER) > CAST(broker_meta.value AS INTEGER)", [seq.to_string()])?;
    Ok(())
}

/// Pull/apply/ack loop. A message is acked only after its batch committed (the broker now enforces it).
pub fn sync_loop(b: Shared) {
    loop {
        let r = (|| -> Result<(), String> {
            let mut s = connect()?;
            loop {
                let v = call(&mut s, "registry.pull", json!({ "target": "broker" }))?;
                let msgs = v["messages"].as_array().cloned().unwrap_or_default();
                if let Some(last) = msgs.last().and_then(|m| m["registrySeq"].as_i64()) {
                    {
                        let g = b.db.lock().unwrap();
                        let c = g.as_ref().ok_or("broker log unavailable")?;
                        c.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
                        for m in &msgs {
                            if let Err(e) = apply(c, m) {
                                let _ = c.execute_batch("ROLLBACK");
                                return Err(e.to_string());
                            }
                        }
                        c.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                    }
                    call(&mut s, "registry.ack", json!({ "target": "broker", "registrySeq": last }))?;
                    continue;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        })();
        if let Err(e) = r {
            eprintln!("agentos-broker: machine registry sync: {e}");
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// A registered workspace Host for this peer UID and store, if any.
pub fn machine_host(c: &Connection, uid: u32, store: Option<&str>) -> Option<(String, String, i64)> {
    let r = match store {
        Some(s) => c.query_row("SELECT store_uuid, workspace_id, workspace_incarnation FROM machine_hosts WHERE execution_uid = ?1 AND store_uuid = ?2 AND state = 'active'", params![uid, s], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))),
        None => c.query_row("SELECT store_uuid, workspace_id, workspace_incarnation FROM machine_hosts WHERE execution_uid = ?1 AND state = 'active'", params![uid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))),
    };
    r.optional().ok().flatten()
}

fn meta_i64(c: &Connection, k: &str) -> i64 {
    c.query_row("SELECT value FROM broker_meta WHERE key = ?1", [k], |r| r.get::<_, String>(0)).optional().ok().flatten().and_then(|s| s.parse().ok()).unwrap_or(0)
}

/// Protocol-3 workspace check (spec §14.3): the write names its workspace, executor, principal and the registry
/// state it was decided under; every field is compared with the synced machine directory before the body is used.
pub fn check_v3(b: &Shared, peer_uid: u32, params: &Value) -> Result<Value, BErr> {
    let w = params.get("workspace").ok_or_else(|| BErr::new("INVALID_SYSTEM_PLAN", "protocol-3 write needs a workspace envelope"))?;
    let body = params.get("body").cloned().ok_or_else(|| BErr::new("INVALID_SYSTEM_PLAN", "protocol-3 write needs a body"))?;
    if params.as_object().map(|o| o.len()).unwrap_or(0) != 2 {
        return Err(BErr::new("INVALID_SYSTEM_PLAN", "unknown protocol-3 field"));
    }
    let mut unsigned = w.clone();
    let claimed = unsigned.as_object_mut().and_then(|o| o.remove("envelopeHash")).and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    let h = agentos_protocol::canonical::domain_hash(V3_DOMAIN, &json!({ "workspace": unsigned, "body": body })).map_err(|e| BErr::new("INVALID_SYSTEM_PLAN", e.0))?;
    if h != claimed {
        return Err(BErr::new("INVALID_SYSTEM_PLAN", "protocol-3 envelope hash does not match"));
    }
    let g = b.db.lock().unwrap();
    let c = g.as_ref().ok_or_else(|| BErr::new("BROKER_HISTORY_MISSING", "broker log unavailable"))?;
    let store = w["storeUuid"].as_str().unwrap_or_default();
    let (_, ws, inc) = machine_host(c, peer_uid, Some(store)).ok_or_else(|| BErr::new("BROKER_POLICY_DENIED", "this execution UID is not registered for that store"))?;
    if w["workspaceId"].as_str() != Some(ws.as_str()) || w["executionUid"].as_u64() != Some(peer_uid as u64) {
        return Err(BErr::new("BROKER_POLICY_DENIED", "workspace or executor does not match the machine directory"));
    }
    if w["workspaceIncarnation"].as_i64() != Some(inc) {
        return Err(BErr::new("BROKER_IDENTITY_MISMATCH", "workspace incarnation is stale"));
    }
    let synced = meta_i64(c, "machine_registry_seq");
    if w["registrySeq"].as_i64().unwrap_or(i64::MAX) > synced {
        return Err(BErr::new("REGISTRY_NOT_SYNCED", "the broker has not applied the directory state this write was decided under"));
    }
    if w["machineControlEpoch"].as_i64() != Some(meta_i64(c, "machine_control_epoch").max(1)) {
        return Err(BErr::new("SESSION_STALE", "machine control epoch changed"));
    }
    if c.query_row("SELECT 1 FROM broker_meta WHERE key = 'machine_barrier'", [], |_| Ok(())).optional().ok().flatten().is_some() {
        return Err(BErr::new("CHECKPOINT_INCOMPLETE", "a machine barrier holds new writes"));
    }
    let member = |user: &str, version: i64, need_owner: bool| -> Result<(), BErr> {
        let r: Option<(String, i64, String)> = c
            .query_row("SELECT role, member_version, state FROM machine_members WHERE store_uuid = ?1 AND user_id = ?2", params![store, user], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()
            .ok()
            .flatten();
        match r {
            Some((role, v, st)) if st == "active" && v == version && (!need_owner || role == "owner") && role != "viewer" => Ok(()),
            Some(_) => Err(BErr::new("MEMBERSHIP_REVOKED", "the member's authority changed")),
            None => Err(BErr::new("MEMBERSHIP_REVOKED", "unknown member")),
        }
    };
    match w["principalKind"].as_str().unwrap_or_default() {
        "user" | "run" => member(w["userId"].as_str().unwrap_or_default(), w["memberVersion"].as_i64().unwrap_or(-1), false)?,
        "maintenance" => member(w["approvedByUserId"].as_str().unwrap_or_default(), w["approvedMemberVersion"].as_i64().unwrap_or(-1), true)?,
        _ => return Err(BErr::new("INVALID_SYSTEM_PLAN", "unknown protocol-3 principal kind")),
    }
    Ok(body)
}
