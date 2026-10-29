//! broker.sqlite (spec §19.2): WAL, foreign keys, synchronous=FULL, opened only by the single broker process that holds
//! the data-directory lock. It is never created implicitly: a missing or mismatched log keeps writes disabled.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

pub const SCHEMA_VERSION: i64 = 3;

/// v0.4 (spec §21.2): maintenance policies, workspace maintenance state, target control epochs and the rolling
/// attempt counts (authority for privileged maintenance), plus the maintenance origin of an operation. Additive.
const SCHEMA_V2: &str = r#"
CREATE TABLE maintenance_policies (
  store_uuid TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  policy_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  policy_hash TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_generation INTEGER NOT NULL,
  action_family TEXT NOT NULL,
  bounds_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  maintenance_epoch INTEGER NOT NULL,
  request_hash TEXT NOT NULL,
  synced_seq INTEGER NOT NULL,
  revoked_seq INTEGER,
  PRIMARY KEY (store_uuid, incarnation, policy_id, policy_version)
) STRICT;
CREATE TABLE workspace_maintenance_state (
  store_uuid TEXT PRIMARY KEY,
  incarnation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','paused')),
  maintenance_epoch INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL
) STRICT;
CREATE TABLE target_control_epochs (
  store_uuid TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  resource_id TEXT NOT NULL,
  control_epoch INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  PRIMARY KEY (store_uuid, resource_id)
) STRICT;
CREATE TABLE maintenance_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_uuid TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  resource_id TEXT NOT NULL,
  action_family TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  job_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  admitted_at INTEGER NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending',
  seq INTEGER NOT NULL
) STRICT;
CREATE INDEX maintenance_attempts_window ON maintenance_attempts(store_uuid, resource_id, action_family, admitted_at);
CREATE TRIGGER maintenance_attempts_keep BEFORE DELETE ON maintenance_attempts BEGIN SELECT RAISE(ABORT, 'maintenance attempts are never deleted'); END;
ALTER TABLE effect_operations ADD COLUMN maintenance_json TEXT;
"#;
/// v0.4 rev 3 (spec §21.2, R08): workspace maintenance state and target control epochs are kept per workspace
/// incarnation, so a restore starts a fresh row and the old incarnation's facts stay readable (never overwritten).
/// Table rebuild that copies every row; nothing is deleted.
const SCHEMA_V3: &str = r#"
CREATE TABLE workspace_maintenance_state_v3 (
  store_uuid TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','paused')),
  maintenance_epoch INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  PRIMARY KEY (store_uuid, incarnation)
) STRICT;
INSERT INTO workspace_maintenance_state_v3 SELECT store_uuid, incarnation, state, maintenance_epoch, updated_seq FROM workspace_maintenance_state;
DROP TABLE workspace_maintenance_state;
ALTER TABLE workspace_maintenance_state_v3 RENAME TO workspace_maintenance_state;
CREATE TABLE target_control_epochs_v3 (
  store_uuid TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  resource_id TEXT NOT NULL,
  control_epoch INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  PRIMARY KEY (store_uuid, incarnation, resource_id)
) STRICT;
INSERT INTO target_control_epochs_v3 SELECT store_uuid, incarnation, resource_id, control_epoch, updated_seq FROM target_control_epochs;
DROP TABLE target_control_epochs;
ALTER TABLE target_control_epochs_v3 RENAME TO target_control_epochs;
"#;
pub const DATA_DIR: &str = "/var/lib/agentos-broker";
pub const DB_PATH: &str = "/var/lib/agentos-broker/broker.sqlite";
pub const BLOB_DIR: &str = "/var/lib/agentos-broker/blobs";

