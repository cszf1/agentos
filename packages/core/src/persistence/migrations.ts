/** Versioned os.sqlite migrations. Never edit an applied migration; append a new one. */
export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  store_uuid TEXT NOT NULL,
  client_epoch INTEGER NOT NULL CHECK (client_epoch >= 1),
  agent_binding_state TEXT NOT NULL CHECK (agent_binding_state IN ('pending','bound')),
  created_at TEXT NOT NULL
);

CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  active_revision_id TEXT,
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  contract_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (id, active_revision_id) REFERENCES revisions (app_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE revisions (
  app_id TEXT NOT NULL REFERENCES apps (id),
  id TEXT NOT NULL,
  bundle_json TEXT NOT NULL,
  created_by_run_id TEXT,
  created_at TEXT NOT NULL,
  first_activated_at TEXT,
  PRIMARY KEY (app_id, id)
);

CREATE TRIGGER revisions_immutable BEFORE UPDATE OF app_id, id, bundle_json, created_by_run_id, created_at ON revisions
BEGIN SELECT RAISE(ABORT, 'revision is immutable'); END;
CREATE TRIGGER revisions_first_activated_once BEFORE UPDATE OF first_activated_at ON revisions
WHEN OLD.first_activated_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'first_activated_at is set once'); END;

CREATE TABLE records (
  app_id TEXT NOT NULL REFERENCES apps (id),
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id)
);
CREATE INDEX records_order ON records (app_id, created_at DESC, id DESC);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  target_app_id TEXT NOT NULL REFERENCES apps (id),
  expected_app_epoch INTEGER NOT NULL CHECK (expected_app_epoch >= 0),
  intent TEXT NOT NULL,
  frozen_submit_json TEXT NOT NULL,
  submit_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','cancel_requested','blocked','succeeded','failed','cancelled')),
  dispatch_state TEXT NOT NULL CHECK (dispatch_state IN ('pending','dispatching','submitted')),
  pi_submission_id INTEGER,
  applied_revision_id TEXT,
  model_request_count INTEGER NOT NULL DEFAULT 0 CHECK (model_request_count >= 0),
  stop_reason TEXT,
  last_validation_json TEXT,
  error_json TEXT,
  warning TEXT,
  deadline_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX runs_single_active ON runs ((status IS NOT NULL))
  WHERE status IN ('queued','running','cancel_requested','blocked');
CREATE TRIGGER runs_applied_sticky BEFORE UPDATE OF applied_revision_id ON runs
WHEN OLD.applied_revision_id IS NOT NULL AND (NEW.applied_revision_id IS NULL OR NEW.applied_revision_id <> OLD.applied_revision_id)
BEGIN SELECT RAISE(ABORT, 'applied_revision_id cannot change'); END;

CREATE TABLE operations (
  principal TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal, operation_key)
);

