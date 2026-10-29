//! Execution log, admission, dispatch, reconciliation (spec §11.3, §17). The admission transaction is the
//! linearization point: grants, cancellation, resource locks, generation and deadline are checked and the dispatch
//! fence is committed before any target system call. Unknown outcomes become `indeterminate` and keep the resource
//! quarantined until reconciliation or an explicit operator decision.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::time::Duration;

use crate::db;
use crate::state::*;
use agentos_protocol::dto::*;
use agentos_protocol::worker::CallError;

const MAX_AUTO_RECONCILE: i64 = 2;

pub struct Obs {
    pub digest: String,
    pub version: String,
    pub details: Value,
}

fn ce(e: CallError) -> BErr {
    BErr::new(&e.code, e.message)
}

/// Observe a resource's identity and version through its worker (or the broker's own read for files' roots).
pub fn observe(b: &Broker, r: &CatalogRes) -> Result<Obs, BErr> {
    let v = b.call_worker(r.kind, "observe", &r.target, json!({}), None, None, 5000).map_err(ce)?;
    let identity = v.get("identity").cloned().unwrap_or(Value::Null);
    let version = v.get("version").and_then(|x| x.as_str()).unwrap_or("").to_string();
    Ok(Obs { digest: digest(&identity), version, details: v })
}

/// Record an observation: a changed identity increases the generation (old grants and plans become stale).
pub fn apply_observation(c: &Connection, r: &CatalogRes, obs: &Result<Obs, BErr>) -> Result<(i64, String, Option<String>), BErr> {
    let (gen, digest, quarantine): (i64, Option<String>, Option<String>) =
        c.query_row("SELECT generation, identity_digest, quarantine_operation_id FROM resource_state WHERE resource_id=?1", params![r.resource_id], |x| Ok((x.get(0)?, x.get(1)?, x.get(2)?)))?;
    match obs {
        Ok(o) => {
            let mut g = gen;
            if let Some(d) = &digest {
                if d != &o.digest {
                    g += 1;
                    db::audit(c, "resource_generation", None, None, None, None, &json!({"resource": r.resource_id, "generation": g, "reason": "identity changed"}))?;
                }
            }
            let status = if quarantine.is_some() { "quarantined" } else { "available" };
            c.execute("UPDATE resource_state SET generation=?2, identity_digest=?3, observed_version=?4, status=?5, updated_at=?6 WHERE resource_id=?1", params![r.resource_id, g, o.digest, o.version, status, now()])?;
            Ok((g, status.into(), quarantine))
        }
        Err(e) => {
            let status = if e.code == "RESOURCE_GONE" { "gone" } else { "unavailable" };
            c.execute("UPDATE resource_state SET status=?2, updated_at=?3 WHERE resource_id=?1", params![r.resource_id, status, now()])?;
            Ok((gen, status.into(), quarantine))
        }
    }
}

fn get_range(v: &Value) -> Option<(u64, u64)> {
    Some((v.get("min")?.as_u64()?, v.get("max")?.as_u64()?))
}

/// G01: limits a host asks for must be inside the installed caps for that resource.
pub fn check_limits_within_policy(cap: &str, limits: &Value, caps: &Value) -> Result<(), BErr> {
    let deny = |m: &str| Err(BErr::new("BROKER_POLICY_DENIED", m.to_string()));
    let obj = limits.as_object().ok_or_else(|| BErr::new("INVALID_SYSTEM_PLAN", "limits must be an object"))?;
    match cap {
        "file.write_text_atomic" => {
            let mb = obj.get("maxBytes").and_then(|x| x.as_u64()).ok_or_else(|| BErr::new("INVALID_SYSTEM_PLAN", "maxBytes required"))?;
            if mb > caps["maxFileBytes"].as_u64().unwrap_or(0) {
                return deny("maxBytes exceeds the installed limit");
            }
        }
        "service.ensure_state" => {
            let st = obj.get("states").and_then(|x| x.as_array()).ok_or_else(|| BErr::new("INVALID_SYSTEM_PLAN", "states required"))?;
            for s in st {
                if s != "running" && s != "stopped" {
                    return deny("only running/stopped are installable states");
                }
            }
        }
        "service.set_limit" => {
            if obj.is_empty() {
                return Err(BErr::new("INVALID_SYSTEM_PLAN", "set_limit grants need explicit ranges"));
            }
            for (k, v) in obj {
                if k != "CPUQuotaPerSecUSec" && k != "MemoryMax" {
                    return deny("unknown limit property");
                }
                let (lo, hi) = get_range(v).ok_or_else(|| BErr::new("INVALID_SYSTEM_PLAN", "range needs min/max"))?;
                let (plo, phi) = get_range(&caps[k]).ok_or_else(|| BErr::new("BROKER_POLICY_DENIED", "property not installable"))?;
                if lo < plo || hi > phi || lo > hi {
                    return deny(&format!("{k} range {lo}..{hi} is outside the installed {plo}..{phi}"));
                }
            }
        }
        "network.apply_profile" => {
            let pr = obj.get("profiles").and_then(|x| x.as_array()).ok_or_else(|| BErr::new("INVALID_SYSTEM_PLAN", "profiles required"))?;
            let allowed = caps["profiles"].as_array().cloned().unwrap_or_default();
            if pr.iter().any(|p| !allowed.contains(p)) {
                return deny("profile not in the installed catalog");
            }
        }
        "serial.exchange" => {
            let cm = obj.get("commands").and_then(|x| x.as_array()).ok_or_else(|| BErr::new("INVALID_SYSTEM_PLAN", "commands required"))?;
            if cm.iter().any(|x| x != "SAMPLE" && x != "ECHO") {
                return deny("command not in the installed profile");
            }
        }
        _ => {
            if !obj.is_empty() {
                return deny("read capabilities take no limits");
            }
        }
    }
    Ok(())
}

/// The normalized parameters must fall inside the grant limits and the installed caps.
fn params_within(cap: &str, p: &Value, limits: &Value, caps: &Value) -> Result<(), BErr> {
    let deny = |m: String| Err(BErr::new("BROKER_POLICY_DENIED", m));
    match cap {
        "file.write_text_atomic" => {
            let n = p["content"].as_str().map(|s| s.len() as u64).unwrap_or(0);
            if n > limits["maxBytes"].as_u64().unwrap_or(0) || n > caps["maxFileBytes"].as_u64().unwrap_or(0) {
                return deny(format!("content of {n} bytes exceeds the granted limit"));
            }
        }
        "service.ensure_state" => {
            if !limits["states"].as_array().map(|a| a.contains(&p["state"])).unwrap_or(false) {
                return deny("target state is not granted".into());
            }
        }
        "service.set_limit" => {
            let prop = p["property"].as_str().unwrap_or("");
            let v = p["value"].as_u64().unwrap_or(u64::MAX);
            let (lo, hi) = get_range(&limits[prop]).ok_or_else(|| BErr::new("BROKER_POLICY_DENIED", "property not granted"))?;
            let (plo, phi) = get_range(&caps[prop]).ok_or_else(|| BErr::new("BROKER_POLICY_DENIED", "property not installable"))?;
            if v < lo.max(plo) || v > hi.min(phi) {
                return deny(format!("{prop}={v} is outside {}..{}", lo.max(plo), hi.min(phi)));
            }
        }
        "network.apply_profile" => {
            if !limits["profiles"].as_array().map(|a| a.contains(&p["profileId"])).unwrap_or(false) {
                return deny("profile not granted".into());
            }
        }
        "serial.exchange" => {
            if !limits["commands"].as_array().map(|a| a.contains(&p["command"])).unwrap_or(false) {
                return deny("serial command not granted".into());
            }
        }
        _ => {}
    }
    Ok(())
}

struct GrantRow {
    principal: Value,
    capability: String,
    resource: String,
    generation: i64,
    limits: Value,
    params_hash: Option<String>,
    expires: i64,
    revoked: bool,
}

fn load_grant(c: &Connection, store: &str, id: &str, ver: u64) -> Result<Option<GrantRow>, BErr> {
    Ok(c
        .query_row(
            "SELECT principal_json, capability_id, resource_id, resource_generation, limits_json, params_hash, expires_at, revoked_seq FROM broker_grants WHERE grant_id=?1 AND grant_version=?2 AND store_uuid=?3",
            params![id, ver as i64, store],
            |r| {
                Ok(GrantRow {
                    principal: serde_json::from_str(&r.get::<_, String>(0)?).unwrap_or(Value::Null),
                    capability: r.get(1)?,
                    resource: r.get(2)?,
                    generation: r.get(3)?,
                    limits: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or(Value::Null),
                    params_hash: r.get(5)?,
                    expires: r.get(6)?,
                    revoked: r.get::<_, Option<i64>>(7)?.is_some(),
                })
            },
        )
        .optional()?)
}

fn grant_usable(g: &Option<GrantRow>, cap: &str, res: &str, gen: i64) -> Result<(), BErr> {
    let Some(g) = g else { return Err(BErr::new("PROVIDER_GRANT_REQUIRED", "no broker grant with that id/version")) };
    if g.revoked {
        return Err(BErr::new("GRANT_REVOKED", "the grant was revoked"));
    }
    if g.expires <= now() {
        return Err(BErr::new("GRANT_REVOKED", "the grant expired"));
    }
    if g.capability != cap || g.resource != res {
        return Err(BErr::new("PROVIDER_GRANT_REQUIRED", "grant does not cover this capability/resource"));
    }
    if g.generation != gen {
        return Err(BErr::new("RESOURCE_GENERATION_STALE", "grant was issued for another resource generation"));
    }
    Ok(())
}

// ---------------------------------------------------------------- read

