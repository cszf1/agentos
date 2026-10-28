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
];
