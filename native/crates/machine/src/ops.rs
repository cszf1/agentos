//! Machine operations (spec §12.2): plan → one-time 60 s ticket bound to the full planHash → authorized →
//! dispatching → reconciling → succeeded, or a definite *_no_effect, or indeterminate. Ticket use, operation intent
//! and the idempotency receipt commit in one machine transaction before any helper runs. Unknown outcomes are read
//! back from the real service and never retried under a new operationId.
use crate::dir::Machine;
use crate::err::{MErr, R};
use crate::util::{canon, hash, is_uuid, now_ms, random_bytes, sha256, uuid};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

pub const TICKET_MS: i64 = 60_000;
pub const PLAN_MS: i64 = 10 * 60_000;

/// Fixed action catalogue. `admin` kinds need a machine administrator with fresh local PAM authentication.
pub const KINDS: &[(&str, bool)] = &[
    ("network.wifi.connect", false),
    ("network.wifi.forget", false),
    ("network.wifi.disconnect", false),
    ("network.device.disconnect", false),
    ("network.device.connect", false),
    ("time.timezone.set", true),
    ("time.ntp.enable", true),
    ("power.reboot", false),
    ("power.poweroff", false),
    ("power.suspend", false),
    ("users.create", true),
    ("users.disable", true),
    ("updates.activate", true),
    ("updates.rollback", true),
    ("restores.confirm", true),
    ("workspaces.delete", true),
    // Owner's confirmation of a deletion and its data disposition (spec §8.2: owner AND machine administrator).
    ("workspaces.deleteConsent", false),
    // Owner setting (spec §9.3, §27.1, V1-W08): owner of the workspace only, checked at plan and again at dispatch.
    ("workspaces.runWhenLoggedOut", false),
    // Owner setting: the workspace's model credential; the key arrives only as a secretRef (spec §5.2, V1-I11).
    ("workspaces.modelCredential.set", false),
];

/// Parameter names that would carry a secret; a plan never stores one (the gateway puts the secret in machined's
/// one-time secret store and passes `secretRef`; spec §12.1 "操作日志只保存 secretRef").
pub fn secret_param(k: &str) -> bool {
    let k = k.to_ascii_lowercase();
    ["psk", "password", "passphrase", "secret", "key", "apikey", "api_key", "token"].iter().any(|w| k == *w || (k.contains(w) && k != "secretref"))
}

pub fn kind_admin(kind: &str) -> R<bool> {
    KINDS.iter().find(|(k, _)| *k == kind).map(|(_, a)| *a).ok_or_else(|| MErr::new("INVALID_REQUEST", "unknown machine action kind"))
}

#[derive(Debug, Clone)]
pub struct Principal {
    pub user_id: String,
    pub session_epoch: i64,
    pub admin: bool,
    pub locked: bool,
}

/// What a backend says about the resource before and after an action.
pub trait Executor {
    /// Resource identity and current generation (a monotonic or content version of its real state).
    fn probe(&mut self, kind: &str, params: &Value) -> R<(String, i64, Value)>;
    /// Perform the action. Err with code *_NO_EFFECT only when it is certain nothing changed.
    fn dispatch(&mut self, m: &mut Machine, op: &Value) -> R<Value>;
    /// Read back the real state after dispatch: Some(true) applied, Some(false) not applied, None unknown.
    fn reconcile(&mut self, kind: &str, params: &Value, dispatched: &Value) -> Option<bool>;
}

fn op_json(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "operationId": r.get::<_, String>(0)?, "kind": r.get::<_, String>(1)?, "resourceId": r.get::<_, String>(2)?,
        "resourceGeneration": r.get::<_, i64>(3)?, "planHash": r.get::<_, String>(4)?, "state": r.get::<_, String>(5)?,
        "effectCertainty": r.get::<_, String>(6)?, "expiresAt": r.get::<_, i64>(7)?, "result": r.get::<_, Option<String>>(8)?.and_then(|t| serde_json::from_str::<Value>(&t).ok()),
        "machineControlEpoch": r.get::<_, i64>(9)?, "initiator": r.get::<_, String>(10)?, "params": r.get::<_, String>(11)?.parse::<Value>().unwrap_or(Value::Null),
    }))
}
const OP_COLS: &str = "operation_id, kind, resource_id, resource_generation, plan_hash, state, effect_certainty, expires_at, result_json, machine_control_epoch, principal_user_id, params_json";

