import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  AgentOsError,
  PENDING_ACTION_STATES,
  SYSTEM_LIMITS,
  TERMINAL_ACTION_STATES,
  canonicalJson,
  capabilityDecl,
  checkProviderParams,
  domainHash,
  sealEnvelope,
  type SystemActionState,
  type WriteEnvelope,
} from "@agentos/contracts";
import { BrokerError, type BrokerOperation } from "@agentos/broker-client";
import { iso, type Store } from "../persistence/store.js";
import type { ResourceRow, ResourceService } from "../resources/resource-service.js";
import { ProviderGrantService, type GrantRow } from "../system-grants/grant-service.js";
import type { ObservationService } from "../observations/observation-service.js";
import type { ProviderReadService } from "../providers/provider-read-service.js";
import { paramError } from "../providers/provider-read-service.js";
import { buildPreview, type TrustedPreview } from "../providers/preview.js";
import type { BrokerLink } from "../system/broker-link.js";
import { fault } from "../faults.js";

export interface ActionRow {
  id: string;
  origin: "app" | "agent" | "compensation";
  app_id: string | null;
  revision_id: string | null;
  run_id: string | null;
  tool_task_id: string | null;
  source_app_epoch: number | null;
  data_epoch: number | null;
  handler_id: string | null;
  capability_id: string;
  plan_hash: string;
  plan_json: string;
  observation_refs: string;
  grant_id: string | null;
  grant_version: number | null;
  resource_id: string;
  resource_generation: number;
  confirmation_policy: "per_plan" | "standing";
  state: SystemActionState;
  operation_id: string | null;
  confirm_key: string | null;
  expires_at: string;
  approved_at: string | null;
  completion_kind: string | null;
  effect_certainty: string | null;
  evidence_kind: string | null;
  result_json: string | null;
  evidence_json: string | null;
  error_json: string | null;
  resolution_json: string | null;
  compensates_action_id: string | null;
  workspace_incarnation: number | null;
  broker_seq: number | null;
  created_at: string;
  updated_at: string;
}

export interface FrozenPlan {
  origin: ActionRow["origin"];
  appId: string | null;
  revisionId: string | null;
  appEpoch: number | null;
  handlerId: string | null;
  runId: string | null;
  capabilityId: string;
  contractVersion: number;
  resourceId: string;
  resourceGeneration: number;
  params: Record<string, unknown>;
  preconditions: Record<string, unknown>;
  observationRefs: string[];
  preview: TrustedPreview;
  appPreview: unknown;
  replayClass: string;
  createdAt: string;
  expiresAt: string;
  compensatesActionId: string | null;
}

export interface ActionView {
  actionId: string;
  origin: string;
  appId: string | null;
  revisionId: string | null;
  runId: string | null;
  handlerId: string | null;
  capabilityId: string;
  resourceId: string;
  resourceGeneration: number;
  planHash: string;
  plan: FrozenPlan;
  preview: TrustedPreview;
  confirmationRequired: boolean;
  confirmationPolicy: string;
  state: SystemActionState;
  /** Short user-facing phase: plan ready / executing / verified done / unknown (spec §20.3). */
  phase: "awaiting_confirmation" | "granting" | "executing" | "done" | "no_effect" | "unknown" | "rejected";
  operationId: string | null;
  grant: { grantId: string; state: string } | null;
  expiresAt: string;
  approvedAt: string | null;
  completionKind: string | null;
  effectCertainty: string | null;
  evidenceKind: string | null;
  result: unknown;
  evidence: unknown;
  error: unknown;
  resolution: unknown;
  compensatesActionId: string | null;
  compensationAvailable: boolean;
  retryAdvice: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FreezeInput {
  origin: ActionRow["origin"];
  appId?: string | null;
  revisionId?: string | null;
  appEpoch?: number | null;
  dataEpoch?: number | null;
  handlerId?: string | null;
  runId?: string | null;
  toolTaskId?: string | null;
  capabilityId: string;
  resource: ResourceRow;
  params: Record<string, unknown>;
  preconditions: Record<string, unknown>;
  observationRefs: string[];
  preview: TrustedPreview;
  appPreview?: unknown;
  grant?: GrantRow | null;
  standing?: boolean;
  compensatesActionId?: string | null;
}

const FINAL = new Set<string>(TERMINAL_ACTION_STATES);
const PENDING = new Set<string>(PENDING_ACTION_STATES);

/**
 * SystemActionService (spec §11, §17): freezes plans, takes the user's confirmation, admits into the durable outbox,
 * delivers the frozen envelope to the broker and projects the broker's verified results. It never performs system
 * calls itself and never runs inside an SQLite callback. Unknown outcomes stay unknown.
 */
export class SystemActionService {
  onChange: ((actionId: string) => void) | null = null;
  #timer: NodeJS.Timeout | null = null;
  #ticking = false;
  #kicked = false;
  stopped = false;

