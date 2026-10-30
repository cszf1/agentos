import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  AgentOsError,
  V1_LIMITS,
  admitReleaseSequence,
  assertTransition,
  highWaterAfterRollback,
  isUuid,
  UPDATE_CLOSED,
  type MemberRole,
  type MigrationClass,
  type PermitState,
  type RestoreState,
  type UpdateState,
  type WorkspaceAction,
  type WorkspaceState,
} from "@agentos/contracts";
import { systemClock, type Clock } from "../persistence/store.js";
import { decide } from "../identity/access.js";
import { chooseWaiter, type HeldPermit, type PermitWaiter } from "./fairness.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS machine_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  machine_install_id TEXT NOT NULL,
  first_boot_id TEXT NOT NULL UNIQUE,
  machine_control_epoch INTEGER NOT NULL CHECK (machine_control_epoch >= 1),
  registry_seq INTEGER NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  current_release_id TEXT,
  known_good_release_id TEXT,
  accepted_release_sequence INTEGER NOT NULL,
  restore_state TEXT NOT NULL CHECK (restore_state IN ('idle','in_progress')),
  business_writes INTEGER NOT NULL CHECK (business_writes IN (0,1)),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  login_uid INTEGER NOT NULL UNIQUE,
  login_name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  state TEXT NOT NULL CHECK (state IN ('provisioning','active','disabled')),
  auth_version INTEGER NOT NULL,
  provisioning_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  create_id TEXT NOT NULL UNIQUE,
  store_uuid TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL REFERENCES users(user_id),
  execution_uid INTEGER NOT NULL UNIQUE,
  subuid_start INTEGER NOT NULL UNIQUE,
  range_size INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('creating','stopped','starting','running','quiescing','recovery_required','archived')),
  instance_epoch INTEGER NOT NULL,
  run_when_logged_out INTEGER NOT NULL CHECK (run_when_logged_out IN (0,1)),
  legacy_policy_state TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  user_id TEXT NOT NULL REFERENCES users(user_id),
  role TEXT NOT NULL CHECK (role IN ('viewer','editor','owner')),
  member_version INTEGER NOT NULL CHECK (member_version >= 1),
  state TEXT NOT NULL CHECK (state IN ('active','revoking','revoked')),
  changed_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE IF NOT EXISTS provisioning_steps (
  provisioning_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('done')),
  target_identity TEXT NOT NULL,
  PRIMARY KEY (provisioning_id, step_id)
);
CREATE TABLE IF NOT EXISTS revocations (
  revocation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  old_version INTEGER NOT NULL,
  new_version INTEGER NOT NULL,
  gateway_ack INTEGER NOT NULL,
  host_ack INTEGER NOT NULL,
  broker_ack INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('revoking','revoked')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS machine_permits (
  permit_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  execution_epoch INTEGER NOT NULL,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  resource_class TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  member_version INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  background INTEGER NOT NULL CHECK (background IN (0,1)),
  state TEXT NOT NULL CHECK (state IN ('queued','reserved','in_use','released','reconciling','revoked')),
  usage_status TEXT NOT NULL CHECK (usage_status IN ('none','unused','used','unknown')),
  reserved_at INTEGER NOT NULL,
  UNIQUE (workspace_id, execution_epoch, owner_kind, owner_id, attempt_id, resource_class)
);
CREATE TABLE IF NOT EXISTS releases (
  release_id TEXT PRIMARY KEY,
  release_sequence INTEGER NOT NULL UNIQUE,
  manifest_hash TEXT NOT NULL,
  migration_class TEXT NOT NULL CHECK (migration_class IN ('none','compatible_expand','offline_breaking')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS update_jobs (
  update_id TEXT PRIMARY KEY,
  to_release_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoint_sets (
  set_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('building','complete')),
  manifest_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS restore_jobs (
  restore_id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('same-machine','clone','workspace')),
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_transfers (
  transfer_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  to_user_id TEXT NOT NULL,
  from_member_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','confirmed','expired')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS legacy_bindings (
  store_uuid TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  legacy_principal TEXT NOT NULL,
  receipt_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS root_audit (
  seq INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  scope_id TEXT,
  outcome TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;

const USER_STEPS = ["account", "registry"] as const;
const WORKSPACE_STEPS = ["account", "directory", "databases", "broker"] as const;
type UserStep = (typeof USER_STEPS)[number];
type WorkspaceStep = (typeof WORKSPACE_STEPS)[number];

export interface MachineUser {
  userId: string;
  loginUid: number;
  loginName: string;
  role: "admin" | "user";
  state: "provisioning" | "active" | "disabled";
  provisioningId: string;
}

export interface MachineWorkspace {
  workspaceId: string;
  createId: string;
  storeUUID: string;
  ownerUserId: string;
  executionUid: number;
  state: WorkspaceState;
  runWhenLoggedOut: boolean;
  legacyPolicyState: string | null;
}

export interface MachineMember {
  workspaceId: string;
  userId: string;
  role: MemberRole;
  memberVersion: number;
  state: "active" | "revoking" | "revoked";
}

export interface MachinePermit {
  permitId: string;
  workspaceId: string;
  state: PermitState;
  usageStatus: "none" | "unused" | "used" | "unknown";
  resourceClass: string;
  bodyHash: string;
  seq: number;
}

export interface MachineRevocation {
  revocationId: string;
  state: "revoking" | "revoked";
  gatewayAck: boolean;
  hostAck: boolean;
  brokerAck: boolean;
  newVersion: number;
}

interface UserRow {
  user_id: string;
  login_uid: number;
  login_name: string;
  role: "admin" | "user";
  state: "provisioning" | "active" | "disabled";
  provisioning_id: string;
}

interface WsRow {
  workspace_id: string;
  create_id: string;
  store_uuid: string;
  owner_user_id: string;
  execution_uid: number;
  state: WorkspaceState;
  run_when_logged_out: number;
  legacy_policy_state: string | null;
}

interface MemberRow {
  workspace_id: string;
  user_id: string;
  role: MemberRole;
  member_version: number;
  state: "active" | "revoking" | "revoked";
}

interface PermitRow {
  permit_id: string;
  workspace_id: string;
  state: PermitState;
  usage_status: MachinePermit["usageStatus"];
  resource_class: string;
  body_hash: string;
  seq: number;
  background: number;
  member_version: number;
  execution_epoch: number;
  owner_kind: string;
  owner_id: string;
  attempt_id: string;
}

function userOf(r: UserRow): MachineUser {
  return { userId: r.user_id, loginUid: r.login_uid, loginName: r.login_name, role: r.role, state: r.state, provisioningId: r.provisioning_id };
}
function wsOf(r: WsRow): MachineWorkspace {
  return {
    workspaceId: r.workspace_id,
    createId: r.create_id,
    storeUUID: r.store_uuid,
    ownerUserId: r.owner_user_id,
    executionUid: r.execution_uid,
    state: r.state,
    runWhenLoggedOut: r.run_when_logged_out === 1,
    legacyPolicyState: r.legacy_policy_state,
  };
}
function memberOf(r: MemberRow): MachineMember {
  return { workspaceId: r.workspace_id, userId: r.user_id, role: r.role, memberVersion: r.member_version, state: r.state };
}
function permitOf(r: PermitRow): MachinePermit {
  return { permitId: r.permit_id, workspaceId: r.workspace_id, state: r.state, usageStatus: r.usage_status, resourceClass: r.resource_class, bodyHash: r.body_hash, seq: r.seq };
}

const LOGIN_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export class MachineDirectory {
  #db: DatabaseSync;
  readonly clock: Clock;
  #depth = 0;

  private constructor(db: DatabaseSync, clock: Clock) {
    this.#db = db;
    this.clock = clock;
  }

  static open(file: string, clock: Clock = systemClock): MachineDirectory {
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);
    return new MachineDirectory(db, clock);
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }

  #now(): number {
    return this.clock.now();
  }

  #tx<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    this.#db.exec("BEGIN IMMEDIATE");
    this.#depth++;
    try {
      const out = fn();
      this.#db.exec("COMMIT");
      return out;
    } catch (e) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw e;
    } finally {
      this.#depth--;
    }
  }

  #audit(kind: string, scope: string, outcome: string): void {
    const seq = (this.#db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM root_audit").get() as { s: number }).s;
    this.#db.prepare("INSERT INTO root_audit (seq, kind, scope_id, outcome, at) VALUES (?, ?, ?, ?, ?)").run(seq, kind, scope, outcome, this.#now());
  }

  #meta(): { machine_install_id: string; first_boot_id: string; accepted_release_sequence: number; known_good_release_id: string | null; restore_state: string; business_writes: number } | undefined {
    return this.#db.prepare("SELECT machine_install_id, first_boot_id, accepted_release_sequence, known_good_release_id, restore_state, business_writes FROM machine_meta WHERE id = 1").get() as never;
  }

  #requireMeta() {
    const m = this.#meta();
    if (!m) throw new AgentOsError("STORE_UNAVAILABLE", "machine is not installed");
    return m;
  }

  ensureInstall(firstBootId: string): { machineInstallId: string; created: boolean } {
    if (!isUuid(firstBootId)) throw new AgentOsError("INVALID_REQUEST", "firstBootId must be a lowercase uuid");
    return this.#tx(() => {
      const m = this.#meta();
      if (m) {
        if (m.first_boot_id !== firstBootId) throw new AgentOsError("IDEMPOTENCY_CONFLICT", "this disk already has a machine identity");
        return { machineInstallId: m.machine_install_id, created: false };
      }
      const machineInstallId = randomUUID();
      this.#db.prepare(
        `INSERT INTO machine_meta (id, machine_install_id, first_boot_id, machine_control_epoch, registry_seq, schema_version, accepted_release_sequence, restore_state, business_writes, created_at)
         VALUES (1, ?, ?, 1, 0, 1, 0, 'idle', 1, ?)`,
      ).run(machineInstallId, firstBootId, this.#now());
      this.#audit("install", machineInstallId, "created");
      return { machineInstallId, created: true };
    });
  }

  applyUserStep(provisioningId: string, step: UserStep, spec: { loginName: string; role: "admin" | "user" }): MachineUser {
    if (!isUuid(provisioningId) || !LOGIN_NAME.test(spec.loginName)) throw new AgentOsError("INVALID_REQUEST", "bad account request");
    if (spec.role !== "admin" && spec.role !== "user") throw new AgentOsError("INVALID_REQUEST", "bad role");
    return this.#tx(() => {
      this.#requireMeta();
      const order = USER_STEPS.indexOf(step);
      const existing = this.#db.prepare("SELECT * FROM users WHERE provisioning_id = ?").get(provisioningId) as unknown as UserRow | undefined;
      if (step === "account") {
        if (existing) {
          if (existing.login_name !== spec.loginName || existing.role !== spec.role) throw new AgentOsError("IDEMPOTENCY_CONFLICT", "provisioning id already used");
          return userOf(existing);
        }
        const byName = this.#db.prepare("SELECT user_id FROM users WHERE login_name = ?").get(spec.loginName);
        if (byName) throw new AgentOsError("NAME_TAKEN", "an account with that name already exists");
        const n = (this.#db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
        if (n >= V1_LIMITS.maxUsers) throw new AgentOsError("MACHINE_CAPACITY", "user limit reached");
        const loginUid = (this.#db.prepare("SELECT COALESCE(MAX(login_uid), ?) + 1 AS u FROM users").get(V1_LIMITS.loginUidStart - 1) as { u: number }).u;
        const userId = randomUUID();
        this.#db.prepare(
          "INSERT INTO users (user_id, login_uid, login_name, role, state, auth_version, provisioning_id, created_at) VALUES (?, ?, ?, ?, 'provisioning', 1, ?, ?)",
        ).run(userId, loginUid, spec.loginName, spec.role, provisioningId, this.#now());
        this.#db.prepare("INSERT INTO provisioning_steps (provisioning_id, step_id, state, target_identity) VALUES (?, 'account', 'done', ?)").run(provisioningId, userId);
        this.#audit("user", userId, "provisioning");
        return userOf(this.#db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId) as unknown as UserRow);
      }
      if (!existing) throw new AgentOsError("INVALID_REQUEST", "account step is missing");
      if (existing.login_name !== spec.loginName || existing.role !== spec.role) throw new AgentOsError("IDEMPOTENCY_CONFLICT", "provisioning id already used");
      for (const prev of USER_STEPS.slice(0, order)) {
        const done = this.#db.prepare("SELECT 1 AS ok FROM provisioning_steps WHERE provisioning_id = ? AND step_id = ?").get(provisioningId, prev);
        if (!done) throw new AgentOsError("INVALID_REQUEST", `step ${prev} is not done`);
      }
      if (existing.state === "provisioning") {
        this.#db.prepare("UPDATE users SET state = 'active' WHERE user_id = ?").run(existing.user_id);
      }
      this.#db.prepare("INSERT INTO provisioning_steps (provisioning_id, step_id, state, target_identity) VALUES (?, 'registry', 'done', ?) ON CONFLICT DO NOTHING").run(provisioningId, existing.user_id);
      this.#audit("user", existing.user_id, "active");
      return userOf(this.#db.prepare("SELECT * FROM users WHERE user_id = ?").get(existing.user_id) as unknown as UserRow);
    });
  }

  provisionUser(provisioningId: string, spec: { loginName: string; role: "admin" | "user" }): MachineUser {
    this.applyUserStep(provisioningId, "account", spec);
    return this.applyUserStep(provisioningId, "registry", spec);
  }

  applyWorkspaceStep(createId: string, step: WorkspaceStep, spec: { ownerUserId: string; storeUUID: string }): MachineWorkspace {
    if (!isUuid(createId) || !isUuid(spec.ownerUserId) || !isUuid(spec.storeUUID)) throw new AgentOsError("INVALID_REQUEST", "bad workspace request");
    return this.#tx(() => {
      this.#requireMeta();
      const owner = this.#db.prepare("SELECT * FROM users WHERE user_id = ?").get(spec.ownerUserId) as unknown as UserRow | undefined;
      if (!owner || owner.state !== "active") throw new AgentOsError("INVALID_REQUEST", "owner is not an active account");
      const existing = this.#db.prepare("SELECT * FROM workspaces WHERE create_id = ?").get(createId) as unknown as WsRow | undefined;
      if (step === "account") {
        if (existing) {
          if (existing.store_uuid !== spec.storeUUID || existing.owner_user_id !== spec.ownerUserId) throw new AgentOsError("IDEMPOTENCY_CONFLICT", "create id already used");
          return wsOf(existing);
        }
        const dup = this.#db.prepare("SELECT workspace_id FROM workspaces WHERE store_uuid = ?").get(spec.storeUUID);
        if (dup) throw new AgentOsError("STORE_ALREADY_REGISTERED", "storeUUID is already registered");
        const n = (this.#db.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number }).n;
        if (n >= V1_LIMITS.maxWorkspaces) throw new AgentOsError("MACHINE_CAPACITY", "workspace limit reached");
        const executionUid = (this.#db.prepare("SELECT COALESCE(MAX(execution_uid), ?) + 1 AS u FROM workspaces").get(V1_LIMITS.executionUidStart - 1) as { u: number }).u;
        const subuid = 1_000_000 + (executionUid - V1_LIMITS.executionUidStart) * V1_LIMITS.subuidRange;
        const workspaceId = randomUUID();
        this.#db.prepare(
          `INSERT INTO workspaces (workspace_id, create_id, store_uuid, owner_user_id, execution_uid, subuid_start, range_size, state, instance_epoch, run_when_logged_out, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'creating', 1, 0, ?)`,
        ).run(workspaceId, createId, spec.storeUUID, spec.ownerUserId, executionUid, subuid, V1_LIMITS.subuidRange, this.#now());
        this.#db.prepare(
          "INSERT INTO workspace_members (workspace_id, user_id, role, member_version, state, changed_at) VALUES (?, ?, 'owner', 1, 'active', ?)",
        ).run(workspaceId, spec.ownerUserId, this.#now());
        this.#db.prepare("INSERT INTO provisioning_steps (provisioning_id, step_id, state, target_identity) VALUES (?, 'account', 'done', ?)").run(createId, workspaceId);
        this.#audit("workspace", workspaceId, "creating");
        return wsOf(this.#db.prepare("SELECT * FROM workspaces WHERE workspace_id = ?").get(workspaceId) as unknown as WsRow);
      }
      if (!existing) throw new AgentOsError("INVALID_REQUEST", "workspace account step is missing");
      if (existing.store_uuid !== spec.storeUUID || existing.owner_user_id !== spec.ownerUserId) throw new AgentOsError("IDEMPOTENCY_CONFLICT", "create id already used");
      const order = WORKSPACE_STEPS.indexOf(step);
      for (const prev of WORKSPACE_STEPS.slice(0, order)) {
        const done = this.#db.prepare("SELECT 1 AS ok FROM provisioning_steps WHERE provisioning_id = ? AND step_id = ?").get(createId, prev);
        if (!done) throw new AgentOsError("INVALID_REQUEST", `step ${prev} is not done`);
      }
      this.#db.prepare("INSERT INTO provisioning_steps (provisioning_id, step_id, state, target_identity) VALUES (?, ?, 'done', ?) ON CONFLICT DO NOTHING").run(createId, step, existing.workspace_id);
      if (step === "broker" && existing.state === "creating") this.#moveWorkspace(existing.workspace_id, "stopped");
      return wsOf(this.#db.prepare("SELECT * FROM workspaces WHERE workspace_id = ?").get(existing.workspace_id) as unknown as WsRow);
    });
  }

  createWorkspace(createId: string, spec: { ownerUserId: string; storeUUID: string }): MachineWorkspace {
    let ws: MachineWorkspace | undefined;
    for (const step of WORKSPACE_STEPS) ws = this.applyWorkspaceStep(createId, step, spec);
    return ws!;
  }

  listVisible(userId: string): MachineWorkspace[] {
    this.#requireMeta();
    const rows = this.#db.prepare(
      `SELECT w.* FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.workspace_id
       WHERE m.user_id = ? AND m.state = 'active' AND w.state != 'creating'
       ORDER BY w.created_at, w.workspace_id`,
    ).all(userId) as unknown as WsRow[];
    return rows.map(wsOf);
  }

  #moveWorkspace(workspaceId: string, to: WorkspaceState): void {
    const row = this.#db.prepare("SELECT state FROM workspaces WHERE workspace_id = ?").get(workspaceId) as { state: string };
    assertTransition("workspace", row.state, to);
    this.#db.prepare("UPDATE workspaces SET state = ? WHERE workspace_id = ?").run(to, workspaceId);
  }

  startWorkspace(workspaceId: string): MachineWorkspace {
    return this.#tx(() => {
      this.#requireMeta();
      const row = this.#workspace(workspaceId);
      if (row.state === "running") return wsOf(row);
      const busy = (this.#db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE state IN ('starting','running') AND workspace_id != ?").get(workspaceId) as { n: number }).n;
      if (busy >= V1_LIMITS.maxRunningWorkspaces) throw new AgentOsError("MACHINE_CAPACITY", "running workspace limit reached");
      if (row.state === "stopped") this.#moveWorkspace(workspaceId, "starting");
      this.#moveWorkspace(workspaceId, "running");
      this.#audit("workspace", workspaceId, "running");
      return wsOf(this.#workspace(workspaceId));
    });
  }

  stopWorkspace(workspaceId: string): MachineWorkspace {
    return this.#tx(() => {
      this.#requireMeta();
      const row = this.#workspace(workspaceId);
      if (row.state === "stopped") return wsOf(row);
      if (row.state === "running") this.#moveWorkspace(workspaceId, "quiescing");
      this.#moveWorkspace(workspaceId, "stopped");
      this.#audit("workspace", workspaceId, "stopped");
      return wsOf(this.#workspace(workspaceId));
    });
  }

  #workspace(id: string): WsRow {
    const row = this.#db.prepare("SELECT * FROM workspaces WHERE workspace_id = ?").get(id) as unknown as WsRow | undefined;
    if (!row) throw new AgentOsError("NOT_FOUND_OR_FORBIDDEN", "not allowed");
    return row;
  }

  #member(workspaceId: string, userId: string): MemberRow | undefined {
    return this.#db.prepare("SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?").get(workspaceId, userId) as unknown as MemberRow | undefined;
  }

  setRole(actorUserId: string, workspaceId: string, targetUserId: string, role: MemberRole): MachineMember {
    if (role !== "viewer" && role !== "editor" && role !== "owner") throw new AgentOsError("INVALID_REQUEST", "bad role");
    return this.#tx(() => {
      this.#requireMeta();
      this.#requireOwner(actorUserId, workspaceId);
      const account = this.#db.prepare("SELECT state FROM users WHERE user_id = ?").get(targetUserId) as { state: string } | undefined;
      if (!account || account.state !== "active") throw new AgentOsError("NOT_FOUND_OR_FORBIDDEN", "not allowed");
      const current = this.#member(workspaceId, targetUserId);
      if (!current) {
        if (role !== "viewer") throw new AgentOsError("INVALID_REQUEST", "a new member starts as viewer");
        this.#db.prepare(
          "INSERT INTO workspace_members (workspace_id, user_id, role, member_version, state, changed_at) VALUES (?, ?, 'viewer', 1, 'active', ?)",
        ).run(workspaceId, targetUserId, this.#now());
        this.#audit("member", workspaceId, "added");
        return memberOf(this.#member(workspaceId, targetUserId)!);
      }
      if (current.role === role && current.state === "active") return memberOf(current);
      if (current.role === "owner" && role !== "owner") this.#refuseLastOwner(workspaceId, targetUserId);
      const next = current.member_version + 1;
      this.#db.prepare("UPDATE workspace_members SET role = ?, member_version = ?, state = 'active', changed_at = ? WHERE workspace_id = ? AND user_id = ?").run(
        role, next, this.#now(), workspaceId, targetUserId,
      );
      this.#audit("member", workspaceId, "role");
      return memberOf(this.#member(workspaceId, targetUserId)!);
    });
  }

  #requireOwner(userId: string, workspaceId: string): MemberRow {
    const m = this.#member(workspaceId, userId);
    if (!m || m.state !== "active" || m.role !== "owner") throw new AgentOsError("FORBIDDEN", "owner required");
    return m;
  }

  #refuseLastOwner(workspaceId: string, userId: string): void {
    const n = (this.#db.prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = 'owner' AND state = 'active' AND user_id != ?").get(workspaceId, userId) as { n: number }).n;
    if (n === 0) throw new AgentOsError("INVALID_REQUEST", "the last owner cannot be removed");
  }

  revokeMember(actorUserId: string, revocationId: string, workspaceId: string, targetUserId: string): MachineRevocation {
    if (!isUuid(revocationId)) throw new AgentOsError("INVALID_REQUEST", "bad revocation id");
    return this.#tx(() => {
      this.#requireMeta();
      this.#requireOwner(actorUserId, workspaceId);
      const prior = this.#db.prepare("SELECT * FROM revocations WHERE revocation_id = ?").get(revocationId) as { state: "revoking" | "revoked"; gateway_ack: number; host_ack: number; broker_ack: number; new_version: number; user_id: string } | undefined;
      if (prior) {
        if (prior.user_id !== targetUserId) throw new AgentOsError("IDEMPOTENCY_CONFLICT", "revocation id already used");
        return { revocationId, state: prior.state, gatewayAck: prior.gateway_ack === 1, hostAck: prior.host_ack === 1, brokerAck: prior.broker_ack === 1, newVersion: prior.new_version };
      }
      const member = this.#member(workspaceId, targetUserId);
      if (!member || member.state === "revoked") throw new AgentOsError("NOT_FOUND_OR_FORBIDDEN", "not allowed");
      if (member.role === "owner") this.#refuseLastOwner(workspaceId, targetUserId);
      const next = member.member_version + 1;
      this.#db.prepare("UPDATE workspace_members SET state = 'revoking', member_version = ?, changed_at = ? WHERE workspace_id = ? AND user_id = ?").run(next, this.#now(), workspaceId, targetUserId);
      this.#db.prepare(
        "INSERT INTO revocations (revocation_id, workspace_id, user_id, old_version, new_version, gateway_ack, host_ack, broker_ack, state, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 'revoking', ?)",
      ).run(revocationId, workspaceId, targetUserId, member.member_version, next, this.#now());
      this.#audit("revocation", revocationId, "revoking");
      return { revocationId, state: "revoking", gatewayAck: false, hostAck: false, brokerAck: false, newVersion: next };
    });
  }

  ackRevocation(revocationId: string, who: "gateway" | "host" | "broker"): MachineRevocation {
    const col = who === "gateway" ? "gateway_ack" : who === "host" ? "host_ack" : "broker_ack";
    return this.#tx(() => {
      const row = this.#db.prepare("SELECT * FROM revocations WHERE revocation_id = ?").get(revocationId) as { workspace_id: string; user_id: string; new_version: number; gateway_ack: number; host_ack: number; broker_ack: number; state: "revoking" | "revoked" } | undefined;
      if (!row) throw new AgentOsError("NOT_FOUND_OR_FORBIDDEN", "not allowed");
      this.#db.prepare(`UPDATE revocations SET ${col} = 1 WHERE revocation_id = ?`).run(revocationId);
      const after = this.#db.prepare("SELECT gateway_ack, host_ack, broker_ack, state FROM revocations WHERE revocation_id = ?").get(revocationId) as { gateway_ack: number; host_ack: number; broker_ack: number; state: "revoking" | "revoked" };
      let state = after.state;
      if (after.gateway_ack && after.host_ack && after.broker_ack && state === "revoking") {
        this.#db.prepare("UPDATE revocations SET state = 'revoked', completed_at = ? WHERE revocation_id = ?").run(this.#now(), revocationId);
        this.#db.prepare("UPDATE workspace_members SET state = 'revoked', changed_at = ? WHERE workspace_id = ? AND user_id = ?").run(this.#now(), row.workspace_id, row.user_id);
        state = "revoked";
        this.#audit("revocation", revocationId, "revoked");
      }
      return { revocationId, state, gatewayAck: !!after.gateway_ack, hostAck: !!after.host_ack, brokerAck: !!after.broker_ack, newVersion: row.new_version };
    });
  }

  beginTransfer(transferId: string, workspaceId: string, fromUserId: string, toUserId: string): void {
    if (!isUuid(transferId)) throw new AgentOsError("INVALID_REQUEST", "bad transfer id");
    this.#tx(() => {
      this.#requireMeta();
      const from = this.#requireOwner(fromUserId, workspaceId);
      const to = this.#member(workspaceId, toUserId);
      if (!to || to.state !== "active" || toUserId === fromUserId) throw new AgentOsError("INVALID_REQUEST", "the receiver must be a different active member");
      const existing = this.#db.prepare("SELECT from_user_id, to_user_id FROM owner_transfers WHERE transfer_id = ?").get(transferId) as { from_user_id: string; to_user_id: string } | undefined;
      if (existing) {
        if (existing.from_user_id !== fromUserId || existing.to_user_id !== toUserId) throw new AgentOsError("IDEMPOTENCY_CONFLICT", "transfer id already used");
        return;
      }
      this.#db.prepare(
        "INSERT INTO owner_transfers (transfer_id, workspace_id, from_user_id, to_user_id, from_member_version, expires_at, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
      ).run(transferId, workspaceId, fromUserId, toUserId, from.member_version, this.#now() + V1_LIMITS.ownerTransferMs, this.#now());
      this.#audit("transfer", transferId, "pending");
    });
  }

  confirmTransfer(transferId: string, toUserId: string): void {
    this.#tx(() => {
      const t = this.#db.prepare("SELECT * FROM owner_transfers WHERE transfer_id = ?").get(transferId) as { workspace_id: string; from_user_id: string; to_user_id: string; from_member_version: number; expires_at: number; state: string } | undefined;
      if (!t || t.to_user_id !== toUserId) throw new AgentOsError("NOT_FOUND_OR_FORBIDDEN", "not allowed");
      if (t.state === "confirmed") return;
      if (this.#now() > t.expires_at) {
        this.#db.prepare("UPDATE owner_transfers SET state = 'expired' WHERE transfer_id = ?").run(transferId);
        throw new AgentOsError("PLAN_STALE", "the transfer expired");
      }
      const from = this.#member(t.workspace_id, t.from_user_id);
      if (!from || from.state !== "active" || from.role !== "owner" || from.member_version !== t.from_member_version) {
        throw new AgentOsError("PLAN_STALE", "the owner changed");
      }
      const to = this.#member(t.workspace_id, toUserId);
      if (!to || to.state !== "active") throw new AgentOsError("PLAN_STALE", "the receiver changed");
      this.#db.prepare("UPDATE workspace_members SET role = 'editor', member_version = member_version + 1, changed_at = ? WHERE workspace_id = ? AND user_id = ?").run(this.#now(), t.workspace_id, t.from_user_id);
      this.#db.prepare("UPDATE workspace_members SET role = 'owner', member_version = member_version + 1, changed_at = ? WHERE workspace_id = ? AND user_id = ?").run(this.#now(), t.workspace_id, toUserId);
      this.#db.prepare("UPDATE workspaces SET owner_user_id = ? WHERE workspace_id = ?").run(toUserId, t.workspace_id);
      this.#db.prepare("UPDATE owner_transfers SET state = 'confirmed' WHERE transfer_id = ?").run(transferId);
      this.#audit("transfer", transferId, "confirmed");
    });
  }

  disableUser(userId: string): void {
    this.#tx(() => {
      this.#requireMeta();
      const u = this.#db.prepare("SELECT state FROM users WHERE user_id = ?").get(userId) as { state: string } | undefined;
      if (!u) throw new AgentOsError("NOT_FOUND_OR_FORBIDDEN", "not allowed");
      if (u.state === "disabled") return;
      this.#db.prepare("UPDATE users SET state = 'disabled', disabled_at = ? WHERE user_id = ?").run(this.#now(), userId);
      this.#audit("user", userId, "disabled");
    });
  }

  setRunWhenLoggedOut(actorUserId: string, workspaceId: string, enabled: boolean): void {
    this.#tx(() => {
      this.#requireMeta();
      this.#requireOwner(actorUserId, workspaceId);
      const row = this.#workspace(workspaceId);
      if (!enabled) {
        this.#db.prepare("UPDATE workspaces SET run_when_logged_out = 0 WHERE workspace_id = ?").run(workspaceId);
        return;
      }
      if (row.run_when_logged_out === 1) return;
      const n = (this.#db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE run_when_logged_out = 1").get() as { n: number }).n;
      if (n >= V1_LIMITS.maxRunningWorkspaces) throw new AgentOsError("MACHINE_CAPACITY", "logged-out workspace limit reached");
      this.#db.prepare("UPDATE workspaces SET run_when_logged_out = 1 WHERE workspace_id = ?").run(workspaceId);
      this.#audit("workspace", workspaceId, "run_when_logged_out");
    });
  }

  authorize(input: {
    actorUserId: string;
    workspaceId: string | null;
    action: WorkspaceAction;
    presentedMemberVersion: number | null;
    sessionEpoch: number;
    currentSessionEpoch: number;
    locked: boolean;
    taskOwnerUserId: string | null;
  }): void {
    const user = this.#db.prepare("SELECT role, state FROM users WHERE user_id = ?").get(input.actorUserId) as { role: "admin" | "user"; state: string } | undefined;
    if (!user) throw new AgentOsError("SESSION_REQUIRED", "unknown account");
    const member = input.workspaceId ? this.#member(input.workspaceId, input.actorUserId) : undefined;
    decide({
      memberRole: member?.role ?? null,
      memberState: member?.state ?? null,
      memberVersion: member?.member_version ?? null,
      presentedMemberVersion: input.presentedMemberVersion,
      machineAdmin: user.role === "admin",
      action: input.action,
      actorUserId: input.actorUserId,
      taskOwnerUserId: input.taskOwnerUserId,
      sessionBound: true,
      sessionEpoch: input.sessionEpoch,
      currentSessionEpoch: input.currentSessionEpoch,
      locked: input.locked,
      accountDisabled: user.state === "disabled",
    });
  }

  reservePermit(input: {
    workspaceId: string;
    executionEpoch: number;
    ownerKind: string;
    ownerId: string;
    attemptId: string;
    resourceClass: "model" | "background_model" | "build" | "io";
    bodyHash: string;
    memberVersion: number;
    background: boolean;
  }): MachinePermit {
    return this.#tx(() => {
      this.#requireMeta();
      if (!this.businessWritesOpen()) throw new AgentOsError("RESTORE_IN_PROGRESS", "business writes are closed");
      if (input.resourceClass === "background_model" && !input.background) throw new AgentOsError("INVALID_REQUEST", "background_model permits are background work");
      if (input.resourceClass !== "background_model" && input.background) throw new AgentOsError("INVALID_REQUEST", "only background_model permits are background work");
      const found = this.#db.prepare(
        `SELECT * FROM machine_permits WHERE workspace_id = ? AND execution_epoch = ? AND owner_kind = ? AND owner_id = ? AND attempt_id = ? AND resource_class = ?`,
      ).get(input.workspaceId, input.executionEpoch, input.ownerKind, input.ownerId, input.attemptId, input.resourceClass) as unknown as PermitRow | undefined;
      if (found) {
        if (found.body_hash !== input.bodyHash) throw new AgentOsError("IDEMPOTENCY_CONFLICT", "permit key reused with a different body");
        return permitOf(found);
      }
      const member = this.#member(input.workspaceId, input.ownerKind === "maintenance" ? this.#workspace(input.workspaceId).owner_user_id : input.ownerId);
      if (input.ownerKind !== "maintenance") {
        if (!member || member.state !== "active" || member.member_version !== input.memberVersion) throw new AgentOsError("MEMBERSHIP_REVOKED", "membership is not current");
      }
      const seq = (this.#db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM machine_permits").get() as { s: number }).s;
      const permitId = randomUUID();
      this.#db.prepare(
        `INSERT INTO machine_permits (permit_id, workspace_id, execution_epoch, owner_kind, owner_id, attempt_id, resource_class, body_hash, member_version, seq, background, state, usage_status, reserved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'none', ?)`,
      ).run(permitId, input.workspaceId, input.executionEpoch, input.ownerKind, input.ownerId, input.attemptId, input.resourceClass, input.bodyHash, input.memberVersion, seq, input.background ? 1 : 0, this.#now());
      this.#pump(input.resourceClass);
      return permitOf(this.#db.prepare("SELECT * FROM machine_permits WHERE permit_id = ?").get(permitId) as unknown as PermitRow);
    });
  }

  #cap(resourceClass: string): number {
    if (resourceClass === "model") return V1_LIMITS.maxModelPermits;
    if (resourceClass === "background_model") return V1_LIMITS.maxBackgroundModelPermits;
    return 1;
  }

  #pump(resourceClass: string): void {
    const heldRows = this.#db.prepare("SELECT workspace_id, background FROM machine_permits WHERE resource_class = ? AND state IN ('reserved','in_use','reconciling')").all(resourceClass) as { workspace_id: string; background: number }[];
    let capacity = this.#cap(resourceClass) - heldRows.length;
    const held: HeldPermit[] = heldRows.map((r) => ({ workspaceId: r.workspace_id, background: r.background === 1 }));
    const queued = this.#db.prepare("SELECT permit_id, workspace_id, seq, background FROM machine_permits WHERE resource_class = ? AND state = 'queued' ORDER BY seq").all(resourceClass) as { permit_id: string; workspace_id: string; seq: number; background: number }[];
    const waiting: PermitWaiter[] = queued.map((q) => ({ workspaceId: q.workspace_id, seq: q.seq, background: q.background === 1 }));
    const left = [...waiting];
    while (capacity > 0 && left.length > 0) {
      const choice = resourceClass === "model" || resourceClass === "background_model" ? chooseWaiter(left, held, capacity) : left[0] ?? null;
      if (!choice) break;
      const row = queued.find((q) => q.workspace_id === choice.workspaceId && q.seq === choice.seq);
      if (!row) break;
      assertTransition("permit", "queued", "reserved");
      this.#db.prepare("UPDATE machine_permits SET state = 'reserved' WHERE permit_id = ? AND state = 'queued'").run(row.permit_id);
      held.push({ workspaceId: choice.workspaceId, background: choice.background });
      const idx = left.findIndex((w) => w.workspaceId === choice.workspaceId && w.seq === choice.seq);
      left.splice(idx, 1);
      capacity--;
    }
  }

  admitPermit(permitId: string): MachinePermit {
    return this.#tx(() => {
      const row = this.#db.prepare("SELECT * FROM machine_permits WHERE permit_id = ?").get(permitId) as unknown as PermitRow | undefined;
      if (!row) throw new AgentOsError("NOT_FOUND_OR_FORBIDDEN", "not allowed");
      if (row.state === "in_use") return permitOf(row);
      if (row.state !== "reserved") throw new AgentOsError("PERMIT_RECONCILING", "permit is not reserved");
      if (row.owner_kind !== "maintenance") {
        const member = this.#member(row.workspace_id, row.owner_id);
        if (!member || member.state !== "active" || member.member_version !== row.member_version) {
          assertTransition("permit", "reserved", "revoked");
          this.#db.prepare("UPDATE machine_permits SET state = 'revoked', usage_status = 'unused' WHERE permit_id = ?").run(permitId);
          throw new AgentOsError("MEMBERSHIP_REVOKED", "membership changed before dispatch");
        }
      }
      assertTransition("permit", "reserved", "in_use");
      this.#db.prepare("UPDATE machine_permits SET state = 'in_use' WHERE permit_id = ?").run(permitId);
      return permitOf(this.#db.prepare("SELECT * FROM machine_permits WHERE permit_id = ?").get(permitId) as unknown as PermitRow);
    });
  }

  reconcilePermits(): number {
    return this.#tx(() => {
      this.#requireMeta();
      const n = (this.#db.prepare("SELECT COUNT(*) AS n FROM machine_permits WHERE state IN ('reserved','in_use')").get() as { n: number }).n;
      const rows = this.#db.prepare("SELECT permit_id, state FROM machine_permits WHERE state IN ('reserved','in_use')").all() as { permit_id: string; state: string }[];
      for (const row of rows) {
        assertTransition("permit", row.state, "reconciling");
        this.#db.prepare("UPDATE machine_permits SET state = 'reconciling' WHERE permit_id = ?").run(row.permit_id);
      }
      this.#audit("permits", "machine", "reconciling");
      return n;
    });
  }

  confirmSlot(permitId: string, usage: "unused" | "used" | "unknown", cgroupStopped: boolean): MachinePermit {
    if (!cgroupStopped) throw new AgentOsError("PERMIT_RECONCILING", "the execution cgroup is still running");
    return this.#tx(() => {
      const row = this.#db.prepare("SELECT * FROM machine_permits WHERE permit_id = ?").get(permitId) as unknown as PermitRow | undefined;
      if (!row) throw new AgentOsError("NOT_FOUND_OR_FORBIDDEN", "not allowed");
      if (row.state !== "reconciling") throw new AgentOsError("PERMIT_RECONCILING", "permit is not waiting for reconciliation");
      const to: PermitState = usage === "unused" ? "revoked" : "released";
      assertTransition("permit", "reconciling", to);
      this.#db.prepare("UPDATE machine_permits SET state = ?, usage_status = ? WHERE permit_id = ?").run(to, usage, permitId);
      return permitOf(this.#db.prepare("SELECT * FROM machine_permits WHERE permit_id = ?").get(permitId) as unknown as PermitRow);
    });
  }

  chargedPermits(): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM machine_permits WHERE usage_status IN ('used','unknown')").get() as { n: number }).n;
  }

  heldSlots(resourceClass: string): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM machine_permits WHERE resource_class = ? AND state IN ('reserved','in_use','reconciling')").get(resourceClass) as { n: number }).n;
  }

  businessWritesOpen(): boolean {
    const m = this.#requireMeta();
    return m.business_writes === 1 && m.restore_state === "idle";
  }

  acceptRelease(input: { releaseId: string; sequence: number; manifestHash: string; migrationClass: MigrationClass }): void {
    this.#tx(() => {
      const m = this.#requireMeta();
      const verdict = admitReleaseSequence(input.sequence, m.accepted_release_sequence, input.migrationClass);
      if (verdict === "replay") throw new AgentOsError("RELEASE_REPLAYED", "release sequence is not newer");
      if (verdict === "breaking") throw new AgentOsError("MIGRATION_REQUIRED", "offline breaking releases are refused");
      this.#db.prepare("INSERT INTO releases (release_id, release_sequence, manifest_hash, migration_class, created_at) VALUES (?, ?, ?, ?, ?)").run(
        input.releaseId, input.sequence, input.manifestHash, input.migrationClass, this.#now(),
      );
      this.#db.prepare("UPDATE machine_meta SET accepted_release_sequence = ? WHERE id = 1").run(input.sequence);
      this.#audit("release", input.releaseId, "accepted");
    });
  }

  openUpdate(updateId: string, releaseId: string): void {
    if (!isUuid(updateId)) throw new AgentOsError("INVALID_REQUEST", "bad update id");
    this.#tx(() => {
      this.#requireMeta();
      const open = this.#db.prepare("SELECT update_id, state FROM update_jobs").all() as { update_id: string; state: string }[];
      if (open.some((j) => j.update_id !== updateId && !UPDATE_CLOSED.has(j.state as UpdateState))) throw new AgentOsError("INVALID_REQUEST", "an update is already open");
      const existing = open.find((j) => j.update_id === updateId);
      if (existing) return;
      const rel = this.#db.prepare("SELECT release_id FROM releases WHERE release_id = ?").get(releaseId);
      if (!rel) throw new AgentOsError("INVALID_REQUEST", "unknown release");
      this.#db.prepare("INSERT INTO update_jobs (update_id, to_release_id, state, created_at) VALUES (?, ?, 'discovered', ?)").run(updateId, releaseId, this.#now());
      this.#audit("update", updateId, "discovered");
    });
  }

  advanceUpdate(updateId: string, to: UpdateState): void {
    this.#tx(() => {
      const row = this.#db.prepare("SELECT state, to_release_id FROM update_jobs WHERE update_id = ?").get(updateId) as { state: string; to_release_id: string } | undefined;
      if (!row) throw new AgentOsError("NOT_FOUND_OR_FORBIDDEN", "not allowed");
      if (row.state === to) return;
      assertTransition("update", row.state, to);
      this.#db.prepare("UPDATE update_jobs SET state = ? WHERE update_id = ?").run(to, updateId);
      if (to === "committed") {
        this.#db.prepare("UPDATE machine_meta SET current_release_id = ?, known_good_release_id = ? WHERE id = 1").run(row.to_release_id, row.to_release_id);
      }
      this.#audit("update", updateId, to);
    });
  }

  /** Switching back to the known-good release does not lower the accepted sequence. */
  rollbackKnownGood(): { releaseId: string; highWater: number } {
    return this.#tx(() => {
      const m = this.#requireMeta();
      if (!m.known_good_release_id) throw new AgentOsError("ROLLBACK_INCOMPATIBLE", "there is no known-good release");
      const rel = this.#db.prepare("SELECT migration_class FROM releases WHERE release_id = ?").get(m.known_good_release_id) as { migration_class: MigrationClass } | undefined;
      if (!rel || rel.migration_class === "offline_breaking") throw new AgentOsError("ROLLBACK_INCOMPATIBLE", "known-good is not a compatible release");
      const highWater = highWaterAfterRollback(m.accepted_release_sequence);
      this.#db.prepare("UPDATE machine_meta SET current_release_id = ?, accepted_release_sequence = ? WHERE id = 1").run(m.known_good_release_id, highWater);
      this.#audit("update", m.known_good_release_id, "rolled_back");
      return { releaseId: m.known_good_release_id, highWater };
    });
  }

  acceptedSequence(): number {
    return this.#requireMeta().accepted_release_sequence;
  }

  createCheckpoint(setId: string): void {
    if (!isUuid(setId)) throw new AgentOsError("INVALID_REQUEST", "bad checkpoint id");
    this.#tx(() => {
      this.#requireMeta();
      const existing = this.#db.prepare("SELECT state FROM checkpoint_sets WHERE set_id = ?").get(setId) as { state: string } | undefined;
      if (existing) return;
      this.#db.prepare("INSERT INTO checkpoint_sets (set_id, state, created_at) VALUES (?, 'building', ?)").run(setId, this.#now());
    });
  }

  completeCheckpoint(setId: string, manifestHash: string): void {
    this.#tx(() => {
      const row = this.#db.prepare("SELECT state FROM checkpoint_sets WHERE set_id = ?").get(setId) as { state: string } | undefined;
      if (!row) throw new AgentOsError("CHECKPOINT_INCOMPLETE", "checkpoint does not exist");
      if (row.state === "complete") return;
      this.#db.prepare("UPDATE checkpoint_sets SET state = 'complete', manifest_hash = ? WHERE set_id = ?").run(manifestHash, setId);
    });
  }

  planRestore(restoreId: string, setId: string, mode: "same-machine" | "clone" | "workspace"): void {
    if (!isUuid(restoreId)) throw new AgentOsError("INVALID_REQUEST", "bad restore id");
    this.#tx(() => {
      const m = this.#requireMeta();
      const ck = this.#db.prepare("SELECT state FROM checkpoint_sets WHERE set_id = ?").get(setId) as { state: string } | undefined;
      if (!ck || ck.state !== "complete") throw new AgentOsError("CHECKPOINT_INCOMPLETE", "checkpoint is not complete");
      const existing = this.#db.prepare("SELECT set_id, state FROM restore_jobs WHERE restore_id = ?").get(restoreId) as { set_id: string; state: string } | undefined;
      if (existing) {
        if (existing.set_id !== setId) throw new AgentOsError("IDEMPOTENCY_CONFLICT", "restore id already used");
        return;
      }
      if (m.restore_state !== "idle") throw new AgentOsError("RESTORE_IN_PROGRESS", "a restore is already open");
      this.#db.prepare("INSERT INTO restore_jobs (restore_id, set_id, mode, state, created_at) VALUES (?, ?, ?, 'planned', ?)").run(restoreId, setId, mode, this.#now());
      this.#db.prepare("UPDATE machine_meta SET restore_state = 'in_progress', business_writes = 0 WHERE id = 1").run();
      this.#audit("restore", restoreId, "planned");
    });
  }

  advanceRestore(restoreId: string, to: RestoreState): void {
    this.#tx(() => {
      const row = this.#db.prepare("SELECT state FROM restore_jobs WHERE restore_id = ?").get(restoreId) as { state: string } | undefined;
      if (!row) throw new AgentOsError("NOT_FOUND_OR_FORBIDDEN", "not allowed");
      if (row.state === to) return;
      assertTransition("restore", row.state, to);
      this.#db.prepare("UPDATE restore_jobs SET state = ? WHERE restore_id = ?").run(to, restoreId);
      if (to === "complete") this.#db.prepare("UPDATE machine_meta SET restore_state = 'idle', business_writes = 1 WHERE id = 1").run();
      this.#audit("restore", restoreId, to);
    });
  }

  applyMemberSnapshot(workspaceId: string, backup: readonly { userId: string; role: MemberRole; state: "active" | "revoked" }[]): { members: MachineMember[]; rejected: string[] } {
    return this.#tx(() => {
      const m = this.#requireMeta();
      if (m.restore_state !== "in_progress") throw new AgentOsError("INVALID_REQUEST", "member snapshot applies only during restore");
      const rejected: string[] = [];
      for (const entry of backup) {
        const account = this.#db.prepare("SELECT state FROM users WHERE user_id = ?").get(entry.userId) as { state: string } | undefined;
        const member = this.#member(workspaceId, entry.userId);
        const sameActive = !!account && account.state !== "disabled" && !!member && member.state === "active" && member.role === entry.role && entry.state === "active";
        if (!sameActive) rejected.push(entry.userId);
      }
      this.#audit("restore", workspaceId, rejected.length === 0 ? "members_kept" : "members_rejected");
      const members = (this.#db.prepare("SELECT * FROM workspace_members WHERE workspace_id = ? ORDER BY user_id").all(workspaceId) as unknown as MemberRow[]).map(memberOf);
      return { members, rejected };
    });
  }

  importLegacy(input: { importId: string; ownerUserId: string; storeUUID: string; receiptHash: string }): MachineWorkspace {
    const ws = this.createWorkspace(input.importId, { ownerUserId: input.ownerUserId, storeUUID: input.storeUUID });
    this.#tx(() => {
      const prior = this.#db.prepare("SELECT receipt_hash, owner_user_id FROM legacy_bindings WHERE store_uuid = ?").get(input.storeUUID) as { receipt_hash: string; owner_user_id: string } | undefined;
      if (prior) {
        if (prior.receipt_hash !== input.receiptHash || prior.owner_user_id !== input.ownerUserId) throw new AgentOsError("IDEMPOTENCY_CONFLICT", "legacy binding differs");
        return;
      }
      this.#db.prepare("UPDATE workspaces SET legacy_policy_state = 'paused_needs_review' WHERE workspace_id = ?").run(ws.workspaceId);
      this.#db.prepare(
        "INSERT INTO legacy_bindings (store_uuid, workspace_id, owner_user_id, legacy_principal, receipt_hash) VALUES (?, ?, ?, 'user:local', ?)",
      ).run(input.storeUUID, ws.workspaceId, input.ownerUserId, input.receiptHash);
      this.#audit("import", ws.workspaceId, "legacy");
    });
    return wsOf(this.#db.prepare("SELECT * FROM workspaces WHERE workspace_id = ?").get(ws.workspaceId) as unknown as WsRow);
  }

  legacyBinding(storeUUID: string): { receiptHash: string; legacyPrincipal: string } | undefined {
    const row = this.#db.prepare("SELECT receipt_hash, legacy_principal FROM legacy_bindings WHERE store_uuid = ?").get(storeUUID) as { receipt_hash: string; legacy_principal: string } | undefined;
    return row ? { receiptHash: row.receipt_hash, legacyPrincipal: row.legacy_principal } : undefined;
  }
}
