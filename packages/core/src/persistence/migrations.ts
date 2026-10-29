/** Versioned os.sqlite migrations. Never edit an applied migration; append a new one. */
/**
 * A migration is plain SQL, or a v0.4-style structural migration: SQL plus table rebuilds for columns whose NOT NULL /
 * CHECK constraints change (SQLite cannot ALTER those). Rebuilds keep every row, index and trigger of the original
 * definition except the listed replacements; they run with foreign keys off and are checked with foreign_key_check.
 */
export const V04_MIGRATION_SQL = `
-- v0.4 (spec §21.1): scheduler, model budgets, maintenance, online GC, lifecycle, proposals, compaction.
ALTER TABLE meta ADD COLUMN scheduler_protocol_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE meta ADD COLUMN scheduler_epoch INTEGER NOT NULL DEFAULT 1 CHECK (scheduler_epoch >= 1);
ALTER TABLE meta ADD COLUMN maintenance_epoch INTEGER NOT NULL DEFAULT 1 CHECK (maintenance_epoch >= 1);
ALTER TABLE meta ADD COLUMN maintenance_state TEXT NOT NULL DEFAULT 'running' CHECK (maintenance_state IN ('running','paused'));
ALTER TABLE meta ADD COLUMN maintenance_root_state TEXT NOT NULL DEFAULT 'synced' CHECK (maintenance_root_state IN ('synced','pending','unavailable'));
ALTER TABLE meta ADD COLUMN background_model_enabled INTEGER NOT NULL DEFAULT 0 CHECK (background_model_enabled IN (0,1));
ALTER TABLE meta ADD COLUMN clock_state TEXT NOT NULL DEFAULT 'ok' CHECK (clock_state IN ('ok','clock_uncertain'));
ALTER TABLE meta ADD COLUMN clock_wall_ms INTEGER;
ALTER TABLE meta ADD COLUMN clock_mono_ms INTEGER;
ALTER TABLE meta ADD COLUMN clock_boot_id TEXT;
ALTER TABLE meta ADD COLUMN budget_limits_json TEXT;
ALTER TABLE meta ADD COLUMN gc_generation INTEGER NOT NULL DEFAULT 1 CHECK (gc_generation >= 1);
ALTER TABLE meta ADD COLUMN scheduler_quiesce TEXT;

ALTER TABLE runs ADD COLUMN agent_profile_id TEXT NOT NULL DEFAULT 'builder' CHECK (agent_profile_id IN ('builder','system-planner','maintenance-analyst','maintenance-refactor'));
ALTER TABLE runs ADD COLUMN conversation_id TEXT;
ALTER TABLE runs ADD COLUMN legacy_root INTEGER NOT NULL DEFAULT 0 CHECK (legacy_root IN (0,1));
ALTER TABLE runs ADD COLUMN execution_epoch INTEGER NOT NULL DEFAULT 1 CHECK (execution_epoch >= 1);
ALTER TABLE runs ADD COLUMN scheduling_state TEXT NOT NULL DEFAULT 'done'
  CHECK (scheduling_state IN ('waiting_slot','waiting_target','waiting_build','waiting_model','dispatching','active','draining','done'));
ALTER TABLE runs ADD COLUMN wait_reason TEXT;
ALTER TABLE runs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN background INTEGER NOT NULL DEFAULT 0 CHECK (background IN (0,1));
ALTER TABLE runs ADD COLUMN queue_deadline_at TEXT;
ALTER TABLE runs ADD COLUMN started_at TEXT;
ALTER TABLE runs ADD COLUMN budget_config TEXT;
ALTER TABLE runs ADD COLUMN report_id TEXT;
ALTER TABLE runs ADD COLUMN proposal_id TEXT;
ALTER TABLE runs ADD COLUMN job_id TEXT;
ALTER TABLE runs ADD COLUMN incident_id TEXT;
ALTER TABLE runs ADD COLUMN output_reserved INTEGER NOT NULL DEFAULT 0 CHECK (output_reserved >= 0);
UPDATE runs SET legacy_root = 1, agent_profile_id = CASE mode WHEN 'system_plan' THEN 'system-planner' ELSE 'builder' END;
CREATE INDEX runs_sched ON runs (scheduling_state, background, priority, created_at) WHERE scheduling_state <> 'done';
CREATE TRIGGER runs_identity_frozen BEFORE UPDATE OF agent_profile_id, target_app_id, request_key, frozen_submit_json, submit_hash, background, job_id ON runs
BEGIN SELECT RAISE(ABORT, 'a run identity is frozen at acceptance'); END;
CREATE TRIGGER runs_conversation_once BEFORE UPDATE OF conversation_id ON runs
WHEN OLD.conversation_id IS NOT NULL AND (NEW.conversation_id IS NULL OR NEW.conversation_id <> OLD.conversation_id)
BEGIN SELECT RAISE(ABORT, 'a run binds exactly one conversation'); END;
CREATE TRIGGER runs_epoch_monotonic BEFORE UPDATE OF execution_epoch ON runs
WHEN NEW.execution_epoch < OLD.execution_epoch
BEGIN SELECT RAISE(ABORT, 'execution_epoch never goes back'); END;
CREATE TRIGGER runs_report_sticky BEFORE UPDATE OF report_id, proposal_id ON runs
WHEN (OLD.report_id IS NOT NULL AND NEW.report_id IS NOT OLD.report_id) OR (OLD.proposal_id IS NOT NULL AND NEW.proposal_id IS NOT OLD.proposal_id)
BEGIN SELECT RAISE(ABORT, 'completion facts cannot change'); END;

-- Pi conversation directory mirror (agent.sqlite holds the authoritative create transaction; this is the host mapping).
CREATE TABLE agent_conversations (
  conversation_id TEXT UNIQUE,
  create_key TEXT PRIMARY KEY,
  run_id TEXT UNIQUE REFERENCES runs (id),
  compaction_job_id TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('run','compaction','legacy_root')),
  profile_id TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  toolset_version INTEGER NOT NULL,
  model_route_id TEXT NOT NULL UNIQUE,
  route_epoch INTEGER NOT NULL DEFAULT 1 CHECK (route_epoch >= 1),
  route_purpose TEXT NOT NULL DEFAULT 'run' CHECK (route_purpose IN ('run','compaction','closed')),
  route_subject_id TEXT,
  binding_state TEXT NOT NULL CHECK (binding_state IN ('creating','bound','closed','quarantined','legacy')),
  maintenance_lock TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER agent_conversations_frozen BEFORE UPDATE OF create_key, run_id, purpose, profile_id, binding_hash, model_route_id ON agent_conversations
BEGIN SELECT RAISE(ABORT, 'a conversation binding is frozen'); END;
CREATE TRIGGER agent_conversations_id_once BEFORE UPDATE OF conversation_id ON agent_conversations
WHEN OLD.conversation_id IS NOT NULL AND (NEW.conversation_id IS NULL OR NEW.conversation_id <> OLD.conversation_id)
BEGIN SELECT RAISE(ABORT, 'conversation_id is written once'); END;

CREATE TABLE agent_dispatch_outbox (
  run_id TEXT NOT NULL REFERENCES runs (id),
  phase TEXT NOT NULL CHECK (phase IN ('create','submit','cancel')),
  frozen_request TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  create_key TEXT NOT NULL,
  conversation_id TEXT,
  submission_id INTEGER,
  dispatch_state TEXT NOT NULL CHECK (dispatch_state IN ('pending','sent','done','fenced')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, phase)
);
CREATE TRIGGER agent_dispatch_outbox_frozen BEFORE UPDATE OF run_id, phase, frozen_request, request_hash, create_key ON agent_dispatch_outbox
BEGIN SELECT RAISE(ABORT, 'a frozen dispatch request cannot change'); END;

CREATE TABLE target_leases (
  target_kind TEXT NOT NULL CHECK (target_kind IN ('app','service','conversation','workspace','resource')),
  target_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('run','job','user','compaction','archive')),
  owner_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 1),
  expected_version INTEGER,
  state TEXT NOT NULL CHECK (state IN ('held','reclaiming','released','unknown')),
  deadline_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (target_kind, target_id, owner_kind, owner_id)
);
CREATE UNIQUE INDEX target_leases_one_holder ON target_leases (target_kind, target_id) WHERE state IN ('held','reclaiming','unknown');

CREATE TABLE model_attempts (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT,
  job_id TEXT,
  compaction_job_id TEXT,
  conversation_id TEXT,
  route_id TEXT NOT NULL,
  route_epoch INTEGER NOT NULL,
  execution_epoch INTEGER,
  purpose TEXT NOT NULL CHECK (purpose IN ('run','compaction')),
  background INTEGER NOT NULL CHECK (background IN (0,1)),
  config_hash TEXT NOT NULL,
  reserved_output INTEGER NOT NULL CHECK (reserved_output >= 0),
  usage_json TEXT,
  output_tokens INTEGER,
  state TEXT NOT NULL CHECK (state IN ('waiting','running','completed','failed','interrupted','usage_unknown','denied')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  host_boot_id TEXT
);
CREATE INDEX model_attempts_time ON model_attempts (started_at);
CREATE INDEX model_attempts_open ON model_attempts (state) WHERE state IN ('waiting','running');

CREATE TABLE maintenance_policies (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('app','service','workspace','conversation')),
  target_id TEXT NOT NULL,
  target_contract TEXT,
  trigger_json TEXT NOT NULL,
  condition_json TEXT NOT NULL,
  bounds_json TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('observe','suggest','automatic')),
  allowed_actions TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  approved_hash TEXT,
  maintenance_epoch INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending_approval','syncing','enabled','paused','paused_needs_review','revoked','expired','superseded')),
  root_sync_state TEXT NOT NULL DEFAULT 'none' CHECK (root_sync_state IN ('none','pending','synced','revoking','revoked','failed')),
  root_version INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE TRIGGER maintenance_policies_frozen BEFORE UPDATE OF id, version, template_id, template_version, target_kind, target_id, trigger_json, condition_json,
  bounds_json, mode, allowed_actions, policy_hash, expires_at, created_at ON maintenance_policies
BEGIN SELECT RAISE(ABORT, 'a policy version is immutable; create a new version'); END;
CREATE TRIGGER maintenance_policies_approval_once BEFORE UPDATE OF approved_at, approved_hash, approved_by ON maintenance_policies
WHEN OLD.approved_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'an approval is recorded once'); END;
CREATE UNIQUE INDEX maintenance_policies_live ON maintenance_policies (id) WHERE state IN ('syncing','enabled');

CREATE TABLE schedule_cursors (
  policy_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  schedule_epoch INTEGER NOT NULL,
  anchor_utc TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL CHECK (interval_seconds BETWEEN 60 AND 86400),
  occurrence_seq INTEGER NOT NULL DEFAULT 0 CHECK (occurrence_seq >= 0),
  next_due_at TEXT NOT NULL,
  last_seen_utc TEXT,
  missed_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (policy_id, policy_version, schedule_epoch)
);
CREATE TRIGGER schedule_cursors_monotonic BEFORE UPDATE OF occurrence_seq ON schedule_cursors
WHEN NEW.occurrence_seq < OLD.occurrence_seq
BEGIN SELECT RAISE(ABORT, 'occurrence_seq never goes back'); END;

CREATE TABLE trigger_receipts (
  trigger_key TEXT PRIMARY KEY,
  policy_id TEXT,
  policy_version INTEGER,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual','interval','event')),
  occurrence_seq INTEGER,
  incident_id TEXT,
  job_id TEXT NOT NULL,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TRIGGER trigger_receipts_immutable BEFORE UPDATE ON trigger_receipts
BEGIN SELECT RAISE(ABORT, 'a trigger receipt is immutable'); END;

CREATE TABLE health_incidents (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  condition_key TEXT NOT NULL,
  episode_id INTEGER NOT NULL,
  generation INTEGER,
  quality TEXT NOT NULL CHECK (quality IN ('fresh','stale','gap','unavailable')),
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  evidence_json TEXT NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('open','investigating','mitigating','resolved','suppressed','needs_attention')),
  job_id TEXT,
  circuit TEXT NOT NULL DEFAULT 'closed' CHECK (circuit IN ('closed','open')),
  resolution_json TEXT,
  notified_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE UNIQUE INDEX health_incidents_one_open ON health_incidents (target_kind, target_id, condition_key) WHERE state IN ('open','investigating','mitigating','needs_attention');

CREATE TABLE health_samples (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  condition_key TEXT NOT NULL,
  value TEXT NOT NULL,
  quality TEXT NOT NULL,
  detail_json TEXT,
  observed_at TEXT NOT NULL
);
CREATE INDEX health_samples_target ON health_samples (target_kind, target_id, condition_key, seq);

CREATE TABLE maintenance_jobs (
  id TEXT PRIMARY KEY,
  trigger_key TEXT NOT NULL UNIQUE,
  policy_id TEXT,
  policy_version INTEGER,
  maintenance_epoch INTEGER NOT NULL,
  scheduler_epoch INTEGER NOT NULL,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_version TEXT,
  incident_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('observe','suggest','automatic','manual_check')),
  state TEXT NOT NULL CHECK (state IN ('queued','deferred','observing','diagnosing','awaiting_approval','ready','running','verifying','reconciling',
    'succeeded','no_change','failed_no_effect','cancelled','expired','indeterminate','needs_attention')),
  step_cursor INTEGER NOT NULL DEFAULT 0,
  completed_steps INTEGER NOT NULL DEFAULT 0,
  effect_certainty TEXT NOT NULL DEFAULT 'none' CHECK (effect_certainty IN ('none','confirmed','partial','unknown')),
  budget_json TEXT,
  deadline_at TEXT NOT NULL,
  wait_reason TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  stop_reason TEXT,
  outcome_reason TEXT,
  evidence_json TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX maintenance_jobs_open ON maintenance_jobs (state) WHERE state NOT IN ('succeeded','no_change','failed_no_effect','cancelled','expired','indeterminate','needs_attention');
CREATE TRIGGER maintenance_jobs_frozen BEFORE UPDATE OF id, trigger_key, policy_id, policy_version, maintenance_epoch, template_id, template_version, target_kind, target_id, created_at ON maintenance_jobs
BEGIN SELECT RAISE(ABORT, 'a job identity is frozen'); END;
CREATE TRIGGER maintenance_jobs_final_sticky BEFORE UPDATE OF state ON maintenance_jobs
WHEN OLD.state IN ('succeeded','no_change','failed_no_effect','cancelled','expired','indeterminate','needs_attention') AND NEW.state <> OLD.state
BEGIN SELECT RAISE(ABORT, 'a finished job is immutable'); END;

CREATE TABLE maintenance_steps (
  job_id TEXT NOT NULL REFERENCES maintenance_jobs (id),
  step_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  precondition_json TEXT,
  policy_version INTEGER,
  executor TEXT NOT NULL,
  effect_key TEXT UNIQUE,
  action_id TEXT,
  delete_intent_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('planned','admitted','dispatched','succeeded','no_change','failed_no_effect','unknown','skipped','cancelled')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, step_id)
);
CREATE TRIGGER maintenance_steps_frozen BEFORE UPDATE OF job_id, step_id, seq, kind, input_hash, input_json, executor, created_at ON maintenance_steps
BEGIN SELECT RAISE(ABORT, 'a step input is frozen'); END;
CREATE TRIGGER maintenance_steps_effect_once BEFORE UPDATE OF effect_key ON maintenance_steps
WHEN OLD.effect_key IS NOT NULL AND (NEW.effect_key IS NULL OR NEW.effect_key <> OLD.effect_key)
BEGIN SELECT RAISE(ABORT, 'a step has one execution identity'); END;
CREATE TRIGGER maintenance_steps_final_sticky BEFORE UPDATE OF state ON maintenance_steps
WHEN OLD.state IN ('succeeded','no_change','failed_no_effect','unknown','skipped','cancelled') AND NEW.state <> OLD.state AND NOT (OLD.state = 'unknown' AND NEW.state IN ('succeeded','failed_no_effect'))
BEGIN SELECT RAISE(ABORT, 'a settled step is immutable'); END;

CREATE TABLE maintenance_effect_outbox (
  job_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  frozen_envelope TEXT NOT NULL,
  envelope_hash TEXT NOT NULL,
  dispatch_state TEXT NOT NULL CHECK (dispatch_state IN ('pending','sent','accepted','final','fenced')),
  takeover_epoch INTEGER NOT NULL DEFAULT 1,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, step_id)
);
CREATE TRIGGER maintenance_effect_outbox_frozen BEFORE UPDATE OF job_id, step_id, frozen_envelope, envelope_hash ON maintenance_effect_outbox
BEGIN SELECT RAISE(ABORT, 'a frozen maintenance envelope cannot change'); END;

CREATE TABLE maintenance_attempts (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action_family TEXT NOT NULL,
  job_id TEXT,
  step_id TEXT,
  policy_id TEXT,
  policy_version INTEGER,
  admitted_at TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','succeeded','failed','unknown','no_change')),
  verified_at TEXT,
  consecutive_failure INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX maintenance_attempts_window ON maintenance_attempts (target_kind, target_id, action_family, admitted_at);
CREATE TRIGGER maintenance_attempts_keep BEFORE DELETE ON maintenance_attempts
BEGIN SELECT RAISE(ABORT, 'maintenance attempts are never deleted'); END;

CREATE TABLE maintenance_circuits (
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action_family TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('closed','open')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT,
  reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (target_kind, target_id, action_family)
);

CREATE TABLE artifact_pins (
  id TEXT PRIMARY KEY,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('artifact','staging','build')),
  object_id TEXT NOT NULL,
  gc_generation INTEGER NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('build','revision','deployment','preview','instance','backup','proposal','candidate_check','reader','staging')),
  owner_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held','released')),
  created_at TEXT NOT NULL,
  released_at TEXT,
  UNIQUE (object_kind, object_id, owner_kind, owner_id)
);
CREATE INDEX artifact_pins_live ON artifact_pins (object_kind, object_id) WHERE state = 'held';

CREATE TABLE gc_delete_intents (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  step_id TEXT,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('artifact','staging','log')),
  object_id TEXT NOT NULL,
  gc_generation INTEGER NOT NULL,
  source_path TEXT NOT NULL,
  source_identity TEXT,
  trash_path TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('marked','moved','deleted','recorded','aborted','unknown')),
  logical_bytes INTEGER NOT NULL DEFAULT 0,
  unlinked_bytes INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX gc_delete_intents_live ON gc_delete_intents (object_kind, object_id) WHERE phase IN ('marked','moved','unknown');

CREATE TABLE staging_owners (
  path_key TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('build','write')),
  owner_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','closed')),
  created_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE app_lifecycle (
  app_id TEXT PRIMARY KEY REFERENCES apps (id),
  state TEXT NOT NULL CHECK (state IN ('active','archiving','archived','restoring')),
  last_used_at TEXT,
  archive_intent_json TEXT,
  control_epoch INTEGER NOT NULL DEFAULT 1 CHECK (control_epoch >= 1),
  policy_id TEXT,
  recovery_paused INTEGER NOT NULL DEFAULT 0 CHECK (recovery_paused IN (0,1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE maintenance_reports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  incident_id TEXT,
  job_id TEXT,
  body_json TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER maintenance_reports_immutable BEFORE UPDATE ON maintenance_reports
BEGIN SELECT RAISE(ABORT, 'a maintenance report is immutable'); END;

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps (id),
  run_id TEXT NOT NULL UNIQUE,
  job_id TEXT,
  base_revision_id TEXT NOT NULL,
  base_app_epoch INTEGER NOT NULL,
  candidate_revision_id TEXT NOT NULL,
  candidate_check_id TEXT,
  body_json TEXT NOT NULL,
  proposal_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','accepted','publishing','published','rejected','stale','expired','needs_recheck')),
  decided_at TEXT,
  deployment_id TEXT,
  applied_revision_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER proposals_frozen BEFORE UPDATE OF id, app_id, run_id, base_revision_id, base_app_epoch, candidate_revision_id, body_json, proposal_hash, created_at ON proposals
BEGIN SELECT RAISE(ABORT, 'a proposal is immutable'); END;
CREATE TRIGGER proposals_applied_sticky BEFORE UPDATE OF applied_revision_id ON proposals
WHEN OLD.applied_revision_id IS NOT NULL AND NEW.applied_revision_id IS NOT OLD.applied_revision_id
BEGIN SELECT RAISE(ABORT, 'a published proposal stays published'); END;

CREATE TABLE candidate_checks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  fixture_set_version TEXT NOT NULL,
  runtime_lock_id TEXT,
  catalog_hash TEXT,
  tool_versions TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  baseline_hash TEXT,
  candidate_hash TEXT,
  checker_identity TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued','running','passed','failed','cancelled')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE compaction_jobs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  run_id TEXT,
  cutoff_entry_id TEXT NOT NULL,
  context_version TEXT,
  input_scope TEXT NOT NULL,
  compaction_key TEXT NOT NULL UNIQUE,
  pi_task_id TEXT,
  budget_route_epoch INTEGER,
  state TEXT NOT NULL CHECK (state IN ('queued','creating','running','placed','summary_unplaced','stale','failed','cancelled')),
  result_json TEXT,
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER compaction_jobs_task_once BEFORE UPDATE OF pi_task_id ON compaction_jobs
WHEN OLD.pi_task_id IS NOT NULL AND NEW.pi_task_id IS NOT OLD.pi_task_id
BEGIN SELECT RAISE(ABORT, 'a compaction job maps one Pi task'); END;

CREATE TABLE root_sync_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('policy-sync','policy-revoke','control','target-epoch')),
  subject TEXT NOT NULL,
  version INTEGER NOT NULL,
  frozen_request TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  dispatch_state TEXT NOT NULL CHECK (dispatch_state IN ('pending','sent','confirmed','failed')),
  broker_result TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER root_sync_outbox_frozen BEFORE UPDATE OF id, kind, subject, version, frozen_request, request_hash ON root_sync_outbox
BEGIN SELECT RAISE(ABORT, 'a frozen root sync request cannot change'); END;

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('open','read','resolved')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX notifications_one_open ON notifications (kind, subject) WHERE state = 'open';

CREATE TABLE target_controls (
  target_kind TEXT NOT NULL CHECK (target_kind IN ('service','app')),
  target_id TEXT NOT NULL,
  control_epoch INTEGER NOT NULL CHECK (control_epoch >= 1),
  user_intent TEXT NOT NULL CHECK (user_intent IN ('none','stopped','running')),
  root_state TEXT NOT NULL DEFAULT 'none' CHECK (root_state IN ('none','pending','synced','unavailable')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (target_kind, target_id)
);

ALTER TABLE deployments ADD COLUMN proposal_id TEXT;
ALTER TABLE deployments ADD COLUMN job_id TEXT;
ALTER TABLE system_actions ADD COLUMN job_id TEXT;
ALTER TABLE system_actions ADD COLUMN step_id TEXT;
ALTER TABLE system_actions ADD COLUMN policy_id TEXT;
ALTER TABLE system_actions ADD COLUMN policy_version INTEGER;
ALTER TABLE provider_grants ADD COLUMN policy_id TEXT;
ALTER TABLE provider_grants ADD COLUMN policy_version INTEGER;
ALTER TABLE artifacts ADD COLUMN gc_generation INTEGER NOT NULL DEFAULT 1 CHECK (gc_generation >= 1);
ALTER TABLE artifacts ADD COLUMN delete_intent_id TEXT;

CREATE TRIGGER apps_lifecycle_row AFTER INSERT ON apps WHEN NEW.id <> '00000000-0000-4000-8000-0000000005a5'
BEGIN INSERT OR IGNORE INTO app_lifecycle (app_id, state, last_used_at, control_epoch, updated_at) VALUES (NEW.id, 'active', NEW.created_at, 1, NEW.created_at); END;

INSERT INTO app_lifecycle (app_id, state, last_used_at, control_epoch, updated_at)
  SELECT id, 'active', updated_at, 1, updated_at FROM apps WHERE id <> '00000000-0000-4000-8000-0000000005a5';
`;