  constructor(
    readonly store: Store,
    readonly resources: ResourceService,
    readonly grants: ProviderGrantService,
    readonly observations: ObservationService,
    readonly reads: ProviderReadService,
    readonly broker: BrokerLink,
    readonly blobDir: string,
    readonly log: (level: "info" | "warn" | "error", msg: string, f?: Record<string, unknown>) => void,
  ) {}

  get(id: string): ActionRow | undefined {
    return this.store.get<ActionRow>("SELECT * FROM system_actions WHERE id = ?", id);
  }

  require(id: string): ActionRow {
    const a = this.get(id);
    if (!a) throw new AgentOsError("NOT_FOUND", "system action not found", { actionId: id });
    return a;
  }

  view(a: ActionRow): ActionView {
    const plan = JSON.parse(a.plan_json) as FrozenPlan;
    const g = a.grant_id ? this.grants.get(a.grant_id) : undefined;
    const phase: ActionView["phase"] =
      a.state === "awaiting_approval" ? (a.approved_at ? "granting" : "awaiting_confirmation")
      : PENDING.has(a.state) ? "executing"
      : a.state === "succeeded" ? "done"
      : a.state === "indeterminate" ? "unknown"
      : a.state === "rejected" ? "rejected"
      : "no_effect";
    const d = capabilityDecl(a.capability_id);
    return {
      actionId: a.id, origin: a.origin, appId: a.app_id, revisionId: a.revision_id, runId: a.run_id, handlerId: a.handler_id,
      capabilityId: a.capability_id, resourceId: a.resource_id, resourceGeneration: a.resource_generation, planHash: a.plan_hash,
      plan, preview: plan.preview, confirmationRequired: a.state === "awaiting_approval" && !a.approved_at, confirmationPolicy: a.confirmation_policy,
      state: a.state, phase, operationId: a.operation_id, grant: g ? { grantId: g.id, state: this.grants.view(g).state } : null,
      expiresAt: a.expires_at, approvedAt: a.approved_at, completionKind: a.completion_kind, effectCertainty: a.effect_certainty, evidenceKind: a.evidence_kind,
      result: a.result_json ? JSON.parse(a.result_json) : null, evidence: a.evidence_json ? JSON.parse(a.evidence_json) : null,
      error: a.error_json ? JSON.parse(a.error_json) : null, resolution: a.resolution_json ? JSON.parse(a.resolution_json) : null,
      compensatesActionId: a.compensates_action_id,
      compensationAvailable: a.state === "succeeded" && !!d?.compensation && a.completion_kind !== "already_satisfied",
      retryAdvice: a.state === "indeterminate" ? "上一次可能已经生效。请先查看当前状态并记录处置；如需再试，会生成新的计划，界面会提示前一次可能已送达。" : null,
      createdAt: a.created_at, updatedAt: a.updated_at,
    };
  }

  list(filter: { appId?: string; open?: boolean; limit?: number } = {}): ActionView[] {
    const lim = Math.min(filter.limit ?? 100, 500);
    let rows: ActionRow[];
    if (filter.appId) rows = this.store.all<ActionRow>("SELECT * FROM system_actions WHERE app_id = ? ORDER BY created_at DESC LIMIT ?", filter.appId, lim);
    else if (filter.open) rows = this.store.all<ActionRow>("SELECT * FROM system_actions WHERE state NOT IN ('succeeded','failed_no_effect','cancelled_no_effect','expired_no_effect','rejected') ORDER BY created_at DESC LIMIT ?", lim);
    else rows = this.store.all<ActionRow>("SELECT * FROM system_actions ORDER BY created_at DESC LIMIT ?", lim);
    return rows.map((r) => this.view(r));
  }

  // ---------------------------------------------------------------- freeze

