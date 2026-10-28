import { randomUUID } from "node:crypto";
import {
  ACTIVE_RUN_STATUSES,
  AgentOsError,
  HOST_VERSION,
  LIMITS,
  canonicalJson,
  sha256Hex,
  type DispatchState,
  type RunCreateBody,
  type RunStatus,
  type RunView,
  type ValidationIssue,
} from "@agentos/contracts";
import { iso, type Store } from "../persistence/store.js";
import type { AppService } from "../apps/app-service.js";
import type { FrozenRunInput } from "./engine.js";

export interface RunRow {
  id: string;
  request_key: string;
  request_hash: string;
  target_app_id: string;
  expected_app_epoch: number;
  intent: string;
  frozen_submit_json: string;
  submit_hash: string;
  status: RunStatus;
  dispatch_state: DispatchState;
  pi_submission_id: number | null;
  applied_revision_id: string | null;
  model_request_count: number;
  mode: "build" | "system_plan";
  system_resource_scope: string | null;
  prepared_action_id: string | null;
  stop_reason: string | null;
  last_validation_json: string | null;
  error_json: string | null;
  warning: string | null;
  deadline_at: string;
  created_at: string;
  updated_at: string;
}

const ACTIVE_SQL = `status IN (${ACTIVE_RUN_STATUSES.map((s) => `'${s}'`).join(",")})`;

export interface RunSettings {
  deadlineMs: number;
  maxModelRequests: number;
  maxToolTasks: number;
  maxStageAttempts: number;
}

export const DEFAULT_RUN_SETTINGS: RunSettings = {
  deadlineMs: LIMITS.runDeadlineMs,
  maxModelRequests: LIMITS.maxModelRequestsPerRun,
  maxToolTasks: LIMITS.maxToolTasksPerRun,
  maxStageAttempts: LIMITS.maxStageAttemptsPerRun,
};

export type StopReason = "user" | "budget" | "deadline";

/** system_plan budgets (spec §20.2): 180 s, 6 model requests, 20 tool tasks, 3 invalid plan attempts. */
export const SYSTEM_PLAN_RUN_SETTINGS: RunSettings = { deadlineMs: 180_000, maxModelRequests: 6, maxToolTasks: 20, maxStageAttempts: 3 };
/** Hidden placeholder that system_plan runs reference (runs.target_app_id is NOT NULL); never listed, never activated. */
export const SYSTEM_PLAN_APP_ID = "00000000-0000-4000-8000-0000000005a5";

export class RunService {
  constructor(
    private readonly store: Store,
    private readonly apps: AppService,
    readonly settings: RunSettings = DEFAULT_RUN_SETTINGS,
    private readonly platform: { platform: string; arch: string } = { platform: process.platform, arch: process.arch },
  ) {}

  nowMs(): number {
    return this.store.clock.now();
  }
  private now(): string {
    return iso(this.nowMs());
  }

  activeRun(): RunRow | undefined {
    return this.store.get<RunRow>(`SELECT * FROM runs WHERE ${ACTIVE_SQL} LIMIT 1`);
  }

  getRow(runId: string): RunRow | undefined {
    return this.store.get<RunRow>("SELECT * FROM runs WHERE id = ?", runId);
  }

  lastRun(): RunRow | undefined {
    return this.store.get<RunRow>("SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT 1");
  }

