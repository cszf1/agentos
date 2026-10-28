//! Shared broker state: policy, the single log connection, the resource catalog and operation projections.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use crate::db;
use crate::policy::{self, Policy};
use agentos_protocol::worker::{self, CallError, WorkerRequest};

pub struct Broker {
    pub db: Mutex<Option<Connection>>,
    pub diag: Option<String>,
    pub policy: Policy,
    pub policy_version: String,
    pub instance_id: String,
    pub install_id: String,
    pub wake: (Mutex<bool>, Condvar),
}

pub type Shared = Arc<Broker>;

#[derive(Debug, Clone)]
pub struct BErr {
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

impl BErr {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        BErr { code: code.into(), message: message.into(), details: None }
    }
    pub fn with(mut self, d: Value) -> Self {
        self.details = Some(d);
        self
    }
}

impl From<rusqlite::Error> for BErr {
    fn from(e: rusqlite::Error) -> Self {
        BErr::new("BROKER_UNAVAILABLE", format!("log: {e}"))
    }
}

/// A catalog resource resolved for this workspace: kind, key, display and the worker target (never from the host).
#[derive(Debug, Clone)]
pub struct CatalogRes {
    pub resource_id: String,
    pub kind: &'static str,
    pub key: String,
    pub display_name: String,
    pub target: Value,
    pub caps: Value,
}

impl Broker {
    pub fn catalog(&self, store: &str) -> Vec<CatalogRes> {
        let p = &self.policy;
        let mut out = Vec::new();
        for m in p.managed_roots.iter().filter(|m| m.store_uuid == store) {
            out.push(CatalogRes {
                resource_id: policy::resource_id(&self.install_id, store, "managed-root", &m.key),
                kind: "managed-root",
                key: m.key.clone(),
                display_name: m.display_name.clone(),
                target: json!({"root": m.path, "writerUid": p.workers.file.uid}),
                caps: json!({"maxFileBytes": m.max_file_bytes.min(128 * 1024), "quotaBytes": m.quota_bytes}),
            });
        }
        for u in p.units.iter().filter(|u| u.store_uuid == store) {
            out.push(CatalogRes {
                resource_id: policy::resource_id(&self.install_id, store, "service", &u.key),
                kind: "service",
                key: u.key.clone(),
                display_name: u.display_name.clone(),
                target: json!({"unit": u.unit, "templateHash": u.template_hash}),
                caps: json!({
                    "states": ["running", "stopped"],
                    "CPUQuotaPerSecUSec": {"min": u.cpu_quota_per_sec_usec.min, "max": u.cpu_quota_per_sec_usec.max},
                    "MemoryMax": {"min": u.memory_max.min, "max": u.memory_max.max},
                    "safeRepeatStart": u.safe_repeat_start, "autoConverge": u.auto_converge
                }),
            });
        }
        for n in p.lab_networks.iter().filter(|n| n.store_uuid == store) {
            out.push(CatalogRes {
                resource_id: policy::resource_id(&self.install_id, store, "lab-network", &n.key),
                kind: "lab-network",
                key: n.key.clone(),
                display_name: n.display_name.clone(),
                target: json!({"netnsPath": n.netns_path, "table": n.table, "peerAddress": n.peer_address, "peerPort": n.peer_port, "maxRules": n.max_rules}),
                caps: json!({"profiles": n.profiles}),
            });
        }
        for s in p.serial.iter().filter(|s| s.store_uuid == store) {
            out.push(CatalogRes {
                resource_id: policy::resource_id(&self.install_id, store, "serial", &s.key),
                kind: "serial",
                key: s.key.clone(),
                display_name: s.display_name.clone(),
                target: json!({"kind": s.kind, "path": s.path, "profile": s.profile, "udevMatch": s.udev_match}),
                caps: json!({"commands": ["SAMPLE", "ECHO"], "profile": s.profile, "frameMax": 256, "responseMax": 4096, "timeoutMs": 2000}),
            });
        }
        out
    }

    pub fn find_res(&self, store: &str, resource_id: &str) -> Option<CatalogRes> {
        self.catalog(store).into_iter().find(|r| r.resource_id == resource_id)
    }

    pub fn worker_for(&self, kind: &str) -> &policy::WorkerEntry {
        match kind {
            "managed-root" => &self.policy.workers.file,
            "service" => &self.policy.workers.service,
            "lab-network" => &self.policy.workers.network,
            _ => &self.policy.workers.serial,
        }
    }

    pub fn call_worker(&self, kind: &str, op: &str, target: &Value, params: Value, op_id: Option<&str>, nonce: Option<&str>, timeout_ms: u64) -> Result<Value, CallError> {
        let w = self.worker_for(kind);
        // Worker fault points fire only on effectful dispatches of the matching worker (never on observe/read).
        let role = match kind { "managed-root" => "file", "service" => "service", "lab-network" => "network", _ => "serial" };
        let faults = if op_id.is_some() && !matches!(op, "observe" | "read" | "version" | "status" | "usage") { self.worker_faults(role) } else { vec![] };
        let req = WorkerRequest {
            v: 1,
            op: op.into(),
            broker_instance_id: self.instance_id.clone(),
            operation_id: op_id.map(String::from),
            dispatch_nonce: nonce.map(String::from),
            target: target.clone(),
            params,
            faults,
        };
        worker::call(&w.socket, w.uid, &req, Duration::from_millis(timeout_ms))
    }

