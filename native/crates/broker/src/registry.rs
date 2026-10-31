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

fn apply(c: &Connection, m: &Value, verdicts: &mut Vec<Value>) -> rusqlite::Result<()> {
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
        // V1-W10: before machined removes a workspace, the broker judges its effects. Any accepted/running/
        // reconciling or unresolved indeterminate effect, or a resource quarantined/locked by one of its operations,
        // blocks the deletion. The store stays fenced (no new writes) while deleting.
        "workspace.deleting" => {
            let store = b["storeUUID"].as_str().unwrap_or_default();
            // the host row stays non-active (fenced) without a broker schema change
            c.execute("UPDATE machine_hosts SET state = 'archived', registry_seq = ?2 WHERE store_uuid = ?1", params![store, seq])?;
            verdicts.push(delete_verdict(c, b)?);
        }
        "workspace.deleted" => {
            // tombstone: the host row stays fenced and the deletion is recorded; effect history is kept untouched
            c.execute("UPDATE machine_hosts SET state = 'archived', registry_seq = ?2 WHERE workspace_id = ?1", params![b["workspaceId"].as_str(), seq])?;
            if let Some(store) = store_of(c, b["workspaceId"].as_str().unwrap_or_default())? {
                c.execute("INSERT INTO broker_meta(key,value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![format!("workspace_deleted:{store}"), seq.to_string()])?;
            }
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

/// The broker's verdict on deleting one store (spec §8.2, V1-W10): unknown or in-flight effects and quarantines.
pub fn delete_verdict(c: &Connection, b: &Value) -> rusqlite::Result<Value> {
    let store = b["storeUUID"].as_str().unwrap_or_default();
    let mut st = c.prepare("SELECT operation_id, state FROM effect_operations WHERE store_uuid = ?1 AND (state IN ('accepted','running','reconciling') OR (state = 'indeterminate' AND resolution_json IS NULL))")?;
    let ops: Vec<Value> = st.query_map([store], |r| Ok(json!({ "operationId": r.get::<_, String>(0)?, "state": r.get::<_, String>(1)? })))?.collect::<Result<_, _>>()?;
    drop(st);
    let mut st = c.prepare("SELECT r.resource_id, r.status FROM resource_state r WHERE (r.quarantine_operation_id IS NOT NULL AND r.quarantine_operation_id IN (SELECT operation_id FROM effect_operations WHERE store_uuid = ?1)) OR (r.lock_operation_id IS NOT NULL AND r.lock_operation_id IN (SELECT operation_id FROM effect_operations WHERE store_uuid = ?1))")?;
    let res: Vec<Value> = st.query_map([store], |r| Ok(json!({ "resourceId": r.get::<_, String>(0)?, "status": r.get::<_, String>(1)? })))?.collect::<Result<_, _>>()?;
    Ok(json!({ "workspaceId": b["workspaceId"], "deleteId": b["deleteId"], "unresolved": (ops.len() + res.len()) as i64, "detail": { "operations": ops, "resources": res } }))
}

/// Pull/apply/ack loop. A message is acked only after its batch committed (the broker now enforces it).
/// Messages for other targets (a Host's quiesce, gateway state changes) take registry sequence numbers too. Once
/// every broker message up to `high` is applied, the broker's view is the directory's view at `high`, which is what a
/// Host's protocol-3 envelope may claim (m17 W09: without this, REGISTRY_NOT_SYNCED never cleared).
fn advance_high_water(c: &Connection, high: i64) -> rusqlite::Result<()> {
    if high > 0 {
        c.execute("INSERT INTO broker_meta(key,value) VALUES ('machine_registry_seq', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(excluded.value AS INTEGER) > CAST(broker_meta.value AS INTEGER)", [high.to_string()])?;
    }
    Ok(())
}

pub fn sync_loop(b: Shared) {
    loop {
        let r = (|| -> Result<(), String> {
            let mut s = connect()?;
            let mut verdicts: Vec<Value> = vec![];
            loop {
                let v = call(&mut s, "registry.pull", json!({ "target": "broker" }))?;
                let msgs = v["messages"].as_array().cloned().unwrap_or_default();
                // Complete up to here once this batch is applied (machined reads both in one core step).
                let high = v["registryHighWater"].as_i64().unwrap_or(0);
                if let Some(last) = msgs.last().and_then(|m| m["registrySeq"].as_i64()) {
                    {
                        let g = b.db.lock().unwrap();
                        let c = g.as_ref().ok_or("broker log unavailable")?;
                        c.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
                        verdicts.clear();
                        for m in &msgs {
                            if let Err(e) = apply(c, m, &mut verdicts) {
                                let _ = c.execute_batch("ROLLBACK");
                                return Err(e.to_string());
                            }
                        }
                        advance_high_water(c, high).map_err(|e| e.to_string())?;
                        c.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                    }
                    call(&mut s, "registry.ack", json!({ "target": "broker", "registrySeq": last }))?;
                    // after the batch committed: report deletion verdicts (machined ignores stale/repeated ones and
                    // asks again after a restart, so a verdict lost here is not a lost decision)
                    for v in verdicts.drain(..) {
                        let _ = call(&mut s, "workspaces.deleteVerdict", v);
                    }
                    continue;
                }
                if high > 0 {
                    let g = b.db.lock().unwrap();
                    let c = g.as_ref().ok_or("broker log unavailable")?;
                    if meta_i64(c, "machine_registry_seq") < high {
                        advance_high_water(c, high).map_err(|e| e.to_string())?;
                    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> (Connection, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!("broker-w10-{}.sqlite", std::process::id() as u64 * 1000 + rand_suffix()));
        let _ = std::fs::remove_file(&path);
        let c = crate::db::create(path.to_str().unwrap(), "machine-registry", "p1").unwrap();
        ensure_schema(&c).unwrap();
        (c, path)
    }
    fn rand_suffix() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos() as u64 % 1000
    }
    fn op(c: &Connection, store: &str, id: &str, state: &str) {
        c.execute(
            "INSERT INTO effect_operations(machine_install_id,store_uuid,incarnation,operation_id,action_id,plan_hash,request_hash,envelope_json,capability_id,resource_id,resource_generation,replay_class,state,deadline_ms,accepted_seq,updated_seq,created_at,updated_at) VALUES ('m',?1,1,?2,'a','p','r','{}','cap','res',1,'read',?3,1,1,1,1,1)",
            params![store, id, state],
        )
        .unwrap();
    }

    #[test]
    fn w10_delete_verdict_counts_only_this_stores_unresolved_effects() {
        let (c, path) = db();
        let reg = |seq: i64, ws: &str, store: &str| json!({ "registrySeq": seq, "kind": "workspace.registered", "body": { "workspaceId": ws, "storeUUID": store, "executionUid": 60000 + seq, "workspaceIncarnation": 1 } });
        let mut v = vec![];
        apply(&c, &reg(1, "wa", "sa"), &mut v).unwrap();
        apply(&c, &reg(2, "wb", "sb"), &mut v).unwrap();
        op(&c, "sa", "done", "succeeded");
        op(&c, "sa", "open", "indeterminate");
        op(&c, "sb", "other", "running");
        let del = |seq: i64| json!({ "registrySeq": seq, "kind": "workspace.deleting", "body": { "workspaceId": "wa", "storeUUID": "sa", "deleteId": "d1" } });
        apply(&c, &del(3), &mut v).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["unresolved"], 1, "only sa's unresolved indeterminate effect counts, not sb's or a succeeded one");
        assert_eq!(v[0]["deleteId"], "d1");
        // the store is fenced while deleting: no host writes for it
        assert!(machine_host(&c, 60001, Some("sa")).is_none());
        // once resolved the verdict is clean
        c.execute("UPDATE effect_operations SET resolution_json = '{}' WHERE operation_id = 'open'", []).unwrap();
        v.clear();
        apply(&c, &del(4), &mut v).unwrap();
        assert_eq!(v[0]["unresolved"], 0);
        // a quarantine held by one of its operations blocks too
        c.execute("INSERT INTO resource_state (resource_id, store_uuid, kind, catalog_key, generation, status, quarantine_operation_id, updated_at) VALUES ('r1','sa','serial','k',1,'quarantined','done',1)", []).unwrap();
        v.clear();
        apply(&c, &del(5), &mut v).unwrap();
        assert_eq!(v[0]["unresolved"], 1);
        apply(&c, &json!({ "registrySeq": 6, "kind": "workspace.deleted", "body": { "workspaceId": "wa" } }), &mut v).unwrap();
        let st: String = c.query_row("SELECT state FROM machine_hosts WHERE store_uuid = 'sa'", [], |r| r.get(0)).unwrap();
        assert_eq!(st, "archived");
        assert!(crate::db::meta(&c, "workspace_deleted:sa").is_some());
        let kept: i64 = c.query_row("SELECT COUNT(*) FROM effect_operations WHERE store_uuid = 'sa'", [], |r| r.get(0)).unwrap();
        assert_eq!(kept, 2, "effect history is kept");
        drop(c);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn f04_broker_fences_writes_across_a_directory_gap_revocation_and_incarnation() {
        use std::sync::{Arc, Condvar, Mutex};
        let (c, path) = db();
        let mut v = vec![];
        apply(&c, &json!({ "registrySeq": 1, "kind": "workspace.registered", "body": { "workspaceId": "wa", "storeUUID": "sa", "executionUid": 60001, "workspaceIncarnation": 1 } }), &mut v).unwrap();
        let snap = |seq: i64, v2: i64, st2: &str| json!({ "registrySeq": seq, "kind": if st2 == "active" { "members.snapshot" } else { "member.revoking" }, "body": { "workspaceId": "wa", "members": [
            { "userId": "u1", "role": "owner", "memberVersion": 1, "state": "active" }, { "userId": "u2", "role": "editor", "memberVersion": v2, "state": st2 } ] } });
        apply(&c, &snap(2, 1, "active"), &mut v).unwrap();
        let w = |pol: &str| json!({ "policyFormat": 1, "machineInstallId": pol, "hosts": [], "managedRoots": [], "labNetworks": [], "serial": [], "units": [],
            "workers": { "file": { "socket": "/run/f.sock", "unit": "f.service", "uid": 961 }, "service": { "socket": "/run/s.sock", "unit": "s.service", "uid": 961 },
                         "network": { "socket": "/run/n.sock", "unit": "n.service", "uid": 961 }, "serial": { "socket": "/run/r.sock", "unit": "r.service", "uid": 961 } }, "testMode": false });
        let b: Shared = Arc::new(crate::state::Broker {
            db: Mutex::new(Some(c)), diag: None, policy: serde_json::from_value(w("m")).unwrap(), policy_version: "p1".into(),
            instance_id: "bi".into(), install_id: "m".into(), wake: (Mutex::new(false), Condvar::new()),
        });
        let env = |user: &str, ver: i64, seq: i64, inc: i64| {
            let ws = json!({ "workspaceId": "wa", "storeUuid": "sa", "executionUid": 60001, "workspaceIncarnation": inc, "machineControlEpoch": 1, "registrySeq": seq,
                             "principalKind": "user", "userId": user, "memberVersion": ver });
            let body = json!({ "op": "x" });
            let h = agentos_protocol::canonical::domain_hash(V3_DOMAIN, &json!({ "workspace": ws, "body": body })).unwrap();
            let mut ws2 = ws.clone();
            ws2["envelopeHash"] = json!(h);
            json!({ "workspace": ws2, "body": body })
        };
        let code = |r: Result<Value, BErr>| r.err().map(|e| e.code).unwrap_or_else(|| "OK".into());
        assert_eq!(code(check_v3(&b, 60001, &env("u2", 1, 2, 1))), "OK");
        // another execution UID cannot use this workspace's envelope (executor fence)
        assert_eq!(code(check_v3(&b, 60002, &env("u2", 1, 2, 1))), "BROKER_POLICY_DENIED");
        // broker↔machined cut: machined already revoked u2 at seq 3 and the Host applied it; the broker has not.
        // A write decided under seq 3 is refused (never acted on a directory the broker has not seen)
        assert_eq!(code(check_v3(&b, 60001, &env("u2", 2, 3, 1))), "REGISTRY_NOT_SYNCED");
        assert_eq!(code(check_v3(&b, 60001, &env("u1", 1, 3, 1))), "REGISTRY_NOT_SYNCED");
        // reconnect: the broker applies the revocation; u2's old and new versions are both refused, u1 continues
        apply(&b.db.lock().unwrap().as_ref().unwrap(), &snap(3, 2, "revoking"), &mut v).unwrap();
        assert_eq!(code(check_v3(&b, 60001, &env("u2", 1, 3, 1))), "MEMBERSHIP_REVOKED");
        assert_eq!(code(check_v3(&b, 60001, &env("u2", 2, 3, 1))), "MEMBERSHIP_REVOKED");
        assert_eq!(code(check_v3(&b, 60001, &env("u1", 1, 3, 1))), "OK");
        // the revocation raised the store's revocation high-water mark (the broker's ack basis)
        let hw: i64 = b.db.lock().unwrap().as_ref().unwrap().query_row("SELECT revocation_high_water FROM workspace_protocol WHERE store_uuid='sa'", [], |r| r.get(0)).unwrap();
        assert_eq!(hw, 3);
        // a new incarnation (restart/restore) fences the old executor instance
        apply(&b.db.lock().unwrap().as_ref().unwrap(), &json!({ "registrySeq": 4, "kind": "workspace.incarnation", "body": { "workspaceId": "wa", "workspaceIncarnation": 2, "members": [] } }), &mut v).unwrap();
        assert_eq!(code(check_v3(&b, 60001, &env("u1", 1, 4, 1))), "BROKER_IDENTITY_MISMATCH");
        assert_eq!(code(check_v3(&b, 60001, &env("u1", 1, 4, 2))), "OK");
        let _ = std::fs::remove_file(path);
    }

}