pub fn read<F>(b: &Shared, _uid: u32, _store: Option<&str>, r: &ReadParams, check: F) -> Result<Value, BErr>
where
    F: Fn(&Connection, &Identity) -> Result<(String, i64), BErr>,
{
    let cap = agentos_protocol::params::capability(&r.capability_id).ok_or_else(|| BErr::new("CAPABILITY_VERSION_UNSUPPORTED", "unknown capability"))?;
    if cap.write {
        return Err(BErr::new("INVALID_SYSTEM_PLAN", "read accepts read-only capabilities only"));
    }
    let params = agentos_protocol::params::check_params(&r.capability_id, &r.params).map_err(|m| split_err(&m))?;
    let res = b.find_res(&r.identity.store_uuid, &r.resource_id).ok_or_else(|| BErr::new("RESOURCE_NOT_BOUND", "resource is not in this workspace's catalog"))?;
    {
        let g = b.db.lock().unwrap();
        let c = g.as_ref().ok_or_else(|| BErr::new("BROKER_HISTORY_MISSING", "log unavailable"))?;
        check(c, &r.identity)?;
        let gen: i64 = c.query_row("SELECT generation FROM resource_state WHERE resource_id=?1", params![r.resource_id], |x| x.get(0))?;
        if gen as u64 != r.resource_generation {
            return Err(BErr::new("RESOURCE_GENERATION_STALE", format!("resource generation is {gen}")).with(json!({"generation": gen})));
        }
        // Read grants are looked up by id at any version: the newest unrevoked one counts.
        let g2: Option<(i64, String, String, i64, i64, Option<i64>)> = c
            .query_row(
                "SELECT grant_version, capability_id, resource_id, resource_generation, expires_at, revoked_seq FROM broker_grants WHERE grant_id=?1 AND store_uuid=?2 ORDER BY grant_version DESC LIMIT 1",
                params![r.grant_id, r.identity.store_uuid],
                |x| Ok((x.get(0)?, x.get(1)?, x.get(2)?, x.get(3)?, x.get(4)?, x.get(5)?)),
            )
            .optional()?;
        match g2 {
            None => return Err(BErr::new("PROVIDER_GRANT_REQUIRED", "no broker grant with that id")),
            Some((_, _, _, _, _, Some(_))) => return Err(BErr::new("GRANT_REVOKED", "the grant was revoked")),
            Some((_, _, _, _, exp, None)) if exp <= now() => return Err(BErr::new("GRANT_REVOKED", "the grant expired")),
            Some((_, capid, rid, gg, _, None)) => {
                if capid != r.capability_id || rid != r.resource_id || gg != gen {
                    return Err(BErr::new("PROVIDER_GRANT_REQUIRED", "grant does not cover this read"));
                }
            }
        }
    }
    let v = b.call_worker(res.kind, "read", &res.target, json!({"capabilityId": r.capability_id, "params": params}), None, None, 3000).map_err(ce)?;
    Ok(json!({"resourceId": res.resource_id, "resourceGeneration": r.resource_generation, "observedAt": now(), "data": v}))
}

fn split_err(m: &str) -> BErr {
    match m.split_once(": ") {
        Some((code, msg)) if code.chars().all(|c| c.is_ascii_uppercase() || c == '_') => BErr::new(code, msg),
        _ => BErr::new("INVALID_SYSTEM_PLAN", m),
    }
}

// ---------------------------------------------------------------- submit

pub fn submit<F>(b: &Shared, env: &WriteEnvelope, check: F) -> Result<Value, BErr>
where
    F: Fn(&Connection, &Identity) -> Result<(String, i64), BErr>,
{
    env.check().map_err(|m| split_err(&m))?;
    let want = agentos_protocol::domain_hash("agentos.broker.write.v1", &env.hash_body()).map_err(|e| BErr::new("INVALID_SYSTEM_PLAN", e.0))?;
    if want != env.request_hash {
        return Err(BErr::new("PLAN_HASH_MISMATCH", "requestHash does not match the envelope body"));
    }
    let cap = agentos_protocol::params::capability(&env.capability_id).ok_or_else(|| BErr::new("CAPABILITY_VERSION_UNSUPPORTED", "unknown capability"))?;
    if !cap.write || env.contract_version != 1 {
        return Err(BErr::new("CAPABILITY_VERSION_UNSUPPORTED", "not a supported write capability/contract"));
    }
    let normalized = agentos_protocol::params::check_params(&env.capability_id, &env.params).map_err(|m| split_err(&m))?;
    if normalized != env.params {
        return Err(BErr::new("INVALID_SYSTEM_PLAN", "params are not in normalized form"));
    }
    let id = Identity { machine_install_id: env.machine_install_id.clone(), store_uuid: env.store_uuid.clone(), workspace_incarnation: env.workspace_incarnation };
    let mut g = b.db.lock().unwrap();
    let c = db_or_diag(b, &mut g)?;
    let (_state, inc) = check(c, &id)?;
    if let Some(v) = op_view(c, &b.install_id, &env.store_uuid, inc, &env.operation_id)? {
        if v["requestHash"] != env.request_hash {
            return Err(BErr::new("OPERATION_CONFLICT", "operationId already used with a different request").with(json!({"operation": v})));
        }
        return Ok(v);
    }
    let res = b.find_res(&env.store_uuid, &env.resource_id).ok_or_else(|| BErr::new("RESOURCE_NOT_BOUND", "resource is not in this workspace's catalog"))?;
    if !cap.kinds.contains(&res.kind) {
        return Err(BErr::new("BROKER_POLICY_DENIED", "capability does not apply to that resource kind"));
    }
    // Early grant check (spec §8.3): a request under a revoked/expired/foreign grant is refused before acceptance.
    // Admission re-checks under the same lock, so a revoke committed between the two still wins.
    if !matches!(c.query_row("SELECT 1 FROM cancel_tombstones WHERE machine_install_id=?1 AND store_uuid=?2 AND incarnation=?3 AND operation_id=?4", params![b.install_id, env.store_uuid, inc, env.operation_id], |_| Ok(())).optional()?, Some(())) {
        let gen: i64 = c.query_row("SELECT generation FROM resource_state WHERE resource_id=?1", params![env.resource_id], |r| r.get(0)).unwrap_or(-1);
        grant_usable(&load_grant(c, &env.store_uuid, &env.grant_id, env.grant_version)?, &env.capability_id, &env.resource_id, gen)?;
    }
    // Capacity: business terminal records and tombstones are never deleted; refuse new admissions first (spec §24.1).
    let total: i64 = c.query_row("SELECT count(*) FROM effect_operations WHERE store_uuid=?1", params![env.store_uuid], |r| r.get(0))?;
    if total >= 100_000 {
        return Err(BErr::new("RESOURCE_BUSY", "operation log capacity reached; new admissions are refused"));
    }
    let tx = c.unchecked_transaction()?;
    let seq = db::audit(&tx, "operation_accepted", Some(&env.store_uuid), Some(inc), Some(&env.operation_id), Some(&env.grant_id), &json!({"capability": env.capability_id, "resource": env.resource_id}))?;
    let tomb: Option<String> = tx
        .query_row("SELECT reason FROM cancel_tombstones WHERE machine_install_id=?1 AND store_uuid=?2 AND incarnation=?3 AND operation_id=?4", params![b.install_id, env.store_uuid, inc, env.operation_id], |r| r.get(0))
        .optional()?;
    let (state, cert, evk, err) = match &tomb {
        Some(_) => ("cancelled_no_effect", Some("none"), Some("cancel_tombstone"), Some(("CANCELLED", "a cancellation was recorded before this request arrived"))),
        None => ("accepted", None, None, None),
    };
    tx.execute(
        "INSERT INTO effect_operations(machine_install_id, store_uuid, incarnation, operation_id, action_id, plan_hash, request_hash, envelope_json, capability_id, resource_id, resource_generation, replay_class, state, effect_certainty, evidence_kind, error_code, error_message, deadline_ms, compensates_operation_id, accepted_seq, updated_seq, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?20,?21,?21)",
        params![
            b.install_id, env.store_uuid, inc, env.operation_id, env.action_id, env.plan_hash, env.request_hash, serde_json::to_string(env).unwrap(),
            env.capability_id, env.resource_id, env.resource_generation as i64, cap.replay, state, cert, evk, err.map(|e| e.0), err.map(|e| e.1),
            env.deadline_ms as i64, env.compensates_operation_id, seq, now()
        ],
    )?;
    tx.commit()?;
    let v = op_view(c, &b.install_id, &env.store_uuid, inc, &env.operation_id)?.unwrap();
    drop(g);
    b.fault("broker.after_accept");
    b.kick();
    Ok(v)
}

// ---------------------------------------------------------------- cancel / resolve

pub fn cancel<F>(b: &Shared, p: &CancelParams, check: F) -> Result<Value, BErr>
where
    F: Fn(&Connection, &Identity) -> Result<(String, i64), BErr>,
{
    if !token_ok(&p.operation_id, 64) {
        return Err(BErr::new("INVALID_SYSTEM_PLAN", "malformed operationId"));
    }
    let mut g = b.db.lock().unwrap();
    let c = db_or_diag(b, &mut g)?;
    let (_, inc) = check(c, &p.identity)?;
    let tx = c.unchecked_transaction()?;
    let st: Option<String> = tx
        .query_row("SELECT state FROM effect_operations WHERE machine_install_id=?1 AND store_uuid=?2 AND incarnation=?3 AND operation_id=?4", params![b.install_id, p.identity.store_uuid, inc, p.operation_id], |r| r.get(0))
        .optional()?;
    match st.as_deref() {
        None => {
            let seq = db::audit(&tx, "cancel_tombstone", Some(&p.identity.store_uuid), Some(inc), Some(&p.operation_id), None, &json!({"reason": p.reason}))?;
            tx.execute(
                "INSERT INTO cancel_tombstones(machine_install_id, store_uuid, incarnation, operation_id, reason, seq) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT DO NOTHING",
                params![b.install_id, p.identity.store_uuid, inc, p.operation_id, p.reason, seq],
            )?;
            tx.commit()?;
            return Ok(json!({"operationId": p.operation_id, "state": "cancelled_no_effect", "tombstone": true}));
        }
        Some("accepted") => {
            let seq = db::audit(&tx, "operation_cancelled", Some(&p.identity.store_uuid), Some(inc), Some(&p.operation_id), None, &json!({"reason": p.reason, "before": "admission"}))?;
            tx.execute(
                "UPDATE effect_operations SET state='cancelled_no_effect', effect_certainty='none', evidence_kind='cancelled_before_admission', error_code='CANCELLED', error_message=?5, updated_seq=?6, updated_at=?7 WHERE machine_install_id=?1 AND store_uuid=?2 AND incarnation=?3 AND operation_id=?4",
                params![b.install_id, p.identity.store_uuid, inc, p.operation_id, p.reason, seq, now()],
            )?;
        }
        Some("running") | Some("reconciling") => {
            let seq = db::audit(&tx, "cancel_requested", Some(&p.identity.store_uuid), Some(inc), Some(&p.operation_id), None, &json!({"reason": p.reason}))?;
            tx.execute(
                "UPDATE effect_operations SET cancel_requested=1, updated_seq=?5, updated_at=?6 WHERE machine_install_id=?1 AND store_uuid=?2 AND incarnation=?3 AND operation_id=?4",
                params![b.install_id, p.identity.store_uuid, inc, p.operation_id, seq, now()],
            )?;
        }
        Some(_) => {}
    }
    tx.commit()?;
    Ok(op_view(c, &b.install_id, &p.identity.store_uuid, inc, &p.operation_id)?.unwrap())
}