  /** Steps 3–5 of spec §11.2, inside the caller's transaction. */
  freezeInTx(f: FreezeInput): ActionRow {
    const d = capabilityDecl(f.capabilityId);
    if (!d || d.mode !== "write") throw new AgentOsError("INVALID_SYSTEM_PLAN", `${f.capabilityId} is not a write capability`);
    if (!d.resourceKinds.includes(f.resource.kind)) throw new AgentOsError("INVALID_SYSTEM_PLAN", `${f.capabilityId} does not apply to ${f.resource.kind}`);
    let params: Record<string, unknown>;
    try {
      params = checkProviderParams(f.capabilityId, f.params);
    } catch (e) {
      paramError(e);
    }
    if (canonicalJson(params) !== canonicalJson(f.params)) throw new AgentOsError("INVALID_SYSTEM_PLAN", "parameters must be in normalized form");
    const now = this.store.clock.now();
    const open = this.store.get<{ n: number }>("SELECT count(*) AS n FROM system_actions WHERE state = 'awaiting_approval'")!.n;
    if (open >= SYSTEM_LIMITS.pendingPlansPerWorkspace) throw new AgentOsError("RESOURCE_BUSY", `at most ${SYSTEM_LIMITS.pendingPlansPerWorkspace} plans can wait for confirmation`);
    if (f.appId) {
      const n = this.store.get<{ n: number }>("SELECT count(*) AS n FROM system_actions WHERE app_id = ? AND state = 'awaiting_approval'", f.appId)!.n;
      if (n >= SYSTEM_LIMITS.pendingPlansPerApp) throw new AgentOsError("RESOURCE_BUSY", `at most ${SYSTEM_LIMITS.pendingPlansPerApp} plans per app can wait for confirmation`);
    }
    const id = `sa_${randomBytes(12).toString("hex")}`;
    const plan: FrozenPlan = {
      origin: f.origin, appId: f.appId ?? null, revisionId: f.revisionId ?? null, appEpoch: f.appEpoch ?? null, handlerId: f.handlerId ?? null, runId: f.runId ?? null,
      capabilityId: f.capabilityId, contractVersion: 1, resourceId: f.resource.id, resourceGeneration: f.resource.generation, params,
      preconditions: f.preconditions, observationRefs: f.observationRefs, preview: f.preview, appPreview: f.appPreview ?? null, replayClass: d.replayClass,
      createdAt: iso(now), expiresAt: iso(now + SYSTEM_LIMITS.planTtlMs), compensatesActionId: f.compensatesActionId ?? null,
    };
    const planJson = JSON.stringify(plan);
    if (Buffer.byteLength(planJson) > SYSTEM_LIMITS.planBytes) throw new AgentOsError("LIMIT_EXCEEDED", "the plan exceeds 256 KiB");
    let planHash: string;
    try {
      planHash = domainHash("agentos.system-plan.v1", plan);
    } catch (e) {
      throw new AgentOsError("INVALID_SYSTEM_PLAN", `the plan cannot be frozen: ${(e as Error).message}`);
    }
    // Standing only covers parameters inside the grant's own bounds; anything else is confirmed (spec §8.4, V3-U02).
    const standing = !!f.standing && f.origin === "app" && !!f.grant && f.grant.confirmation_policy === "standing" && ProviderGrantService.paramsWithin(f.capabilityId, plan.params, JSON.parse(f.grant.limits_json) as Record<string, unknown>);
    this.store.run(
      `INSERT INTO system_actions (id, origin, app_id, revision_id, run_id, tool_task_id, source_app_epoch, data_epoch, handler_id, capability_id, plan_hash, plan_json, observation_refs,
        grant_id, grant_version, resource_id, resource_generation, confirmation_policy, state, expires_at, compensates_action_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?, ?, ?)`,
      id, f.origin, f.appId ?? null, f.revisionId ?? null, f.runId ?? null, f.toolTaskId ?? null, f.appEpoch ?? null, f.dataEpoch ?? null, f.handlerId ?? null,
      f.capabilityId, planHash, planJson, JSON.stringify(f.observationRefs), f.grant?.id ?? null, f.grant?.grant_version ?? null, f.resource.id, f.resource.generation,
      standing ? "standing" : "per_plan", plan.expiresAt, f.compensatesActionId ?? null, iso(now), iso(now),
    );
    this.store.event("system_action.planned", { actionId: id, capabilityId: f.capabilityId, resourceId: f.resource.id, origin: f.origin }, { appId: f.appId ?? null, runId: f.runId ?? null });
    let row = this.get(id)!;
    if (standing) {
      // Covered by a standing grant: straight to admission (system_plan runs never take this path, spec §20.3).
      this.store.run("UPDATE system_actions SET approved_at = ?, updated_at = ? WHERE id = ?", iso(now), iso(now), id);
      row = this.#admitInTx(this.get(id)!);
    }
    return row;
  }