const SCHEMA: &str = r#"
CREATE TABLE broker_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE workspace_bindings (
  store_uuid TEXT PRIMARY KEY,
  allowed_uid INTEGER NOT NULL,
  workspace_path_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','quiescing','fenced','restoring')),
  policy_version TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE restore_sessions (
  restore_request_id TEXT PRIMARY KEY,
  store_uuid TEXT NOT NULL REFERENCES workspace_bindings(store_uuid),
  source_incarnation INTEGER,
  previous_incarnation INTEGER NOT NULL,
  target_incarnation INTEGER NOT NULL,
  checkpoint_seq INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('fenced','complete')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
) STRICT;
CREATE TABLE broker_grants (
  grant_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL,
  store_uuid TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  principal_json TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  resource_id TEXT NOT NULL,
  resource_generation INTEGER NOT NULL,
  limits_json TEXT NOT NULL,
  params_hash TEXT,
  expires_at INTEGER NOT NULL,
  request_hash TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  revoked_seq INTEGER,
  revoked_at INTEGER,
  PRIMARY KEY (grant_id, grant_version)
) STRICT;
CREATE TABLE resource_state (
  resource_id TEXT PRIMARY KEY,
  store_uuid TEXT NOT NULL,
  kind TEXT NOT NULL,
  catalog_key TEXT NOT NULL,
  generation INTEGER NOT NULL,
  identity_digest TEXT,
  observed_version TEXT,
  status TEXT NOT NULL,
  lock_operation_id TEXT,
  quarantine_operation_id TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE effect_operations (
  machine_install_id TEXT NOT NULL,
  store_uuid TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_generation INTEGER NOT NULL,
  replay_class TEXT NOT NULL,
  state TEXT NOT NULL,
  completion_kind TEXT,
  effect_certainty TEXT,
  evidence_kind TEXT,
  evidence_json TEXT,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  dispatch_nonce TEXT,
  broker_instance_id TEXT,
  external_ref TEXT,
  deadline_ms INTEGER NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  resolution_json TEXT,
  compensates_operation_id TEXT,
  accepted_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (machine_install_id, store_uuid, incarnation, operation_id)
) STRICT;
CREATE INDEX effect_operations_state ON effect_operations(state);
CREATE TABLE cancel_tombstones (
  machine_install_id TEXT NOT NULL,
  store_uuid TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (machine_install_id, store_uuid, incarnation, operation_id)
) STRICT;
CREATE TABLE effect_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  step TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  before_json TEXT,
  after_json TEXT,
  external_ref TEXT,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX effect_steps_op ON effect_steps(operation_id);
CREATE TABLE broker_audit (
  seq INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  store_uuid TEXT,
  incarnation INTEGER,
  operation_id TEXT,
  grant_id TEXT,
  summary_json TEXT NOT NULL,
  at INTEGER NOT NULL
) STRICT;
CREATE TABLE blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, created_at INTEGER NOT NULL) STRICT;
"#;

pub fn open_existing(path: &str) -> Result<Connection, String> {
    if !std::path::Path::new(path).exists() {
        return Err("BROKER_HISTORY_MISSING: broker.sqlite is missing; writes stay disabled until an administrator restores it or reinstalls".into());
    }
    let c = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|e| format!("BROKER_HISTORY_MISSING: open: {e}"))?;
    pragmas(&c)?;
    let ok: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0)).map_err(|e| format!("BROKER_HISTORY_MISSING: integrity: {e}"))?;
    if ok != "ok" {
        return Err(format!("BROKER_HISTORY_MISSING: integrity check failed: {ok}"));
    }
    let v: Option<String> = c.query_row("SELECT value FROM broker_meta WHERE key='schema_version'", [], |r| r.get(0)).optional().map_err(|e| format!("BROKER_HISTORY_MISSING: {e}"))?;
    match v.and_then(|s| s.parse::<i64>().ok()) {
        Some(SCHEMA_VERSION) => Ok(c),
        Some(1) => {
            // v0.3 log → v0.4: additive tables only; history, tombstones and incarnations are untouched.
            c.execute_batch(&format!("BEGIN IMMEDIATE; {SCHEMA_V2} {SCHEMA_V3} UPDATE broker_meta SET value='3' WHERE key='schema_version'; COMMIT;"))
                .map_err(|e| format!("BROKER_HISTORY_MISSING: schema upgrade 1→3 failed: {e}"))?;
            Ok(c)
        }
        Some(2) => {
            // early v0.4 log: per-incarnation keys; every row is copied.
            c.execute_batch(&format!("BEGIN IMMEDIATE; {SCHEMA_V3} UPDATE broker_meta SET value='3' WHERE key='schema_version'; COMMIT;"))
                .map_err(|e| format!("BROKER_HISTORY_MISSING: schema upgrade 2→3 failed: {e}"))?;
            Ok(c)
        }
        Some(n) if n > SCHEMA_VERSION => Err(format!("BROKER_HISTORY_MISSING: log schema {n} is newer than this broker ({SCHEMA_VERSION})")),
        _ => Err("BROKER_HISTORY_MISSING: log schema version missing or unsupported".into()),
    }
}

pub fn pragmas(c: &Connection) -> Result<(), String> {
    c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;").map_err(|e| format!("pragma: {e}"))
}

/// Administrator install: create a new log with a new machineInstallId. Refuses when a log exists.
pub fn create(path: &str, install_id: &str, policy_version: &str) -> Result<Connection, String> {
    if std::path::Path::new(path).exists() {
        return Err("a broker log already exists; inspect it or move it away explicitly".into());
    }
    let c = Connection::open(path).map_err(|e| format!("create: {e}"))?;
    pragmas(&c)?;
    c.execute_batch(SCHEMA).map_err(|e| format!("schema: {e}"))?;
    c.execute_batch(SCHEMA_V2).map_err(|e| format!("schema v2: {e}"))?;
    c.execute_batch(SCHEMA_V3).map_err(|e| format!("schema v3: {e}"))?;
    let now = agentos_protocol::now_ms() as i64;
    for (k, v) in [("schema_version", SCHEMA_VERSION.to_string()), ("machine_install_id", install_id.to_string()), ("policy_version", policy_version.to_string()), ("seq", "0".into()), ("created_at", now.to_string())] {
        c.execute("INSERT INTO broker_meta(key,value) VALUES (?1,?2)", params![k, v]).map_err(|e| e.to_string())?;
    }
    Ok(c)
}

pub fn meta(c: &Connection, key: &str) -> Option<String> {
    c.query_row("SELECT value FROM broker_meta WHERE key=?1", params![key], |r| r.get(0)).optional().ok().flatten()
}

pub fn set_meta(c: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    c.execute("INSERT INTO broker_meta(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value]).map(|_| ())
}

/// Next global log sequence number (inside the caller's transaction).
pub fn next_seq(c: &Connection) -> rusqlite::Result<i64> {
    let s: i64 = c.query_row("SELECT CAST(value AS INTEGER) FROM broker_meta WHERE key='seq'", [], |r| r.get(0))?;
    c.execute("UPDATE broker_meta SET value=?1 WHERE key='seq'", params![(s + 1).to_string()])?;
    Ok(s + 1)
}

pub fn audit(c: &Connection, kind: &str, store: Option<&str>, inc: Option<i64>, op: Option<&str>, grant: Option<&str>, summary: &Value) -> rusqlite::Result<i64> {
    let seq = next_seq(c)?;
    c.execute(
        "INSERT INTO broker_audit(seq,kind,store_uuid,incarnation,operation_id,grant_id,summary_json,at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![seq, kind, store, inc, op, grant, summary.to_string(), agentos_protocol::now_ms() as i64],
    )?;
    Ok(seq)
}
