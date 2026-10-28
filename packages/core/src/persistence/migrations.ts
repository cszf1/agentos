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
  `
-- v0.3 (spec §19.1): Linux providers, system actions, observations. Append-only; v1/v2 tables keep their meaning.
ALTER TABLE meta ADD COLUMN provider_protocol_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE meta ADD COLUMN broker_install_id TEXT;
ALTER TABLE meta ADD COLUMN workspace_incarnation INTEGER;
ALTER TABLE meta ADD COLUMN broker_binding_state TEXT NOT NULL DEFAULT 'unbound' CHECK (broker_binding_state IN ('unbound','bound','mismatch','fenced'));
ALTER TABLE meta ADD COLUMN provider_policy_version TEXT;

CREATE TABLE system_resources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('import-root','managed-root','service','lab-network','host-network','serial','telemetry')),
  display_name TEXT NOT NULL,
  execution_class TEXT NOT NULL CHECK (execution_class IN ('provider-user','broker')),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  catalog_key TEXT,
  identity_digest TEXT,
  identity_json TEXT,
  host_path TEXT,
  status TEXT NOT NULL CHECK (status IN ('available','unavailable','gone','suspended','quarantined','unobserved')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE provider_grants (
  id TEXT PRIMARY KEY,
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('app','system_action','run')),
  app_id TEXT,
  revision_id TEXT,
  action_id TEXT,
  run_id TEXT,
  binding_alias TEXT,
  capability_id TEXT NOT NULL,
  capability_version INTEGER NOT NULL,
  resource_id TEXT NOT NULL REFERENCES system_resources (id),
  resource_generation INTEGER NOT NULL,
  limits_json TEXT NOT NULL,
  params_hash TEXT,
  confirmation_policy TEXT NOT NULL CHECK (confirmation_policy IN ('per_plan','standing')),
  grant_version INTEGER NOT NULL CHECK (grant_version >= 1),
  expires_at TEXT NOT NULL,
  sync_state TEXT NOT NULL CHECK (sync_state IN ('local','pending','active','revoking','revoked','failed')),
  sync_error TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX provider_grants_app ON provider_grants (app_id, revision_id) WHERE revoked_at IS NULL;
CREATE TRIGGER provider_grants_immutable BEFORE UPDATE OF principal_kind, app_id, revision_id, action_id, run_id, binding_alias, capability_id,
  capability_version, resource_id, resource_generation, limits_json, params_hash, confirmation_policy, grant_version, expires_at, created_at ON provider_grants
BEGIN SELECT RAISE(ABORT, 'a provider grant is immutable; create a new grant'); END;
CREATE TRIGGER provider_grants_revoke_once BEFORE UPDATE OF revoked_at ON provider_grants
WHEN OLD.revoked_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'revoked_at is set once'); END;

CREATE TABLE provider_grant_outbox (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES provider_grants (id),
  kind TEXT NOT NULL CHECK (kind IN ('create','revoke')),
  request_hash TEXT NOT NULL,
  frozen_request TEXT NOT NULL,
  dispatch_state TEXT NOT NULL CHECK (dispatch_state IN ('pending','sent','confirmed','failed')),
  broker_result TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (grant_id, kind)
);
CREATE TRIGGER provider_grant_outbox_frozen BEFORE UPDATE OF grant_id, kind, request_hash, frozen_request ON provider_grant_outbox
BEGIN SELECT RAISE(ABORT, 'a frozen grant request cannot change'); END;

CREATE TABLE system_actions (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL CHECK (origin IN ('app','agent','compensation')),
  app_id TEXT,
  revision_id TEXT,
  run_id TEXT,
  tool_task_id TEXT,
  source_app_epoch INTEGER,
  data_epoch INTEGER,
  handler_id TEXT,
  capability_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  observation_refs TEXT NOT NULL,
  grant_id TEXT,
  grant_version INTEGER,
  resource_id TEXT NOT NULL REFERENCES system_resources (id),
  resource_generation INTEGER NOT NULL,
  confirmation_policy TEXT NOT NULL CHECK (confirmation_policy IN ('per_plan','standing')),
  state TEXT NOT NULL CHECK (state IN ('awaiting_approval','ready','dispatching','running','reconciling','succeeded','failed_no_effect','cancelled_no_effect','expired_no_effect','indeterminate','rejected')),
  operation_id TEXT UNIQUE,
  confirm_key TEXT,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  completion_kind TEXT,
  effect_certainty TEXT,
  evidence_kind TEXT,
  result_json TEXT,
  evidence_json TEXT,
  error_json TEXT,
  resolution_json TEXT,
  compensates_action_id TEXT,
  workspace_incarnation INTEGER,
  broker_seq INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX system_actions_open ON system_actions (state) WHERE state NOT IN ('succeeded','failed_no_effect','cancelled_no_effect','expired_no_effect','rejected');
CREATE INDEX system_actions_app ON system_actions (app_id, state);
CREATE TRIGGER system_actions_plan_frozen BEFORE UPDATE OF id, origin, app_id, revision_id, run_id, handler_id, capability_id, plan_hash, plan_json,
  observation_refs, resource_id, resource_generation, created_at ON system_actions
BEGIN SELECT RAISE(ABORT, 'a frozen system plan is immutable'); END;
CREATE TRIGGER system_actions_operation_once BEFORE UPDATE OF operation_id ON system_actions
WHEN OLD.operation_id IS NOT NULL AND (NEW.operation_id IS NULL OR NEW.operation_id <> OLD.operation_id)
BEGIN SELECT RAISE(ABORT, 'an action binds exactly one operation'); END;
CREATE TRIGGER system_actions_outcome_sticky BEFORE UPDATE OF state ON system_actions
WHEN OLD.state IN ('succeeded','failed_no_effect','cancelled_no_effect','expired_no_effect','rejected') AND NEW.state <> OLD.state
BEGIN SELECT RAISE(ABORT, 'a final system action state is immutable'); END;
CREATE TRIGGER system_actions_unknown_sticky BEFORE UPDATE OF state ON system_actions
WHEN OLD.state = 'indeterminate' AND NEW.state <> 'indeterminate'
BEGIN SELECT RAISE(ABORT, 'an indeterminate outcome is never rewritten; record a resolution instead'); END;

CREATE TABLE system_outbox (
  operation_id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL UNIQUE REFERENCES system_actions (id),
  machine_install_id TEXT NOT NULL,
  workspace_incarnation INTEGER NOT NULL,
  frozen_envelope TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  dispatch_state TEXT NOT NULL CHECK (dispatch_state IN ('pending','sent','accepted','final','fenced')),
  last_broker_seq INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER system_outbox_frozen BEFORE UPDATE OF operation_id, action_id, machine_install_id, workspace_incarnation, frozen_envelope, request_hash ON system_outbox
BEGIN SELECT RAISE(ABORT, 'a delivered envelope cannot change'); END;

CREATE TABLE resource_observations (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('app_call','run','user')),
  call_id TEXT,
  run_id TEXT,
  tool_task_id TEXT,
  principal_key TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_generation INTEGER NOT NULL,
  capability_id TEXT NOT NULL,
  version TEXT,
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  quality TEXT NOT NULL CHECK (quality IN ('fresh','stale','gap','unavailable')),
  summary_json TEXT NOT NULL
);
CREATE INDEX resource_observations_scope ON resource_observations (scope_kind, call_id, run_id);

CREATE TABLE provider_event_cursors (
  source TEXT PRIMARY KEY,
  source_epoch TEXT,
  last_received_seq INTEGER NOT NULL DEFAULT 0,
  drop_count INTEGER NOT NULL DEFAULT 0,
  quality TEXT NOT NULL CHECK (quality IN ('fresh','stale','gap','unavailable')),
  last_refresh_at TEXT
);

CREATE TABLE provider_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_epoch TEXT,
  resource_id TEXT,
  resource_generation INTEGER,
  kind TEXT NOT NULL,
  bounded_payload TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX provider_events_resource ON provider_events (resource_id, seq);

ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'build' CHECK (mode IN ('build','system_plan'));
ALTER TABLE runs ADD COLUMN system_resource_scope TEXT;
ALTER TABLE runs ADD COLUMN prepared_action_id TEXT;
CREATE TRIGGER runs_prepared_sticky BEFORE UPDATE OF prepared_action_id ON runs
WHEN OLD.prepared_action_id IS NOT NULL AND (NEW.prepared_action_id IS NULL OR NEW.prepared_action_id <> OLD.prepared_action_id)
BEGIN SELECT RAISE(ABORT, 'prepared_action_id cannot change'); END;
CREATE TRIGGER runs_mode_frozen BEFORE UPDATE OF mode, system_resource_scope ON runs
BEGIN SELECT RAISE(ABORT, 'a run mode and its resource scope are frozen'); END;
`,
];