  /** Keep the previous content of a file the plan replaces, for a later compensation plan (hash-addressed blob). */
  saveBlob(content: string): string {
    const h = createHash("sha256").update(content, "utf8").digest("hex");
    fs.mkdirSync(this.blobDir, { recursive: true, mode: 0o700 });
    const p = path.join(this.blobDir, h);
    if (!fs.existsSync(p)) {
      let total = 0;
      for (const n of fs.readdirSync(this.blobDir)) total += fs.statSync(path.join(this.blobDir, n)).size;
      if (total + Buffer.byteLength(content) > 64 * 1024 * 1024) throw new AgentOsError("RESOURCE_BUSY", "plan blob storage is full (64 MiB); new plans are refused until history is archived");
      fs.writeFileSync(`${p}.tmp`, content, { mode: 0o600 });
      fs.renameSync(`${p}.tmp`, p);
    }
    return `sha256:${h}`;
  }

  readBlob(hash: string): string {
    const h = hash.replace(/^sha256:/, "");
    if (!/^[0-9a-f]{64}$/.test(h)) throw new AgentOsError("CONTENT_UNAVAILABLE", "bad blob reference");
    const p = path.join(this.blobDir, h);
    if (!fs.existsSync(p)) throw new AgentOsError("CONTENT_UNAVAILABLE", "the saved previous content is missing; it is never treated as an empty file");
    const text = fs.readFileSync(p, "utf8");
    if (createHash("sha256").update(text, "utf8").digest("hex") !== h) throw new AgentOsError("CONTENT_UNAVAILABLE", "the saved previous content failed its hash check");
    return text;
  }

  // ---------------------------------------------------------------- confirm / admit

  /** POST /api/system-actions/:id/confirm (inside the gateway transaction). Same plan → same state, never a second operation. */
  confirmInTx(actionId: string, planHash: string, confirmKey: string): ActionRow {
    const a = this.require(actionId);
    if (a.plan_hash !== planHash) throw new AgentOsError("PLAN_HASH_MISMATCH", "the confirmed plan hash does not match this action; a changed plan is a new plan");
    if (a.state !== "awaiting_approval") return a;
    if (a.approved_at) return a;
    // A broker reinstall (new machineInstallId) or a fenced workspace voids every plan made before (spec §23.4).
    const bind = this.store.get<{ broker_binding_state: string }>("SELECT broker_binding_state FROM meta WHERE id = 1")?.broker_binding_state;
    if (bind === "mismatch") throw new AgentOsError("BROKER_IDENTITY_MISMATCH", "the broker was reinstalled or does not match this workspace; plans made before cannot be confirmed");
    if (bind === "fenced") throw new AgentOsError("WORKSPACE_FENCED", "the workspace incarnation is fenced; make a new plan");
    const now = this.store.clock.now();
    if (Date.parse(a.expires_at) <= now) {
      this.#setState(a.id, "expired_no_effect", { error_json: JSON.stringify({ code: "PLAN_EXPIRED", message: "the plan expired before confirmation" }), effect_certainty: "none" });
      throw new AgentOsError("PLAN_EXPIRED", "the plan expired before confirmation; ask for a new plan");
    }
    const r = this.resources.require(a.resource_id);
    if (r.generation !== a.resource_generation) throw new AgentOsError("RESOURCE_GENERATION_STALE", "the resource changed after the plan was made");
    if (r.status === "quarantined") throw new AgentOsError("RESOURCE_BUSY", "the resource is quarantined by an operation whose outcome is unknown");
    const plan = JSON.parse(a.plan_json) as FrozenPlan;
    this.store.run("UPDATE system_actions SET approved_at = ?, confirm_key = ?, updated_at = ? WHERE id = ?", iso(now), confirmKey, iso(now), a.id);
    if (a.origin === "app") {
      // The app's own grant must still be active for this revision (it may have been revoked meanwhile).
      const g = a.grant_id ? this.grants.get(a.grant_id) : undefined;
      if (!g) throw new AgentOsError("PROVIDER_GRANT_REQUIRED", "the app's grant is missing");
      this.grants.requireUsable(g);
      if (ProviderGrantService.paramsWithin(a.capability_id, plan.params, JSON.parse(g.limits_json) as Record<string, unknown>)) return this.#admitInTx(this.get(a.id)!);
      // Outside the connection's bounds: this confirmation authorizes exactly these parameters, once.
      const og = this.grants.createActionGrantInTx({ id: a.id, capability_id: a.capability_id, resource_id: a.resource_id, resource_generation: a.resource_generation, params: plan.params }, SYSTEM_LIMITS.writeDeadlineMs + 120_000);
      this.store.run("UPDATE system_actions SET grant_id = ?, grant_version = ?, updated_at = ? WHERE id = ?", og.id, og.grant_version, iso(now), a.id);
      this.store.event("system_action.confirmed", { actionId: a.id, grantId: og.id }, { appId: a.app_id, runId: a.run_id });
      return this.get(a.id)!;
    }
    // Agent/compensation plans: a one-time grant bound to this action and its frozen parameters (spec §8.4).
    const g = this.grants.createActionGrantInTx({ id: a.id, capability_id: a.capability_id, resource_id: a.resource_id, resource_generation: a.resource_generation, params: plan.params }, SYSTEM_LIMITS.writeDeadlineMs + 120_000);
    this.store.run("UPDATE system_actions SET grant_id = ?, grant_version = ?, updated_at = ? WHERE id = ?", g.id, g.grant_version, iso(now), a.id);
    this.store.event("system_action.confirmed", { actionId: a.id, grantId: g.id }, { appId: a.app_id, runId: a.run_id });
    return this.get(a.id)!;
  }

