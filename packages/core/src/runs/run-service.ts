import { randomUUID } from "node:crypto";
import {
  ACTIVE_RUN_STATUSES,
  AGENT_PROFILES,
  AgentOsError,
  HOST_VERSION,
  LIMITS,
  MODE_BUDGETS,
  V4_LIMITS,
  canonicalJson,
  profileForMode,
  sha256Hex,
  type AgentProfileId,
  type DispatchState,
  type RunCreateBody,
  type RunMode,
  type RunStatus,
  type RunView,
  type SchedulingState,
  type ValidationIssue,
} from "@agentos/contracts";
import { iso, type Store } from "../persistence/store.js";
import type { AppService } from "../apps/app-service.js";
import type { FrozenRunInput } from "./engine.js";

export interface RunRow {
  id: string;
  request_key: string;
  request_hash: string;
  target_app_id: string | null;
  expected_app_epoch: number;
  intent: string;
  frozen_submit_json: string;
  submit_hash: string;
  status: RunStatus;
  dispatch_state: DispatchState;
  pi_submission_id: number | null;
  applied_revision_id: string | null;
  model_request_count: number;
  mode: RunMode;
  system_resource_scope: string | null;
  prepared_action_id: string | null;
  stop_reason: string | null;
  last_validation_json: string | null;
  error_json: string | null;
  warning: string | null;
  /** execution deadline; null while queued (the queue deadline is separate) */
  deadline_at: string | null;
  created_at: string;
  updated_at: string;
  // v0.4
  agent_profile_id: AgentProfileId;
  conversation_id: string | null;
  legacy_root: number;
  execution_epoch: number;
  scheduling_state: SchedulingState;
  wait_reason: string | null;
  priority: number;
  background: number;
  queue_deadline_at: string | null;
  started_at: string | null;
  budget_config: string | null;
  report_id: string | null;
  proposal_id: string | null;
  job_id: string | null;
  incident_id: string | null;
  output_reserved: number;
}

export interface RunSettings {
  deadlineMs: number;
  maxModelRequests: number;
  maxToolTasks: number;
  maxStageAttempts: number;
  maxOutputTokens?: number;
}

export const DEFAULT_RUN_SETTINGS: RunSettings = {
  deadlineMs: LIMITS.runDeadlineMs,
  maxModelRequests: LIMITS.maxModelRequestsPerRun,
  maxToolTasks: LIMITS.maxToolTasksPerRun,
  maxStageAttempts: LIMITS.maxStageAttemptsPerRun,
};

export type StopReason = "user" | "budget" | "deadline" | "target_changed" | "maintenance_paused" | "restore";

/** system_plan budgets (spec §9.3): 180 s, 6 model requests, 20 tool tasks, 3 invalid plan attempts. */
export const SYSTEM_PLAN_RUN_SETTINGS: RunSettings = { deadlineMs: 180_000, maxModelRequests: 6, maxToolTasks: 20, maxStageAttempts: 3 };
/** v0.3 hidden placeholder that old system_plan runs reference; v0.4 non-app runs use a NULL target (spec §21.1). */
export const SYSTEM_PLAN_APP_ID = "00000000-0000-4000-8000-0000000005a5";

/** Conflict-relevant run states: started and not yet released (spec §7.2). */
export const RUNNING_SCHED: readonly SchedulingState[] = ["dispatching", "active", "waiting_build", "waiting_model", "draining"];
const QUEUED_SQL = "scheduling_state IN ('waiting_slot','waiting_target')";
const STARTED_SQL = "scheduling_state IN ('dispatching','active','waiting_build','waiting_model','draining')";

export interface BackgroundRunInput {
  mode: "maintenance_diagnose" | "maintenance_refactor";
  jobId: string;
  incidentId: string | null;
  appId: string | null;
  intent: string;
  /** frozen evidence / candidate scope; stored in the frozen input */
  scope: Record<string, unknown>;
}

export class RunService {
  constructor(
    readonly store: Store,
    private readonly apps: AppService,
    readonly settings: RunSettings = DEFAULT_RUN_SETTINGS,
    private readonly platform: { platform: string; arch: string } = { platform: process.platform, arch: process.arch },
  ) {}

  /** Foreground slots (spec §7.2: 2). Raised from 1 only after the v0.4 identity self-check passed (spec §3.3). */
  foregroundSlots = 1;

  nowMs(): number {
    return this.store.clock.now();
  }
  private now(): string {
    return iso(this.nowMs());
  }

  /** Runs that have not reached a final status (queued, running, cancel_requested, blocked). */
  unfinished(): RunRow[] {
    return this.store.all<RunRow>(`SELECT * FROM runs WHERE status IN ('queued','running','cancel_requested','blocked') ORDER BY created_at ASC, id ASC`);
  }

