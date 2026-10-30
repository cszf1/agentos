import { randomUUID } from "node:crypto";
import { MODE_BUDGETS, V4_LIMITS, COMPACTION_BUDGET, type RunMode } from "@agentos/contracts";
import { iso, type Store } from "../persistence/store.js";
import type { RunService } from "../runs/run-service.js";

/**
 * Foreground is not idle for a new background model activity (spec §7.2, §9.4): a foreground task is still waiting for
 * a slot, a target or dispatch, or for the single build slot. Shared by model-request admission and by starting a
 * background run or a compaction job.
 */
export function foregroundBusy(store: Store): boolean {
  return !!store.get("SELECT 1 FROM runs WHERE background = 0 AND status = 'queued' AND scheduling_state IN ('waiting_slot','waiting_target','dispatching')")
    || !!store.get("SELECT 1 FROM runs WHERE background = 0 AND scheduling_state = 'waiting_build'");
}

/** A background model run already holds the one shared slot (spec §7.2: background run and compaction together are 1). */
export function backgroundRunBusy(store: Store): boolean {
  return !!store.get("SELECT 1 FROM runs WHERE background = 1 AND scheduling_state IN ('dispatching','active','waiting_build','waiting_model','draining')");
}

/** A compaction job already holds that same slot. */
export function compactionBusy(store: Store): boolean {
  return !!store.get("SELECT 1 FROM compaction_jobs WHERE state IN ('creating','running')");
}

/**
 * Persistent model-request budgets and the workspace-wide concurrency permit (spec §9).
 *
 * Every network request of every model route goes through `admit()` before anything connects upstream:
 *   1. wait (cancellably, bounded by the subject's deadline) for one of the global permits; foreground first, background
 *      only while no foreground request waits and the background slot is free (spec §9.4, V4-S08);
 *   2. one short transaction re-reads the route binding, checks the subject (run status, execution epoch, deadline,
 *      per-run, rolling-24h and background limits), reserves the request and its maxOutputTokens, and writes the
 *      attempt row; a reservation is never refunded;
 *   3. `settle()` stores trusted usage, or keeps the reservation when usage is missing (interrupted / usage_unknown).
 * The subject is the route's binding in os.sqlite, never "the current run", a prompt or the last tool call.
 */

export interface RouteBindingRow {
  conversation_id: string | null;
  create_key: string;
  run_id: string | null;
  compaction_job_id: string | null;
  purpose: "run" | "compaction" | "legacy_root";
  profile_id: string;
  model_route_id: string;
  route_epoch: number;
  route_purpose: "run" | "compaction" | "closed";
  route_subject_id: string | null;
  binding_state: string;
  maintenance_lock?: string | null;
}

export type Admission =
  | { ok: true; attemptId: string; maxTokens: number; background: boolean; subject: string }
  | { ok: false; reason: string; code: "MODEL_BUDGET_EXCEEDED" | "RUN_IDENTITY_MISMATCH" | "EXECUTION_EPOCH_STALE" | "FORBIDDEN" | "DEADLINE" | "MEMBERSHIP_REVOKED" | "MACHINE_CAPACITY" };

/**
 * v1.0 machine admission (spec §13.1): every model request also holds a machine permit. Implemented by the Host's
 * link to agentos-machined; null outside machine mode. `acquire` resolves once the permit is reserved (or denied).
 */
export interface MachineGate {
  acquire(req: { ownerKind: "run" | "compaction"; ownerId: string; executionEpoch: number; attemptId: string; background: boolean; userId: string | null; memberVersion: number; deadlineMs: number; bodyHash: string }, signal?: AbortSignal): Promise<{ ok: true; permitId: string } | { ok: false; reason: string; code: "MACHINE_CAPACITY" | "MEMBERSHIP_REVOKED" | "DEADLINE" }>;
  use(permitId: string, memberVersion: number): Promise<boolean>;
  release(permitId: string, usage: "used" | "unused" | "unknown", usageJson?: unknown): void;
}

interface Waiter {
  background: boolean;
  resolve: (ok: boolean) => void;
  timer: NodeJS.Timeout | undefined;
}

export interface BudgetLimits {
  modelRequestsPer24h: number;
  backgroundModelRequestsPer24h: number;
  backgroundOutputTokensPer24h: number;
  globalModelPermits: number;
}