  /** Ready: re-check versions, grant and deadline; write the frozen envelope to the outbox (spec §11.3). */
  #admitInTx(a: ActionRow): ActionRow {
    const now = this.store.clock.now();
    const plan = JSON.parse(a.plan_json) as FrozenPlan;
    const g = a.grant_id ? this.grants.get(a.grant_id) : undefined;
    if (!g) throw new AgentOsError("PROVIDER_GRANT_REQUIRED", "no grant for this action");
    this.grants.requireUsable(g);
    const r = this.resources.require(a.resource_id);
    if (r.generation !== a.resource_generation) throw new AgentOsError("RESOURCE_GENERATION_STALE", "the resource changed after the plan was made");
    if (a.origin === "app" && a.data_epoch !== null) {
      const de = this.store.get<{ data_epoch: number }>("SELECT data_epoch FROM apps WHERE id = ?", a.app_id);
      if (de && de.data_epoch !== a.data_epoch) throw new AgentOsError("DATA_EPOCH_STALE", "the app's records changed after the plan was made");
    }
    if (a.origin === "app" && a.source_app_epoch !== null) {
      const ap = this.store.get<{ epoch: number; active_revision_id: string }>("SELECT epoch, active_revision_id FROM apps WHERE id = ?", a.app_id);
      if (!ap || ap.active_revision_id !== a.revision_id || ap.epoch !== a.source_app_epoch) throw new AgentOsError("APP_EPOCH_STALE", "the app changed version after the plan was made");
    }
    const m = this.store.get<{ broker_install_id: string | null; workspace_incarnation: number | null }>("SELECT broker_install_id, workspace_incarnation FROM meta WHERE id = 1")!;
    if (!m.broker_install_id || m.workspace_incarnation === null) throw new AgentOsError("BROKER_UNAVAILABLE", "the workspace is not paired with the broker");
    const operationId = `op_${randomBytes(12).toString("hex")}`;
    const env: WriteEnvelope = sealEnvelope({
      protocolVersion: 1, machineInstallId: m.broker_install_id, storeUuid: this.broker.storeUUID, workspaceIncarnation: m.workspace_incarnation,
      operationId, actionId: a.id, planHash: a.plan_hash, capabilityId: a.capability_id, contractVersion: 1, resourceId: a.resource_id,
      resourceGeneration: a.resource_generation, grantId: g.id, grantVersion: g.grant_version, preconditions: plan.preconditions,
      deadlineMs: now + SYSTEM_LIMITS.writeDeadlineMs, params: plan.params, compensatesOperationId: plan.compensatesActionId ? (this.get(plan.compensatesActionId)?.operation_id ?? null) : null,
    });
    this.store.run(
      "INSERT INTO system_outbox (operation_id, action_id, machine_install_id, workspace_incarnation, frozen_envelope, request_hash, dispatch_state, attempt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)",
      operationId, a.id, m.broker_install_id, m.workspace_incarnation, JSON.stringify(env), env.requestHash, iso(now), iso(now),
    );
    this.store.run("UPDATE system_actions SET state = 'ready', operation_id = ?, workspace_incarnation = ?, updated_at = ? WHERE id = ?", operationId, m.workspace_incarnation, iso(now), a.id);
    this.store.event("system_action.ready", { actionId: a.id, operationId }, { appId: a.app_id, runId: a.run_id });
    fault("system.after_outbox_commit");
    setImmediate(() => this.kick());
    return this.get(a.id)!;
  }

  // ---------------------------------------------------------------- controller

