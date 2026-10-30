//! machine.sqlite (spec §15.1): local filesystem, WAL, foreign keys, synchronous=FULL; only agentos-machined writes it.
//! schemaVersion 1. Every ID column holds a canonical lowercase UUID unless noted; times are UTC milliseconds.
use rusqlite::Connection;

pub const SCHEMA_VERSION: i64 = 1;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS machine_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  machine_install_id TEXT NOT NULL,
  first_boot_id TEXT NOT NULL UNIQUE,
  machine_control_epoch INTEGER NOT NULL CHECK (machine_control_epoch >= 1),
  registry_seq INTEGER NOT NULL CHECK (registry_seq >= 0),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  current_release_id TEXT,
  known_good_release_id TEXT,
  accepted_release_sequence INTEGER NOT NULL DEFAULT 0,
  restore_state TEXT NOT NULL CHECK (restore_state IN ('idle','in_progress')),
  first_boot_state TEXT NOT NULL CHECK (first_boot_state IN ('open','closed')),
  machine_secret_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  login_uid INTEGER NOT NULL UNIQUE,
  login_name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  state TEXT NOT NULL CHECK (state IN ('provisioning','active','disabled')),
  auth_version INTEGER NOT NULL CHECK (auth_version >= 1),
  provisioning_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  create_id TEXT NOT NULL UNIQUE,
  store_uuid TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(user_id),
  execution_uid INTEGER NOT NULL UNIQUE,
  exec_login TEXT NOT NULL UNIQUE,
  subuid_start INTEGER NOT NULL UNIQUE,
  subgid_start INTEGER NOT NULL UNIQUE,
  range_size INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('creating','stopped','starting','running','quiescing','recovery_required','archived')),
  instance_epoch INTEGER NOT NULL CHECK (instance_epoch >= 1),
  workspace_incarnation INTEGER NOT NULL CHECK (workspace_incarnation >= 1),
  data_path_id TEXT NOT NULL,
  run_when_logged_out INTEGER NOT NULL DEFAULT 0 CHECK (run_when_logged_out IN (0,1)),
  origin TEXT NOT NULL CHECK (origin IN ('created','imported_v04','restored','cloned')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  user_id TEXT NOT NULL REFERENCES users(user_id),
  role TEXT NOT NULL CHECK (role IN ('viewer','editor','owner')),
  member_version INTEGER NOT NULL CHECK (member_version >= 1),
  state TEXT NOT NULL CHECK (state IN ('active','revoking','revoked')),
  changed_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_owner ON workspace_members(workspace_id) WHERE role = 'owner' AND state = 'active';
CREATE TABLE IF NOT EXISTS registry_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  registry_seq INTEGER NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('host','broker','gateway')),
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body_json TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','acked')),
  ack_seq INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (target_kind, target_id, registry_seq)
) STRICT;
CREATE TABLE IF NOT EXISTS revocations (
  revocation_id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('member','user','workspace')),
  scope_id TEXT NOT NULL,
  workspace_id TEXT,
  user_id TEXT,
  old_version INTEGER NOT NULL,
  new_version INTEGER NOT NULL,
  registry_seq INTEGER NOT NULL,
  reason TEXT NOT NULL,
  gateway_ack INTEGER NOT NULL DEFAULT 0,
  host_ack INTEGER NOT NULL DEFAULT 0,
  broker_ack INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('revoking','revoked')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS workspace_instances (
  instance_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  instance_epoch INTEGER NOT NULL,
  boot_id TEXT NOT NULL,
  host_pid INTEGER,
  cgroup_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting','running','stopping','stopped','lost')),
  last_seen_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_live_instance ON workspace_instances(workspace_id) WHERE state IN ('starting','running','stopping');
CREATE TABLE IF NOT EXISTS machine_permits (
  permit_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  execution_epoch INTEGER NOT NULL,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  resource_class TEXT NOT NULL CHECK (resource_class IN ('model','build','io')),
  priority TEXT NOT NULL CHECK (priority IN ('foreground','background')),
  body_hash TEXT NOT NULL,
  member_version INTEGER NOT NULL,
  user_id TEXT,
  instance_id TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','reserved','in_use','released','reconciling','revoked')),
  reserved_at INTEGER,
  used_at INTEGER,
  deadline_at INTEGER NOT NULL,
  usage_status TEXT NOT NULL CHECK (usage_status IN ('none','unused','used','unknown')),
  usage_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, execution_epoch, owner_kind, owner_id, attempt_id, resource_class)
) STRICT;
CREATE TABLE IF NOT EXISTS machine_operations (
  operation_id TEXT PRIMARY KEY,
  principal_user_id TEXT NOT NULL,
  session_epoch INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_generation INTEGER NOT NULL,
  params_json TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  machine_control_epoch INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('planned','authorized','dispatching','reconciling','succeeded','cancelled_no_effect','failed_no_effect','expired_no_effect','indeterminate')),
  effect_certainty TEXT NOT NULL CHECK (effect_certainty IN ('none','applied','unknown')),
  ticket_hash TEXT,
  ticket_expires_at INTEGER,
  ticket_used INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (principal_user_id, idempotency_key)
) STRICT;
CREATE TABLE IF NOT EXISTS provisioning_steps (
  provisioning_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user','workspace','install')),
  target_identity TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('intent','done')),
  receipt_json TEXT,
  PRIMARY KEY (provisioning_id, step_id)
) STRICT;
CREATE TABLE IF NOT EXISTS owner_transfers (
  transfer_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  to_user_id TEXT NOT NULL,
  from_member_version INTEGER NOT NULL,
  to_member_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','confirmed','expired','cancelled')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS releases (
  release_id TEXT PRIMARY KEY,
  manifest_hash TEXT NOT NULL,
  release_sequence INTEGER NOT NULL UNIQUE,
  closure_path TEXT NOT NULL,
  compatibility_json TEXT NOT NULL,
  migration_class TEXT NOT NULL CHECK (migration_class IN ('none','compatible_expand','offline_breaking')),
  verification_state TEXT NOT NULL CHECK (verification_state IN ('verified','rejected')),
  support_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS revoked_keys (
  key_id TEXT PRIMARY KEY,
  revoked_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS trusted_keys (
  key_id TEXT PRIMARY KEY,
  public_key_hex TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS update_jobs (
  update_id TEXT PRIMARY KEY,
  from_release_id TEXT,
  to_release_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  trial_boot_id TEXT,
  previous_entry_id TEXT,
  candidate_entry_id TEXT,
  checkpoint_set_id TEXT,
  barrier_id TEXT,
  error_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_open_update ON update_jobs((1)) WHERE state NOT IN ('committed','cancelled','failed_no_switch','rolled_back');
CREATE TABLE IF NOT EXISTS barriers (
  barrier_id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('update','checkpoint','restore')),
  owner_id TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held','released')),
  created_at INTEGER NOT NULL,
  released_at INTEGER
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_held_barrier ON barriers((1)) WHERE state = 'held';
CREATE TABLE IF NOT EXISTS checkpoint_sets (
  set_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('workspace','machine')),
  state TEXT NOT NULL CHECK (state IN ('building','complete','abandoned')),
  manifest_hash TEXT,
  release_id TEXT,
  barrier_id TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  export_state TEXT NOT NULL DEFAULT 'none' CHECK (export_state IN ('none','exporting','exported','verified'))
) STRICT;
CREATE TABLE IF NOT EXISTS restore_jobs (
  restore_id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('same-machine','clone','workspace')),
  state TEXT NOT NULL,
  old_control_epoch INTEGER NOT NULL,
  new_control_epoch INTEGER,
  staging_identity TEXT,
  step_cursor TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_open_restore ON restore_jobs((1)) WHERE state NOT IN ('complete','abandoned');
CREATE TABLE IF NOT EXISTS legacy_bindings (
  store_uuid TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  legacy_principal TEXT NOT NULL,
  receipt_hash TEXT NOT NULL,
  import_id TEXT NOT NULL UNIQUE
) STRICT;
CREATE TABLE IF NOT EXISTS sessions_audit (
  session_digest TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  login_session TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  bound_at INTEGER NOT NULL,
  ended_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS root_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope_id TEXT,
  outcome TEXT NOT NULL,
  timestamp INTEGER NOT NULL
) STRICT;
"#;

pub fn open(path: &str) -> rusqlite::Result<Connection> {
    let c = Connection::open(path)?;
    c.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;")?;
    c.execute_batch(SCHEMA)?;
    Ok(c)
}
