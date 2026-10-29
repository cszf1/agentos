//! Protocol 2: the maintenance principal (v0.4 spec §13.3, §13.4, §16, §21.2).
//!
//! A workspace's maintenance controller may only keep registered units running, inside the install caps of the root
//! policy narrowed by the user's approved policy. The admission transaction checks policy/revocation/pause, resource
//! generation, the target control epoch (a user stop wins), cooldown and the rolling counts per target + action family,
//! then reserves one count in the same transaction as the operation row. Counts never reset on a new jobId, a new
//! policyVersion, a host restart or a new incarnation. Protocol-1 requests can never carry maintenance fields and a
//! maintenance request is never downgraded to a user/action request.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::db;
use crate::server::{check_identity_db, Session};
use crate::state::*;
use agentos_protocol::dto::*;

fn p<T: serde::de::DeserializeOwned>(v: &Value) -> Result<T, BErr> {
    serde_json::from_value(v.clone()).map_err(|e| BErr::new("INVALID_SYSTEM_PLAN", format!("params: {e}")))
}

pub struct Caps {
    pub per_hour: u32,
    pub per24h: u32,
    pub cooldown_seconds: u64,
}

/// Install caps for a maintenance target (the root policy's `maintenance` entries). None = no maintenance allowed.
pub fn install_caps(b: &Broker, store: &str, resource_id: &str, family: &str) -> Option<Caps> {
    let res = b.find_res(store, resource_id)?;
    if res.kind != "service" {
        return None;
    }
    let e = b.policy.maintenance.iter().find(|m| m.store_uuid == store && m.unit_key == res.key)?;
    if !e.action_families.iter().any(|f| f == family) {
        return None;
    }
    Some(Caps { per_hour: e.per_hour, per24h: e.per24h, cooldown_seconds: e.cooldown_seconds })
}

pub fn dispatch(b: &Shared, sess: &mut Session, method: &str, params: &Value) -> Result<Value, BErr> {
    match method {
        "maintenance-policy-sync" => policy_sync(b, sess, &p(params)?),
        "maintenance-policy-revoke" => policy_revoke(b, sess, &p(params)?),
        "maintenance-control" => control(b, sess, &p(params)?),
        "maintenance-state" => state(b, sess, &p(params)?),
        "maintenance-submit" => submit(b, sess, &p(params)?),
        m => Err(BErr::new("CAPABILITY_VERSION_UNSUPPORTED", format!("unknown protocol-2 method {m}"))),
    }
}