    /// One-shot fault points (test installs only): a line in /etc/agentos/broker/faultpoints is removed when it fires.
    pub fn fault(&self, name: &str) {
        if !self.policy.test_mode {
            return;
        }
        let path = "/etc/agentos/broker/faultpoints";
        let Ok(text) = std::fs::read_to_string(path) else { return };
        let lines: Vec<&str> = text.lines().collect();
        if lines.iter().any(|l| l.trim() == name) {
            let rest: Vec<&str> = lines.into_iter().filter(|l| l.trim() != name).collect();
            let _ = std::fs::write(path, rest.join("\n") + if rest.is_empty() { "" } else { "\n" });
            eprintln!("agentos-broker: fault point {name} fired; aborting");
            unsafe { libc::kill(libc::getpid(), libc::SIGKILL) };
        }
    }

    pub fn worker_faults(&self, role: &str) -> Vec<String> {
        if !self.policy.test_mode {
            return vec![];
        }
        let path = "/etc/agentos/broker/faultpoints";
        let Ok(text) = std::fs::read_to_string(path) else { return vec![] };
        let prefix = format!("worker.{role}.");
        let (w, rest): (Vec<&str>, Vec<&str>) = text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).partition(|l| l.starts_with(&prefix));
        if !w.is_empty() {
            let _ = std::fs::write(path, rest.join("\n") + if rest.is_empty() { "" } else { "\n" });
        }
        w.into_iter().map(|s| s.trim_start_matches("worker.").to_string()).collect()
    }

    pub fn kick(&self) {
        let (m, c) = &self.wake;
        *m.lock().unwrap() = true;
        c.notify_all();
    }
}

pub fn op_view(c: &Connection, install: &str, store: &str, inc: i64, op_id: &str) -> Result<Option<Value>, BErr> {
    let row = c
        .query_row(
            "SELECT operation_id, action_id, incarnation, state, completion_kind, effect_certainty, evidence_kind, evidence_json, result_json, error_code, error_message, resolution_json, capability_id, resource_id, resource_generation, accepted_seq, updated_seq, request_hash, plan_hash, compensates_operation_id, deadline_ms, cancel_requested, reconcile_attempts, external_ref
             FROM effect_operations WHERE machine_install_id=?1 AND store_uuid=?2 AND incarnation=?3 AND operation_id=?4",
            params![install, store, inc, op_id],
            |r| row_view(r),
        )
        .optional()?;
    let Some(mut v) = row else { return Ok(None) };
    let mut st = c.prepare("SELECT step, attempt, at, after_json FROM effect_steps WHERE operation_id=?1 AND incarnation=?2 ORDER BY id")?;
    let steps: Vec<Value> = st
        .query_map(params![op_id, inc], |r| Ok(json!({"step": r.get::<_, String>(0)?, "attempt": r.get::<_, i64>(1)?, "at": r.get::<_, i64>(2)?})))?
        .filter_map(|x| x.ok())
        .collect();
    v["steps"] = Value::Array(steps);
    Ok(Some(v))
}

pub fn row_view(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let parse = |s: Option<String>| s.and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(Value::Null);
    Ok(json!({
        "operationId": r.get::<_, String>(0)?,
        "actionId": r.get::<_, String>(1)?,
        "incarnation": r.get::<_, i64>(2)?,
        "state": r.get::<_, String>(3)?,
        "completionKind": r.get::<_, Option<String>>(4)?,
        "effectCertainty": r.get::<_, Option<String>>(5)?,
        "evidenceKind": r.get::<_, Option<String>>(6)?,
        "evidence": parse(r.get(7)?),
        "result": parse(r.get(8)?),
        "error": match r.get::<_, Option<String>>(9)? { Some(code) => json!({"code": code, "message": r.get::<_, Option<String>>(10)?}), None => Value::Null },
        "resolution": parse(r.get(11)?),
        "capabilityId": r.get::<_, String>(12)?,
        "resourceId": r.get::<_, String>(13)?,
        "resourceGeneration": r.get::<_, i64>(14)?,
        "acceptedSeq": r.get::<_, i64>(15)?,
        "updatedSeq": r.get::<_, i64>(16)?,
        "requestHash": r.get::<_, String>(17)?,
        "planHash": r.get::<_, String>(18)?,
        "compensatesOperationId": r.get::<_, Option<String>>(19)?,
        "deadlineMs": r.get::<_, i64>(20)?,
        "cancelRequested": r.get::<_, i64>(21)? != 0,
        "reconcileAttempts": r.get::<_, i64>(22)?,
        "externalRef": r.get::<_, Option<String>>(23)?,
    }))
}

pub fn ensure_resource_rows(c: &Connection, b: &Broker) -> rusqlite::Result<()> {
    let now = agentos_protocol::now_ms() as i64;
    for h in &b.policy.hosts {
        for r in b.catalog(&h.store_uuid) {
            c.execute(
                "INSERT INTO resource_state(resource_id, store_uuid, kind, catalog_key, generation, status, updated_at) VALUES (?1,?2,?3,?4,1,'unobserved',?5) ON CONFLICT(resource_id) DO NOTHING",
                params![r.resource_id, h.store_uuid, r.kind, r.key, now],
            )?;
        }
    }
    Ok(())
}

pub fn db_or_diag<'a>(b: &'a Broker, g: &'a mut std::sync::MutexGuard<'_, Option<Connection>>) -> Result<&'a Connection, BErr> {
    match g.as_ref() {
        Some(c) => Ok(c),
        None => Err(BErr::new(if b.diag.as_deref().unwrap_or("").starts_with("BROKER_IDENTITY_MISMATCH") { "BROKER_IDENTITY_MISMATCH" } else { "BROKER_HISTORY_MISSING" }, b.diag.clone().unwrap_or_else(|| "broker log unavailable".into()))),
    }
}

pub fn now() -> i64 {
    agentos_protocol::now_ms() as i64
}

pub fn digest(v: &Value) -> String {
    agentos_protocol::domain_hash("agentos.resource-identity.v1", v).unwrap_or_default()
}

pub fn db_path() -> &'static str {
    db::DB_PATH
}