  view(row: RunRow): RunView {
    const frozen = JSON.parse(row.frozen_submit_json) as FrozenRunInput;
    const steps = this.store.all<{ kind: string; tool_name: string | null; created_at: string }>(
      "SELECT kind, tool_name, created_at FROM run_steps WHERE run_id = ? ORDER BY created_at ASC, rowid ASC",
      row.id,
    );
    const tools = steps.filter((s) => s.kind === "tool");
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
    };
  }

  requireRun(runId: string): RunRow {
    const row = this.getRow(runId);
    if (!row) throw new AgentOsError("NOT_FOUND", "run not found", { runId });
    return row;
  }

  /** v0.2 hooks: refuse a run while a user version switch is open; cancel a run's deployments with it (spec §13, §15). */
  acceptGuard: (() => void) | null = null;
  onStopInTx: ((runId: string) => void) | null = null;
  /** v0.3: freezes the user's resource scope for a system_plan run (set by the system-capabilities layer). */
  systemScope: ((runId: string, resourceIds: string[], capabilityScopes: string[], deadlineMs: number) => unknown) | null = null;

  settingsFor(row: { mode?: string } | undefined): RunSettings {
    if (row?.mode === "system_plan") {
      // Test hosts may shorten deadlines like build runs do.
      return { ...SYSTEM_PLAN_RUN_SETTINGS, deadlineMs: Math.min(SYSTEM_PLAN_RUN_SETTINGS.deadlineMs, this.settings.deadlineMs) };
    }
    return this.settings;
  }

  /** Accept a generation request (inside the gateway write tx). */
  accept(body: RunCreateBody, requestKey: string, requestHash: string, engineIdle: boolean): { runId: string; targetAppId: string; status: RunStatus } {
    if (this.activeRun() !== undefined || !engineIdle) {
      throw new AgentOsError("RUN_BUSY", "another generation is still running");
    }
    this.acceptGuard?.();
    const runMode = body.mode ?? "build";
    if (runMode === "system_plan") return this.#acceptSystemPlan(body, requestKey, requestHash);
    if (body.resourceIds !== undefined || body.capabilityScopes !== undefined) throw new AgentOsError("INVALID_REQUEST", "resourceIds/capabilityScopes are only for mode=system_plan");
    let targetAppId: string;
    let expectedAppEpoch: number;
    let mode: "create" | "modify";
    let contractAtAccept: { fields: Record<string, unknown> } = { fields: {} };
    let activeRevisionAtAccept: string | null = null;
    if (body.targetAppId === null) {
      if (body.expectedAppEpoch !== undefined) throw new AgentOsError("INVALID_REQUEST", "expectedAppEpoch is only for modifying an app");
      targetAppId = this.apps.createPlaceholder();
      expectedAppEpoch = 0;
      mode = "create";
    } else {
      const app = this.apps.requireApp(body.targetAppId);
      if (body.expectedAppEpoch === undefined) throw new AgentOsError("INVALID_REQUEST", "expectedAppEpoch is required when modifying an app");
      if (app.epoch !== body.expectedAppEpoch) throw new AgentOsError("APP_EPOCH_STALE", "the app changed; reload first", { appEpoch: app.epoch });
      targetAppId = app.id;
      expectedAppEpoch = app.epoch;
      mode = app.active_revision_id === null ? "create" : "modify";
      contractAtAccept = this.apps.contractOf(app);
      activeRevisionAtAccept = app.active_revision_id;
    }
    const runId = randomUUID();
    const nowMs = this.nowMs();
    const frozen: FrozenRunInput = {
      protocolVersion: 1,
      runId,
      storeUUID: this.store.meta().store_uuid,
      mode,
      targetAppId,
      expectedAppEpoch,
      intent: body.intent,
      contractAtAccept,
      activeRevisionAtAccept,
      system: { hostVersion: HOST_VERSION, platform: this.platform.platform, arch: this.platform.arch },
      acceptedAt: iso(nowMs),
    };
    const frozenJson = canonicalJson(frozen);
    this.store.run(
      `INSERT INTO runs (id, request_key, request_hash, target_app_id, expected_app_epoch, intent, frozen_submit_json, submit_hash,
        status, dispatch_state, deadline_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'pending', ?, ?, ?)`,
      runId, requestKey, requestHash, targetAppId, expectedAppEpoch, body.intent, frozenJson, sha256Hex(frozenJson),
      iso(nowMs + this.settings.deadlineMs), iso(nowMs), iso(nowMs),
    );
    this.store.event("run.accepted", { runId, targetAppId, mode }, { appId: targetAppId, runId });
    return { runId, targetAppId, status: "queued" };
  }

  /** mode=system_plan: no app target; the resource scope is frozen with the run (spec §8.4, §20.1). */
  #acceptSystemPlan(body: RunCreateBody, requestKey: string, requestHash: string): { runId: string; targetAppId: string; status: RunStatus } {
    if (body.targetAppId !== null) throw new AgentOsError("INVALID_REQUEST", "system_plan runs do not target an app");
    if (!this.systemScope) throw new AgentOsError("PROVIDER_UNAVAILABLE", "system capabilities are not available on this host");
    const runId = randomUUID();
    const nowMs = this.nowMs();
    const st = this.settingsFor({ mode: "system_plan" });
    if (!this.store.get("SELECT 1 FROM apps WHERE id = ?", SYSTEM_PLAN_APP_ID)) {
      this.store.run("INSERT INTO apps (id, active_revision_id, epoch, contract_json, created_at, updated_at) VALUES (?, NULL, 0, ?, ?, ?)", SYSTEM_PLAN_APP_ID, JSON.stringify({ fields: {} }), iso(nowMs), iso(nowMs));
    }
    const scope = this.systemScope(runId, body.resourceIds ?? [], body.capabilityScopes ?? [], nowMs + st.deadlineMs);
    const frozen: FrozenRunInput = {
      protocolVersion: 1,
      runId,
      storeUUID: this.store.meta().store_uuid,
      mode: "create",
      runMode: "system_plan",
      systemScope: scope,
      targetAppId: SYSTEM_PLAN_APP_ID,
      expectedAppEpoch: 0,
      intent: body.intent,
      contractAtAccept: { fields: {} },
      activeRevisionAtAccept: null,
      system: { hostVersion: HOST_VERSION, platform: this.platform.platform, arch: this.platform.arch },
      acceptedAt: iso(nowMs),
    };
    const frozenJson = canonicalJson(frozen);
    this.store.run(
      `INSERT INTO runs (id, request_key, request_hash, target_app_id, expected_app_epoch, intent, frozen_submit_json, submit_hash,
        status, dispatch_state, deadline_at, created_at, updated_at, mode, system_resource_scope)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'queued', 'pending', ?, ?, ?, 'system_plan', ?)`,
      runId, requestKey, requestHash, SYSTEM_PLAN_APP_ID, body.intent, frozenJson, sha256Hex(frozenJson), iso(nowMs + st.deadlineMs), iso(nowMs), iso(nowMs), JSON.stringify(scope),
    );
    this.store.event("run.accepted", { runId, mode: "system_plan" }, { runId });
    return { runId, targetAppId: SYSTEM_PLAN_APP_ID, status: "queued" };
  }

  frozen(row: RunRow): FrozenRunInput {
    const f = JSON.parse(row.frozen_submit_json) as FrozenRunInput;
    if (sha256Hex(canonicalJson(f)) !== row.submit_hash) throw new AgentOsError("STORE_UNAVAILABLE", "frozen run input hash mismatch");
    return f;
  }

  /** User cancel (inside the gateway write tx). Spec §11.5. */
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
    this.store.run(
      "UPDATE runs SET status = 'cancel_requested', stop_reason = 'user', updated_at = ? WHERE id = ?",
      this.now(),
      runId,
    );
    this.store.event("run.cancel_requested", { runId, reason: "user" }, { runId, appId: row.target_app_id });
    this.onStopInTx?.(runId);
    return { status: 202, body: this.view(this.requireRun(runId)) };
  }

  /** Close the write fence for budget/deadline (own tx). */
  requestStop(runId: string, reason: StopReason): void {
    this.store.tx(() => {
      const row = this.getRow(runId);
      if (!row || row.applied_revision_id !== null) return;
      if (row.status !== "queued" && row.status !== "running" && row.status !== "blocked") return;
      this.store.run("UPDATE runs SET status = 'cancel_requested', stop_reason = ?, updated_at = ? WHERE id = ?", reason, this.now(), runId);
      this.store.event("run.cancel_requested", { runId, reason }, { runId, appId: row.target_app_id });
      this.onStopInTx?.(runId);
    });
  }

  /** pending → dispatching, only while the run may still run (wins or loses against cancel atomically). */
  beginDispatch(runId: string): boolean {
    return this.store.tx(() => {
      const r = this.store.run(
        "UPDATE runs SET dispatch_state = 'dispatching', updated_at = ? WHERE id = ? AND dispatch_state = 'pending' AND status = 'queued' AND deadline_at > ?",
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
           status = CASE WHEN status = 'queued' THEN 'running' ELSE status END, updated_at = ? WHERE id = ?`,
        submissionId, this.now(), runId,
      );
      this.store.event("run.submitted", { runId, submissionId }, { runId });
    });
  }

  markBlocked(runId: string, diagnostic: Record<string, unknown>): void {
    this.store.tx(() => {
      const r = this.store.run(
        "UPDATE runs SET status = 'blocked', error_json = ?, updated_at = ? WHERE id = ? AND status IN ('queued','running')",
        JSON.stringify({ code: "RECOVERY_BLOCKED", message: "the agent task cannot continue; cancel it to free the slot", details: diagnostic }),
        this.now(), runId,
      );
      if (r.changes) this.store.event("run.blocked", { runId, ...diagnostic }, { runId });
    });
  }

  finalize(runId: string, piOutcome: { state: string; reason?: string; detail?: string }): RunRow {
    return this.store.tx(() => {
      const row = this.requireRun(runId);
      if (!ACTIVE_RUN_STATUSES.includes(row.status)) return row;
      let status: RunStatus;
      let error: Record<string, unknown> | null = null;
      let warning: string | null = row.warning;
      if (row.mode === "system_plan" && row.prepared_action_id !== null) {
        // Completion fact of a system_plan run: a prepared plan, not an executed action (spec §20.3).
        status = "succeeded";
        if (piOutcome.state !== "done" || row.stop_reason !== null) warning = `plan prepared, but the agent did not finish cleanly (${row.stop_reason ?? piOutcome.reason ?? piOutcome.state})`;
      } else if (row.applied_revision_id !== null) {
        status = "succeeded";
        if (piOutcome.state !== "done" || row.stop_reason !== null) {
          warning = `published, but the agent did not finish cleanly (${row.stop_reason ?? piOutcome.reason ?? piOutcome.state})`;
        }
      } else if (row.stop_reason === "user") {
        status = "cancelled";
        error = { code: "CANCELLED", message: "cancelled by the user" };
      } else if (row.stop_reason === "budget") {
        status = "failed";
        error = { code: "BUDGET_EXCEEDED", message: row.mode === "system_plan" ? "the planning budget was used up before a plan was prepared" : "the generation budget was used up before an app was published" };
      } else if (row.stop_reason === "deadline") {
        status = "failed";
        error = { code: "DEADLINE_EXCEEDED", message: "the generation took longer than allowed" };
      } else if (piOutcome.state === "unanswered" && piOutcome.reason !== undefined && piOutcome.reason !== "aborted") {
        status = "failed";
        error = { code: "MODEL_ERROR", message: "the model request failed", details: { reason: piOutcome.reason, detail: (piOutcome.detail ?? "").slice(0, 500) } };
      } else if (row.mode === "system_plan") {
        status = "failed";
        error = { code: "NO_SYSTEM_PLAN_PREPARED", message: "the agent finished without preparing a system plan" };
      } else {
        status = "failed";
        error = { code: "NO_APPLICATION_PUBLISHED", message: "the agent finished without publishing an app" };
      }
      this.store.run(
        "UPDATE runs SET status = ?, error_json = ?, warning = ?, updated_at = ? WHERE id = ?",
        status, error ? JSON.stringify(error) : null, warning, this.now(), runId,
      );
      this.store.event(`run.${status}`, { runId, appliedRevisionId: row.applied_revision_id }, { runId, appId: row.target_app_id });
      return this.requireRun(runId);
    });
  }

  // ---- fences and budgets used by agent tools and the provider wrapper ----

  /** The run a tool call acts for: the single active run, which must be dispatched. */
  currentToolRun(): RunRow {
    const row = this.activeRun();
    if (!row || row.dispatch_state === "pending") throw new AgentOsError("FORBIDDEN", "no active generation run");
    return row;
  }

  /** Inside a tx: may this run still write? */
  assertWritable(runId: string): RunRow {
    const row = this.requireRun(runId);
    if (row.applied_revision_id !== null) throw new AgentOsError("FORBIDDEN", "this run already published; no further writes");
    if (row.status !== "running") throw new AgentOsError("FORBIDDEN", `run is ${row.status}; writes are closed`);
    if (Date.parse(row.deadline_at) <= this.nowMs()) throw new AgentOsError("FORBIDDEN", "run deadline passed");
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
      const st = this.settingsFor(this.getRow(runId));
      if (tools > st.maxToolTasks) return `tool task budget (${st.maxToolTasks}) exhausted`;
      if (stages > st.maxStageAttempts) return `${this.getRow(runId)?.mode === "system_plan" ? "invalid plan" : "stage"} attempt budget (${st.maxStageAttempts}) exhausted`;
      return null;
    });
    if (over !== null) {
      this.requestStop(runId, "budget");
      return { ok: false, reason: over };
    }
    return { ok: true };
  }

  /** Admission for one model request; reserved before connecting and never refunded. */
  admitModelRequest(): { ok: true; runId: string; count: number } | { ok: false; reason: string } {
    const res = this.store.tx(() => {
      const row = this.activeRun();
      if (!row) return { ok: false as const, reason: "no active run", stop: null };
      if (row.status !== "running") return { ok: false as const, reason: `run is ${row.status}`, stop: null };
      if (Date.parse(row.deadline_at) <= this.nowMs()) return { ok: false as const, reason: "deadline passed", stop: { runId: row.id, why: "deadline" as const } };
      const st = this.settingsFor(row);
      if (row.model_request_count >= st.maxModelRequests) {
        return { ok: false as const, reason: `model request budget (${st.maxModelRequests}) exhausted`, stop: { runId: row.id, why: "budget" as const } };
      }
      this.store.run("UPDATE runs SET model_request_count = model_request_count + 1, updated_at = ? WHERE id = ?", this.now(), row.id);
      return { ok: true as const, runId: row.id, count: row.model_request_count + 1, stop: null };
    });
    if (!res.ok) {
      if (res.stop) this.requestStop(res.stop.runId, res.stop.why);
      return { ok: false, reason: res.reason };
    }
    return { ok: true, runId: res.runId, count: res.count };
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