export class ModelBudgets {
  #inUse = 0;
  #inUseBackground = 0;
  #waiters: Waiter[] = [];
  /** process identity: attempts of an earlier process are interrupted at recover() */
  readonly bootId = randomUUID();
  /** §9.4 idle signal: may a background request start now? (no foreground work waiting for dispatch or the build slot) */
  /**
   * Foreground priority (spec §9.2, V4-S06): a background request waits while any foreground task waits for a slot,
   * a target or the build queue. The host and the scheduler share this one predicate.
   */
  backgroundIdle: () => boolean = () => !foregroundBusy(this.store);
  /** for tests and diagnostics */
  readonly stats = { admitted: 0, denied: 0, networkStarts: 0, waitedForeground: 0, waitedBackground: 0, maxConcurrent: 0 };

  /** v1.0 machine-level permit gate (null = single-workspace development mode). */
  machineGate: MachineGate | null = null;
  #permitOf = new Map<string, string>();

  constructor(
    private readonly store: Store,
    private readonly runs: RunService,
  ) {}

  /** Subject of a route for the machine permit key: owner, execution epoch, initiator and memberVersion. */
  #subjectOf(b: RouteBindingRow): { ownerKind: "run" | "compaction"; ownerId: string; executionEpoch: number; userId: string | null; memberVersion: number } | null {
    if (b.route_purpose === "compaction" && b.route_subject_id) return { ownerKind: "compaction", ownerId: b.route_subject_id, executionEpoch: b.route_epoch, userId: null, memberVersion: 1 };
    if (!b.run_id) return null;
    const r = this.store.get<{ execution_epoch: number; initiator_user_id: string | null; member_version: number | null }>("SELECT execution_epoch, initiator_user_id, member_version FROM runs WHERE id = ?", b.run_id);
    if (!r) return null;
    return { ownerKind: "run", ownerId: b.run_id, executionEpoch: r.execution_epoch, userId: r.initiator_user_id, memberVersion: r.member_version ?? 1 };
  }

  private now(): string {
    return iso(this.store.clock.now());
  }

  limits(): BudgetLimits {
    const raw = this.store.get<{ j: string | null }>("SELECT budget_limits_json AS j FROM meta WHERE id = 1")?.j;
    const user = raw ? (JSON.parse(raw) as Partial<BudgetLimits>) : {};
    return {
      modelRequestsPer24h: user.modelRequestsPer24h ?? V4_LIMITS.modelRequestsPer24h,
      backgroundModelRequestsPer24h: user.backgroundModelRequestsPer24h ?? V4_LIMITS.backgroundModelRequestsPer24h,
      backgroundOutputTokensPer24h: user.backgroundOutputTokensPer24h ?? V4_LIMITS.backgroundOutputTokensPer24h,
      globalModelPermits: V4_LIMITS.globalModelPermits,
    };
  }

  /** User settings only (spec §9.3: the model cannot change limits). Values are clamped to the platform maxima. */
  setLimits(l: Partial<BudgetLimits>): BudgetLimits {
    const cur = this.limits();
    const next = {
      modelRequestsPer24h: clamp(l.modelRequestsPer24h ?? cur.modelRequestsPer24h, 0, 10_000),
      backgroundModelRequestsPer24h: clamp(l.backgroundModelRequestsPer24h ?? cur.backgroundModelRequestsPer24h, 0, 1000),
      backgroundOutputTokensPer24h: clamp(l.backgroundOutputTokensPer24h ?? cur.backgroundOutputTokensPer24h, 0, 10_000_000),
    };
    this.store.tx(() => this.store.run("UPDATE meta SET budget_limits_json = ? WHERE id = 1", JSON.stringify(next)));
    return this.limits();
  }

  binding(routeId: string): RouteBindingRow | undefined {
    return this.store.get<RouteBindingRow>("SELECT * FROM agent_conversations WHERE model_route_id = ?", routeId);
  }

  #isBackground(b: RouteBindingRow): boolean {
    if (b.route_purpose === "compaction") return true;
    if (!b.run_id) return true;
    const r = this.store.get<{ background: number }>("SELECT background FROM runs WHERE id = ?", b.run_id);
    return r?.background === 1;
  }

  #deadlineOf(b: RouteBindingRow): number {
    if (b.route_purpose === "compaction" && b.route_subject_id) {
      const j = this.store.get<{ created_at: string }>("SELECT created_at FROM compaction_jobs WHERE id = ?", b.route_subject_id);
      return j ? Date.parse(j.created_at) + COMPACTION_BUDGET.deadlineMs : 0;
    }
    if (!b.run_id) return 0;
    const r = this.store.get<{ deadline_at: string | null }>("SELECT deadline_at FROM runs WHERE id = ?", b.run_id);
    return r?.deadline_at ? Date.parse(r.deadline_at) : 0;
  }

  /** Wait for a permit; resolves false at the deadline or when aborted. Waiting reserves nothing (spec §9.4). */
  #acquire(background: boolean, deadlineMs: number, signal?: AbortSignal): Promise<boolean> {
    const free = () =>
      this.#inUse < this.limits().globalModelPermits &&
      (!background || (this.#inUseBackground < V4_LIMITS.backgroundModelSlots && !this.#waiters.some((w) => !w.background) && this.backgroundIdle()));
    if (free() && (background || !this.#waiters.some((w) => !w.background))) {
      this.#take(background);
      return Promise.resolve(true);
    }
    if (background) this.stats.waitedBackground++;
    else this.stats.waitedForeground++;
    return new Promise<boolean>((resolve) => {
      const w: Waiter = { background, resolve, timer: undefined };
      const done = (ok: boolean) => {
        if (w.timer) clearTimeout(w.timer);
        this.#waiters = this.#waiters.filter((x) => x !== w);
        resolve(ok);
      };
      w.resolve = done;
      const left = deadlineMs - this.store.clock.now();
      w.timer = setTimeout(() => done(false), Math.max(0, Math.min(left, 2 ** 31 - 1)));
      w.timer.unref?.();
      signal?.addEventListener("abort", () => done(false), { once: true });
      this.#waiters.push(w);
    });
  }

  #take(background: boolean): void {
    this.#inUse++;
    if (background) this.#inUseBackground++;
    this.stats.maxConcurrent = Math.max(this.stats.maxConcurrent, this.#inUse);
  }

  #release(background: boolean): void {
    this.#inUse = Math.max(0, this.#inUse - 1);
    if (background) this.#inUseBackground = Math.max(0, this.#inUseBackground - 1);
    this.pump();
  }

  /** Hand free permits to waiters: foreground in arrival order first, then one background waiter when idle. */
  pump(): void {
    const max = this.limits().globalModelPermits;
    for (;;) {
      if (this.#inUse >= max) return;
      const fg = this.#waiters.find((w) => !w.background);
      if (fg) {
        this.#take(false);
        fg.resolve(true);
        continue;
      }
      const bg = this.#waiters.find((w) => w.background);
      if (bg && this.#inUseBackground < V4_LIMITS.backgroundModelSlots && this.backgroundIdle()) {
        this.#take(true);
        bg.resolve(true);
        continue;
      }
      return;
    }
  }

  get inUse(): { total: number; background: number; waiting: number; waitingForeground: number } {
    return { total: this.#inUse, background: this.#inUseBackground, waiting: this.#waiters.length, waitingForeground: this.#waiters.filter((w) => !w.background).length };
  }

  /**
   * Admission of one network request on `routeId`. Resolves after the permit is held and the reservation committed,
   * or with a denial (never a thrown provider error that Pi would retry).
   */
  async admit(routeId: string, configHash: string, signal?: AbortSignal): Promise<Admission> {
    const b0 = this.binding(routeId);
    if (!b0) return this.#deny("no trusted binding for this model route", "RUN_IDENTITY_MISMATCH");
    if (b0.route_purpose === "closed" || b0.binding_state === "quarantined") return this.#deny("this model route is closed", "EXECUTION_EPOCH_STALE");
    // An ended task's binding is closed for good; the only request it can still carry is its own approved compaction
    // job's summary, on the route the job re-pointed (purpose=compaction, job lock held, job still open).
    if (b0.binding_state === "closed" && !this.#openCompaction(b0)) return this.#deny("this model route is closed", "EXECUTION_EPOCH_STALE");
    const background = this.#isBackground(b0);
    const deadline = this.#deadlineOf(b0);
    if (deadline <= this.store.clock.now()) return this.#deny("the task deadline passed", "DEADLINE");
    const got = await this.#acquire(background, deadline, signal);
    if (!got) return this.#deny("no model permit before the task deadline", "DEADLINE");
    const attemptId = randomUUID();
    let permitId: string | null = null;
    const subj = this.#subjectOf(b0);
    if (this.machineGate && subj) {
      // Machine permit first (spec §13.1); the workspace's own final checks below run after it is held.
      const m = await this.machineGate.acquire({ ...subj, attemptId, background, deadlineMs: deadline, bodyHash: `sha256:${configHash}` }, signal);
      if (!m.ok) {
        this.#release(background);
        if (m.code !== "DEADLINE" && b0.run_id) this.runs.requestStop(b0.run_id, m.code === "MEMBERSHIP_REVOKED" ? "membership_revoked" : "budget");
        return this.#deny(m.reason, m.code);
      }
      permitId = m.permitId;
    }
    let res: Admission;
    try {
      res = this.store.tx((): Admission => this.#reserveInTx(routeId, configHash, background, attemptId));
    } catch (e) {
      this.#release(background);
      if (permitId) this.machineGate?.release(permitId, "unused");
      throw e;
    }
    if (res.ok && permitId && this.machineGate) {
      // Final machine step: in_use only with the same memberVersion; a revocation in between returns the permit unused.
      const used = await this.machineGate.use(permitId, subj!.memberVersion);
      if (!used) {
        this.store.tx(() => this.store.run("UPDATE model_attempts SET state = 'denied', ended_at = ? WHERE attempt_id = ? AND state = 'running'", this.now(), res.ok ? res.attemptId : ""));
        this.machineGate.release(permitId, "unused");
        this.#release(background);
        if (b0.run_id) this.runs.requestStop(b0.run_id, "membership_revoked");
        return this.#deny("the machine permit was revoked before the request was sent", "MEMBERSHIP_REVOKED");
      }
      this.#permitOf.set(res.attemptId, permitId);
    }
    if (!res.ok) {
      if (permitId) this.machineGate?.release(permitId, "unused");
      this.#release(background);
      if (res.code === "MODEL_BUDGET_EXCEEDED" || res.code === "DEADLINE") {
        const b = this.binding(routeId);
        if (b?.run_id) this.runs.requestStop(b.run_id, res.code === "DEADLINE" ? "deadline" : "budget");
      }
      this.stats.denied++;
      return res;
    }
    this.stats.admitted++;
    this.stats.networkStarts++;
    return res;
  }

  #openCompaction(b: { route_purpose: string; route_subject_id: string | null; maintenance_lock?: string | null }): boolean {
    if (b.route_purpose !== "compaction" || !b.route_subject_id || b.maintenance_lock !== b.route_subject_id) return false;
    return !!this.store.get("SELECT 1 FROM compaction_jobs WHERE id = ? AND state IN ('creating','running')", b.route_subject_id);
  }

  #deny(reason: string, code: Extract<Admission, { ok: false }>["code"]): Admission {
    this.stats.denied++;
    return { ok: false, reason, code };
  }

  #reserveInTx(routeId: string, configHash: string, background: boolean, attemptId: string = randomUUID()): Admission {
    const s = this.store;
    const b = this.binding(routeId);
    if (!b) return { ok: false, reason: "no trusted binding for this model route", code: "RUN_IDENTITY_MISMATCH" };
    if (b.route_purpose === "closed") return { ok: false, reason: "this model route is closed", code: "EXECUTION_EPOCH_STALE" };
    const nowMs = s.clock.now();
    if (background) {
      // Final background admission (spec §8.1, §13.1, §13.2, §14.3): re-checked here, at the permit, not only when the
      // job or run was scheduled. A global pause, the background-model switch, an observe-only job, a cancelled job
      // or a policy with no live version stops a background model request before it reaches the provider.
      const deny = this.#backgroundAuthorityInTx(b);
      if (deny) return { ok: false, reason: deny, code: "FORBIDDEN" };
    }
    const lim = this.limits();
    const since = iso(nowMs - 86_400_000);
    const total = s.get<{ n: number }>("SELECT COUNT(*) AS n FROM model_attempts WHERE started_at > ? AND state <> 'denied'", since)!.n;
    if (total >= lim.modelRequestsPer24h) return { ok: false, reason: `workspace model budget (${lim.modelRequestsPer24h} requests / 24 h) exhausted`, code: "MODEL_BUDGET_EXCEEDED" };
    let maxTokens: number;
    let runId: string | null = null;
    let jobId: string | null = null;
    let compactionJobId: string | null = null;
    let executionEpoch: number | null = null;
    if (b.route_purpose === "compaction") {
      compactionJobId = b.route_subject_id;
      const job = s.get<{ budget_route_epoch: number | null; state: string }>("SELECT budget_route_epoch, state FROM compaction_jobs WHERE id = ?", compactionJobId);
      if (!job || (job.state !== "creating" && job.state !== "running")) return { ok: false, reason: "the compaction job is not open", code: "EXECUTION_EPOCH_STALE" };
      // The route epoch was raised for this job. A request that arrives after the route moved on is not this job's.
      if (job.budget_route_epoch === null || job.budget_route_epoch !== b.route_epoch) return { ok: false, reason: "the route belongs to another compaction binding", code: "EXECUTION_EPOCH_STALE" };
      const used = s.get<{ n: number }>("SELECT COUNT(*) AS n FROM model_attempts WHERE compaction_job_id = ? AND state <> 'denied'", compactionJobId)!.n;
      if (used >= COMPACTION_BUDGET.maxModelRequests) return { ok: false, reason: "the compaction job already used its model request", code: "MODEL_BUDGET_EXCEEDED" };
      maxTokens = COMPACTION_BUDGET.maxOutputTokens;
    } else {
      if (!b.run_id) return { ok: false, reason: "route has no subject", code: "RUN_IDENTITY_MISMATCH" };
      const row = this.runs.getRow(b.run_id);
      if (!row) return { ok: false, reason: "run not found", code: "RUN_IDENTITY_MISMATCH" };
      if (row.execution_epoch !== b.route_epoch) return { ok: false, reason: "the route belongs to an earlier execution of this task", code: "EXECUTION_EPOCH_STALE" };
      if (row.status !== "running") return { ok: false, reason: `run is ${row.status}`, code: "FORBIDDEN" };
      if (row.deadline_at === null || Date.parse(row.deadline_at) <= nowMs) return { ok: false, reason: "deadline passed", code: "DEADLINE" };
      // v1.0 (spec §7.3, §13.1): the initiator's membership is re-read here, after every permit is held.
      const init = s.get<{ initiator_user_id: string | null; member_version: number | null }>("SELECT initiator_user_id, member_version FROM runs WHERE id = ?", row.id);
      if (init?.initiator_user_id) {
        const mm = s.get<{ member_version: number; state: string }>("SELECT member_version, state FROM membership_mirror WHERE user_id = ?", init.initiator_user_id);
        if (!mm || mm.state !== "active" || mm.member_version !== init.member_version) return { ok: false, reason: "the member who started this task no longer has that membership", code: "MEMBERSHIP_REVOKED" };
      }
      const st = this.runs.settingsFor(row);
      if (row.model_request_count >= st.maxModelRequests) return { ok: false, reason: `model request budget (${st.maxModelRequests}) exhausted`, code: "MODEL_BUDGET_EXCEEDED" };
      maxTokens = st.maxOutputTokens ?? MODE_BUDGETS[(row.mode ?? "build") as RunMode].maxOutputTokens;
      runId = row.id;
      jobId = row.job_id;
      executionEpoch = row.execution_epoch;
      s.run("UPDATE runs SET model_request_count = model_request_count + 1, output_reserved = output_reserved + ?, updated_at = ? WHERE id = ?", maxTokens, iso(nowMs), row.id);
    }
    if (background) {
      maxTokens = Math.min(maxTokens, V4_LIMITS.backgroundMaxOutputTokens);
      const bg = s.get<{ n: number; out: number | null }>(
        "SELECT COUNT(*) AS n, SUM(COALESCE(output_tokens, reserved_output)) AS out FROM model_attempts WHERE started_at > ? AND background = 1 AND state <> 'denied'",
        since,
      )!;
      if (bg.n >= lim.backgroundModelRequestsPer24h) return this.#undoRun(runId, maxTokens, `background model budget (${lim.backgroundModelRequestsPer24h} requests / 24 h) exhausted`);
      if ((bg.out ?? 0) + maxTokens > lim.backgroundOutputTokensPer24h) return this.#undoRun(runId, maxTokens, `background output budget (${lim.backgroundOutputTokensPer24h} tokens / 24 h) exhausted`);
    }
    s.run(
      `INSERT INTO model_attempts (attempt_id, run_id, job_id, compaction_job_id, conversation_id, route_id, route_epoch, execution_epoch, purpose, background, config_hash, reserved_output, state, started_at, host_boot_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      attemptId, runId, jobId, compactionJobId, b.conversation_id, routeId, b.route_epoch, executionEpoch, b.route_purpose === "compaction" ? "compaction" : "run",
      background ? 1 : 0, configHash, maxTokens, iso(nowMs), this.bootId,
    );
    return { ok: true, attemptId, maxTokens, background, subject: runId ?? `compaction:${compactionJobId}` };
  }

  #backgroundAuthorityInTx(b: { route_purpose: string; run_id?: string | null }): string | null {
    const s = this.store;
    const m = s.get<{ ms: string; bm: number }>("SELECT maintenance_state AS ms, background_model_enabled AS bm FROM meta WHERE id = 1");
    if (m?.ms === "paused") return "maintenance is paused: no new background model request";
    if (b.route_purpose === "compaction" || !b.run_id) return null; // a user-requested summary: its own job checks
    const run = s.get<{ job_id: string | null }>("SELECT job_id FROM runs WHERE id = ?", b.run_id);
    if (!run?.job_id) return null;
    if (m && m.bm !== 1) return "background model analysis is switched off";
    const j = s.get<{ mode: string; state: string; cancel_requested: number; policy_id: string | null }>("SELECT mode, state, cancel_requested, policy_id FROM maintenance_jobs WHERE id = ?", run.job_id);
    if (!j) return "the maintenance job of this run is gone";
    if (j.mode === "observe") return "an observe-only job never calls the model";
    if (j.cancel_requested === 1 || j.state !== "diagnosing") return `the maintenance job is ${j.cancel_requested === 1 ? "cancelled" : j.state}`;
    if (j.policy_id && !s.get("SELECT 1 FROM maintenance_policies WHERE id = ? AND state = 'enabled'", j.policy_id)) return "the job's policy is no longer enabled";
    return null;
  }

  /** A background denial inside the reservation tx: the run counter must not move (the tx would otherwise commit it). */
  #undoRun(runId: string | null, maxTokens: number, reason: string): Admission {
    if (runId) this.store.run("UPDATE runs SET model_request_count = model_request_count - 1, output_reserved = output_reserved - ? WHERE id = ?", maxTokens, runId);
    return { ok: false, reason, code: "MODEL_BUDGET_EXCEEDED" };
  }

  /** Settle one attempt: trusted terminal usage settles output tokens; missing usage keeps the full reservation. */
  settle(attemptId: string, background: boolean, outcome: { usage?: { output?: number; input?: number; totalTokens?: number; cost?: unknown } | null; failed?: boolean }): void {
    try {
      this.store.tx(() => {
        const out = outcome.usage && typeof outcome.usage.output === "number" && outcome.usage.output >= 0 ? outcome.usage.output : null;
        const state = out === null ? (outcome.failed ? "failed" : "usage_unknown") : outcome.failed ? "failed" : "completed";
        this.store.run(
          "UPDATE model_attempts SET state = ?, usage_json = ?, output_tokens = ?, ended_at = ? WHERE attempt_id = ? AND state = 'running'",
          state, outcome.usage ? JSON.stringify(outcome.usage) : null, out, this.now(), attemptId,
        );
      });
    } finally {
      const permit = this.#permitOf.get(attemptId);
      if (permit && this.machineGate) {
        this.#permitOf.delete(attemptId);
        const known = outcome.usage && typeof outcome.usage.output === "number";
        // A request that may have reached the provider is never refunded (spec §13.1): unknown, not unused.
        this.machineGate.release(permit, known ? "used" : "unknown", outcome.usage ?? null);
      }
      this.#release(background);
    }
  }

  /**
   * Startup (spec §9.2): attempts of an earlier process may still be billed upstream; they keep their reservation and are
   * marked interrupted (usage unknown). Their late output can never write: the binding/epoch checks refuse it.
   */
  recover(): number {
    return this.store.tx(() =>
      this.store.run("UPDATE model_attempts SET state = 'interrupted', ended_at = ? WHERE state IN ('waiting','running') AND COALESCE(host_boot_id,'') <> ?", this.now(), this.bootId).changes,
    );
  }

  /** Diagnostics (spec §24.2). */
  summary(): Record<string, unknown> {
    const since = iso(this.store.clock.now() - 86_400_000);
    const r = this.store.get<{ n: number; bg: number; out: number | null; unknown: number }>(
      "SELECT COUNT(*) AS n, SUM(background) AS bg, SUM(CASE WHEN background = 1 THEN COALESCE(output_tokens, reserved_output) ELSE 0 END) AS out, SUM(CASE WHEN state IN ('interrupted','usage_unknown') THEN 1 ELSE 0 END) AS unknown FROM model_attempts WHERE started_at > ? AND state <> 'denied'",
      since,
    )!;
    return { last24h: { requests: r.n, background: r.bg ?? 0, backgroundOutputTokens: r.out ?? 0, usageUnknown: r.unknown ?? 0 }, limits: this.limits(), permits: this.inUse, stats: this.stats };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}