fn policy_sync(b: &Shared, sess: &mut Session, g: &MaintenancePolicySyncParams) -> Result<Value, BErr> {
    let mut guard = b.db.lock().unwrap();
    let c = db_or_diag(b, &mut guard)?;
    let (_, inc) = check_identity_db(b, c, sess, &g.identity, false)?;
    let want = agentos_protocol::domain_hash(MAINTENANCE_POLICY_DOMAIN, &g.hash_body()).map_err(|e| BErr::new("INVALID_SYSTEM_PLAN", e.0))?;
    if want != g.request_hash {
        return Err(BErr::new("PLAN_HASH_MISMATCH", "maintenance policy hash does not match its body"));
    }
    if !token_ok(&g.policy_id, 64) || !safe_u64(g.policy_version) || g.policy_version == 0 || !safe_u64(g.expires_at_ms) || !safe_u64(g.maintenance_epoch) {
        return Err(BErr::new("INVALID_SYSTEM_PLAN", "malformed maintenance policy"));
    }
    if g.action_family != MAINTENANCE_FAMILY_ENSURE_RUNNING {
        return Err(BErr::new("BROKER_POLICY_DENIED", "only service.ensure_state.running is a maintenance action in v0.4"));
    }
    let existing: Option<(String, Option<i64>)> = c
        .query_row(
            "SELECT request_hash, revoked_seq FROM maintenance_policies WHERE store_uuid=?1 AND incarnation=?4 AND policy_id=?2 AND policy_version=?3",
            params![g.identity.store_uuid, g.policy_id, g.policy_version as i64, inc],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((h, revoked)) = existing {
        if h != g.request_hash {
            return Err(BErr::new("OPERATION_CONFLICT", "same policy id/version with a different body"));
        }
        return Ok(
            json!({"policyId": g.policy_id, "policyVersion": g.policy_version, "state": if revoked.is_some() { "revoked" } else { "active" }, "replayed": true}),
        );
    }
    // Install caps: the user's policy may only narrow them (V4-P06).
    let caps = install_caps(b, &g.identity.store_uuid, &g.resource_id, &g.action_family)
        .ok_or_else(|| BErr::new("BROKER_POLICY_DENIED", "this unit is not registered for maintenance recovery in the root policy"))?;
    if g.bounds.per_hour == 0
        || g.bounds.per24h == 0
        || g.bounds.per_hour > caps.per_hour
        || g.bounds.per24h > caps.per24h
        || g.bounds.cooldown_seconds < caps.cooldown_seconds
    {
        return Err(BErr::new("BROKER_POLICY_DENIED", "the policy exceeds the install caps (per hour, per 24 h or cooldown)").with(json!({
            "caps": {"perHour": caps.per_hour, "per24h": caps.per24h, "cooldownSeconds": caps.cooldown_seconds}
        })));
    }
    if g.expires_at_ms as i64 <= now() || g.expires_at_ms as i64 > now() + 366 * 86_400_000 {
        return Err(BErr::new("INVALID_SYSTEM_PLAN", "policy expiry must be in the future and at most 365 days away"));
    }
    let gen: i64 = c.query_row("SELECT generation FROM resource_state WHERE resource_id=?1", params![g.resource_id], |r| r.get(0)).unwrap_or(-1);
    if gen as u64 != g.resource_generation {
        return Err(BErr::new("RESOURCE_GENERATION_STALE", format!("resource generation is {gen}")).with(json!({"generation": gen})));
    }
    let tx = c.unchecked_transaction()?;
    let seq = db::audit(
        &tx,
        "maintenance_policy_sync",
        Some(&g.identity.store_uuid),
        Some(inc),
        None,
        Some(&g.policy_id),
        &json!({"version": g.policy_version, "resource": g.resource_id, "bounds": g.bounds}),
    )?;
    tx.execute(
        "INSERT INTO maintenance_policies(store_uuid, incarnation, policy_id, policy_version, policy_hash, resource_id, resource_generation, action_family, bounds_json, expires_at, maintenance_epoch, request_hash, synced_seq)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            g.identity.store_uuid, inc, g.policy_id, g.policy_version as i64, g.policy_hash, g.resource_id, gen, g.action_family,
            serde_json::to_string(&g.bounds).unwrap(), g.expires_at_ms as i64, g.maintenance_epoch as i64, g.request_hash, seq
        ],
    )?;
    // An older version of the same policy stops being usable the moment a newer one is synced.
    tx.execute(
        "UPDATE maintenance_policies SET revoked_seq=?3 WHERE store_uuid=?1 AND policy_id=?2 AND (policy_version < ?4 OR incarnation < ?5) AND revoked_seq IS NULL",
        params![g.identity.store_uuid, g.policy_id, seq, g.policy_version as i64, inc],
    )?;
    tx.commit()?;
    Ok(json!({"policyId": g.policy_id, "policyVersion": g.policy_version, "state": "active", "seq": seq}))
}