CREATE TABLE run_steps (
  run_id TEXT NOT NULL REFERENCES runs (id),
  kind TEXT NOT NULL,
  durable_task_id TEXT NOT NULL,
  tool_name TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, kind, durable_task_id)
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  app_id TEXT,
  run_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  // v0.2 (spec §13). Appended; v0.1 tables and constraints keep their meaning.
  `
ALTER TABLE apps ADD COLUMN data_epoch INTEGER NOT NULL DEFAULT 0 CHECK (data_epoch >= 0);

ALTER TABLE meta ADD COLUMN runtime_protocol_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE meta ADD COLUMN runtime_policy_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE meta ADD COLUMN catalog_hash TEXT;
ALTER TABLE meta ADD COLUMN host_boot_id TEXT;
ALTER TABLE meta ADD COLUMN agent_toolset_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE build_jobs (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps (id),
  revision_id TEXT NOT NULL,
  build_key TEXT NOT NULL,
  runtime_lock_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','building','succeeded','failed','cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  container_name TEXT NOT NULL,
  container_id TEXT,
  host_boot_id TEXT,
  artifact_id TEXT,
  deadline_at TEXT NOT NULL,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (app_id, revision_id) REFERENCES revisions (app_id, id)
);
CREATE UNIQUE INDEX build_jobs_one_inflight ON build_jobs (build_key) WHERE status IN ('queued','building');

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  build_key TEXT NOT NULL,
  runtime_lock_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  verified_at TEXT,
  gc_state TEXT NOT NULL DEFAULT 'live' CHECK (gc_state IN ('live','unavailable','marked')),
  created_at TEXT NOT NULL
);
CREATE INDEX artifacts_build_key ON artifacts (build_key);
CREATE TRIGGER artifacts_immutable BEFORE UPDATE OF id, build_key, runtime_lock_id, platform, manifest_json, relative_path, size_bytes, created_at ON artifacts
BEGIN SELECT RAISE(ABORT, 'artifact is immutable'); END;

CREATE TABLE revision_artifacts (
  app_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  runtime_lock_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts (id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, revision_id),
  FOREIGN KEY (app_id, revision_id) REFERENCES revisions (app_id, id)
);
CREATE TRIGGER revision_artifacts_immutable BEFORE UPDATE ON revision_artifacts
BEGIN SELECT RAISE(ABORT, 'a revision points at a fixed artifact'); END;

CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps (id),
  target_revision_id TEXT NOT NULL,
  base_revision_id TEXT,
  expected_app_epoch INTEGER NOT NULL CHECK (expected_app_epoch >= 0),
  origin TEXT NOT NULL CHECK (origin IN ('agent_prepare','user_history')),
  owner_run_id TEXT REFERENCES runs (id),
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','preparing','ready','committed','failed','cancelled','superseded')),
  stage TEXT,
  no_op INTEGER NOT NULL DEFAULT 0 CHECK (no_op IN (0,1)),
  build_job_id TEXT REFERENCES build_jobs (id),
  artifact_id TEXT REFERENCES artifacts (id),
  candidate_instance_id TEXT,
  last_probe_at TEXT,
  deadline_at TEXT NOT NULL,
  committed_epoch INTEGER,
  committed_at TEXT,
  cleanup_state TEXT NOT NULL DEFAULT 'pending' CHECK (cleanup_state IN ('pending','complete','retrying')),
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (app_id, target_revision_id) REFERENCES revisions (app_id, id)
);
CREATE UNIQUE INDEX deployments_request ON deployments (origin, request_key);
CREATE UNIQUE INDEX deployments_one_per_app ON deployments (app_id) WHERE status IN ('queued','preparing','ready');
CREATE UNIQUE INDEX deployments_one_preparing ON deployments ((status IS NOT NULL)) WHERE status IN ('queued','preparing','ready');
CREATE TRIGGER deployments_committed_sticky BEFORE UPDATE OF committed_at, committed_epoch ON deployments
WHEN OLD.committed_at IS NOT NULL AND (NEW.committed_at IS NOT OLD.committed_at OR NEW.committed_epoch IS NOT OLD.committed_epoch)
BEGIN SELECT RAISE(ABORT, 'committed deployment facts cannot change'); END;
CREATE TRIGGER deployments_committed_status BEFORE UPDATE OF status ON deployments
WHEN OLD.status = 'committed' AND NEW.status <> 'committed'
BEGIN SELECT RAISE(ABORT, 'a committed deployment stays committed'); END;

CREATE TABLE runtime_instances (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps (id),
  revision_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts (id),
  deployment_id TEXT REFERENCES deployments (id),
  role TEXT NOT NULL CHECK (role IN ('active','preview')),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  host_boot_id TEXT NOT NULL,
  container_name TEXT NOT NULL UNIQUE,
  container_id TEXT,
  desired_state TEXT NOT NULL CHECK (desired_state IN ('running','stopped','removed')),
  observed_state TEXT NOT NULL CHECK (observed_state IN ('absent','starting','ready','serving','draining','stopped','failed','unknown')),
  lease_digest TEXT NOT NULL,
  last_probe_at TEXT,
  exit_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (app_id, revision_id) REFERENCES revisions (app_id, id)
);
CREATE INDEX runtime_instances_app ON runtime_instances (app_id, desired_state);

CREATE TABLE app_runtime (
  app_id TEXT PRIMARY KEY REFERENCES apps (id),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  active_instance_id TEXT REFERENCES runtime_instances (id),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  health TEXT NOT NULL CHECK (health IN ('stopped','recovering','ready','degraded')),
  control_epoch INTEGER NOT NULL DEFAULT 0 CHECK (control_epoch >= 0),
  restart_window_started_at TEXT,
  restart_count INTEGER NOT NULL DEFAULT 0 CHECK (restart_count >= 0),
  next_restart_at TEXT,
  last_error_json TEXT,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER app_runtime_instance_owner BEFORE UPDATE OF active_instance_id ON app_runtime
WHEN NEW.active_instance_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM runtime_instances i JOIN apps a ON a.id = i.app_id
  WHERE i.id = NEW.active_instance_id AND i.app_id = NEW.app_id AND i.revision_id = a.active_revision_id AND i.role = 'active')
BEGIN SELECT RAISE(ABORT, 'the active instance must belong to this app and its active revision'); END;
CREATE TRIGGER app_runtime_instance_owner_ins BEFORE INSERT ON app_runtime
WHEN NEW.active_instance_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'app_runtime starts without an active instance'); END;

CREATE TABLE invocations (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps (id),
  revision_id TEXT NOT NULL,
  app_epoch INTEGER NOT NULL,
  data_epoch INTEGER NOT NULL,
  command_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  request_key TEXT NOT NULL,
  principal_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted','executing','succeeded','failed')),
  instance_id TEXT,
  generation INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  logical_time TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (principal_key, request_key)
);
CREATE INDEX invocations_open ON invocations (status) WHERE status IN ('accepted','executing');
CREATE TRIGGER invocations_final_sticky BEFORE UPDATE ON invocations
WHEN OLD.status IN ('succeeded','failed')
BEGIN SELECT RAISE(ABORT, 'a finished invocation is immutable'); END;

CREATE TABLE service_grants (
  id TEXT PRIMARY KEY,
  source_app_id TEXT NOT NULL REFERENCES apps (id),
  source_revision_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  target_app_id TEXT NOT NULL REFERENCES apps (id),
  target_revision_id TEXT NOT NULL,
  export_name TEXT NOT NULL,
  contract_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (source_app_id, source_revision_id) REFERENCES revisions (app_id, id),
  FOREIGN KEY (target_app_id, target_revision_id) REFERENCES revisions (app_id, id)
);
CREATE UNIQUE INDEX service_grants_live ON service_grants (source_app_id, source_revision_id, alias) WHERE revoked_at IS NULL;
CREATE TRIGGER service_grants_revoke_once BEFORE UPDATE ON service_grants
WHEN OLD.revoked_at IS NOT NULL OR NEW.id <> OLD.id OR NEW.source_app_id <> OLD.source_app_id OR NEW.source_revision_id <> OLD.source_revision_id
  OR NEW.alias <> OLD.alias OR NEW.target_app_id <> OLD.target_app_id OR NEW.target_revision_id <> OLD.target_revision_id
  OR NEW.export_name <> OLD.export_name OR NEW.contract_hash <> OLD.contract_hash
BEGIN SELECT RAISE(ABORT, 'a grant can only be revoked once and is otherwise immutable'); END;

CREATE TABLE agent_toolset_migrations (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`,
];