  start(): void {
    this.stopped = false;
    if (!this.#timer) this.#timer = setInterval(() => void this.tick(), 500);
  }

  stop(): void {
    this.stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  kick(): void {
    if (this.stopped) return;
    if (this.#ticking) {
      this.#kicked = true;
      return;
    }
    void this.tick();
  }

  async tick(): Promise<void> {
    if (this.#ticking || this.stopped) return;
    this.#ticking = true;
    try {
      do {
        this.#kicked = false;
        this.#expire();
        await this.grants.pump().catch((e) => this.log("warn", "grant sync failed", { error: (e as Error).message }));
        this.#admitApproved();
        await this.#deliver();
      } while (this.#kicked && !this.stopped);
    } catch (e) {
      this.log("warn", "system action controller tick failed", { error: (e as Error).message });
    } finally {
      this.#ticking = false;
    }
  }

  #expire(): void {
    const now = iso(this.store.clock.now());
    const rows = this.store.all<ActionRow>("SELECT * FROM system_actions WHERE state = 'awaiting_approval' AND expires_at <= ?", now);
    for (const a of rows) {
      // An approved plan whose one-time grant is still syncing also expires: it was never dispatched.
      this.store.tx(() => this.#setState(a.id, "expired_no_effect", { effect_certainty: "none", evidence_kind: "never_dispatched", error_json: JSON.stringify({ code: "PLAN_EXPIRED", message: "the plan expired before it was executed" }) }));
    }
  }

  #admitApproved(): void {
    const rows = this.store.all<ActionRow>("SELECT * FROM system_actions WHERE state = 'awaiting_approval' AND approved_at IS NOT NULL AND grant_id IS NOT NULL");
    for (const a of rows) {
      const g = this.grants.get(a.grant_id!);
      if (!g) continue;
      if (g.sync_state === "failed") {
        this.store.tx(() => this.#setState(a.id, "failed_no_effect", { effect_certainty: "none", evidence_kind: "grant_refused", error_json: JSON.stringify({ code: "BROKER_POLICY_DENIED", message: g.sync_error ?? "the broker refused the execution grant" }) }));
        continue;
      }
      if (g.sync_state !== "active") continue;
      try {
        this.store.tx(() => {
          const cur = this.get(a.id)!;
          if (cur.state === "awaiting_approval") this.#admitInTx(cur);
        });
      } catch (e) {
        const ae = e as AgentOsError;
        this.store.tx(() => this.#setState(a.id, "failed_no_effect", { effect_certainty: "none", evidence_kind: "admission_refused", error_json: JSON.stringify({ code: ae.code ?? "INTERNAL", message: ae.message }) }));
      }
    }
  }

  async #deliver(): Promise<void> {
    const rows = this.store.all<{ operation_id: string; action_id: string; frozen_envelope: string; dispatch_state: string; machine_install_id: string; workspace_incarnation: number }>(
      "SELECT * FROM system_outbox WHERE dispatch_state IN ('pending','sent','accepted') ORDER BY created_at LIMIT 32",
    );
    if (rows.length === 0) return;
    const st = await this.broker.ensure();
    if (!st.brokerReady || st.binding !== "bound") return;
    for (const o of rows) {
      if (this.stopped) return;
      const env = JSON.parse(o.frozen_envelope) as WriteEnvelope;
      const identity = { machineInstallId: o.machine_install_id, storeUuid: env.storeUuid, workspaceIncarnation: o.workspace_incarnation };
      if (identity.machineInstallId !== st.machineInstallId || identity.workspaceIncarnation !== st.workspaceIncarnation) continue; // restore flow owns these
      try {
        let op: BrokerOperation;
        if (o.dispatch_state === "pending" || o.dispatch_state === "sent") {
          // The same frozen body and operationId on every attempt (spec §11.3).
          this.store.tx(() => {
            this.store.run("UPDATE system_outbox SET dispatch_state = 'sent', attempt = attempt + 1, updated_at = ? WHERE operation_id = ?", iso(this.store.clock.now()), o.operation_id);
            const a = this.get(o.action_id)!;
            if (a.state === "ready") this.#setState(a.id, "dispatching", {});
          });
          fault("system.before_submit");
          op = await this.broker.client.submit(env);
          fault("system.after_submit_before_record");
          this.store.tx(() => this.store.run("UPDATE system_outbox SET dispatch_state = 'accepted', last_broker_seq = ?, updated_at = ? WHERE operation_id = ?", op.updatedSeq, iso(this.store.clock.now()), o.operation_id));
        } else {
          op = await this.broker.client.operationGet(identity, o.operation_id);
        }
        this.applyBrokerOp(o.action_id, op);
      } catch (e) {
        const be = e as BrokerError;
        if (be.code === "NOT_FOUND" && o.dispatch_state === "accepted") {
          // The broker does not know it in this incarnation: deliver the same envelope again.
          this.store.tx(() => this.store.run("UPDATE system_outbox SET dispatch_state = 'sent', updated_at = ? WHERE operation_id = ?", iso(this.store.clock.now()), o.operation_id));
        } else if (be.code === "OPERATION_CONFLICT") {
          this.store.tx(() => {
            this.store.run("UPDATE system_outbox SET dispatch_state = 'final', updated_at = ? WHERE operation_id = ?", iso(this.store.clock.now()), o.operation_id);
            this.#setState(o.action_id, "indeterminate", { effect_certainty: "unknown", error_json: JSON.stringify({ code: "OPERATION_CONFLICT", message: be.message }) });
          });
        } else if (be.code === "WORKSPACE_FENCED" || be.code === "BROKER_IDENTITY_MISMATCH") {
          await this.broker.refresh();
          return;
        } else if (be.code === "PLAN_HASH_MISMATCH" || be.code === "INVALID_SYSTEM_PLAN" || be.code === "CAPABILITY_VERSION_UNSUPPORTED" || be.code === "RESOURCE_NOT_BOUND" || be.code === "BROKER_POLICY_DENIED") {
          // Refused before acceptance: provably never executed.
          this.store.tx(() => {
            this.store.run("UPDATE system_outbox SET dispatch_state = 'final', updated_at = ? WHERE operation_id = ?", iso(this.store.clock.now()), o.operation_id);
            this.#setState(o.action_id, "failed_no_effect", { effect_certainty: "none", evidence_kind: "broker_refused", error_json: JSON.stringify({ code: be.code, message: be.message }) });
          });
        } else {
          this.log("warn", "system outbox delivery deferred", { operationId: o.operation_id, code: be.code, error: be.message });
          return; // unreachable broker: keep order and retry on the next tick
        }
      }
    }
  }

  /** Project a broker operation onto the action. Facts that already happened are never discarded (spec §11.3). */
  applyBrokerOp(actionId: string, op: BrokerOperation): void {
    this.store.tx(() => {
      const a = this.get(actionId);
      if (!a || FINAL.has(a.state)) return;
      const map: Record<string, SystemActionState> = { accepted: "dispatching", running: "running", reconciling: "reconciling" };
      const next = (map[op.state] ?? op.state) as SystemActionState;
      if (a.state === "indeterminate" && next !== "indeterminate") return;
      const final = FINAL.has(next) || next === "indeterminate";
      this.#setState(a.id, next, {
        completion_kind: op.completionKind, effect_certainty: op.effectCertainty, evidence_kind: op.evidenceKind,
        result_json: op.result === null || op.result === undefined ? null : JSON.stringify(op.result),
        evidence_json: op.evidence === null || op.evidence === undefined ? null : JSON.stringify(op.evidence),
        error_json: op.error ? JSON.stringify(op.error) : null,
        resolution_json: op.resolution ? JSON.stringify(op.resolution) : a.resolution_json,
        broker_seq: op.updatedSeq,
      });
      if (final) this.store.run("UPDATE system_outbox SET dispatch_state = 'final', last_broker_seq = ?, updated_at = ? WHERE action_id = ?", op.updatedSeq, iso(this.store.clock.now()), a.id);
      if (final) fault("system.after_result_projection");
    });
    this.onChange?.(actionId);
  }

  #setState(id: string, state: SystemActionState, f: Partial<Record<keyof ActionRow, unknown>>): void {
    const sets = ["state = ?", "updated_at = ?"];
    const vals: unknown[] = [state, iso(this.store.clock.now())];
    for (const [k, v] of Object.entries(f)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    const cur = this.get(id);
    if (!cur) return;
    if (cur.state === state && Object.keys(f).length === 0) return;
    this.store.run(`UPDATE system_actions SET ${sets.join(", ")} WHERE id = ?`, ...vals, id);
    if (cur.state !== state) this.store.event("system_action.state", { actionId: id, from: cur.state, to: state }, { appId: cur.app_id, runId: cur.run_id });
  }

  // ---------------------------------------------------------------- cancel / resolve

  /** Cancel: awaiting → rejected; dispatched → broker cancel (tombstone or reconcile). Never promises no effect. */
  async cancel(actionId: string, reason: string): Promise<ActionRow> {
    let a = this.require(actionId);
    if (a.state === "awaiting_approval") {
      this.store.tx(() => {
        const cur = this.require(actionId);
        if (cur.state === "awaiting_approval") {
          this.#setState(cur.id, cur.approved_at ? "cancelled_no_effect" : "rejected", { effect_certainty: "none", evidence_kind: "never_dispatched", error_json: JSON.stringify({ code: "CANCELLED", message: reason }) });
          if (cur.grant_id && cur.origin !== "app") this.grants.revokeInTx(cur.grant_id, "plan cancelled");
        }
      });
      return this.require(actionId);
    }
    if (FINAL.has(a.state) || !a.operation_id) return a;
    await this.broker.ensure();
    const identity = this.broker.requireWritable();
    const r = await this.broker.client.operationCancel(identity, a.operation_id, reason.slice(0, 200)).catch((e: BrokerError) => {
      throw e.toAgentOs();
    });
    if (r.tombstone) {
      // The broker never saw it and now never will (V3-R07).
      this.store.tx(() => {
        this.store.run("UPDATE system_outbox SET dispatch_state = 'final', updated_at = ? WHERE action_id = ?", iso(this.store.clock.now()), a.id);
        this.#setState(a.id, "cancelled_no_effect", { effect_certainty: "none", evidence_kind: "cancel_tombstone", error_json: JSON.stringify({ code: "CANCELLED", message: reason }) });
      });
    } else if ((r as BrokerOperation).operationId) {
      this.applyBrokerOp(a.id, r as BrokerOperation);
    }
    a = this.require(actionId);
    return a;
  }

  /** Operator decision on an indeterminate outcome: recorded beside the original facts, never replacing them. */
  async resolve(actionId: string, decision: "confirmed_applied" | "confirmed_not_applied" | "accept_unknown", note: string, releaseQuarantine: boolean): Promise<ActionRow> {
    const a = this.require(actionId);
    if (a.state !== "indeterminate" || !a.operation_id) throw new AgentOsError("RECONCILIATION_REQUIRED", "only an indeterminate action takes an operator decision");
    await this.broker.ensure();
    const identity = this.broker.requireWritable();
    // Fresh user-scope observation as the evidence the decision is based on.
    const r = this.resources.require(a.resource_id);
    let observed: Record<string, unknown> = { note: note.slice(0, 500) };
    try {
      const statusCap = r.kind === "service" ? "service.describe" : r.kind === "lab-network" ? "network.policy_status" : r.kind === "serial" ? "serial.status" : null;
      if (statusCap) {
        const g = r.execution_class === "broker" ? this.#userReadGrant(r, statusCap) : null;
        const env = await this.reads.read({ kind: "user" }, r, statusCap, {}, { grant: g, timeoutMs: 3000 });
        observed = { ...observed, observationId: env.observationId, version: env.resourceVersion };
      }
    } catch (e) {
      observed = { ...observed, observeError: (e as Error).message };
    }
    const op = await this.broker.client.operationResolve(identity, a.operation_id, decision, observed, releaseQuarantine).catch((e: BrokerError) => {
      throw e.toAgentOs();
    });
    this.store.tx(() => this.store.run("UPDATE system_actions SET resolution_json = ?, updated_at = ? WHERE id = ?", JSON.stringify(op.resolution), iso(this.store.clock.now()), a.id));
    return this.require(actionId);
  }

  /** User reads of broker-backed resources (previews, resolution evidence) use the newest matching app/run grant. */
  #userReadGrant(r: ResourceRow, cap: string): GrantRow | null {
    return this.store.get<GrantRow>("SELECT * FROM provider_grants WHERE resource_id = ? AND capability_id = ? AND sync_state = 'active' AND revoked_at IS NULL AND resource_generation = ? ORDER BY created_at DESC LIMIT 1", r.id, cap, r.generation) ?? null;
  }

  // ---------------------------------------------------------------- version gate

  /** Spec §11.4: pending or unresolved-unknown operations block a new version; awaiting plans of the old one are voided. */
  activationBlockers(appId: string): ActionRow[] {
    return this.store.all<ActionRow>(
      "SELECT * FROM system_actions WHERE app_id = ? AND (state IN ('ready','dispatching','running','reconciling') OR (state = 'indeterminate' AND resolution_json IS NULL))",
      appId,
    );
  }

  voidAwaitingForAppInTx(appId: string, reason: string): void {
    for (const a of this.store.all<ActionRow>("SELECT * FROM system_actions WHERE app_id = ? AND state = 'awaiting_approval'", appId)) {
      this.#setState(a.id, "rejected", { effect_certainty: "none", evidence_kind: "never_dispatched", error_json: JSON.stringify({ code: "PLAN_EXPIRED", message: reason }) });
    }
  }

  /** App stop: no new admissions for its plans; undelivered ready plans get a broker cancel (tombstone). */
  async onAppStopped(appId: string): Promise<void> {
    this.store.tx(() => this.voidAwaitingForAppInTx(appId, "the app was stopped before the plan was confirmed"));
    for (const a of this.store.all<ActionRow>("SELECT * FROM system_actions WHERE app_id = ? AND state = 'ready'", appId)) {
      await this.cancel(a.id, "app stopped before dispatch").catch(() => undefined);
    }
  }
}