impl Machine {
    pub fn operation(&self, p: &Principal, operation_id: &str) -> R<Value> {
        let v = self.c.query_row(&format!("SELECT {OP_COLS} FROM machine_operations WHERE operation_id = ?1"), [operation_id], op_json).optional()?.ok_or_else(MErr::hidden)?;
        if v["initiator"] != p.user_id.as_str() && !p.admin {
            return Err(MErr::hidden());
        }
        Ok(v)
    }

    pub fn plan_operation(&mut self, ex: &mut dyn Executor, p: &Principal, idempotency_key: &str, kind: &str, params_v: &Value) -> R<Value> {
        let admin = kind_admin(kind)?;
        if admin && !p.admin {
            return Err(MErr::hidden());
        }
        if p.locked {
            return Err(MErr::new("SESSION_LOCKED", "unlock the session to plan machine actions"));
        }
        if idempotency_key.is_empty() || idempotency_key.len() > 200 {
            return Err(MErr::new("INVALID_REQUEST", "idempotency key required"));
        }
        let request_hash = hash("agentos.machine.action.request.v1", &json!({ "kind": kind, "params": params_v }));
        if let Some((id, rh)) = self.c.query_row("SELECT operation_id, request_hash FROM machine_operations WHERE principal_user_id = ?1 AND idempotency_key = ?2", params![p.user_id, idempotency_key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).optional()? {
            if rh != request_hash {
                return Err(MErr::new("CONFLICT", "idempotency key reused with a different request"));
            }
            return self.operation(p, &id);
        }
        if kind != "restores.confirm" {
            self.require_restore_idle()?;
        }
        // full/read-only disk: only actions that free space, revoke authority or stop the machine stay available
        if !matches!(kind, "workspaces.delete" | "workspaces.deleteConsent" | "users.disable" | "power.reboot" | "power.poweroff" | "network.device.disconnect") {
            self.storage_guard()?;
        }
        if kind == "workspaces.deleteConsent" {
            let ws = params_v["workspaceId"].as_str().ok_or_else(|| MErr::new("INVALID_REQUEST", "workspaceId is required"))?;
            self.delete_consent_check(&p.user_id, ws)?;
        }
        if kind == "workspaces.delete" {
            let ws = params_v["workspaceId"].as_str().ok_or_else(|| MErr::new("INVALID_REQUEST", "workspaceId is required"))?;
            // the plan shows the current blocker (if any) so the administrator sees why it would fail
            if let Some(b) = self.delete_blocker(ws)? {
                return Err(crate::dir::blocker_err(&b));
            }
        }
        if let Some(o) = params_v.as_object() {
            if let Some(k) = o.keys().find(|k| secret_param(k)) {
                return Err(MErr::new("INVALID_REQUEST", format!("{k}: a secret never travels in params")));
            }
        }
        if kind == "workspaces.modelCredential.set" {
            crate::backends::model_credential_params(params_v)?;
            if !params_v["secretRef"].is_string() {
                return Err(MErr::new("INVALID_REQUEST", "the key is required"));
            }
            let (role, _) = self.membership(&p.user_id, params_v["workspaceId"].as_str().unwrap_or_default())?;
            if role != crate::dir::Role::Owner {
                return Err(MErr::hidden());
            }
        }
        if kind == "workspaces.runWhenLoggedOut" {
            let ws = params_v["workspaceId"].as_str().ok_or_else(|| MErr::new("INVALID_REQUEST", "workspaceId is required"))?;
            if !params_v["enabled"].is_boolean() {
                return Err(MErr::new("INVALID_REQUEST", "enabled must be a boolean"));
            }
            let (role, _) = self.membership(&p.user_id, ws)?;
            if role != crate::dir::Role::Owner {
                return Err(MErr::hidden());
            }
        }
        let (resource_id, generation, impact) = ex.probe(kind, params_v)?;
        let epoch = self.control_epoch()?;
        let id = uuid();
        let expires = now_ms() + PLAN_MS;
        let params_hash = hash("agentos.machine.action.params.v1", params_v);
        let plan = json!({ "operationId": id, "kind": kind, "resourceId": resource_id, "resourceGeneration": generation, "paramsHash": params_hash,
            "initiator": p.user_id, "sessionEpoch": p.session_epoch, "machineControlEpoch": epoch, "expiresAt": expires, "impact": impact });
        let plan_hash = hash("agentos.machine.action.plan.v1", &plan);
        self.tx(|c| {
            c.execute(
                "INSERT INTO machine_operations (operation_id, principal_user_id, session_epoch, idempotency_key, kind, resource_id, resource_generation, params_json, plan_hash, request_hash, machine_control_epoch, state, effect_certainty, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'planned', 'none', ?12, ?13)",
                params![id, p.user_id, p.session_epoch, idempotency_key, kind, resource_id, generation, canon(params_v), plan_hash, request_hash, epoch, expires, now_ms()],
            )?;
            Self::audit(c, &p.user_id, &format!("op.plan:{kind}"), Some(&resource_id), "planned", Some(&id))
        })?;
        let mut v = self.operation(p, &id)?;
        v["impact"] = impact;
        v["admin"] = json!(admin);
        Ok(v)
    }

    /// Issue the one-time confirmation ticket. The gateway calls this only for the current local, active, unlocked
    /// session, and for admin kinds only right after PAM authenticated this user (spec §12.2, §9.3).
    pub fn issue_ticket(&self, p: &Principal, operation_id: &str, plan_hash: &str, authenticated: bool) -> R<String> {
        let op = self.operation(p, operation_id)?;
        if op["initiator"] != p.user_id.as_str() {
            return Err(MErr::hidden());
        }
        if p.locked {
            return Err(MErr::new("SESSION_LOCKED", "session is locked"));
        }
        if kind_admin(op["kind"].as_str().unwrap_or_default())? && !authenticated {
            return Err(MErr::new("SESSION_REQUIRED", "administrator authentication is required"));
        }
        if op["planHash"] != plan_hash || op["state"] != "planned" {
            return Err(MErr::new("PLAN_STALE", "the plan changed; review it again"));
        }
        let ticket = hex::encode(random_bytes::<32>());
        let th = sha256(ticket.as_bytes());
        self.tx(|c| {
            c.execute("UPDATE machine_operations SET ticket_hash = ?2, ticket_expires_at = ?3, ticket_used = 0 WHERE operation_id = ?1 AND state = 'planned'", params![operation_id, th, now_ms() + TICKET_MS])?;
            Ok(())
        })?;
        Ok(ticket)
    }

    pub fn confirm_operation(&mut self, ex: &mut dyn Executor, p: &Principal, operation_id: &str, plan_hash: &str, ticket: &str) -> R<Value> {
        if !is_uuid(operation_id) {
            return Err(MErr::new("INVALID_REQUEST", "operationId must be a uuid"));
        }
        if p.locked {
            return Err(MErr::new("SESSION_LOCKED", "session is locked"));
        }
        let op = self.operation(p, operation_id)?;
        let state = op["state"].as_str().unwrap_or_default().to_string();
        if state != "planned" {
            // Confirming again is idempotent: return the recorded state, never a second dispatch.
            return Ok(op);
        }
        let kind = op["kind"].as_str().unwrap_or_default().to_string();
        let params_v = op["params"].clone();
        // Re-probe: a changed resource generation or control epoch makes the plan stale (no silent re-plan).
        let (rid, gen, _) = ex.probe(&kind, &params_v)?;
        let epoch = self.control_epoch()?;
        let th = sha256(ticket.as_bytes());
        self.tx(|c| {
            let (tk, texp, used, exp, sess): (Option<String>, Option<i64>, i64, i64, i64) = c.query_row(
                "SELECT ticket_hash, ticket_expires_at, ticket_used, expires_at, session_epoch FROM machine_operations WHERE operation_id = ?1",
                [operation_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )?;
            let now = now_ms();
            if now > exp {
                c.execute("UPDATE machine_operations SET state = 'expired_no_effect' WHERE operation_id = ?1", [operation_id])?;
                return Err(MErr::new("PLAN_STALE", "the plan expired"));
            }
            if op["planHash"] != plan_hash || rid != op["resourceId"].as_str().unwrap_or_default() || gen != op["resourceGeneration"].as_i64().unwrap_or(-1) || epoch != op["machineControlEpoch"].as_i64().unwrap_or(-1) || sess != p.session_epoch {
                return Err(MErr::new("PLAN_STALE", "the plan no longer matches the current state"));
            }
            if tk.as_deref() != Some(th.as_str()) || used != 0 || texp.unwrap_or(0) < now {
                return Err(MErr::new("SESSION_STALE", "the confirmation ticket is invalid, used or expired"));
            }
            c.execute("UPDATE machine_operations SET ticket_used = 1, state = 'dispatching' WHERE operation_id = ?1 AND state = 'planned'", [operation_id])?;
            Self::audit(c, &p.user_id, &format!("op.confirm:{kind}"), Some(&rid), "dispatching", Some(operation_id))
        })?;
        let op = self.operation(p, operation_id)?;
        let dispatched = ex.dispatch(self, &op);
        let (state, certainty, result) = match dispatched {
            Ok(res) => {
                self.tx(|c| {
                    c.execute("UPDATE machine_operations SET state = 'reconciling' WHERE operation_id = ?1", [operation_id])?;
                    Ok(())
                })?;
                match ex.reconcile(&kind, &params_v, &res) {
                    Some(true) => ("succeeded", "applied", res),
                    Some(false) => ("failed_no_effect", "none", res),
                    None => ("indeterminate", "unknown", res),
                }
            }
            Err(e) if e.code.ends_with("_NO_EFFECT") || e.code == "INVALID_REQUEST" || e.code == "HARDWARE_UNSUPPORTED" => ("failed_no_effect", "none", e.json()),
            Err(e) => match ex.reconcile(&kind, &params_v, &Value::Null) {
                Some(true) => ("succeeded", "applied", e.json()),
                Some(false) => ("failed_no_effect", "none", e.json()),
                None => ("indeterminate", "unknown", e.json()),
            },
        };
        self.tx(|c| {
            c.execute("UPDATE machine_operations SET state = ?2, effect_certainty = ?3, result_json = ?4 WHERE operation_id = ?1", params![operation_id, state, certainty, canon(&result)])?;
            Self::audit(c, &p.user_id, &format!("op.result:{kind}"), None, state, Some(operation_id))
        })?;
        self.operation(p, operation_id)
    }

    pub fn cancel_operation(&self, p: &Principal, operation_id: &str) -> R<Value> {
        let op = self.operation(p, operation_id)?;
        if op["initiator"] != p.user_id.as_str() && !p.admin {
            return Err(MErr::hidden());
        }
        self.tx(|c| {
            // Cancel wins only before dispatch; once dispatching the action is reconciled, not undone.
            c.execute("UPDATE machine_operations SET state = 'cancelled_no_effect' WHERE operation_id = ?1 AND state IN ('planned','authorized')", [operation_id])?;
            Ok(())
        })?;
        self.operation(p, operation_id)
    }

    /// Restart: operations left in dispatching/reconciling are read back, never re-dispatched (§26).
    pub fn reconcile_operations(&mut self, ex: &mut dyn Executor) -> R<usize> {
        let rows: Vec<(String, String, String)> = {
            let mut st = self.c.prepare("SELECT operation_id, kind, params_json FROM machine_operations WHERE state IN ('dispatching','reconciling','authorized')")?;
            let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<Vec<_>, _>>()?;
            v
        };
        let n = rows.len();
        for (id, kind, params_t) in rows {
            let pv: Value = serde_json::from_str(&params_t).unwrap_or(Value::Null);
            let (state, cert) = match ex.reconcile(&kind, &pv, &Value::Null) {
                Some(true) => ("succeeded", "applied"),
                Some(false) => ("failed_no_effect", "none"),
                None => ("indeterminate", "unknown"),
            };
            self.tx(|c| {
                c.execute("UPDATE machine_operations SET state = ?2, effect_certainty = ?3 WHERE operation_id = ?1", params![id, state, cert])?;
                Self::audit(c, "root", &format!("op.reconcile:{kind}"), None, state, Some(&id))
            })?;
        }
        Ok(n)
    }
}