pub fn resolve<F>(b: &Shared, p: &ResolveParams, check: F) -> Result<Value, BErr>
where
    F: Fn(&Connection, &Identity) -> Result<(String, i64), BErr>,
{
    if !["confirmed_applied", "confirmed_not_applied", "accept_unknown"].contains(&p.decision.as_str()) {
        return Err(BErr::new("INVALID_SYSTEM_PLAN", "decision must be confirmed_applied, confirmed_not_applied or accept_unknown"));
    }
    if !p.observed_evidence.is_object() || p.observed_evidence.to_string().len() > 16 * 1024 {
        return Err(BErr::new("INVALID_SYSTEM_PLAN", "observedEvidence must be a small object"));
    }
    let mut g = b.db.lock().unwrap();
    let c = db_or_diag(b, &mut g)?;
    let (_, inc) = check(c, &p.identity)?;
    let v = op_view(c, &b.install_id, &p.identity.store_uuid, inc, &p.operation_id)?.ok_or_else(|| BErr::new("NOT_FOUND", "no such operation"))?;
    if v["state"] != "indeterminate" {
        return Err(BErr::new("RECONCILIATION_REQUIRED", "only indeterminate operations take an operator decision"));
    }
    let tx = c.unchecked_transaction()?;
    let seq = db::audit(&tx, "operation_resolved", Some(&p.identity.store_uuid), Some(inc), Some(&p.operation_id), None, &json!({"decision": p.decision, "releaseQuarantine": p.release_quarantine}))?;
    // The original state and evidence stay; the decision is recorded beside them (spec §17.5).
    let resolution = json!({"operatorDecision": p.decision, "observedEvidence": p.observed_evidence, "releaseQuarantine": p.release_quarantine, "seq": seq, "at": now()});
    tx.execute(
        "UPDATE effect_operations SET resolution_json=?5, updated_seq=?6, updated_at=?7 WHERE machine_install_id=?1 AND store_uuid=?2 AND incarnation=?3 AND operation_id=?4",
        params![b.install_id, p.identity.store_uuid, inc, p.operation_id, resolution.to_string(), seq, now()],
    )?;
    if p.release_quarantine {
        tx.execute(
            "UPDATE resource_state SET quarantine_operation_id=NULL, lock_operation_id=NULL, status='available', updated_at=?2 WHERE resource_id=?1 AND (quarantine_operation_id=?3 OR lock_operation_id=?3)",
            params![v["resourceId"].as_str().unwrap_or(""), now(), p.operation_id],
        )?;
    }
    tx.commit()?;
    Ok(op_view(c, &b.install_id, &p.identity.store_uuid, inc, &p.operation_id)?.unwrap())
}

// ---------------------------------------------------------------- quiesce / restore