fn policy_revoke(b: &Shared, sess: &mut Session, g: &MaintenancePolicyRevokeParams) -> Result<Value, BErr> {
    let mut guard = b.db.lock().unwrap();
    let c = db_or_diag(b, &mut guard)?;
    let (_, inc) = check_identity_db(b, c, sess, &g.identity, true)?;
    let tx = c.unchecked_transaction()?;
    let row: Option<Option<i64>> = tx
        .query_row(
            "SELECT revoked_seq FROM maintenance_policies WHERE store_uuid=?1 AND incarnation=?4 AND policy_id=?2 AND policy_version=?3",
            params![g.identity.store_uuid, g.policy_id, g.policy_version as i64, inc],
            |r| r.get(0),
        )
        .optional()?;
    let seq = match row {
        Some(Some(s)) => s,
        Some(None) => {
            let seq = db::audit(
                &tx,
                "maintenance_policy_revoke",
                Some(&g.identity.store_uuid),
                Some(inc),
                None,
                Some(&g.policy_id),
                &json!({"version": g.policy_version}),
            )?;
            tx.execute(
                "UPDATE maintenance_policies SET revoked_seq=?4 WHERE store_uuid=?1 AND policy_id=?2 AND policy_version <= ?3 AND revoked_seq IS NULL",
                params![g.identity.store_uuid, g.policy_id, g.policy_version as i64, seq],
            )?;
            seq
        }
        None => {
            // Unknown version: a revoked tombstone, so a late sync of that version can never activate.
            let seq = db::audit(
                &tx,
                "maintenance_policy_revoke_tombstone",
                Some(&g.identity.store_uuid),
                Some(inc),
                None,
                Some(&g.policy_id),
                &json!({"version": g.policy_version}),
            )?;
            tx.execute(
                "INSERT INTO maintenance_policies(store_uuid, incarnation, policy_id, policy_version, policy_hash, resource_id, resource_generation, action_family, bounds_json, expires_at, maintenance_epoch, request_hash, synced_seq, revoked_seq)
                 VALUES (?1,?2,?3,?4,'tombstone','',0,'','{}',0,0,'tombstone',?5,?5)",
                params![g.identity.store_uuid, inc, g.policy_id, g.policy_version as i64, seq],
            )?;
            tx.execute(
                "UPDATE maintenance_policies SET revoked_seq=?4 WHERE store_uuid=?1 AND policy_id=?2 AND policy_version < ?3 AND revoked_seq IS NULL",
                params![g.identity.store_uuid, g.policy_id, g.policy_version as i64, seq],
            )?;
            seq
        }
    };
    tx.commit()?;
    Ok(json!({"policyId": g.policy_id, "policyVersion": g.policy_version, "state": "revoked", "revokedSeq": seq}))
}