  /** Runs the coordinator drives: started and not done. */
  started(): RunRow[] {
    return this.store.all<RunRow>(`SELECT * FROM runs WHERE ${STARTED_SQL} ORDER BY created_at ASC, id ASC`);
  }

  getRow(runId: string): RunRow | undefined {
    return this.store.get<RunRow>("SELECT * FROM runs WHERE id = ?", runId);
  }

  lastRun(): RunRow | undefined {
    return this.store.get<RunRow>("SELECT * FROM runs WHERE background = 0 ORDER BY created_at DESC, id DESC LIMIT 1");
  }

  /** Paged run list (spec §22.1 GET /api/runs): never a single "activeRun". */
  list(opts: { status?: string; targetAppId?: string; background?: boolean; limit?: number; before?: string } = {}): RunRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.status === "unfinished") where.push(`status IN ('queued','running','cancel_requested','blocked')`);
    else if (opts.status) {
      where.push("status = ?");
      args.push(opts.status);
    }
    if (opts.targetAppId) {
      where.push("target_app_id = ?");
      args.push(opts.targetAppId);
    }
    if (opts.background !== undefined) {
      where.push("background = ?");
      args.push(opts.background ? 1 : 0);
    }
    if (opts.before) {
      where.push("created_at < ?");
      args.push(opts.before);
    }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return this.store.all<RunRow>(`SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ${limit}`, ...args);
  }

  /** Is an app the target of an unfinished run? (replaces the v0.3 global activeRun guard, spec §21.1) */
  targetBusy(appId: string): RunRow | undefined {
    return this.store.get<RunRow>(`SELECT * FROM runs WHERE target_app_id = ? AND status IN ('queued','running','cancel_requested','blocked') AND background = 0 AND ${STARTED_SQL} LIMIT 1`, appId);
  }

  view(row: RunRow): RunView {
    const frozen = JSON.parse(row.frozen_submit_json) as FrozenRunInput;
    const steps = this.store.all<{ kind: string; tool_name: string | null; created_at: string }>(
      "SELECT kind, tool_name, created_at FROM run_steps WHERE run_id = ? ORDER BY created_at ASC, rowid ASC",
      row.id,
    );
    const tools = steps.filter((s) => s.kind === "tool");
    const st = this.settingsFor(row);
    const attempts = this.store.get<{ n: number; out: number | null; unknown: number }>(
      "SELECT COUNT(*) AS n, SUM(COALESCE(output_tokens, reserved_output)) AS out, SUM(CASE WHEN state IN ('interrupted','usage_unknown') THEN 1 ELSE 0 END) AS unknown FROM model_attempts WHERE run_id = ? AND state <> 'denied'",
      row.id,
    );
    const queuePos = row.scheduling_state === "waiting_slot" || row.scheduling_state === "waiting_target"
      ? (this.store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE background = ? AND ${QUEUED_SQL} AND (created_at < ? OR (created_at = ? AND id < ?))`, row.background, row.created_at, row.created_at, row.id)?.n ?? 0) + 1
      : null;
    return {
      runId: row.id,
      status: row.status,
      dispatchState: row.dispatch_state,
      intent: row.intent,
      mode: frozen.mode,
      runMode: row.mode ?? "build",
      preparedActionId: row.prepared_action_id ?? null,
      systemScope: row.system_resource_scope ? JSON.parse(row.system_resource_scope) : null,
      targetAppId: row.target_app_id,
      expectedAppEpoch: row.expected_app_epoch,
      appliedRevisionId: row.applied_revision_id,
      modelRequestCount: row.model_request_count,
      stopReason: row.stop_reason,
      lastValidation: row.last_validation_json ? JSON.parse(row.last_validation_json) : null,
      error: row.error_json ? JSON.parse(row.error_json) : null,
      warning: row.warning,
      progress: {
        stageAttempts: steps.filter((s) => s.kind === "stage").length,
        toolTasks: tools.length,
        lastTool: tools.length > 0 ? tools[tools.length - 1]!.tool_name : null,
      },
      deadlineAt: row.deadline_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      agentProfileId: row.agent_profile_id,
      background: row.background === 1,
      schedulingState: row.scheduling_state,
      waitReason: row.wait_reason,
      queuePosition: queuePos,
      queueDeadlineAt: row.queue_deadline_at,
      startedAt: row.started_at,
      executionEpoch: row.execution_epoch,
      conversationId: row.conversation_id,
      reportId: row.report_id,
      proposalId: row.proposal_id,
      jobId: row.job_id,
      permissions: AGENT_PROFILES[row.agent_profile_id]?.tools ?? [],
      budget: {
        maxModelRequests: st.maxModelRequests,
        maxToolTasks: st.maxToolTasks,
        maxStageAttempts: st.maxStageAttempts,
        deadlineMs: st.deadlineMs,
        maxOutputTokens: st.maxOutputTokens ?? MODE_BUDGETS[row.mode ?? "build"].maxOutputTokens,
        modelRequests: attempts?.n ?? row.model_request_count,
        outputTokensReservedOrUsed: attempts?.out ?? 0,
        usageUnknownAttempts: attempts?.unknown ?? 0,
      },
    };
  }

  requireRun(runId: string): RunRow {
    const row = this.getRow(runId);
    if (!row) throw new AgentOsError("NOT_FOUND", "run not found", { runId });
    return row;
  }

  /** v0.2 hooks: refuse a run while a user version switch of its target is open; cancel a run's deployments with it. */
  acceptGuard: ((appId: string | null) => void) | null = null;
  onStopInTx: ((runId: string) => void) | null = null;
  /** v0.3: freezes the user's resource scope for a system_plan run (set by the system-capabilities layer). */
  systemScope: ((runId: string, resourceIds: string[], capabilityScopes: string[], deadlineMs: number) => unknown) | null = null;
  /** v0.4: an archived app takes no new runs (lifecycle layer). */
  archivedGuard: ((appId: string) => void) | null = null;

  settingsFor(row: { mode?: string | null; budget_config?: string | null } | undefined): RunSettings {
    if (row?.budget_config) {
      const b = JSON.parse(row.budget_config) as RunSettings;
      return b;
    }
    const mode = (row?.mode ?? "build") as RunMode;
    if (mode === "system_plan") {
      return { ...SYSTEM_PLAN_RUN_SETTINGS, deadlineMs: Math.min(SYSTEM_PLAN_RUN_SETTINGS.deadlineMs, this.settings.deadlineMs) };
    }
    if (mode === "build") return this.settings;
    const b = MODE_BUDGETS[mode];
    return { deadlineMs: Math.min(b.deadlineMs, this.settings.deadlineMs), maxModelRequests: b.maxModelRequests, maxToolTasks: b.maxToolTasks, maxStageAttempts: b.maxStageAttempts, maxOutputTokens: b.maxOutputTokens };
  }

  #budgetFor(mode: RunMode): RunSettings {
    const base = this.settingsFor({ mode });
    return { ...base, maxOutputTokens: base.maxOutputTokens ?? MODE_BUDGETS[mode].maxOutputTokens };
  }

  #queueCheck(background: boolean): void {
    if (background) return;
    // Cancelled tasks stay in waiting_* until the scheduler ends them. They are not waiting work and must not fill the
    // 16-deep queue (a paused scheduler would otherwise refuse every new task).
    const n = this.store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE background = 0 AND status = 'queued' AND ${QUEUED_SQL}`)!.n;
    if (n >= V4_LIMITS.foregroundQueue) throw new AgentOsError("RUN_QUEUE_FULL", `the task queue is full (${V4_LIMITS.foregroundQueue}); wait for a task to finish`);
  }

  #insert(r: {
    runId: string; requestKey: string; requestHash: string; targetAppId: string | null; expectedAppEpoch: number; intent: string;
    frozen: FrozenRunInput; mode: RunMode; background: boolean; scope?: unknown; jobId?: string | null; incidentId?: string | null; priority?: number;
  }): void {
    const nowMs = this.nowMs();
    const frozenJson = canonicalJson(r.frozen);
    const budget = this.#budgetFor(r.mode);
    this.store.run(
      `INSERT INTO runs (id, request_key, request_hash, target_app_id, expected_app_epoch, intent, frozen_submit_json, submit_hash,
        status, dispatch_state, deadline_at, created_at, updated_at, mode, system_resource_scope,
        agent_profile_id, execution_epoch, scheduling_state, wait_reason, priority, background, queue_deadline_at, budget_config, job_id, incident_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'pending', NULL, ?, ?, ?, ?, ?, 1, 'waiting_slot', 'waiting for a free task slot', ?, ?, ?, ?, ?, ?)`,
      r.runId, r.requestKey, r.requestHash, r.targetAppId, r.expectedAppEpoch, r.intent, frozenJson, sha256Hex(frozenJson),
      iso(nowMs), iso(nowMs), r.mode, r.scope === undefined ? null : JSON.stringify(r.scope),
      profileForMode(r.mode), r.priority ?? 0, r.background ? 1 : 0, iso(nowMs + V4_LIMITS.queueDeadlineMs), JSON.stringify(budget), r.jobId ?? null, r.incidentId ?? null,
    );
    // Spec §6.2 step 1: the conversation-create intent is frozen with the run; no model call happens here.
    const createKey = `${this.store.meta().store_uuid}/run/${r.runId}`;
    this.store.run(
      `INSERT INTO agent_dispatch_outbox (run_id, phase, frozen_request, request_hash, create_key, dispatch_state, created_at, updated_at)
       VALUES (?, 'create', ?, ?, ?, 'pending', ?, ?)`,
      r.runId, frozenJson, sha256Hex(frozenJson), createKey, iso(nowMs), iso(nowMs),
    );
  }

  /** Accept a foreground generation request (inside the gateway write tx): persist and queue; never RUN_BUSY (spec §7.1). */
  accept(body: RunCreateBody, requestKey: string, requestHash: string): { runId: string; targetAppId: string | null; status: RunStatus; queueState: SchedulingState; waitReason: string | null } {
    const runMode = body.mode ?? "build";
    this.#queueCheck(false);
    if (runMode === "system_plan") return this.#acceptSystemPlan(body, requestKey, requestHash);
    if (runMode !== "build") throw new AgentOsError("INVALID_REQUEST", "mode must be build or system_plan");
    if (body.resourceIds !== undefined || body.capabilityScopes !== undefined) throw new AgentOsError("INVALID_REQUEST", "resourceIds/capabilityScopes are only for mode=system_plan");
    let targetAppId: string;
    let expectedAppEpoch: number;
    let mode: "create" | "modify";
    let contractAtAccept: { fields: Record<string, unknown> } = { fields: {} };
    let activeRevisionAtAccept: string | null = null;
    if (body.targetAppId === null) {
      if (body.expectedAppEpoch !== undefined) throw new AgentOsError("INVALID_REQUEST", "expectedAppEpoch is only for modifying an app");
      // A new app reserves its unique appId at acceptance; the same Idempotency-Key never creates a second one.
      targetAppId = this.apps.createPlaceholder();
      expectedAppEpoch = 0;
      mode = "create";
    } else {
      const app = this.apps.requireApp(body.targetAppId);
      if (body.expectedAppEpoch === undefined) throw new AgentOsError("INVALID_REQUEST", "expectedAppEpoch is required when modifying an app");
      if (app.epoch !== body.expectedAppEpoch) throw new AgentOsError("APP_EPOCH_STALE", "the app changed; reload first", { appEpoch: app.epoch });
      this.archivedGuard?.(app.id);
      targetAppId = app.id;
      expectedAppEpoch = app.epoch;
      mode = app.active_revision_id === null ? "create" : "modify";
      contractAtAccept = this.apps.contractOf(app);
      activeRevisionAtAccept = app.active_revision_id;
    }
    this.acceptGuard?.(targetAppId);
    const runId = randomUUID();
    const nowMs = this.nowMs();
    const frozen: FrozenRunInput = {
      protocolVersion: 1,
      runId,
      storeUUID: this.store.meta().store_uuid,
      mode,
      runMode: "build",
      agentProfileId: "builder",
      targetAppId,
      expectedAppEpoch,
      intent: body.intent,
      contractAtAccept,
      activeRevisionAtAccept,
      system: { hostVersion: HOST_VERSION, platform: this.platform.platform, arch: this.platform.arch },
      acceptedAt: iso(nowMs),
    };
    this.#insert({ runId, requestKey, requestHash, targetAppId, expectedAppEpoch, intent: body.intent, frozen, mode: "build", background: false });
    this.store.event("run.accepted", { runId, targetAppId, mode }, { appId: targetAppId, runId });
    return { runId, targetAppId, status: "queued", queueState: "waiting_slot", waitReason: "waiting for a free task slot" };
  }

  /** mode=system_plan: no app target (NULL, spec §21.1); the resource scope is frozen with the run. */
  #acceptSystemPlan(body: RunCreateBody, requestKey: string, requestHash: string): { runId: string; targetAppId: string | null; status: RunStatus; queueState: SchedulingState; waitReason: string | null } {
    if (body.targetAppId !== null) throw new AgentOsError("INVALID_REQUEST", "system_plan runs do not target an app");
    if (!this.systemScope) throw new AgentOsError("PROVIDER_UNAVAILABLE", "system capabilities are not available on this host");
    const runId = randomUUID();
    const nowMs = this.nowMs();
    const st = this.settingsFor({ mode: "system_plan" });
    // The scope's own deadline covers queueing plus execution; it is re-checked at dispatch.
    const scope = this.systemScope(runId, body.resourceIds ?? [], body.capabilityScopes ?? [], nowMs + V4_LIMITS.queueDeadlineMs + st.deadlineMs);
    const frozen: FrozenRunInput = {
      protocolVersion: 1,
      runId,
      storeUUID: this.store.meta().store_uuid,
      mode: "create",
      runMode: "system_plan",
      agentProfileId: "system-planner",
      systemScope: scope,
      targetAppId: null,
      expectedAppEpoch: 0,
      intent: body.intent,
      contractAtAccept: { fields: {} },
      activeRevisionAtAccept: null,
      system: { hostVersion: HOST_VERSION, platform: this.platform.platform, arch: this.platform.arch },
      acceptedAt: iso(nowMs),
    };
    this.#insert({ runId, requestKey, requestHash, targetAppId: null, expectedAppEpoch: 0, intent: body.intent, frozen, mode: "system_plan", background: false, scope });
    this.store.event("run.accepted", { runId, mode: "system_plan" }, { runId });
    return { runId, targetAppId: null, status: "queued", queueState: "waiting_slot", waitReason: "waiting for a free task slot" };
  }

  /** A host-scheduled background analysis run (maintenance principal, never a user request; spec §8.1, §19). */
  acceptBackground(input: BackgroundRunInput): string {
    return this.store.tx(() => {
      const key = `job:${input.jobId}:${input.mode}`;
      const prior = this.store.get<{ id: string }>("SELECT id FROM runs WHERE request_key = ?", key);
      if (prior) return prior.id;
      const runId = randomUUID();
      const nowMs = this.nowMs();
      let expectedAppEpoch = 0;
      let activeRevision: string | null = null;
      if (input.appId) {
        const app = this.apps.requireApp(input.appId);
        expectedAppEpoch = app.epoch;
        activeRevision = app.active_revision_id;
      }
      const frozen: FrozenRunInput = {
        protocolVersion: 1,
        runId,
        storeUUID: this.store.meta().store_uuid,
        mode: "modify",
        runMode: input.mode,
        agentProfileId: profileForMode(input.mode),
        targetAppId: input.appId,
        expectedAppEpoch,
        intent: input.intent,
        contractAtAccept: { fields: {} },
        activeRevisionAtAccept: activeRevision,
        maintenance: { jobId: input.jobId, incidentId: input.incidentId, scope: input.scope },
        system: { hostVersion: HOST_VERSION, platform: this.platform.platform, arch: this.platform.arch },
        acceptedAt: iso(nowMs),
      };
      this.#insert({ runId, requestKey: key, requestHash: sha256Hex(canonicalJson(frozen)), targetAppId: input.appId, expectedAppEpoch, intent: input.intent, frozen, mode: input.mode, background: true, jobId: input.jobId, incidentId: input.incidentId });
      this.store.event("run.accepted", { runId, mode: input.mode, jobId: input.jobId, background: true }, { runId, appId: input.appId });
      return runId;
    });
  }

  frozen(row: RunRow): FrozenRunInput {
    const f = JSON.parse(row.frozen_submit_json) as FrozenRunInput;
    if (sha256Hex(canonicalJson(f)) !== row.submit_hash) throw new AgentOsError("STORE_UNAVAILABLE", "frozen run input hash mismatch");
    return f;
  }

  /**
   * Close the write fence of ONE run (spec §10.1): status cancel_requested and a new execution epoch in os.sqlite first;
   * the coordinator then aborts only that conversation. Used by user cancel (inside the gateway tx) and host stops.
   */
  #closeFence(row: RunRow, reason: StopReason): void {
    const draining = (RUNNING_SCHED as readonly string[]).includes(row.scheduling_state) ? "draining" : row.scheduling_state;
    this.store.run(
      "UPDATE runs SET status = 'cancel_requested', stop_reason = ?, execution_epoch = execution_epoch + 1, scheduling_state = ?, updated_at = ? WHERE id = ?",
      reason, draining, this.now(), row.id,
    );
    this.store.run("UPDATE agent_conversations SET route_purpose = 'closed', updated_at = ? WHERE run_id = ?", this.now(), row.id);
    this.store.event("run.cancel_requested", { runId: row.id, reason, executionEpoch: row.execution_epoch + 1 }, { runId: row.id, appId: row.target_app_id });
    this.onStopInTx?.(row.id);
  }

  /** User cancel (inside the gateway write tx). */
  cancel(runId: string): { status: number; body: RunView } {
    const row = this.requireRun(runId);
    if (row.applied_revision_id !== null) {
      throw new AgentOsError("ALREADY_APPLIED", "this run already published a revision; switch versions to undo it", {
        appliedRevisionId: row.applied_revision_id,
      });
    }
    if (row.status === "failed" || row.status === "cancelled" || row.status === "succeeded" || row.status === "cancel_requested") {
      return { status: 200, body: this.view(row) };
    }
    this.#closeFence(row, "user");
    return { status: 202, body: this.view(this.requireRun(runId)) };
  }

  /** Close the write fence for budget/deadline/host reasons (own tx). */
  requestStop(runId: string, reason: StopReason): void {
    this.store.tx(() => {
      const row = this.getRow(runId);
      if (!row || row.applied_revision_id !== null) return;
      if (row.status !== "queued" && row.status !== "running" && row.status !== "blocked") return;
      this.#closeFence(row, reason);
    });
  }

  /** Scheduler: a queued run takes a slot and its execution deadline starts now (spec §7.1). Inside a tx. */
  startInTx(runId: string): void {
    const row = this.requireRun(runId);
    const st = this.settingsFor(row);
    this.store.run(
      "UPDATE runs SET scheduling_state = 'dispatching', wait_reason = NULL, started_at = ?, deadline_at = ?, updated_at = ? WHERE id = ? AND scheduling_state IN ('waiting_slot','waiting_target') AND status = 'queued'",
      this.now(), iso(this.nowMs() + st.deadlineMs), this.now(), runId,
    );
    this.store.event("run.started", { runId }, { runId, appId: row.target_app_id });
  }

  /** Queued run: why it has no slot yet (waiting_slot / waiting_target). */
  setWaiting(runId: string, state: "waiting_slot" | "waiting_target", reason: string): void {
    this.store.run("UPDATE runs SET scheduling_state = ?, wait_reason = ?, updated_at = ? WHERE id = ? AND scheduling_state IN ('waiting_slot','waiting_target') AND (scheduling_state <> ? OR COALESCE(wait_reason,'') <> ?)", state, reason, this.now(), runId, state, reason);
  }

  /** Started run waiting on a resource (the build/Prepare slot, a model permit): not a tool error, no model retry (spec §7.3). */
  setResourceWait(runId: string, state: "waiting_build" | "waiting_model" | "active", reason: string | null): void {
    this.store.tx(() =>
      this.store.run("UPDATE runs SET scheduling_state = ?, wait_reason = ?, updated_at = ? WHERE id = ? AND scheduling_state IN ('active','waiting_build','waiting_model') AND (scheduling_state <> ? OR COALESCE(wait_reason,'') <> COALESCE(?,''))", state, reason, this.now(), runId, state, reason),
    );
  }

  /** Record the Pi conversation bound to a run (spec §6.2 step 3). The binding row was written before the Pi commit. */
  bindConversation(runId: string, conversationId: string): void {
    this.store.tx(() => {
      const row = this.requireRun(runId);
      if (row.conversation_id !== null && row.conversation_id !== conversationId) throw new AgentOsError("RUN_IDENTITY_MISMATCH", "the run is bound to another conversation");
      const other = this.store.get<{ run_id: string | null }>("SELECT run_id FROM agent_conversations WHERE conversation_id = ?", conversationId);
      if (other && other.run_id !== runId) throw new AgentOsError("RUN_IDENTITY_MISMATCH", "the conversation is bound to another run");
      this.store.run("UPDATE runs SET conversation_id = ?, updated_at = ? WHERE id = ?", conversationId, this.now(), runId);
      this.store.run("UPDATE agent_conversations SET conversation_id = ?, binding_state = CASE binding_state WHEN 'creating' THEN 'bound' ELSE binding_state END, updated_at = ? WHERE run_id = ?", conversationId, this.now(), runId);
      this.store.run("UPDATE agent_dispatch_outbox SET conversation_id = ?, dispatch_state = 'done', updated_at = ? WHERE run_id = ? AND phase = 'create'", conversationId, this.now(), runId);
      this.store.event("run.conversation_bound", { runId, conversationId }, { runId });
    });
  }

  /** pending → dispatching, only while the run may still run (wins or loses against cancel atomically). */
  beginDispatch(runId: string): boolean {
    return this.store.tx(() => {
      const r = this.store.run(
        "UPDATE runs SET dispatch_state = 'dispatching', updated_at = ? WHERE id = ? AND dispatch_state = 'pending' AND status = 'queued' AND scheduling_state = 'dispatching' AND deadline_at > ?",
        this.now(), runId, this.now(),
      );
      return r.changes === 1;
    });
  }

  markSubmitted(runId: string, submissionId: number): void {
    this.store.tx(() => {
      const row = this.requireRun(runId);
      if (row.pi_submission_id !== null && row.pi_submission_id !== submissionId) {
        throw new AgentOsError("STORE_UNAVAILABLE", "Pi returned a different submission for the same run");
      }
      this.store.run(
        `UPDATE runs SET pi_submission_id = ?, dispatch_state = 'submitted',
           status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
           scheduling_state = CASE WHEN scheduling_state = 'dispatching' THEN 'active' ELSE scheduling_state END, updated_at = ? WHERE id = ?`,
        submissionId, this.now(), runId,
      );
      this.store.event("run.submitted", { runId, submissionId }, { runId });
    });
  }

  markBlocked(runId: string, diagnostic: Record<string, unknown>): void {
    this.store.tx(() => {
      const r = this.store.run(
        "UPDATE runs SET status = 'blocked', error_json = ?, updated_at = ? WHERE id = ? AND status IN ('queued','running')",
        JSON.stringify({ code: "RECOVERY_BLOCKED", message: "this agent task cannot continue; cancel it to free its slot (other tasks keep running)", details: diagnostic }),
        this.now(), runId,
      );
      if (r.changes) this.store.event("run.blocked", { runId, ...diagnostic }, { runId });
    });
  }

  /** Release a run's slot and target lease (inside a tx). */
  #release(row: RunRow): void {
    this.store.run("UPDATE runs SET scheduling_state = 'done', wait_reason = NULL, updated_at = ? WHERE id = ?", this.now(), row.id);
    this.store.run("UPDATE target_leases SET state = 'released', updated_at = ? WHERE owner_kind = 'run' AND owner_id = ? AND state <> 'released'", this.now(), row.id);
    this.store.run("UPDATE agent_conversations SET binding_state = CASE WHEN binding_state IN ('bound','creating') THEN 'closed' ELSE binding_state END, route_purpose = 'closed', updated_at = ? WHERE run_id = ?", this.now(), row.id);
  }

  /** Final status from the completion fact of the run's mode (spec §10.2), never from the model saying "done". */
  finalize(runId: string, piOutcome: { state: string; reason?: string; detail?: string }, forced?: { code: string; message: string }): RunRow {
    return this.store.tx(() => {
      const row = this.requireRun(runId);
      if (!ACTIVE_RUN_STATUSES.includes(row.status)) {
        if (row.scheduling_state !== "done") this.#release(row);
        return this.requireRun(runId);
      }
      let status: RunStatus;
      let error: Record<string, unknown> | null = null;
      let warning: string | null = row.warning;
      const unclean = piOutcome.state !== "done" || row.stop_reason !== null;
      const why = row.stop_reason ?? piOutcome.reason ?? piOutcome.state;
      if (row.mode === "system_plan" && row.prepared_action_id !== null) {
        status = "succeeded";
        if (unclean) warning = `plan prepared, but the agent did not finish cleanly (${why})`;
      } else if (row.mode === "maintenance_diagnose" && row.report_id !== null) {
        status = "succeeded";
        if (unclean) warning = `report saved, but the agent did not finish cleanly (${why})`;
      } else if (row.mode === "maintenance_refactor" && row.proposal_id !== null) {
        status = "succeeded";
        if (unclean) warning = `proposal registered, but the agent did not finish cleanly (${why})`;
      } else if (row.applied_revision_id !== null) {
        status = "succeeded";
        if (unclean) warning = `published, but the agent did not finish cleanly (${why})`;
      } else if (forced) {
        status = "failed";
        error = forced;
      } else if (row.stop_reason === "user") {
        status = "cancelled";
        error = { code: "CANCELLED", message: "cancelled by the user" };
      } else if (row.stop_reason === "budget") {
        status = "failed";
        error = { code: "BUDGET_EXCEEDED", message: row.mode === "system_plan" ? "the planning budget was used up before a plan was prepared" : "the task budget was used up before it finished" };
      } else if (row.stop_reason === "deadline") {
        status = "failed";
        error = { code: "DEADLINE_EXCEEDED", message: "the task took longer than allowed" };
      } else if (row.stop_reason === "target_changed") {
        status = "failed";
        error = { code: "TARGET_CHANGED", message: "the target app changed while this task waited; submit it again" };
      } else if (row.stop_reason === "maintenance_paused" || row.stop_reason === "restore") {
        status = "cancelled";
        error = { code: "CANCELLED", message: row.stop_reason === "restore" ? "stopped by a workspace restore" : "stopped because maintenance was paused" };
      } else if (piOutcome.state === "unanswered" && piOutcome.reason !== undefined && piOutcome.reason !== "aborted") {
        status = "failed";
        error = { code: "MODEL_ERROR", message: "the model request failed", details: { reason: piOutcome.reason, detail: (piOutcome.detail ?? "").slice(0, 500) } };
      } else if (row.mode === "system_plan") {
        status = "failed";
        error = { code: "NO_SYSTEM_PLAN_PREPARED", message: "the agent finished without preparing a system plan" };
      } else if (row.mode === "maintenance_diagnose") {
        status = "failed";
        error = { code: "NO_MAINTENANCE_REPORT", message: "the analysis finished without a valid report" };
      } else if (row.mode === "maintenance_refactor") {
        status = "failed";
        error = { code: "NO_PROPOSAL", message: "the optimisation finished without a registered proposal" };
      } else {
        status = "failed";
        error = { code: "NO_APPLICATION_PUBLISHED", message: "the agent finished without publishing an app" };
      }
      this.store.run(
        "UPDATE runs SET status = ?, error_json = ?, warning = ?, updated_at = ? WHERE id = ?",
        status, error ? JSON.stringify(error) : null, warning, this.now(), runId,
      );
      this.#release(row);
      this.store.event(`run.${status}`, { runId, appliedRevisionId: row.applied_revision_id }, { runId, appId: row.target_app_id });
      this.onFinalizedInTx?.(this.requireRun(runId));
      return this.requireRun(runId);
    });
  }

  /** v0.4: background runs report back to their maintenance job. */
  onFinalizedInTx: ((row: RunRow) => void) | null = null;

  // ---- fences and budgets used by agent tools and the provider wrapper ----

  /** Inside a tx: may this run still write? Checks status, deadline and the execution epoch of the calling binding. */
  assertWritable(runId: string, bindingEpoch?: number): RunRow {
    const row = this.requireRun(runId);
    if (row.applied_revision_id !== null) throw new AgentOsError("FORBIDDEN", "this run already published; no further writes");
    if (bindingEpoch !== undefined && bindingEpoch !== row.execution_epoch) throw new AgentOsError("EXECUTION_EPOCH_STALE", "this call belongs to an earlier execution of the task");
    if (row.status !== "running") throw new AgentOsError("FORBIDDEN", `run is ${row.status}; writes are closed`);
    if (row.deadline_at === null || Date.parse(row.deadline_at) <= this.nowMs()) throw new AgentOsError("FORBIDDEN", "run deadline passed");
    return row;
  }

  /**
   * Count a tool task that entered host execution (replays of the same Pi task are not new).
   * Returns false when the budget is exhausted (and closes the fence).
   */
  enterTool(runId: string, piTaskId: string, toolName: string, isStage: boolean): { ok: true } | { ok: false; reason: string } {
    const over = this.store.tx(() => {
      const now = this.now();
      this.store.run("INSERT OR IGNORE INTO run_steps (run_id, kind, durable_task_id, tool_name, created_at) VALUES (?, 'tool', ?, ?, ?)", runId, piTaskId, toolName, now);
      if (isStage) this.store.run("INSERT OR IGNORE INTO run_steps (run_id, kind, durable_task_id, tool_name, created_at) VALUES (?, 'stage', ?, ?, ?)", runId, piTaskId, toolName, now);
      const tools = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM run_steps WHERE run_id = ? AND kind = 'tool'", runId)!.n;
      const stages = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM run_steps WHERE run_id = ? AND kind = 'stage'", runId)!.n;
      const row = this.getRow(runId);
      const st = this.settingsFor(row);
      if (tools > st.maxToolTasks) return `tool task budget (${st.maxToolTasks}) exhausted`;
      const what = row?.mode === "system_plan" ? "invalid plan" : row?.mode === "maintenance_diagnose" ? "report" : row?.mode === "maintenance_refactor" ? "candidate" : "stage";
      if (stages > st.maxStageAttempts) return `${what} attempt budget (${st.maxStageAttempts}) exhausted`;
      return null;
    });
    if (over !== null) {
      this.requestStop(runId, "budget");
      return { ok: false, reason: over };
    }
    return { ok: true };
  }

  recordValidation(runId: string, stage: string, issues: ValidationIssue[]): void {
    this.store.tx(() => {
      this.store.run(
        "UPDATE runs SET last_validation_json = ?, updated_at = ? WHERE id = ?",
        JSON.stringify({ stage, issues: issues.slice(0, 30) }),
        this.now(),
        runId,
      );
    });
  }

  /** Inside the activation tx: the publish fact. */
  setApplied(runId: string, revisionId: string): void {
    this.store.run("UPDATE runs SET applied_revision_id = ?, updated_at = ? WHERE id = ? AND applied_revision_id IS NULL", revisionId, this.now(), runId);
    this.store.event("run.published", { runId, revisionId }, { runId });
  }
}