pub fn quiesce<F>(b: &Shared, p: &QuiesceParams, check: F) -> Result<Value, BErr>
where
    F: Fn(&Connection, &Identity) -> Result<(String, i64), BErr>,
{
    let inc;
    {
        let mut g = b.db.lock().unwrap();
        let c = db_or_diag(b, &mut g)?;
        let (state, i) = check(c, &p.identity)?;
        inc = i;
        if state == "active" {
            c.execute("UPDATE workspace_bindings SET state='quiescing', updated_at=?2 WHERE store_uuid=?1", params![p.identity.store_uuid, now()])?;
            db::audit(c, "workspace_quiesce", Some(&p.identity.store_uuid), Some(inc), None, None, &json!({"reason": p.reason}))?;
        }
    }
    b.kick();
    let deadline = std::time::Instant::now() + Duration::from_millis(p.timeout_ms.clamp(100, 120_000));
    loop {
        let (busy, indeterminate, seq, accepted) = {
            let g = b.db.lock().unwrap();
            let c = g.as_ref().unwrap();
            let busy: i64 = c.query_row("SELECT count(*) FROM effect_operations WHERE store_uuid=?1 AND state IN ('running','reconciling')", params![p.identity.store_uuid], |r| r.get(0))?;
            let mut st = c.prepare("SELECT operation_id, resource_id FROM effect_operations WHERE store_uuid=?1 AND state='indeterminate' AND resolution_json IS NULL")?;
            let ind: Vec<Value> = st.query_map(params![p.identity.store_uuid], |r| Ok(json!({"operationId": r.get::<_, String>(0)?, "resourceId": r.get::<_, String>(1)?})))?.filter_map(|x| x.ok()).collect();
            let mut st2 = c.prepare("SELECT operation_id FROM effect_operations WHERE store_uuid=?1 AND state='accepted'")?;
            let acc: Vec<String> = st2.query_map(params![p.identity.store_uuid], |r| r.get(0))?.filter_map(|x| x.ok()).collect();
            let seq: i64 = db::meta(c, "seq").and_then(|s| s.parse().ok()).unwrap_or(0);
            (busy, ind, seq, acc)
        };
        if busy == 0 {
            // Confirm the file worker is idle (no write still in progress from a previous dispatch).
            let fw = b.call_worker("managed-root", "status", &json!({}), json!({}), None, None, 3000).ok();
            let idle = fw.as_ref().and_then(|v| v["active"].as_u64()).map(|n| n == 0).unwrap_or(false);
            if idle {
                return Ok(json!({"state": "quiescing", "checkpointSeq": seq, "workspaceIncarnation": inc, "machineInstallId": b.install_id, "indeterminate": indeterminate, "acceptedNotAdmitted": accepted, "fileWorkerIdle": true}));
            }
        }
        if std::time::Instant::now() >= deadline {
            // Spec §23.2: a timeout never silently lifts the freeze or claims a consistent checkpoint.
            return Err(BErr::new("RESOURCE_BUSY", "operations are still in flight; the workspace stays quiesced").with(json!({"inFlight": busy})));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn restore_binding(b: &Broker, c: &Connection, uid: u32, sess_store: Option<&str>, p: &RestoreParams) -> Result<(i64, String), BErr> {
    if sess_store != Some(p.store_uuid.as_str()) {
        return Err(BErr::new("BROKER_IDENTITY_MISMATCH", "handshake for this workspace first"));
    }
    if p.machine_install_id != b.install_id {
        return Err(BErr::new("BROKER_IDENTITY_MISMATCH", "machineInstallId does not match"));
    }
    if !token_ok(&p.restore_request_id, 64) {
        return Err(BErr::new("INVALID_SYSTEM_PLAN", "malformed restoreRequestId"));
    }
    let (inc, state, au): (i64, String, i64) = c
        .query_row("SELECT incarnation, state, allowed_uid FROM workspace_bindings WHERE store_uuid=?1", params![p.store_uuid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?
        .ok_or_else(|| BErr::new("BROKER_POLICY_DENIED", "workspace is not registered"))?;
    if au as u32 != uid {
        return Err(BErr::new("BROKER_IDENTITY_MISMATCH", "peer uid is not the registered host"));
    }
    Ok((inc, state))
}

pub fn restore_begin(b: &Shared, uid: u32, sess_store: Option<&str>, p: &RestoreParams) -> Result<Value, BErr> {
    // Quiesce first: dispatched operations of the old incarnation must reach a definite or quarantined state.
    {
        let mut g = b.db.lock().unwrap();
        let c = db_or_diag(b, &mut g)?;
        let (_inc, state) = restore_binding(b, c, uid, sess_store, p)?;
        if let Some(v) = restore_session(c, &p.restore_request_id)? {
            return Ok(v);
        }
        let open: Option<String> = c.query_row("SELECT restore_request_id FROM restore_sessions WHERE store_uuid=?1 AND phase='fenced'", params![p.store_uuid], |r| r.get(0)).optional()?;
        if let Some(o) = open {
            return Err(BErr::new("RECONCILIATION_REQUIRED", format!("restore {o} is not complete")).with(json!({"restoreRequestId": o})));
        }
        if state == "active" {
            c.execute("UPDATE workspace_bindings SET state='quiescing', updated_at=?2 WHERE store_uuid=?1", params![p.store_uuid, now()])?;
        }
    }
    b.kick();
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let busy: i64 = {
            let g = b.db.lock().unwrap();
            g.as_ref().unwrap().query_row("SELECT count(*) FROM effect_operations WHERE store_uuid=?1 AND state IN ('running','reconciling')", params![p.store_uuid], |r| r.get(0))?
        };
        if busy == 0 {
            break;
        }
        if std::time::Instant::now() >= deadline {
            return Err(BErr::new("RESOURCE_BUSY", "dispatched operations are still being reconciled; restore not started"));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let mut g = b.db.lock().unwrap();
    let c = db_or_diag(b, &mut g)?;
    let (inc, _) = restore_binding(b, c, uid, sess_store, p)?;
    if let Some(v) = restore_session(c, &p.restore_request_id)? {
        return Ok(v);
    }
    let tx = c.unchecked_transaction()?;
    let target = inc + 1;
    let seq = db::audit(&tx, "restore_begin", Some(&p.store_uuid), Some(inc), None, None, &json!({"restoreRequestId": p.restore_request_id, "target": target, "source": p.source_incarnation}))?;
    // Fence every old-incarnation request that was never admitted: it can never run.
    tx.execute(
        "UPDATE effect_operations SET state='cancelled_no_effect', effect_certainty='none', evidence_kind='fenced_by_restore', error_code='WORKSPACE_FENCED', error_message='workspace restored to a new incarnation before admission', updated_seq=?3, updated_at=?4 WHERE store_uuid=?1 AND incarnation=?2 AND state='accepted'",
        params![p.store_uuid, inc, seq, now()],
    )?;
    tx.execute("UPDATE workspace_bindings SET incarnation=?2, state='restoring', updated_at=?3 WHERE store_uuid=?1", params![p.store_uuid, target, now()])?;
    tx.execute(
        "INSERT INTO restore_sessions(restore_request_id, store_uuid, source_incarnation, previous_incarnation, target_incarnation, checkpoint_seq, phase, created_at) VALUES (?1,?2,?3,?4,?5,?6,'fenced',?7)",
        params![p.restore_request_id, p.store_uuid, p.source_incarnation.map(|x| x as i64), inc, target, seq, now()],
    )?;
    // Grants of the old incarnation stop authorizing anything.
    tx.execute("UPDATE broker_grants SET revoked_seq=?3, revoked_at=?4 WHERE store_uuid=?1 AND incarnation=?2 AND revoked_seq IS NULL", params![p.store_uuid, inc, seq, now()])?;
    tx.commit()?;
    b.fault("broker.after_restore_fence");
    Ok(restore_session(c, &p.restore_request_id)?.unwrap())
}

fn restore_session(c: &Connection, id: &str) -> Result<Option<Value>, BErr> {
    Ok(c
        .query_row(
            "SELECT restore_request_id, store_uuid, source_incarnation, previous_incarnation, target_incarnation, checkpoint_seq, phase FROM restore_sessions WHERE restore_request_id=?1",
            params![id],
            |r| {
                Ok(json!({"restoreRequestId": r.get::<_, String>(0)?, "storeUUID": r.get::<_, String>(1)?, "sourceIncarnation": r.get::<_, Option<i64>>(2)?, "previousIncarnation": r.get::<_, i64>(3)?, "targetIncarnation": r.get::<_, i64>(4)?, "checkpointSeq": r.get::<_, i64>(5)?, "phase": r.get::<_, String>(6)?}))
            },
        )
        .optional()?)
}

pub fn restore_status(b: &Shared, sess_store: Option<&str>, p: &RestoreParams) -> Result<Value, BErr> {
    let mut g = b.db.lock().unwrap();
    let c = db_or_diag(b, &mut g)?;
    if sess_store != Some(p.store_uuid.as_str()) {
        return Err(BErr::new("BROKER_IDENTITY_MISMATCH", "handshake for this workspace first"));
    }
    restore_session(c, &p.restore_request_id)?.ok_or_else(|| BErr::new("NOT_FOUND", "no such restore session"))
}

pub fn restore_complete(b: &Shared, sess_store: Option<&str>, p: &RestoreParams) -> Result<Value, BErr> {
    let mut g = b.db.lock().unwrap();
    let c = db_or_diag(b, &mut g)?;
    if sess_store != Some(p.store_uuid.as_str()) || p.machine_install_id != b.install_id {
        return Err(BErr::new("BROKER_IDENTITY_MISMATCH", "handshake for this workspace first"));
    }
    let s = restore_session(c, &p.restore_request_id)?.ok_or_else(|| BErr::new("NOT_FOUND", "no such restore session"))?;
    if s["phase"] == "complete" {
        return Ok(s);
    }
    let tx = c.unchecked_transaction()?;
    let seq = db::audit(&tx, "restore_complete", Some(&p.store_uuid), s["targetIncarnation"].as_i64(), None, None, &json!({"restoreRequestId": p.restore_request_id}))?;
    tx.execute("UPDATE restore_sessions SET phase='complete', completed_at=?2 WHERE restore_request_id=?1", params![p.restore_request_id, now()])?;
    tx.execute("UPDATE workspace_bindings SET state='active', updated_at=?2 WHERE store_uuid=?1", params![p.store_uuid, now()])?;
    let _ = seq;
    tx.commit()?;
    drop(g);
    b.kick();
    let mut g = b.db.lock().unwrap();
    let c = db_or_diag(b, &mut g)?;
    Ok(restore_session(c, &p.restore_request_id)?.unwrap())
}

// ---------------------------------------------------------------- executor

#[derive(Clone)]
struct OpRow {
    store: String,
    inc: i64,
    op_id: String,
    env: WriteEnvelope,
    state: String,
    attempts: i64,
}

fn load_ops(c: &Connection, install: &str, states: &[&str]) -> Vec<OpRow> {
    let q = format!(
        "SELECT o.store_uuid, o.incarnation, o.operation_id, o.envelope_json, o.state, o.reconcile_attempts FROM effect_operations o JOIN workspace_bindings w ON w.store_uuid=o.store_uuid WHERE o.machine_install_id=?1 AND o.state IN ({}) ORDER BY o.accepted_seq",
        states.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(",")
    );
    let Ok(mut st) = c.prepare(&q) else { return vec![] };
    st.query_map(params![install], |r| {
        let env: WriteEnvelope = serde_json::from_str(&r.get::<_, String>(3)?).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        Ok(OpRow { store: r.get(0)?, inc: r.get(1)?, op_id: r.get(2)?, env, state: r.get(4)?, attempts: r.get(5)? })
    })
    .map(|it| it.filter_map(|x| x.ok()).collect())
    .unwrap_or_default()
}

pub fn executor_loop(b: Shared) {
    loop {
        {
            let (m, cv) = &b.wake;
            let mut w = m.lock().unwrap();
            if !*w {
                w = cv.wait_timeout(w, Duration::from_millis(1000)).unwrap().0;
            }
            *w = false;
        }
        let ops = {
            let g = b.db.lock().unwrap();
            let Some(c) = g.as_ref() else { continue };
            load_ops(c, &b.install_id, &["accepted", "reconciling"])
        };
        for op in ops {
            if op.state == "accepted" {
                admit_and_run(&b, &op);
            } else {
                reconcile_one(&b, &op);
            }
        }
    }
}

fn step(c: &Connection, op: &OpRow, name: &str, attempt: i64, before: Option<&Value>, after: Option<&Value>, ext: Option<&str>) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO effect_steps(operation_id, incarnation, step, attempt, before_json, after_json, external_ref, at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![op.op_id, op.inc, name, attempt, before.map(|v| v.to_string()), after.map(|v| v.to_string()), ext, now()],
    )?;
    Ok(())
}

fn has_step(c: &Connection, op: &OpRow, name: &str) -> Option<Value> {
    c.query_row("SELECT before_json, after_json FROM effect_steps WHERE operation_id=?1 AND incarnation=?2 AND step=?3 ORDER BY id DESC LIMIT 1", params![op.op_id, op.inc, name], |r| {
        let a: Option<String> = r.get(0)?;
        let bb: Option<String> = r.get(1)?;
        Ok(json!({"before": a.and_then(|s| serde_json::from_str::<Value>(&s).ok()), "after": bb.and_then(|s| serde_json::from_str::<Value>(&s).ok())}))
    })
    .optional()
    .ok()
    .flatten()
}

struct Outcome {
    state: &'static str,
    completion: Option<&'static str>,
    certainty: &'static str,
    evidence_kind: &'static str,
    evidence: Value,
    result: Value,
    error: Option<(String, String)>,
}

fn ok(completion: &'static str, evidence_kind: &'static str, evidence: Value, result: Value) -> Outcome {
    Outcome { state: "succeeded", completion: Some(completion), certainty: "verified", evidence_kind, evidence, result, error: None }
}
fn no_effect(state: &'static str, evidence_kind: &'static str, evidence: Value, code: &str, msg: impl Into<String>) -> Outcome {
    Outcome { state, completion: None, certainty: "none", evidence_kind, evidence, result: Value::Null, error: Some((code.into(), msg.into())) }
}
fn unknown(evidence_kind: &'static str, evidence: Value, code: &str, msg: impl Into<String>) -> Outcome {
    Outcome { state: "indeterminate", completion: None, certainty: "unknown", evidence_kind, evidence, result: Value::Null, error: Some((code.into(), msg.into())) }
}

fn finish(b: &Broker, op: &OpRow, o: Outcome) {
    let g = b.db.lock().unwrap();
    let c = g.as_ref().unwrap();
    let tx = match c.unchecked_transaction() {
        Ok(t) => t,
        Err(_) => return,
    };
    let seq = db::audit(&tx, "operation_finished", Some(&op.store), Some(op.inc), Some(&op.op_id), None, &json!({"state": o.state, "certainty": o.certainty, "evidence": o.evidence_kind})).unwrap_or(0);
    let _ = tx.execute(
        "UPDATE effect_operations SET state=?5, completion_kind=?6, effect_certainty=?7, evidence_kind=?8, evidence_json=?9, result_json=?10, error_code=?11, error_message=?12, updated_seq=?13, updated_at=?14 WHERE machine_install_id=?1 AND store_uuid=?2 AND incarnation=?3 AND operation_id=?4",
        params![b.install_id, op.store, op.inc, op.op_id, o.state, o.completion, o.certainty, o.evidence_kind, o.evidence.to_string(), o.result.to_string(), o.error.as_ref().map(|e| e.0.clone()), o.error.as_ref().map(|e| e.1.clone()), seq, now()],
    );
    if o.state == "indeterminate" {
        // Keep the write lock and quarantine the resource: only reconciliation or an operator decision releases it.
        let _ = tx.execute("UPDATE resource_state SET quarantine_operation_id=?2, lock_operation_id=?2, status='quarantined', updated_at=?3 WHERE resource_id=?1", params![op.env.resource_id, op.op_id, now()]);
    } else {
        let _ = tx.execute("UPDATE resource_state SET lock_operation_id=NULL, updated_at=?3 WHERE resource_id=?1 AND lock_operation_id=?2", params![op.env.resource_id, op.op_id, now()]);
        if let Some(v) = o.result.get("version").and_then(|v| v.as_str()) {
            let _ = tx.execute("UPDATE resource_state SET observed_version=?2 WHERE resource_id=?1", params![op.env.resource_id, v]);
        }
    }
    if o.state != "running" && o.state != "reconciling" {
        let outcome = match o.state {
            "succeeded" => if o.completion == Some("already_satisfied") { "no_change" } else { "succeeded" },
            "indeterminate" => "unknown",
            _ => "failed",
        };
        let _ = tx.execute("UPDATE maintenance_attempts SET outcome=?3 WHERE store_uuid=?1 AND operation_id=?2", params![op.store, op.op_id, outcome]);
    }
    let _ = tx.commit();
}

fn set_state(b: &Broker, op: &OpRow, state: &str) {
    let g = b.db.lock().unwrap();
    let c = g.as_ref().unwrap();
    let seq = db::audit(c, "operation_state", Some(&op.store), Some(op.inc), Some(&op.op_id), None, &json!({"state": state})).unwrap_or(0);
    let _ = c.execute(
        "UPDATE effect_operations SET state=?5, updated_seq=?6, updated_at=?7 WHERE machine_install_id=?1 AND store_uuid=?2 AND incarnation=?3 AND operation_id=?4",
        params![b.install_id, op.store, op.inc, op.op_id, state, seq, now()],
    );
}

enum Admission {
    Admitted { nonce: String, caps: Value, res: CatalogRes },
    Wait,
    Refused(Outcome),
}

/// The linearization point (spec §17.2).
fn admission(b: &Broker, op: &OpRow) -> Admission {
    let env = &op.env;
    let Some(res) = b.find_res(&op.store, &env.resource_id) else {
        return Admission::Refused(no_effect("failed_no_effect", "admission_refused", json!({}), "RESOURCE_NOT_BOUND", "resource left the installed catalog"));
    };
    // Observe identity outside the transaction (worker call), then decide inside it.
    let obs = observe(b, &res);
    let g = b.db.lock().unwrap();
    let c = g.as_ref().unwrap();
    let Ok(tx) = c.unchecked_transaction() else { return Admission::Wait };
    let _ = apply_observation(&tx, &res, &obs);
    let ws: (i64, String) = match tx.query_row("SELECT incarnation, state FROM workspace_bindings WHERE store_uuid=?1", params![op.store], |r| Ok((r.get(0)?, r.get(1)?))) {
        Ok(x) => x,
        Err(_) => return Admission::Wait,
    };
    if ws.0 != op.inc {
        let _ = tx.commit();
        return Admission::Refused(no_effect("cancelled_no_effect", "fenced_by_restore", json!({"incarnation": ws.0}), "WORKSPACE_FENCED", "the workspace moved to a new incarnation"));
    }
    if ws.1 != "active" {
        let _ = tx.commit();
        return Admission::Wait;
    }
    let cancel: i64 = tx
        .query_row("SELECT cancel_requested FROM effect_operations WHERE machine_install_id=?1 AND store_uuid=?2 AND incarnation=?3 AND operation_id=?4", params![b.install_id, op.store, op.inc, op.op_id], |r| r.get(0))
        .unwrap_or(0);
    if cancel != 0 {
        let _ = tx.commit();
        return Admission::Refused(no_effect("cancelled_no_effect", "cancelled_before_admission", json!({}), "CANCELLED", "cancelled before admission"));
    }
    if (env.deadline_ms as i64) <= now() {
        let _ = tx.commit();
        return Admission::Refused(no_effect("expired_no_effect", "deadline_before_dispatch", json!({"deadlineMs": env.deadline_ms}), "PLAN_EXPIRED", "the execution deadline passed before dispatch"));
    }
    let grant = load_grant(&tx, &op.store, &env.grant_id, env.grant_version).ok().flatten();
    let (gen, lock, quarantine): (i64, Option<String>, Option<String>) =
        tx.query_row("SELECT generation, lock_operation_id, quarantine_operation_id FROM resource_state WHERE resource_id=?1", params![env.resource_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap_or((0, None, None));
    if let Err(e) = obs {
        let _ = tx.commit();
        return Admission::Refused(no_effect("failed_no_effect", "admission_refused", json!({"observe": e.message}), if e.code == "RESOURCE_GONE" { "RESOURCE_GONE" } else { "PROVIDER_UNAVAILABLE" }, e.message));
    }
    if gen as u64 != env.resource_generation {
        let _ = tx.commit();
        return Admission::Refused(no_effect("failed_no_effect", "admission_refused", json!({"generation": gen}), "RESOURCE_GENERATION_STALE", format!("resource generation is {gen}, the plan was made for {}", env.resource_generation)));
    }
    // Protocol-2 maintenance operation: the approved policy, pause state and target control epoch replace the grant.
    let maint = crate::maintenance::maintenance_of(&tx, &b.install_id, &op.store, op.inc, &op.op_id);
    if let Some(m) = &maint {
        if let Err((code, msg)) = crate::maintenance::admission_check(&tx, &op.store, m, &env.resource_id, gen) {
            let _ = tx.commit();
            return Admission::Refused(no_effect("failed_no_effect", "admission_refused", json!({"maintenance": m}), &code, msg));
        }
    }
    if maint.is_none() {
    if let Err(e) = grant_usable(&grant, &env.capability_id, &env.resource_id, gen) {
        let _ = tx.commit();
        return Admission::Refused(no_effect("failed_no_effect", "admission_refused", json!({}), &e.code, e.message));
    }
    let g0 = grant.unwrap();
    if let Some(ph) = &g0.params_hash {
        let h = agentos_protocol::domain_hash("agentos.system-params.v1", &env.params).unwrap_or_default();
        if &h != ph {
            let _ = tx.commit();
            return Admission::Refused(no_effect("failed_no_effect", "admission_refused", json!({}), "PLAN_HASH_MISMATCH", "parameters differ from the confirmed plan"));
        }
    }
    if g0.principal["kind"] == "system_action" && g0.principal["actionId"] != env.action_id {
        let _ = tx.commit();
        return Admission::Refused(no_effect("failed_no_effect", "admission_refused", json!({}), "PROVIDER_GRANT_REQUIRED", "the one-time grant belongs to another action"));
    }
    if let Err(e) = params_within(&env.capability_id, &env.params, &g0.limits, &res.caps) {
        let _ = tx.commit();
        return Admission::Refused(no_effect("failed_no_effect", "admission_refused", json!({}), &e.code, e.message));
    }
    }
    // A quarantined resource refuses new writes at once (spec §12.4); only a held execution lock makes it wait.
    if let Some(q) = quarantine.filter(|q| q != &op.op_id) {
        let _ = tx.commit();
        return Admission::Refused(no_effect("failed_no_effect", "admission_refused", json!({"quarantineOperationId": q}), "RESOURCE_BUSY", "the resource is quarantined until an unknown result is resolved"));
    }
    if lock.as_deref().map_or(false, |l| l != op.op_id) {
        let _ = tx.commit();
        return Admission::Wait;
    }
    let inflight: i64 = tx.query_row("SELECT count(*) FROM effect_operations WHERE store_uuid=?1 AND state IN ('running','reconciling') AND operation_id<>?2", params![op.store, op.op_id], |r| r.get(0)).unwrap_or(0);
    if inflight > 0 {
        let _ = tx.commit();
        return Admission::Wait;
    }
    let nonce = agentos_protocol::random_hex(8);
    let seq = db::audit(&tx, "operation_admitted", Some(&op.store), Some(op.inc), Some(&op.op_id), Some(&env.grant_id), &json!({"nonce": nonce})).unwrap_or(0);
    let r1 = tx.execute(
        "UPDATE effect_operations SET state='running', dispatch_nonce=?5, broker_instance_id=?6, updated_seq=?7, updated_at=?8 WHERE machine_install_id=?1 AND store_uuid=?2 AND incarnation=?3 AND operation_id=?4 AND state='accepted'",
        params![b.install_id, op.store, op.inc, op.op_id, nonce, b.instance_id, seq, now()],
    );
    let r2 = tx.execute("UPDATE resource_state SET lock_operation_id=?2, updated_at=?3 WHERE resource_id=?1", params![env.resource_id, op.op_id, now()]);
    let r3 = step(&tx, op, "admitted", 0, None, Some(&json!({"nonce": nonce, "bootId": agentos_protocol::boot_id()})), None);
    if r1.map(|n| n == 1).unwrap_or(false) && r2.is_ok() && r3.is_ok() && tx.commit().is_ok() {
        Admission::Admitted { nonce, caps: res.caps.clone(), res }
    } else {
        Admission::Wait
    }
}

fn admit_and_run(b: &Shared, op: &OpRow) {
    match admission(b, op) {
        Admission::Wait => {
            if (op.env.deadline_ms as i64) <= now() {
                finish(b, op, no_effect("expired_no_effect", "deadline_before_dispatch", json!({}), "RESOURCE_BUSY", "the deadline passed while the resource was busy or the workspace quiesced"));
            }
        }
        Admission::Refused(o) => finish(b, op, o),
        Admission::Admitted { nonce, caps, res } => {
            b.fault("broker.after_admission");
            let mut op2 = op.clone();
            op2.state = "running".into();
            let o = run(b, &op2, &res, &caps, &nonce, 0);
            if o.state == "reconciling" {
                set_state(b, &op2, "reconciling");
                b.kick();
            } else {
                finish(b, &op2, o);
            }
            b.fault("broker.after_finish");
        }
    }
}

fn cancel_requested(b: &Broker, op: &OpRow) -> bool {
    let g = b.db.lock().unwrap();
    g.as_ref()
        .and_then(|c| c.query_row("SELECT cancel_requested FROM effect_operations WHERE machine_install_id=?1 AND store_uuid=?2 AND incarnation=?3 AND operation_id=?4", params![b.install_id, op.store, op.inc, op.op_id], |r| r.get::<_, i64>(0)).ok())
        .unwrap_or(0)
        != 0
}

fn log_step(b: &Broker, op: &OpRow, name: &str, attempt: i64, before: Option<&Value>, after: Option<&Value>) -> bool {
    let g = b.db.lock().unwrap();
    let c = g.as_ref().unwrap();
    step(c, op, name, attempt, before, after, None).is_ok()
}

fn remaining_ms(op: &OpRow) -> u64 {
    (op.env.deadline_ms as i64 - now()).max(0) as u64
}

/// Dispatch to the provider. Every step that may change the target is preceded by a committed step record.
fn run(b: &Broker, op: &OpRow, res: &CatalogRes, caps: &Value, nonce: &str, attempt: i64) -> Outcome {
    let env = &op.env;
    let p = &env.params;
    match env.capability_id.as_str() {
        "file.write_text_atomic" => {
            let path = p["path"].as_str().unwrap_or("");
            let content = p["content"].as_str().unwrap_or("");
            let new_hash = agentos_protocol::fsutil::content_version(content.as_bytes());
            let cur = match b.call_worker("managed-root", "version", &res.target, json!({"path": path}), Some(&op.op_id), Some(nonce), 5000) {
                Ok(v) => v,
                Err(e) => return no_effect("failed_no_effect", "provider_refused", json!({"stage": "version"}), &e.code, e.message),
            };
            let cur_v = cur["version"].as_str().map(String::from);
            let expected_absent = p.get("expectedAbsent").is_some();
            let expected = p.get("expectedVersion").and_then(|x| x.as_str());
            if expected_absent && cur_v.is_some() {
                return no_effect("failed_no_effect", "precondition_mismatch", json!({"current": cur_v}), "FILE_VERSION_STALE", "the target already exists");
            }
            if !expected_absent && cur_v.as_deref() != expected {
                if cur_v.as_deref() == Some(new_hash.as_str()) {
                    return ok("already_satisfied", "target_hash", json!({"version": new_hash}), json!({"version": new_hash, "path": path}));
                }
                return no_effect("failed_no_effect", "precondition_mismatch", json!({"current": cur_v, "expected": expected}), "FILE_VERSION_STALE", "the target changed since the plan was made");
            }
            let usage = b.call_worker("managed-root", "usage", &res.target, json!({}), None, None, 5000).ok().and_then(|v| v["bytes"].as_u64()).unwrap_or(u64::MAX);
            if usage.saturating_add(content.len() as u64) > caps["quotaBytes"].as_u64().unwrap_or(0) {
                return no_effect("failed_no_effect", "admission_refused", json!({"usage": usage}), "LIMIT_EXCEEDED", "managed directory quota would be exceeded");
            }
            let (parent, leaf) = agentos_protocol::fsutil::split_parent(path);
            let temp = format!(".aos-tmp-{}-{}", op.op_id, nonce);
            let plan = json!({"path": path, "parent": parent, "leaf": leaf, "temp": temp, "oldVersion": cur_v, "newVersion": new_hash, "expectedAbsent": expected_absent});
            if !log_step(b, op, "prepared", attempt, Some(&plan), None) {
                return unknown("log_failure", json!({}), "RECONCILIATION_REQUIRED", "could not record the prepare step");
            }
            if let Err(e) = b.call_worker("managed-root", "write_temp", &res.target, json!({"parent": parent, "temp": temp, "content": content}), Some(&op.op_id), Some(nonce), 5000) {
                let _ = b.call_worker("managed-root", "cleanup", &res.target, json!({"parent": parent, "temp": temp}), None, None, 5000);
                return no_effect("failed_no_effect", "target_unchanged", json!({"stage": "write_temp"}), &e.code, e.message);
            }
            b.fault("broker.after_temp");
            if cancel_requested(b, op) {
                let _ = b.call_worker("managed-root", "cleanup", &res.target, json!({"parent": parent, "temp": temp}), None, None, 5000);
                return no_effect("cancelled_no_effect", "target_unchanged", json!({"stage": "before_publish"}), "CANCELLED", "cancelled before publication; the target was not touched");
            }
            match b.call_worker("managed-root", "publish", &res.target, json!({"parent": parent, "temp": temp, "leaf": leaf, "noReplace": expected_absent, "expectedVersion": cur_v}), Some(&op.op_id), Some(nonce), 5000) {
                Ok(_) => {}
                Err(e) if !e.maybe_sent || e.effect == "none" => {
                    let _ = b.call_worker("managed-root", "cleanup", &res.target, json!({"parent": parent, "temp": temp}), None, None, 5000);
                    return no_effect("failed_no_effect", "target_unchanged", json!({"stage": "publish"}), &e.code, e.message);
                }
                Err(e) => return reconcile_file(b, op, res, &plan, &format!("publish response lost: {}", e.message), true),
            }
            let _ = log_step(b, op, "published", attempt, None, Some(&json!({"newVersion": new_hash})));
            b.fault("broker.after_publish");
            reconcile_file(b, op, res, &plan, "verify", false)
        }
        "service.ensure_state" | "service.set_limit" => run_service(b, op, res, caps, nonce, attempt),
        "network.apply_profile" => run_network(b, op, res, nonce, attempt),
        "serial.exchange" => run_serial(b, op, res, nonce, attempt),
        _ => no_effect("failed_no_effect", "admission_refused", json!({}), "CAPABILITY_VERSION_UNSUPPORTED", "no executor"),
    }
}

/// File evidence: new hash → done; old hash/absent → unchanged; anything else → unknown and quarantined.
fn reconcile_file(b: &Broker, op: &OpRow, res: &CatalogRes, plan: &Value, why: &str, may_continue: bool) -> Outcome {
    let path = plan["path"].as_str().unwrap_or("");
    let temp = plan["temp"].as_str().unwrap_or("");
    let parent = plan["parent"].as_str().unwrap_or("");
    let cur = match b.call_worker("managed-root", "version", &res.target, json!({"path": path}), None, None, 5000) {
        Ok(v) => v,
        Err(e) => return unknown("provider_unreachable", json!({"why": why}), "EXTERNAL_RESULT_INDETERMINATE", e.message),
    };
    let cur_v = cur["version"].as_str().map(String::from);
    let new_v = plan["newVersion"].as_str().map(String::from);
    let old_v = plan["oldVersion"].as_str().map(String::from);
    if cur_v == new_v && cur["nlink"].as_u64().unwrap_or(1) == 1 {
        let _ = b.call_worker("managed-root", "cleanup", &res.target, json!({"parent": parent, "temp": temp}), None, None, 5000);
        let kind = if why == "verify" { "applied" } else { "satisfied_on_reconcile" };
        return ok(kind, "target_hash", json!({"version": cur_v, "identity": cur["identity"]}), json!({"version": cur_v, "path": path, "size": cur["size"]}));
    }
    if cur_v == old_v {
        let _ = b.call_worker("managed-root", "cleanup", &res.target, json!({"parent": parent, "temp": temp}), None, None, 5000);
        if may_continue {
            return Outcome { state: "reconciling", completion: None, certainty: "none", evidence_kind: "target_unchanged", evidence: json!({"why": why}), result: Value::Null, error: None };
        }
        return no_effect("failed_no_effect", "target_unchanged", json!({"version": cur_v, "why": why}), "EXTERNAL_RESULT_INDETERMINATE", "publication did not take effect; the target still has its previous content");
    }
    unknown("third_content", json!({"current": cur_v, "old": old_v, "new": new_v}), "RESOURCE_CHANGED", "the target holds content that is neither the previous nor the planned version")
}

fn run_service(b: &Broker, op: &OpRow, res: &CatalogRes, caps: &Value, nonce: &str, attempt: i64) -> Outcome {
    let env = &op.env;
    let p = &env.params;
    let before = match b.call_worker("service", "observe", &res.target, json!({}), None, None, 5000) {
        Ok(v) => v,
        Err(e) => return no_effect("failed_no_effect", "provider_refused", json!({}), &e.code, e.message),
    };
    let d = &before["details"];
    if d["loadState"] != "loaded" {
        return no_effect("failed_no_effect", "admission_refused", json!({"loadState": d["loadState"]}), "SERVICE_TARGET_NOT_REGISTERED", "the catalog unit is not loaded");
    }
    if env.capability_id == "service.ensure_state" {
        let want = p["state"].as_str().unwrap_or("");
        let active = d["activeState"].as_str().unwrap_or("");
        if (want == "running" && active == "active") || (want == "stopped" && (active == "inactive" || active == "failed")) {
            return ok("already_satisfied", "unit_state", json!({"state": d}), json!({"activeState": active, "subState": d["subState"], "invocationId": d["invocationId"]}));
        }
        if cancel_requested(b, op) {
            return no_effect("cancelled_no_effect", "not_dispatched", json!({}), "CANCELLED", "cancelled before the job was requested");
        }
        let _ = log_step(b, op, "job_requested", attempt, Some(&json!({"activeState": active, "invocationId": d["invocationId"], "bootId": agentos_protocol::boot_id()})), None);
        let timeout = remaining_ms(op).min(15_000);
        match b.call_worker("service", "ensure", &res.target, json!({"state": want, "timeoutMs": timeout}), Some(&op.op_id), Some(nonce), timeout + 3000) {
            Ok(v) => {
                let _ = log_step(b, op, "job_finished", attempt, None, Some(&v));
                b.fault("broker.after_job");
                let st = v["state"]["activeState"].as_str().unwrap_or("");
                let reached = (want == "running" && st == "active") || (want == "stopped" && (st == "inactive" || st == "failed"));
                if reached {
                    return ok("applied", "unit_state", json!({"job": v["job"], "jobResult": v["jobResult"], "state": v["state"]}), json!({"activeState": st, "subState": v["state"]["subState"], "invocationId": v["state"]["invocationId"], "job": v["job"]}));
                }
                unknown("unit_state", json!({"job": v["job"], "jobResult": v["jobResult"], "state": v["state"]}), "SERVICE_STATE_UNCONFIRMED", "the job finished but the unit is not in the requested state")
            }
            Err(e) if !e.maybe_sent => no_effect("failed_no_effect", "not_dispatched", json!({}), &e.code, e.message),
            Err(e) => reconcile_service(b, op, res, caps, &format!("job response lost: {}", e.message)),
        }
    } else {
        let prop = p["property"].as_str().unwrap_or("");
        let val = p["value"].as_u64().unwrap_or(0);
        let cur = d[prop].as_u64().unwrap_or(u64::MAX);
        if cur == val {
            return ok("already_satisfied", "unit_property", json!({"property": prop, "value": cur}), json!({"property": prop, "value": cur}));
        }
        if cancel_requested(b, op) {
            return no_effect("cancelled_no_effect", "not_dispatched", json!({}), "CANCELLED", "cancelled before the property was set");
        }
        let _ = log_step(b, op, "property_requested", attempt, Some(&json!({"property": prop, "value": cur, "invocationId": d["invocationId"], "bootId": agentos_protocol::boot_id()})), None);
        match b.call_worker("service", "set_property", &res.target, json!({"property": prop, "value": val}), Some(&op.op_id), Some(nonce), 8000) {
            Ok(v) => {
                b.fault("broker.after_job");
                if v["value"].as_u64() == Some(val) && v["cgroupMatches"].as_bool() == Some(true) {
                    return ok("applied", "unit_property", json!({"property": prop, "value": val, "cgroup": v["cgroup"]}), json!({"property": prop, "value": val, "previous": cur, "cgroup": v["cgroup"]}));
                }
                unknown("unit_property", v, "SERVICE_STATE_UNCONFIRMED", "the property read back differs from the request")
            }
            Err(e) if !e.maybe_sent => no_effect("failed_no_effect", "not_dispatched", json!({}), &e.code, e.message),
            Err(e) if e.effect == "none" => no_effect("failed_no_effect", "provider_refused", json!({}), &e.code, e.message),
            Err(e) => reconcile_service(b, op, res, caps, &format!("response lost: {}", e.message)),
        }
    }
}

fn reconcile_service(b: &Broker, op: &OpRow, res: &CatalogRes, caps: &Value, why: &str) -> Outcome {
    let env = &op.env;
    let p = &env.params;
    let cur = match b.call_worker("service", "observe", &res.target, json!({}), None, None, 5000) {
        Ok(v) => v,
        Err(e) => return unknown("provider_unreachable", json!({"why": why}), "SERVICE_STATE_UNCONFIRMED", e.message),
    };
    let d = &cur["details"];
    let g = b.db.lock().unwrap();
    let c = g.as_ref().unwrap();
    let req = has_step(c, op, if env.capability_id == "service.ensure_state" { "job_requested" } else { "property_requested" });
    drop(g);
    let boot_changed = req.as_ref().map(|r| r["before"]["bootId"].as_str() != Some(&agentos_protocol::boot_id())).unwrap_or(false);
    if boot_changed {
        // Spec §22.3: the unit's identity changed with the boot; never apply the old request to the new instance.
        return unknown("identity_changed", json!({"why": why, "state": d}), "SERVICE_STATE_UNCONFIRMED", "the machine rebooted after the request; the outcome before the reboot is unknown");
    }
    if env.capability_id == "service.ensure_state" {
        let want = p["state"].as_str().unwrap_or("");
        let st = d["activeState"].as_str().unwrap_or("");
        if (want == "running" && st == "active") || (want == "stopped" && (st == "inactive" || st == "failed")) {
            return ok("satisfied_on_reconcile", "unit_state", json!({"why": why, "state": d}), json!({"activeState": st, "subState": d["subState"], "invocationId": d["invocationId"]}));
        }
        if caps["autoConverge"].as_bool() == Some(true) && caps["safeRepeatStart"].as_bool() == Some(true) && remaining_ms(op) > 2000 && op.attempts < MAX_AUTO_RECONCILE {
            return Outcome { state: "reconciling", completion: None, certainty: "unknown", evidence_kind: "unit_state", evidence: json!({"why": why, "state": d}), result: Value::Null, error: None };
        }
        unknown("unit_state", json!({"why": why, "state": d}), "SERVICE_STATE_UNCONFIRMED", "the job outcome is unknown and the catalog does not allow repeating it")
    } else {
        let prop = p["property"].as_str().unwrap_or("");
        let val = p["value"].as_u64().unwrap_or(0);
        let now_v = d[prop].as_u64().unwrap_or(u64::MAX);
        if now_v == val {
            return ok("satisfied_on_reconcile", "unit_property", json!({"why": why, "property": prop, "value": now_v}), json!({"property": prop, "value": now_v}));
        }
        let before = req.as_ref().and_then(|r| r["before"]["value"].as_u64());
        if Some(now_v) == before {
            if caps["autoConverge"].as_bool() == Some(true) && remaining_ms(op) > 2000 && op.attempts < MAX_AUTO_RECONCILE {
                return Outcome { state: "reconciling", completion: None, certainty: "none", evidence_kind: "unit_property", evidence: json!({"why": why}), result: Value::Null, error: None };
            }
            return no_effect("failed_no_effect", "unit_property_unchanged", json!({"why": why, "value": now_v}), "SERVICE_STATE_UNCONFIRMED", "the property still has its previous value");
        }
        unknown("unit_property", json!({"why": why, "value": now_v}), "SERVICE_STATE_UNCONFIRMED", "the property has neither the previous nor the requested value")
    }
}

fn run_network(b: &Broker, op: &OpRow, res: &CatalogRes, nonce: &str, attempt: i64) -> Outcome {
    let profile = op.env.params["profileId"].as_str().unwrap_or("");
    let before = match b.call_worker("lab-network", "observe", &res.target, json!({}), None, None, 5000) {
        Ok(v) => v,
        Err(e) => return no_effect("failed_no_effect", "provider_refused", json!({}), &e.code, e.message),
    };
    let target_hash = before["details"]["profileHashes"][profile].as_str().unwrap_or("").to_string();
    if before["details"]["ruleHash"].as_str() == Some(target_hash.as_str()) && !target_hash.is_empty() {
        return ok("already_satisfied", "rule_hash", json!({"ruleHash": target_hash}), json!({"profileId": profile, "ruleHash": target_hash}));
    }
    if cancel_requested(b, op) {
        return no_effect("cancelled_no_effect", "not_dispatched", json!({}), "CANCELLED", "cancelled before the ruleset commit");
    }
    let _ = log_step(b, op, "commit_requested", attempt, Some(&json!({"ruleHash": before["details"]["ruleHash"], "netns": before["identity"], "targetHash": target_hash})), None);
    match b.call_worker("lab-network", "apply", &res.target, json!({"profileId": profile}), Some(&op.op_id), Some(nonce), remaining_ms(op).min(5000) + 1000) {
        Ok(v) => {
            let probe_ok = v["probe"]["matchesProfile"].as_bool() == Some(true);
            if v["ruleHash"].as_str() == Some(target_hash.as_str()) && probe_ok {
                return ok("applied", "rule_hash_and_probe", json!({"ruleHash": v["ruleHash"], "probe": v["probe"]}), json!({"profileId": profile, "ruleHash": v["ruleHash"], "probe": v["probe"]}));
            }
            unknown("rule_hash_and_probe", v, "EXTERNAL_RESULT_INDETERMINATE", "ruleset or traffic probe does not match the profile")
        }
        Err(e) if !e.maybe_sent => no_effect("failed_no_effect", "not_dispatched", json!({}), &e.code, e.message),
        Err(e) if e.effect == "none" => no_effect("failed_no_effect", "transaction_rejected", json!({"message": e.message}), &e.code, e.message),
        Err(e) => reconcile_network(b, op, res, &format!("commit response lost: {}", e.message)),
    }
}

fn reconcile_network(b: &Broker, op: &OpRow, res: &CatalogRes, why: &str) -> Outcome {
    let profile = op.env.params["profileId"].as_str().unwrap_or("");
    // A crashed worker is restarted by systemd within seconds: read-only observation is retried inside a fixed
    // budget (never the write itself) before the result is declared unknown.
    let mut last = String::new();
    let mut cur = Value::Null;
    for i in 0..8 {
        match b.call_worker("lab-network", "observe", &res.target, json!({"probe": true}), None, None, 5000) {
            Ok(v) => {
                cur = v;
                break;
            }
            Err(e) => {
                last = e.message;
                if i < 7 {
                    std::thread::sleep(Duration::from_millis(750));
                }
            }
        }
    }
    if cur.is_null() {
        return unknown("provider_unreachable", json!({"why": why}), "EXTERNAL_RESULT_INDETERMINATE", last);
    }
    let g = b.db.lock().unwrap();
    let req = has_step(g.as_ref().unwrap(), op, "commit_requested");
    drop(g);
    let target_hash = cur["details"]["profileHashes"][profile].as_str().unwrap_or("");
    let netns_before = req.as_ref().map(|r| r["before"]["netns"].clone()).unwrap_or(Value::Null);
    if !netns_before.is_null() && netns_before != cur["identity"] {
        return unknown("identity_changed", json!({"why": why}), "RESOURCE_GENERATION_STALE", "the lab namespace was recreated; the old request is not applied to the new one");
    }
    let rh = cur["details"]["ruleHash"].as_str().unwrap_or("");
    if rh == target_hash {
        return ok("satisfied_on_reconcile", "rule_hash_and_probe", json!({"why": why, "ruleHash": rh, "probe": cur["details"]["probe"]}), json!({"profileId": profile, "ruleHash": rh}));
    }
    if Some(rh) == req.as_ref().and_then(|r| r["before"]["ruleHash"].as_str()) {
        if remaining_ms(op) > 1500 && op.attempts < MAX_AUTO_RECONCILE {
            return Outcome { state: "reconciling", completion: None, certainty: "none", evidence_kind: "rule_hash", evidence: json!({"why": why}), result: Value::Null, error: None };
        }
        return no_effect("failed_no_effect", "rule_hash_unchanged", json!({"why": why, "ruleHash": rh}), "EXTERNAL_RESULT_INDETERMINATE", "the ruleset still has its previous content");
    }
    unknown("rule_hash", json!({"why": why, "ruleHash": rh}), "EXTERNAL_RESULT_INDETERMINATE", "the ruleset matches neither the previous nor the requested profile")
}

fn run_serial(b: &Broker, op: &OpRow, res: &CatalogRes, nonce: &str, attempt: i64) -> Outcome {
    let obs = match b.call_worker("serial", "observe", &res.target, json!({}), None, None, 3000) {
        Ok(v) => v,
        Err(e) => return no_effect("failed_no_effect", "not_dispatched", json!({}), if e.code == "RESOURCE_GONE" { "DEVICE_DISCONNECTED" } else { &e.code }, e.message),
    };
    let pre_ident = op.env.preconditions.get("identityDigest").and_then(|x| x.as_str()).unwrap_or("");
    if !pre_ident.is_empty() && pre_ident != digest(&obs["identity"]) {
        return no_effect("failed_no_effect", "not_dispatched", json!({}), "RESOURCE_GENERATION_STALE", "the device identity changed since the plan");
    }
    if cancel_requested(b, op) {
        return no_effect("cancelled_no_effect", "not_dispatched", json!({}), "CANCELLED", "cancelled before the port was opened");
    }
    // From here the port may be opened (control lines may change): no "no effect" claim without evidence.
    let req_id = op.op_id.chars().filter(|c| c.is_ascii_hexdigit()).take(8).collect::<String>();
    let req_id = format!("{:0>8}", req_id);
    let _ = log_step(b, op, "port_open_started", attempt, Some(&json!({"identity": obs["identity"], "reqId": req_id})), None);
    match b.call_worker("serial", "exchange", &res.target, json!({"params": op.env.params, "reqId": req_id}), Some(&op.op_id), Some(nonce), 3500) {
        Ok(v) => {
            let _ = log_step(b, op, "response_received", attempt, None, Some(&json!({"bytes": v["bytesWritten"]})));
            ok("applied", "device_response", json!({"reqId": req_id, "response": v["response"], "sessionId": v["sessionId"]}), json!({"reqId": req_id, "response": v["response"], "fields": v["fields"]}))
        }
        Err(e) if e.effect == "none" => no_effect("failed_no_effect", "not_dispatched", json!({"message": e.message}), &e.code, e.message),
        Err(e) => unknown("send_uncertain", json!({"reqId": req_id, "message": e.message}), "SERIAL_DELIVERY_UNKNOWN", "the frame may have been sent; no matching response was received"),
    }
}

fn reconcile_one(b: &Shared, op: &OpRow) {
    let Some(res) = b.find_res(&op.store, &op.env.resource_id) else {
        finish(b, op, unknown("resource_missing", json!({}), "RESOURCE_GONE", "the resource left the catalog during reconciliation"));
        return;
    };
    {
        let g = b.db.lock().unwrap();
        let _ = g.as_ref().unwrap().execute(
            "UPDATE effect_operations SET reconcile_attempts=reconcile_attempts+1 WHERE machine_install_id=?1 AND store_uuid=?2 AND incarnation=?3 AND operation_id=?4",
            params![b.install_id, op.store, op.inc, op.op_id],
        );
    }
    let mut op = op.clone();
    op.attempts += 1;
    let caps = res.caps.clone();
    let o = match op.env.capability_id.as_str() {
        "file.write_text_atomic" => {
            let plan = {
                let g = b.db.lock().unwrap();
                has_step(g.as_ref().unwrap(), &op, "prepared").map(|s| s["before"].clone())
            };
            match plan {
                None => {
                    // Admitted but nothing prepared: the target was never touched.
                    if remaining_ms(&op) > 1000 && op.attempts <= MAX_AUTO_RECONCILE {
                        let nonce = agentos_protocol::random_hex(8);
                        run(b, &op, &res, &caps, &nonce, op.attempts)
                    } else {
                        no_effect("failed_no_effect", "not_dispatched", json!({}), "EXTERNAL_RESULT_INDETERMINATE", "interrupted before any file step; deadline passed")
                    }
                }
                Some(plan) => {
                    let r = reconcile_file(b, &op, &res, &plan, "recovery", true);
                    if r.state == "reconciling" {
                        if remaining_ms(&op) > 1000 && op.attempts <= MAX_AUTO_RECONCILE {
                            let nonce = agentos_protocol::random_hex(8);
                            run(b, &op, &res, &caps, &nonce, op.attempts)
                        } else {
                            no_effect("failed_no_effect", "target_unchanged", json!({"why": "recovery after deadline"}), "EXTERNAL_RESULT_INDETERMINATE", "interrupted before publication; the target kept its previous content")
                        }
                    } else {
                        r
                    }
                }
            }
        }
        "service.ensure_state" | "service.set_limit" => {
            let requested = {
                let g = b.db.lock().unwrap();
                has_step(g.as_ref().unwrap(), &op, if op.env.capability_id == "service.ensure_state" { "job_requested" } else { "property_requested" }).is_some()
            };
            if !requested {
                if remaining_ms(&op) > 1000 && op.attempts <= MAX_AUTO_RECONCILE {
                    run(b, &op, &res, &caps, &agentos_protocol::random_hex(8), op.attempts)
                } else {
                    no_effect("failed_no_effect", "not_dispatched", json!({}), "SERVICE_STATE_UNCONFIRMED", "interrupted before the request was sent; deadline passed")
                }
            } else {
                let r = reconcile_service(b, &op, &res, &caps, "recovery");
                if r.state == "reconciling" {
                    run(b, &op, &res, &caps, &agentos_protocol::random_hex(8), op.attempts)
                } else {
                    r
                }
            }
        }
        "network.apply_profile" => {
            let requested = {
                let g = b.db.lock().unwrap();
                has_step(g.as_ref().unwrap(), &op, "commit_requested").is_some()
            };
            if !requested {
                if remaining_ms(&op) > 1000 && op.attempts <= MAX_AUTO_RECONCILE {
                    run(b, &op, &res, &caps, &agentos_protocol::random_hex(8), op.attempts)
                } else {
                    no_effect("failed_no_effect", "not_dispatched", json!({}), "EXTERNAL_RESULT_INDETERMINATE", "interrupted before the commit; deadline passed")
                }
            } else {
                let r = reconcile_network(b, &op, &res, "recovery");
                if r.state == "reconciling" {
                    run(b, &op, &res, &caps, &agentos_protocol::random_hex(8), op.attempts)
                } else {
                    r
                }
            }
        }
        "serial.exchange" => {
            let started = {
                let g = b.db.lock().unwrap();
                has_step(g.as_ref().unwrap(), &op, "port_open_started").is_some()
            };
            if started {
                unknown("send_uncertain", json!({"why": "recovery"}), "SERIAL_DELIVERY_UNKNOWN", "the broker stopped after the port was opened; the frame may have been sent")
            } else if remaining_ms(&op) > 2500 && op.attempts <= MAX_AUTO_RECONCILE {
                run(b, &op, &res, &caps, &agentos_protocol::random_hex(8), op.attempts)
            } else {
                no_effect("expired_no_effect", "not_dispatched", json!({}), "PLAN_EXPIRED", "the deadline passed before the port was opened")
            }
        }
        _ => unknown("unsupported", json!({}), "RECONCILIATION_REQUIRED", "no reconciler"),
    };
    if o.state == "reconciling" {
        // Budget exhausted while still unconfirmed.
        if op.attempts >= MAX_AUTO_RECONCILE || remaining_ms(&op) == 0 {
            finish(b, &op, unknown("recovery_budget", json!({}), "EXTERNAL_RESULT_INDETERMINATE", "automatic reconciliation budget exhausted"));
        } else {
            set_state(b, &op, "reconciling");
        }
    } else {
        finish(b, &op, o);
    }
}

/// On start: every operation that was admitted (running) is moved to reconciling; nothing is re-run blindly.
pub fn reconcile_all(b: &Shared) {
    let ops = {
        let g = b.db.lock().unwrap();
        load_ops(g.as_ref().unwrap(), &b.install_id, &["running"])
    };
    for op in ops {
        set_state(b, &op, "reconciling");
    }
    let ops = {
        let g = b.db.lock().unwrap();
        load_ops(g.as_ref().unwrap(), &b.install_id, &["reconciling"])
    };
    for op in ops {
        reconcile_one(b, &op);
    }
}

/// Spec §12.3 / V3-R09: stop every worker unit and wait until it is inactive, then start a fresh one.
pub fn fence_workers(b: &Shared) {
    let Ok(conn) = agentos_protocol::sysd::system() else {
        eprintln!("agentos-broker: system bus unavailable; workers not fenced, writes will wait");
        return;
    };
    for w in [&b.policy.workers.file, &b.policy.workers.service, &b.policy.workers.network, &b.policy.workers.serial] {
        if let Err(e) = agentos_protocol::sysd::stop_and_wait(&conn, &w.unit, Duration::from_secs(20)) {
            eprintln!("agentos-broker: fence {}: {e}", w.unit);
            continue;
        }
        if let Err(e) = agentos_protocol::sysd::start_and_wait(&conn, &w.unit, Duration::from_secs(20)) {
            eprintln!("agentos-broker: start {}: {e}", w.unit);
        }
    }
    let g = b.db.lock().unwrap();
    if let Some(c) = g.as_ref() {
        let _ = db::audit(c, "workers_fenced", None, None, None, None, &json!({"instance": b.instance_id}));
    }
}