fn control(b: &Shared, sess: &mut Session, g: &MaintenanceControlParams) -> Result<Value, BErr> {
    if g.state != "running" && g.state != "paused" {
        return Err(BErr::new("INVALID_SYSTEM_PLAN", "state must be running or paused"));
    }
    if !safe_u64(g.maintenance_epoch) {
        return Err(BErr::new("INVALID_SYSTEM_PLAN", "epoch outside the safe range"));
    }
    let mut guard = b.db.lock().unwrap();
    let c = db_or_diag(b, &mut guard)?;
    let (_, inc) = check_identity_db(b, c, sess, &g.identity, false)?;
    let store = &g.identity.store_uuid;
    let tx = c.unchecked_transaction()?;
    // A new incarnation (restore) starts its own epoch sequence; inside one incarnation epochs only move forward, so a
    // late (older) control message never re-opens maintenance.
    let cur: Option<(String, i64)> = tx
        .query_row("SELECT state, maintenance_epoch FROM workspace_maintenance_state WHERE store_uuid=?1 AND incarnation=?2", params![store, inc], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    let applied_ws = match &cur {
        Some((_, e)) if (*e as u64) > g.maintenance_epoch => false,
        Some((s, e)) if (*e as u64) == g.maintenance_epoch && s == &g.state => false,
        _ => true,
    };
    let seq = db::audit(
        &tx,
        "maintenance_control",
        Some(store),
        Some(inc),
        None,
        None,
        &json!({"state": g.state, "epoch": g.maintenance_epoch, "target": g.target}),
    )?;
    if applied_ws {
        tx.execute(
            "INSERT INTO workspace_maintenance_state(store_uuid, incarnation, state, maintenance_epoch, updated_seq) VALUES (?1,?5,?2,?3,?4)
             ON CONFLICT(store_uuid, incarnation) DO UPDATE SET state=excluded.state, maintenance_epoch=excluded.maintenance_epoch, updated_seq=excluded.updated_seq",
            params![store, g.state, g.maintenance_epoch as i64, seq, inc],
        )?;
    }
    let mut target_epoch: Option<i64> = None;
    if let Some(t) = &g.target {
        if !safe_u64(t.control_epoch) {
            return Err(BErr::new("INVALID_SYSTEM_PLAN", "control epoch outside the safe range"));
        }
        let cur_t: Option<i64> = tx
            .query_row(
                "SELECT control_epoch FROM target_control_epochs WHERE store_uuid=?1 AND incarnation=?3 AND resource_id=?2",
                params![store, t.resource_id, inc],
                |r| r.get(0),
            )
            .optional()?;
        let next = cur_t.map(|e| e.max(t.control_epoch as i64)).unwrap_or(t.control_epoch as i64);
        tx.execute(
            "INSERT INTO target_control_epochs(store_uuid, incarnation, resource_id, control_epoch, updated_seq) VALUES (?1,?5,?2,?3,?4)
             ON CONFLICT(store_uuid, incarnation, resource_id) DO UPDATE SET control_epoch=MAX(control_epoch, excluded.control_epoch), updated_seq=excluded.updated_seq",
            params![store, t.resource_id, next, seq, inc],
        )?;
        target_epoch = Some(next);
    }
    tx.commit()?;
    let st: (String, i64) = c
        .query_row("SELECT state, maintenance_epoch FROM workspace_maintenance_state WHERE store_uuid=?1 AND incarnation=?2", params![store, inc], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap_or(("paused".into(), 0));
    Ok(json!({"state": st.0, "maintenanceEpoch": st.1, "applied": applied_ws, "targetControlEpoch": target_epoch, "seq": seq}))
}

pub fn counts(c: &Connection, store: &str, resource_id: &str, family: &str) -> (i64, i64, Option<i64>) {
    let t = now();
    let hour: i64 = c
        .query_row(
            "SELECT count(*) FROM maintenance_attempts WHERE store_uuid=?1 AND resource_id=?2 AND action_family=?3 AND admitted_at > ?4",
            params![store, resource_id, family, t - 3_600_000],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let day: i64 = c
        .query_row(
            "SELECT count(*) FROM maintenance_attempts WHERE store_uuid=?1 AND resource_id=?2 AND action_family=?3 AND admitted_at > ?4",
            params![store, resource_id, family, t - 86_400_000],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let last: Option<i64> = c
        .query_row(
            "SELECT max(admitted_at) FROM maintenance_attempts WHERE store_uuid=?1 AND resource_id=?2 AND action_family=?3",
            params![store, resource_id, family],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    (hour, day, last)
}

fn state(b: &Shared, sess: &mut Session, g: &MaintenanceStateParams) -> Result<Value, BErr> {
    let mut guard = b.db.lock().unwrap();
    let c = db_or_diag(b, &mut guard)?;
    let (_, inc) = check_identity_db(b, c, sess, &g.identity, true)?;
    let store = &g.identity.store_uuid;
    let ws: Option<(String, i64)> = c
        .query_row("SELECT state, maintenance_epoch FROM workspace_maintenance_state WHERE store_uuid=?1 AND incarnation=?2", params![store, inc], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    let mut st = c.prepare("SELECT policy_id, policy_version, resource_id, action_family, bounds_json, expires_at, revoked_seq, policy_hash FROM maintenance_policies WHERE store_uuid=?1 AND incarnation=?2 AND policy_hash <> 'tombstone' ORDER BY synced_seq DESC LIMIT 64")?;
    let policies: Vec<Value> = st
        .query_map(params![store, inc], |r| {
            let res: String = r.get(2)?;
            let fam: String = r.get(3)?;
            Ok(json!({
                "policyId": r.get::<_, String>(0)?, "policyVersion": r.get::<_, i64>(1)?, "resourceId": res, "actionFamily": fam,
                "bounds": serde_json::from_str::<Value>(&r.get::<_, String>(4)?).unwrap_or(Value::Null), "expiresAtMs": r.get::<_, i64>(5)?,
                "revoked": r.get::<_, Option<i64>>(6)?.is_some(), "policyHash": r.get::<_, String>(7)?,
            }))
        })?
        .filter_map(|x| x.ok())
        .collect();
    let mut out_p = vec![];
    for mut pv in policies {
        let (h, d, last) = counts(c, store, pv["resourceId"].as_str().unwrap_or(""), pv["actionFamily"].as_str().unwrap_or(""));
        pv["attempts"] = json!({"lastHour": h, "last24h": d, "lastAdmittedAtMs": last});
        out_p.push(pv);
    }
    let mut st2 = c.prepare("SELECT resource_id, control_epoch FROM target_control_epochs WHERE store_uuid=?1 AND incarnation=?2")?;
    let targets: Vec<Value> = st2
        .query_map(params![store, inc], |r| Ok(json!({"resourceId": r.get::<_, String>(0)?, "controlEpoch": r.get::<_, i64>(1)?})))?
        .filter_map(|x| x.ok())
        .collect();
    let caps: Vec<Value> = b
        .policy
        .maintenance
        .iter()
        .filter(|m| &m.store_uuid == store)
        .map(|m| json!({"unitKey": m.unit_key, "actionFamilies": m.action_families, "perHour": m.per_hour, "per24h": m.per24h, "cooldownSeconds": m.cooldown_seconds}))
        .collect();
    Ok(json!({
        "protocolVersion": PROTOCOL_V2, "incarnation": inc,
        "state": ws.as_ref().map(|w| w.0.clone()).unwrap_or_else(|| "paused".into()),
        "maintenanceEpoch": ws.map(|w| w.1).unwrap_or(0),
        "policies": out_p, "targets": targets, "installCaps": caps,
    }))
}

/// The maintenance write. Every check and the count reservation happen in the transaction that records the operation.
fn submit(b: &Shared, sess: &mut Session, env: &MaintenanceWriteEnvelope) -> Result<Value, BErr> {
    env.check().map_err(|m| match m.split_once(": ") {
        Some((code, rest)) if code.chars().all(|ch| ch.is_ascii_uppercase() || ch == '_') => BErr::new(code, rest),
        _ => BErr::new("INVALID_SYSTEM_PLAN", m),
    })?;
    let want = agentos_protocol::domain_hash(MAINTENANCE_WRITE_DOMAIN, &env.hash_body()).map_err(|e| BErr::new("INVALID_SYSTEM_PLAN", e.0))?;
    if want != env.request_hash {
        return Err(BErr::new("PLAN_HASH_MISMATCH", "requestHash does not match the maintenance envelope body"));
    }
    if env.capability_id != "service.ensure_state" || env.contract_version != 1 || env.params != json!({"state": "running"}) {
        return Err(BErr::new("BROKER_POLICY_DENIED", "a maintenance write is service.ensure_state(running) only"));
    }
    let id =
        Identity { machine_install_id: env.machine_install_id.clone(), store_uuid: env.store_uuid.clone(), workspace_incarnation: env.workspace_incarnation };
    let mut g = b.db.lock().unwrap();
    let c = db_or_diag(b, &mut g)?;
    let (_, inc) = check_identity_db(b, c, sess, &id, false)?;
    if let Some(v) = op_view(c, &b.install_id, &env.store_uuid, inc, &env.operation_id)? {
        if v["requestHash"] != env.request_hash {
            return Err(BErr::new("OPERATION_CONFLICT", "operationId already used with a different request").with(json!({"operation": v})));
        }
        return Ok(v); // the same operation: no second count
    }
    let store = &env.store_uuid;
    let family = MAINTENANCE_FAMILY_ENSURE_RUNNING;
    let res = b.find_res(store, &env.resource_id).ok_or_else(|| BErr::new("RESOURCE_NOT_BOUND", "resource is not in this workspace's catalog"))?;
    let caps = install_caps(b, store, &env.resource_id, family)
        .ok_or_else(|| BErr::new("BROKER_POLICY_DENIED", "this unit is not registered for maintenance recovery"))?;
    let tx = c.unchecked_transaction()?;
    let ws: Option<(String, i64)> = tx
        .query_row("SELECT state, maintenance_epoch FROM workspace_maintenance_state WHERE store_uuid=?1 AND incarnation=?2", params![store, inc], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    match &ws {
        Some((s, e)) if s == "running" && *e as u64 == env.maintenance_epoch => {}
        Some((s, e)) => {
            return Err(BErr::new("MAINTENANCE_DISABLED", format!("maintenance is {s} at epoch {e}; the request carries epoch {}", env.maintenance_epoch))
                .with(json!({"state": s, "maintenanceEpoch": e})))
        }
        None => return Err(BErr::new("MAINTENANCE_DISABLED", "maintenance control was never synced for this workspace")),
    }
    let pol: Option<(String, i64, String, String, i64, Option<i64>)> = tx
        .query_row(
            "SELECT resource_id, resource_generation, action_family, bounds_json, expires_at, revoked_seq FROM maintenance_policies WHERE store_uuid=?1 AND incarnation=?4 AND policy_id=?2 AND policy_version=?3",
            params![store, env.policy_id, env.policy_version as i64, inc],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional()?;
    let Some((p_res, p_gen, p_fam, p_bounds, p_exp, p_rev)) = pol else {
        return Err(BErr::new("POLICY_VERSION_STALE", "no synced maintenance policy with that id/version"));
    };
    if p_rev.is_some() {
        return Err(BErr::new("POLICY_VERSION_STALE", "the maintenance policy was revoked or superseded"));
    }
    if p_exp <= now() {
        return Err(BErr::new("POLICY_VERSION_STALE", "the maintenance policy expired"));
    }
    if p_res != env.resource_id || p_fam != family {
        return Err(BErr::new("BROKER_POLICY_DENIED", "the policy does not cover this resource/action"));
    }
    let gen: i64 = tx.query_row("SELECT generation FROM resource_state WHERE resource_id=?1", params![env.resource_id], |r| r.get(0)).unwrap_or(-1);
    if gen as u64 != env.resource_generation || gen != p_gen {
        return Err(BErr::new("RESOURCE_GENERATION_STALE", format!("resource generation is {gen}; the policy was approved for {p_gen}"))
            .with(json!({"generation": gen})));
    }
    let ce: i64 = tx
        .query_row(
            "SELECT control_epoch FROM target_control_epochs WHERE store_uuid=?1 AND incarnation=?3 AND resource_id=?2",
            params![store, env.resource_id, inc],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);
    if ce as u64 != env.target_control_epoch {
        return Err(BErr::new(
            "EXECUTION_EPOCH_STALE",
            format!("target control epoch is {ce}; the request carries {} (a user stop or newer control wins)", env.target_control_epoch),
        )
        .with(json!({"controlEpoch": ce})));
    }
    let quarantine: Option<String> =
        tx.query_row("SELECT quarantine_operation_id FROM resource_state WHERE resource_id=?1", params![env.resource_id], |r| r.get(0)).optional()?.flatten();
    if let Some(q) = quarantine {
        return Err(BErr::new("RESOURCE_BUSY", "the resource is quarantined by an unknown result; maintenance never clears it")
            .with(json!({"quarantineOperationId": q})));
    }
    let bounds: MaintenanceBounds = serde_json::from_str(&p_bounds).map_err(|e| BErr::new("INVALID_SYSTEM_PLAN", e.to_string()))?;
    let per_hour = bounds.per_hour.min(caps.per_hour) as i64;
    let per24h = bounds.per24h.min(caps.per24h) as i64;
    let cooldown = bounds.cooldown_seconds.max(caps.cooldown_seconds) as i64 * 1000;
    let (h, d, last) = counts(&tx, store, &env.resource_id, family);
    if h >= per_hour || d >= per24h {
        return Err(BErr::new("CIRCUIT_OPEN", format!("{h} attempts in the last hour / {d} in 24 h reach the limit ({per_hour}/{per24h})"))
            .with(json!({"lastHour": h, "last24h": d, "perHour": per_hour, "per24h": per24h})));
    }
    if let Some(l) = last {
        if now() - l < cooldown {
            return Err(
                BErr::new("CIRCUIT_OPEN", format!("cooldown: {} s remain", (cooldown - (now() - l)) / 1000)).with(json!({"cooldownUntilMs": l + cooldown}))
            );
        }
    }
    let total: i64 = tx.query_row("SELECT count(*) FROM effect_operations WHERE store_uuid=?1", params![store], |r| r.get(0))?;
    if total >= 100_000 {
        return Err(BErr::new("RESOURCE_BUSY", "operation log capacity reached; new admissions are refused"));
    }
    let maint = json!({
        "protocolVersion": PROTOCOL_V2, "jobId": env.job_id, "stepId": env.step_id, "policyId": env.policy_id, "policyVersion": env.policy_version,
        "maintenanceEpoch": env.maintenance_epoch, "targetControlEpoch": env.target_control_epoch, "triggerKey": env.trigger_key, "actionFamily": family,
    });
    let seq = db::audit(&tx, "maintenance_operation_accepted", Some(store), Some(inc), Some(&env.operation_id), Some(&env.policy_id), &maint)?;
    let w = env.as_write();
    tx.execute(
        "INSERT INTO effect_operations(machine_install_id, store_uuid, incarnation, operation_id, action_id, plan_hash, request_hash, envelope_json, capability_id, resource_id, resource_generation, replay_class, state, deadline_ms, accepted_seq, updated_seq, created_at, updated_at, maintenance_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'convergent','accepted',?12,?13,?13,?14,?14,?15)",
        params![
            b.install_id, store, inc, env.operation_id, env.action_id, env.plan_hash, env.request_hash, serde_json::to_string(&w).unwrap(),
            env.capability_id, env.resource_id, env.resource_generation as i64, env.deadline_ms as i64, seq, now(), maint.to_string()
        ],
    )?;
    // The count is reserved here and kept whatever the outcome (an admitted but unknown effect still counts).
    tx.execute(
        "INSERT INTO maintenance_attempts(store_uuid, incarnation, resource_id, action_family, operation_id, policy_id, policy_version, job_id, step_id, admitted_at, outcome, seq) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'pending',?11)",
        params![store, inc, env.resource_id, family, env.operation_id, env.policy_id, env.policy_version as i64, env.job_id, env.step_id, now(), seq],
    )?;
    tx.commit()?;
    let _ = res;
    let v = op_view(c, &b.install_id, store, inc, &env.operation_id)?.unwrap();
    drop(g);
    b.fault("broker.after_maintenance_accept");
    b.kick();
    Ok(v)
}

/// Executor admission re-check for a maintenance operation (replaces the grant check). Err = refuse with that code.
pub fn admission_check(c: &Connection, store: &str, inc: i64, maint: &Value, resource_id: &str, gen: i64) -> Result<(), (String, String)> {
    let e = |c: &str, m: String| Err((c.to_string(), m));
    let ws: Option<(String, i64)> = c
        .query_row("SELECT state, maintenance_epoch FROM workspace_maintenance_state WHERE store_uuid=?1 AND incarnation=?2", params![store, inc], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()
        .ok()
        .flatten();
    match ws {
        Some((s, ep)) if s == "running" && Some(ep) == maint["maintenanceEpoch"].as_i64() => {}
        Some((s, ep)) => return e("MAINTENANCE_DISABLED", format!("maintenance is {s} at epoch {ep}")),
        None => return e("MAINTENANCE_DISABLED", "maintenance control missing".into()),
    }
    let pid = maint["policyId"].as_str().unwrap_or("");
    let pv = maint["policyVersion"].as_i64().unwrap_or(0);
    let pol: Option<(Option<i64>, i64, i64)> = c
        .query_row("SELECT revoked_seq, expires_at, resource_generation FROM maintenance_policies WHERE store_uuid=?1 AND incarnation=?4 AND policy_id=?2 AND policy_version=?3", params![store, pid, pv, inc], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()
        .ok()
        .flatten();
    match pol {
        None => return e("POLICY_VERSION_STALE", "policy missing".into()),
        Some((Some(_), _, _)) => return e("POLICY_VERSION_STALE", "the policy was revoked before dispatch".into()),
        Some((None, exp, _)) if exp <= now() => return e("POLICY_VERSION_STALE", "the policy expired before dispatch".into()),
        Some((None, _, pg)) if pg != gen => return e("RESOURCE_GENERATION_STALE", "resource identity changed since approval".into()),
        _ => {}
    }
    let ce: i64 = c
        .query_row(
            "SELECT control_epoch FROM target_control_epochs WHERE store_uuid=?1 AND incarnation=?3 AND resource_id=?2",
            params![store, resource_id, inc],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
        .unwrap_or(0);
    if Some(ce) != maint["targetControlEpoch"].as_i64() {
        return e("EXECUTION_EPOCH_STALE", format!("target control epoch moved to {ce} (user stop wins)"));
    }
    Ok(())
}

pub fn maintenance_of(c: &Connection, install: &str, store: &str, inc: i64, op_id: &str) -> Option<Value> {
    c.query_row(
        "SELECT maintenance_json FROM effect_operations WHERE machine_install_id=?1 AND store_uuid=?2 AND incarnation=?3 AND operation_id=?4",
        params![install, store, inc, op_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
    .and_then(|s| serde_json::from_str(&s).ok())
}