/** v0.4 structural migration: rebuild tables whose NOT NULL / CHECK enums change, then the additive SQL. */
export const V04_MIGRATION: StructuralMigration = {
  precondition: {
    sql: "SELECT id FROM runs WHERE status IN ('queued','running','cancel_requested','blocked') LIMIT 1",
    message: "an unfinished v0.3 run exists; finish or cancel it with the v0.3 host before upgrading (spec §3.3)",
  },
  rebuild: [
    {
      table: "runs",
      dropIndexes: ["runs_single_active"],
      replace: [
        ["target_app_id TEXT NOT NULL REFERENCES apps (id)", "target_app_id TEXT REFERENCES apps (id)"],
        ["deadline_at TEXT NOT NULL", "deadline_at TEXT"],
        ["CHECK (mode IN ('build','system_plan'))", "CHECK (mode IN ('build','system_plan','maintenance_diagnose','maintenance_refactor'))"],
      ],
    },
    { table: "deployments", replace: [["CHECK (origin IN ('agent_prepare','user_history'))", "CHECK (origin IN ('agent_prepare','user_history','proposal_accept','maintenance'))"]] },
    { table: "system_actions", replace: [["CHECK (origin IN ('app','agent','compensation'))", "CHECK (origin IN ('app','agent','compensation','maintenance'))"]] },
    { table: "provider_grants", replace: [["CHECK (principal_kind IN ('app','system_action','run'))", "CHECK (principal_kind IN ('app','system_action','run','maintenance'))"]] },
    { table: "artifacts", replace: [["CHECK (gc_state IN ('live','unavailable','marked'))", "CHECK (gc_state IN ('live','unavailable','marked','deleting'))"]] },
    { table: "resource_observations", replace: [["CHECK (scope_kind IN ('app_call','run','user'))", "CHECK (scope_kind IN ('app_call','run','user','maintenance'))"]] },
  ],
  sql: V04_MIGRATION_SQL,
};

export interface StructuralMigration {
  /** refuse the migration (and leave the store at the previous version) when this query returns a row */
  precondition?: { sql: string; message: string };
  rebuild: { table: string; replace: [string, string][]; dropIndexes?: string[]; dropTriggers?: string[] }[];
  sql: string;
}
export type Migration = string | StructuralMigration;

export const MIGRATIONS: readonly Migration[] = [
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
  V04_MIGRATION,
];
