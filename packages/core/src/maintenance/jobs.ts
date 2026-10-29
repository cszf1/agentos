import { randomUUID } from "node:crypto";
import {
  AgentOsError,
  JOB_TERMINAL,
  MAINTENANCE_TEMPLATES,
  V4_LIMITS,
  canonicalJson,
  sha256Hex,
  type EffectCertainty,
  type JobState,
  type MaintenanceTemplateId,
} from "@agentos/contracts";
import { iso, type Store } from "../persistence/store.js";
import type { PolicyRow, PolicyService } from "./policy-service.js";
import type { ClockGuard } from "./clock-guard.js";
import type { IncidentStore, IncidentRow } from "../health/incidents.js";
import { fault } from "../faults.js";

export interface JobRow {
  id: string;
  trigger_key: string;
  policy_id: string | null;
  policy_version: number | null;
  maintenance_epoch: number;
  scheduler_epoch: number;
  template_id: MaintenanceTemplateId;
  template_version: number;
  target_kind: string;
  target_id: string;
  target_version: string | null;
  incident_id: string | null;
  mode: "observe" | "suggest" | "automatic" | "manual_check";
  state: JobState;
  step_cursor: number;
  completed_steps: number;
  effect_certainty: EffectCertainty;
  budget_json: string | null;
  deadline_at: string;
  wait_reason: string | null;
  cancel_requested: number;
  stop_reason: string | null;
  outcome_reason: string | null;
  evidence_json: string | null;
  run_id: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

export interface StepRow {
  job_id: string;
  step_id: string;
  seq: number;
  kind: string;
  input_hash: string;
  input_json: string;
  executor: string;
  effect_key: string | null;
  action_id: string | null;
  delete_intent_id: string | null;
  state: "planned" | "admitted" | "dispatched" | "succeeded" | "no_change" | "failed_no_effect" | "unknown" | "skipped" | "cancelled";
  result_json: string | null;
}

export type StepOutcome = { state: "succeeded" | "no_change" | "failed_no_effect" | "unknown"; result?: Record<string, unknown> };

export interface JobContext {
  job: JobRow;
  policy: PolicyRow | null;
  bounds: Record<string, number>;
  deadlineMs: number;
  /** Has the user asked to stop this job (checked before every step, spec §14.3)? */
  cancelled(): boolean;
  /**
   * Run one fixed effect step exactly once: the step row (identity, input hash, executor) is written before the effect;
   * a replay after a restart returns the stored outcome; a step left `dispatched` is reconciled, never re-executed blindly.
   */
  step(stepId: string, kind: string, executor: string, input: Record<string, unknown>, exec: (effectKey: string) => Promise<StepOutcome>, reconcile?: (s: StepRow) => Promise<StepOutcome>): Promise<StepOutcome>;
  evidence(e: Record<string, unknown>): void;
  /** the incident this job works on (opened by observe when needed) */
  incident: IncidentRow | null;
}

export interface ObserveResult {
  needed: boolean;
  reason: string;
  evidence?: Record<string, unknown>;
  targetVersion?: string | null;
  incidentId?: string | null;
  /** suggest mode: what the user would approve */
  suggestion?: Record<string, unknown>;
}

export interface Admit {
  ok: boolean;
  reason?: string;
  /** defer (retry later: cooldown, resources) vs refuse (needs the user: circuit open, cap) */
  defer?: boolean;
  circuitOpen?: boolean;
}

export interface TemplateHandler {
  /** read-only: is an effect needed now? opens / updates the incident */
  observe(ctx: JobContext): Promise<ObserveResult>;
  /** counts, cooldown, circuit, target fences: may this job take an effect now? (no side effect except reservations in act) */
  admission?(ctx: JobContext): Admit;
  /** the fixed effect steps */
  act(ctx: JobContext): Promise<{ certainty: EffectCertainty; reason: string; completed: number }>;
  /** real-state verification after the effect; `pending` keeps the job verifying (observation window) */
  verify?(ctx: JobContext): Promise<{ healthy: boolean | null; reason: string; pending?: boolean }>;
  /** background model analysis (diagnose/optimize): returns the run id it started */
  analyze?(ctx: JobContext): Promise<{ runId: string } | null>;
}

const ACTIVE_EXEC: JobState[] = ["ready", "running", "verifying", "reconciling"];

/**
 * Durable maintenance scheduling and job execution (spec §11, §13.2, §14). Triggers (manual check, approved interval,
 * event re-check) become exactly one job each, in the same transaction as their receipt and cursor. Jobs run the fixed
 * template flow observe → decide → acquire → act → verify → settle; one effect job at a time; every effect step has a
 * persisted identity; nothing is retried blindly after a timeout or crash. Global pause blocks new effects first in
 * os.sqlite, then is synced to the broker.
 */
export class MaintenanceService {
  readonly handlers = new Map<MaintenanceTemplateId, TemplateHandler>();
  #timer: NodeJS.Timeout | undefined;
  #busy = false;
  #again = false;
  #stopped = true;
  #inflight = new Set<Promise<unknown>>();
  /** root-side control sync hook (protocol 2): pause/resume of the whole workspace */
  onControl: ((state: "running" | "paused", epoch: number) => void) | null = null;
  log: (lvl: "info" | "warn" | "error", msg: string, f?: Record<string, unknown>) => void = () => {};
  /** host quiescing (shutdown / backup): no new trigger, no new step */
  quiescing = false;

  constructor(
    private readonly store: Store,
    readonly policies: PolicyService,
    readonly clock: ClockGuard,
    readonly incidents: IncidentStore,
  ) {}

  private now(): string {
    return iso(this.store.clock.now());
  }
  private nowMs(): number {
    return this.store.clock.now();
  }

  register(id: MaintenanceTemplateId, h: TemplateHandler): void {
    this.handlers.set(id, h);
  }

  // ------------------------------------------------------------------ global control (spec §13.2, V4-J08)

  state(): { state: "running" | "paused"; epoch: number; root: string; clock: string; schedulerEpoch: number; backgroundModel: boolean } {
    const m = this.store.get<{ s: string; e: number; r: string; c: string; se: number; bm: number }>(
      "SELECT maintenance_state AS s, maintenance_epoch AS e, maintenance_root_state AS r, clock_state AS c, scheduler_epoch AS se, background_model_enabled AS bm FROM meta WHERE id = 1",
    )!;
    return { state: m.s as "running" | "paused", epoch: m.e, root: m.r, clock: m.c, schedulerEpoch: m.se, backgroundModel: m.bm === 1 };
  }

  /** Pause: local admission closes and the epoch rises in os.sqlite first; the broker sync follows (pending until confirmed). */
  pause(): ReturnType<MaintenanceService["state"]> {
    this.store.tx(() => {
      this.store.run("UPDATE meta SET maintenance_state = 'paused', maintenance_epoch = maintenance_epoch + 1, maintenance_root_state = 'pending' WHERE id = 1");
      this.store.run("UPDATE maintenance_jobs SET wait_reason = 'maintenance paused', updated_at = ? WHERE state IN ('queued','deferred','ready')", this.now());
      this.store.event("maintenance.paused", { epoch: this.state().epoch });
    });
    const st = this.state();
    this.onControl?.("paused", st.epoch);
    return st;
  }

  /** Resume re-checks the current policies and resources; nothing widens automatically. */
  resume(): ReturnType<MaintenanceService["state"]> {
    this.store.tx(() => {
      this.store.run("UPDATE meta SET maintenance_state = 'running', maintenance_epoch = maintenance_epoch + 1, maintenance_root_state = 'pending' WHERE id = 1");
      this.store.event("maintenance.resumed", { epoch: this.state().epoch });
    });
    this.policies.expireDue();
    const st = this.state();
    this.onControl?.("running", st.epoch);
    void this.kick();
    return st;
  }

  rootConfirmed(epoch: number): void {
    this.store.tx(() => this.store.run("UPDATE meta SET maintenance_root_state = 'synced' WHERE id = 1 AND maintenance_epoch = ?", epoch));
  }

  /**
   * The broker holds a newer maintenance epoch for this incarnation than os.sqlite (a host database reset, or a
   * control the host never recorded). Broker epochs only move forward, so a lower local epoch could never take effect
   * (not even a pause): the local epoch jumps above the root's and the current local state is sent again. Queued
   * effects of the old epoch expire as with any epoch change. Returns the new local epoch, or null when not behind.
   */
  adoptRootEpoch(rootEpoch: number): number | null {
    const moved = this.store.tx(() => {
      const cur = this.state();
      if (cur.epoch > rootEpoch) return null;
      this.store.run("UPDATE meta SET maintenance_epoch = ?, maintenance_root_state = 'pending' WHERE id = 1", rootEpoch + 1);
      this.store.event("maintenance.epoch_adopted", { from: cur.epoch, root: rootEpoch, to: rootEpoch + 1 });
      return rootEpoch + 1;
    });
    if (moved !== null) this.onControl?.(this.state().state, moved);
    return moved;
  }

  rootUnavailable(): void {
    this.store.tx(() => this.store.run("UPDATE meta SET maintenance_root_state = 'unavailable' WHERE id = 1 AND maintenance_root_state = 'pending'"));
  }

  setBackgroundModel(enabled: boolean): void {
    this.store.tx(() => this.store.run("UPDATE meta SET background_model_enabled = ? WHERE id = 1", enabled ? 1 : 0));
  }

  // ------------------------------------------------------------------ triggers (spec §11)

  getJob(id: string): JobRow | undefined {
    return this.store.get<JobRow>("SELECT * FROM maintenance_jobs WHERE id = ?", id);
  }

  requireJob(id: string): JobRow {
    const j = this.getJob(id);
    if (!j) throw new AgentOsError("NOT_FOUND", "job not found");
    return j;
  }

  openJobs(): number {
    return this.store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM maintenance_jobs WHERE state NOT IN (${JOB_TERMINAL.map(() => "?").join(",")})`, ...JOB_TERMINAL)!.n;
  }

  /** Inside a tx: trigger receipt + job in one write; the same trigger key never makes a second job. */
  #createJobInTx(t: {
    triggerKey: string; triggerKind: "manual" | "interval" | "event"; policy: PolicyRow | null; templateId: MaintenanceTemplateId; targetKind: string; targetId: string;
    mode: JobRow["mode"]; incidentId?: string | null; occurrenceSeq?: number | null; skipped?: number; evidence?: Record<string, unknown>;
  }): { jobId: string; created: boolean } {
    const prior = this.store.get<{ job_id: string }>("SELECT job_id FROM trigger_receipts WHERE trigger_key = ?", t.triggerKey);
    if (prior) return { jobId: prior.job_id, created: false };
    const tpl = MAINTENANCE_TEMPLATES[t.templateId];
    const id = randomUUID();
    const now = this.nowMs();
    const st = this.state();
    this.store.run(
      `INSERT INTO maintenance_jobs (id, trigger_key, policy_id, policy_version, maintenance_epoch, scheduler_epoch, template_id, template_version, target_kind, target_id,
         incident_id, mode, state, deadline_at, evidence_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
      id, t.triggerKey, t.policy?.id ?? null, t.policy?.version ?? null, st.epoch, st.schedulerEpoch, tpl.id, tpl.version, t.targetKind, t.targetId,
      t.incidentId ?? null, t.mode, iso(now + 86_400_000), t.evidence ? JSON.stringify(t.evidence) : null, iso(now), iso(now),
    );
    this.store.run(
      "INSERT INTO trigger_receipts (trigger_key, policy_id, policy_version, trigger_kind, occurrence_seq, incident_id, job_id, skipped_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      t.triggerKey, t.policy?.id ?? null, t.policy?.version ?? null, t.triggerKind, t.occurrenceSeq ?? null, t.incidentId ?? null, id, t.skipped ?? 0, iso(now),
    );
    this.store.event("maintenance.job_created", { jobId: id, triggerKey: t.triggerKey, templateId: tpl.id, target: `${t.targetKind}:${t.targetId}` }, t.targetKind === "app" ? { appId: t.targetId } : {});
    return { jobId: id, created: true };
  }

  /**
   * User "check now" (spec §11.1): a one-off job for a template and target; it implies no standing authorization. With an
   * enabled policy of that template and target the policy's mode applies; without one the job only observes and suggests.
   */
  manualCheck(templateId: MaintenanceTemplateId, target: { kind: string; id: string }, key: string): { jobId: string; created: boolean } {
    const tpl = MAINTENANCE_TEMPLATES[templateId];
    if (!tpl) throw new AgentOsError("INVALID_REQUEST", "unknown template");
    if (target.kind !== tpl.targetKind) throw new AgentOsError("INVALID_REQUEST", `template ${templateId} needs a ${tpl.targetKind} target`);
    const r = this.store.tx(() => {
      if (this.openJobs() >= V4_LIMITS.maxPendingJobs) throw new AgentOsError("RESOURCE_BUSY", `at most ${V4_LIMITS.maxPendingJobs} maintenance jobs can be pending`);
      const policy = this.store.get<PolicyRow>("SELECT * FROM maintenance_policies WHERE template_id = ? AND target_kind = ? AND target_id = ? AND state = 'enabled' ORDER BY version DESC LIMIT 1", templateId, target.kind, target.id) ?? null;
      return this.#createJobInTx({
        triggerKey: `${this.state().schedulerEpoch}/manual/${sha256Hex(canonicalJson({ templateId, target, key })).slice(0, 32)}`,
        triggerKind: "manual", policy, templateId, targetKind: target.kind, targetId: target.id, mode: policy ? policy.mode : "manual_check",
      });
    });
    void this.kick();
    return r;
  }

  /**
   * Interval schedules (spec §11.1–§11.3): UTC anchor + interval + increasing occurrenceSeq; due item, receipt, job and
   * cursor in one transaction. Misses while offline coalesce into one new check (coalesce-latest) with the skip count;
   * a rollback never repeats an occurrence; a forward jump never fires the missed ones at once.
   */
  tickSchedules(): number {
    if (this.quiescing) return 0;
    let made = 0;
    const st = this.state();
    for (const p of this.policies.enabled()) {
      const trig = JSON.parse(p.trigger_json) as { kind: string; intervalSeconds?: number };
      if (trig.kind !== "interval" || !trig.intervalSeconds) continue;
      const iv = trig.intervalSeconds * 1000;
      made += this.store.tx(() => {
        const nowMs = this.nowMs();
        let cur = this.store.get<{ occurrence_seq: number; next_due_at: string; anchor_utc: string; missed_count: number; last_seen_utc: string | null }>(
          "SELECT * FROM schedule_cursors WHERE policy_id = ? AND policy_version = ? AND schedule_epoch = ?", p.id, p.version, st.schedulerEpoch,
        );
        if (!cur) {
          const anchor = Date.parse(p.approved_at ?? p.created_at);
          this.store.run(
            "INSERT INTO schedule_cursors (policy_id, policy_version, schedule_epoch, anchor_utc, interval_seconds, occurrence_seq, next_due_at, last_seen_utc, missed_count, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0, ?)",
            p.id, p.version, st.schedulerEpoch, iso(anchor), trig.intervalSeconds, iso(anchor + iv), iso(nowMs), iso(nowMs),
          );
          cur = { occurrence_seq: 0, next_due_at: iso(anchor + iv), anchor_utc: iso(anchor), missed_count: 0, last_seen_utc: iso(nowMs) };
        }
        const due = Date.parse(cur.next_due_at);
        if (nowMs < due) {
          this.store.run("UPDATE schedule_cursors SET last_seen_utc = ?, updated_at = ? WHERE policy_id = ? AND policy_version = ? AND schedule_epoch = ?", iso(nowMs), iso(nowMs), p.id, p.version, st.schedulerEpoch);
          return 0;
        }
        const anchor = Date.parse(cur.anchor_utc);
        // occurrences elapsed since the anchor; only the latest fires, the rest are counted as skipped
        const latestSeq = Math.max(cur.occurrence_seq + 1, Math.floor((nowMs - anchor) / iv));
        const skipped = latestSeq - cur.occurrence_seq - 1;
        if (this.openJobs() >= V4_LIMITS.maxPendingJobs) {
          this.store.run("UPDATE schedule_cursors SET missed_count = missed_count + 1, last_seen_utc = ?, updated_at = ? WHERE policy_id = ? AND policy_version = ? AND schedule_epoch = ?", iso(nowMs), iso(nowMs), p.id, p.version, st.schedulerEpoch);
          return 0;
        }
        const open = this.store.get("SELECT 1 FROM maintenance_jobs WHERE policy_id = ? AND state NOT IN ('succeeded','no_change','failed_no_effect','cancelled','expired','indeterminate','needs_attention')", p.id);
        if (open) {
          // one job per policy at a time: the occurrence is coalesced into the open job (no stacking)
          this.store.run("UPDATE schedule_cursors SET occurrence_seq = ?, next_due_at = ?, missed_count = missed_count + ?, last_seen_utc = ?, updated_at = ? WHERE policy_id = ? AND policy_version = ? AND schedule_epoch = ?",
            latestSeq, iso(anchor + (latestSeq + 1) * iv), skipped + 1, iso(nowMs), iso(nowMs), p.id, p.version, st.schedulerEpoch);
          return 0;
        }
        const key = `${st.schedulerEpoch}/${p.id}/${p.version}/interval/${latestSeq}`;
        fault("maintenance.trigger.before_commit");
        this.#createJobInTx({ triggerKey: key, triggerKind: "interval", policy: p, templateId: p.template_id, targetKind: p.target_kind, targetId: p.target_id, mode: p.mode, occurrenceSeq: latestSeq, skipped, evidence: skipped > 0 ? { coalescedMissed: skipped } : undefined });
        this.store.run(
          "UPDATE schedule_cursors SET occurrence_seq = ?, next_due_at = ?, missed_count = missed_count + ?, last_seen_utc = ?, updated_at = ? WHERE policy_id = ? AND policy_version = ? AND schedule_epoch = ?",
          latestSeq, iso(anchor + (latestSeq + 1) * iv), skipped, iso(nowMs), iso(nowMs), p.id, p.version, st.schedulerEpoch,
        );
        return 1;
      });
    }
    return made;
  }

  /**
   * An observation hint about an incident (spec §11.2): coalesced by incident episode; a job is created only when no job
   * of that incident is open, so an unresolved incident collects evidence instead of creating endless recovery jobs.
   */
  eventTrigger(incident: IncidentRow, templateId: MaintenanceTemplateId): { jobId: string; created: boolean } | null {
    if (this.quiescing) return null;
    return this.store.tx(() => {
      const policy = this.store.get<PolicyRow>("SELECT * FROM maintenance_policies WHERE template_id = ? AND target_kind = ? AND target_id = ? AND state = 'enabled' ORDER BY version DESC LIMIT 1", templateId, incident.target_kind, incident.target_id);
      if (!policy) return null;
      const trig = JSON.parse(policy.trigger_json) as { kind: string };
      if (trig.kind === "manual") return null;
      const open = this.store.get<{ id: string }>("SELECT id FROM maintenance_jobs WHERE incident_id = ? AND state NOT IN ('succeeded','no_change','failed_no_effect','cancelled','expired','indeterminate','needs_attention')", incident.id);
      if (open) return { jobId: open.id, created: false };
      if (this.openJobs() >= V4_LIMITS.maxPendingJobs) return null;
      const n = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM maintenance_jobs WHERE incident_id = ?", incident.id)!.n;
      return this.#createJobInTx({
        triggerKey: `${this.state().schedulerEpoch}/event/${incident.id}/${incident.episode_id}/${n + 1}`,
        triggerKind: "event", policy, templateId, targetKind: incident.target_kind, targetId: incident.target_id, mode: policy.mode, incidentId: incident.id,
      });
    });
  }

  // ------------------------------------------------------------------ user decisions

  /** Cancel (spec §14.3): before an effect step was dispatched → no effect; after → stop later steps and reconcile. */
  cancel(id: string): JobRow {
    this.store.tx(() => {
      const j = this.requireJob(id);
      if (JOB_TERMINAL.includes(j.state)) return;
      const dispatched = this.store.get("SELECT 1 FROM maintenance_steps WHERE job_id = ? AND state IN ('admitted','dispatched','succeeded','unknown')", id);
      if (!dispatched && !ACTIVE_EXEC.includes(j.state) && j.state !== "diagnosing") {
        this.#finish(j, "cancelled", "cancelled before any effect", "none");
      } else {
        this.store.run("UPDATE maintenance_jobs SET cancel_requested = 1, stop_reason = 'user', updated_at = ? WHERE id = ?", this.now(), id);
      }
      this.store.event("maintenance.job_cancel", { jobId: id }, {});
    });
    void this.kick();
    return this.requireJob(id);
  }

  /** Suggest mode: the user approves the concrete suggestion of an awaiting job; it then runs like an automatic one. */
  approveJob(id: string): JobRow {
    this.store.tx(() => {
      const j = this.requireJob(id);
      if (j.state !== "awaiting_approval") throw new AgentOsError("INVALID_REQUEST", `job is ${j.state}`);
      this.store.run("UPDATE maintenance_jobs SET state = 'ready', mode = 'automatic', wait_reason = NULL, deadline_at = ?, updated_at = ? WHERE id = ?", iso(this.nowMs() + V4_LIMITS.maintenanceExecMs), this.now(), id);
      this.store.event("maintenance.job_approved", { jobId: id }, {});
    });
    void this.kick();
    return this.requireJob(id);
  }

  // ------------------------------------------------------------------ execution

  start(pollMs = 1000): void {
    this.#stopped = false;
    this.#timer = setInterval(() => void this.kick(), pollMs);
    this.#timer.unref?.();
    void this.kick();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Waits for the current pass and in-flight job steps (shutdown drain, spec §23.2). */
  async drain(timeoutMs = 15_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while ((this.#busy || this.#inflight.size > 0) && Date.now() < until) {
      await Promise.race([Promise.allSettled([...this.#inflight]), new Promise((r) => setTimeout(r, 50))]);
    }
    return !this.#busy && this.#inflight.size === 0;
  }

  get running(): boolean {
    return !this.#stopped;
  }

  async kick(): Promise<void> {
    if (this.#stopped) return;
    if (this.#busy) {
      this.#again = true;
      return;
    }
    this.#busy = true;
    try {
      do {
        this.#again = false;
        await this.pass();
      } while (this.#again && !this.#stopped);
    } catch (e) {
      this.log("error", "maintenance pass failed", { error: (e as Error).message });
    } finally {
      this.#busy = false;
    }
  }

  /** One pass: clock, expiry, schedules, then every open job one step forward. */
  async pass(force = false): Promise<void> {
    this.clock.sample();
    this.policies.expireDue();
    this.tickSchedules();
    const jobs = this.store.all<JobRow>(`SELECT * FROM maintenance_jobs WHERE state NOT IN (${JOB_TERMINAL.map(() => "?").join(",")}) ORDER BY created_at ASC`, ...JOB_TERMINAL);
    for (const j of jobs) {
      if (this.#stopped && !force) return;
      const p = this.#advance(j.id);
      this.#inflight.add(p);
      try {
        await p;
      } catch (e) {
        this.log("error", "maintenance job step failed (job kept, retried later)", { jobId: j.id, error: (e as Error).message });
      } finally {
        this.#inflight.delete(p);
      }
    }
  }

  #setState(id: string, state: JobState, patch: Partial<Pick<JobRow, "wait_reason" | "outcome_reason" | "deadline_at" | "incident_id" | "target_version" | "run_id">> = {}): void {
    this.store.tx(() => {
      const cols = ["state = ?", "updated_at = ?"];
      const args: unknown[] = [state, this.now()];
      for (const [k, v] of Object.entries(patch)) {
        cols.push(`${k} = ?`);
        args.push(v);
      }
      this.store.run(`UPDATE maintenance_jobs SET ${cols.join(", ")} WHERE id = ? AND state NOT IN (${JOB_TERMINAL.map(() => "?").join(",")})`, ...args, id, ...JOB_TERMINAL);
    });
  }

  /** Completed effects: succeeded effect steps, where a cleanup step counts each object it really removed (spec §14.2). */
  #completed(jobId: string): number {
    const steps = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM maintenance_steps WHERE job_id = ? AND state = 'succeeded' AND kind NOT IN ('gc.delete_unreferenced','logs.delete_closed')", jobId)!.n;
    const objects = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM gc_delete_intents WHERE job_id = ? AND phase = 'recorded'", jobId)!.n;
    return steps + objects;
  }

  /** Inside a tx: settle a job. */
  #finish(j: JobRow, state: JobState, reason: string, certainty?: EffectCertainty): void {
    const completed = this.#completed(j.id);
    const unknown = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM maintenance_steps WHERE job_id = ? AND state = 'unknown'", j.id)!.n;
    let final = state;
    // cancelled / expired only for jobs without unsettled effects (spec §14.2)
    if ((state === "cancelled" || state === "expired") && unknown > 0) final = "indeterminate";
    const cert: EffectCertainty = certainty ?? (unknown > 0 ? "unknown" : completed > 0 ? (state === "succeeded" ? "confirmed" : "partial") : "none");
    this.store.run(
      "UPDATE maintenance_jobs SET state = ?, outcome_reason = ?, completed_steps = ?, effect_certainty = ?, ended_at = ?, updated_at = ? WHERE id = ? AND state NOT IN ('succeeded','no_change','failed_no_effect','cancelled','expired','indeterminate','needs_attention')",
      final, reason, completed, cert, this.now(), this.now(), j.id,
    );
    this.store.event(`maintenance.job_${final}`, { jobId: j.id, reason, completedSteps: completed, effectCertainty: cert }, j.target_kind === "app" ? { appId: j.target_id } : {});
  }

  finish(id: string, state: JobState, reason: string, certainty?: EffectCertainty): void {
    this.store.tx(() => this.#finish(this.requireJob(id), state, reason, certainty));
  }

  #context(j: JobRow): JobContext {
    const policy = j.policy_id ? (this.policies.get(j.policy_id, j.policy_version ?? undefined) ?? null) : null;
    const tpl = MAINTENANCE_TEMPLATES[j.template_id];
    const bounds = policy ? (JSON.parse(policy.bounds_json) as Record<string, number>) : { ...tpl.defaults };
    const self = this;
    const ctx: JobContext = {
      job: j,
      policy,
      bounds,
      deadlineMs: Date.parse(j.deadline_at),
      incident: j.incident_id ? (this.incidents.get(j.incident_id) ?? null) : null,
      cancelled: () => self.getJob(j.id)?.cancel_requested === 1,
      evidence(e) {
        self.store.tx(() => {
          const cur = self.getJob(j.id)?.evidence_json;
          const list = cur ? ([] as unknown[]).concat(JSON.parse(cur)) : [];
          list.push({ at: self.now(), ...e });
          self.store.run("UPDATE maintenance_jobs SET evidence_json = ?, updated_at = ? WHERE id = ?", JSON.stringify(list.slice(-30)), self.now(), j.id);
        });
      },
      async step(stepId, kind, executor, input, exec, reconcile) {
        const inputJson = canonicalJson(input);
        const inputHash = sha256Hex(inputJson);
        const prior = self.store.get<StepRow>("SELECT * FROM maintenance_steps WHERE job_id = ? AND step_id = ?", j.id, stepId);
        if (prior) {
          if (prior.input_hash !== inputHash) throw new AgentOsError("REQUEST_CONFLICT", `step ${stepId} was planned with another input`);
          if (["succeeded", "no_change", "failed_no_effect"].includes(prior.state)) return { state: prior.state as StepOutcome["state"], result: prior.result_json ? JSON.parse(prior.result_json) : undefined };
          if (prior.state === "unknown" && !reconcile) return { state: "unknown", result: prior.result_json ? JSON.parse(prior.result_json) : undefined };
          if ((prior.state === "dispatched" || prior.state === "admitted" || prior.state === "unknown") && reconcile) {
            const out = await reconcile(prior);
            self.#settleStep(j.id, stepId, out);
            return out;
          }
          if (prior.state === "dispatched" || prior.state === "admitted") {
            // the effect may have happened: never re-execute blindly
            self.#settleStep(j.id, stepId, { state: "unknown", result: { reason: "interrupted after dispatch; no reconciler" } });
            return { state: "unknown" };
          }
        }
        if (ctx.cancelled()) return { state: "failed_no_effect", result: { reason: "cancelled before dispatch" } };
        const st = self.state();
        if (st.state !== "running" && j.mode !== "observe") return { state: "failed_no_effect", result: { reason: "maintenance paused before dispatch" } };
        if (self.clock.state === "clock_uncertain") return { state: "failed_no_effect", result: { reason: "clock uncertain before dispatch" } };
        if (self.quiescing) return { state: "failed_no_effect", result: { reason: "host quiescing" } };
        const seq = (self.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM maintenance_steps WHERE job_id = ?", j.id)!.n) + 1;
        const effectKey = `${j.id}/${stepId}`;
        self.store.tx(() => {
          if (!prior) {
            self.store.run(
              `INSERT INTO maintenance_steps (job_id, step_id, seq, kind, input_hash, input_json, policy_version, executor, effect_key, state, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', ?, ?)`,
              j.id, stepId, seq, kind, inputHash, inputJson, j.policy_version, executor, effectKey, self.now(), self.now(),
            );
          } else {
            self.store.run("UPDATE maintenance_steps SET state = 'admitted', effect_key = COALESCE(effect_key, ?), updated_at = ? WHERE job_id = ? AND step_id = ?", effectKey, self.now(), j.id, stepId);
          }
          self.store.run("UPDATE maintenance_jobs SET step_cursor = ?, updated_at = ? WHERE id = ?", seq, self.now(), j.id);
        });
        fault("maintenance.step.before_dispatch");
        self.store.tx(() => self.store.run("UPDATE maintenance_steps SET state = 'dispatched', updated_at = ? WHERE job_id = ? AND step_id = ?", self.now(), j.id, stepId));
        let out: StepOutcome;
        try {
          out = await exec(effectKey);
        } catch (e) {
          out = { state: "unknown", result: { error: (e as Error).message.slice(0, 300) } };
        }
        fault("maintenance.step.after_effect");
        self.#settleStep(j.id, stepId, out);
        return out;
      },
    };
    return ctx;
  }

  #settleStep(jobId: string, stepId: string, out: StepOutcome): void {
    this.store.tx(() => {
      this.store.run("UPDATE maintenance_steps SET state = ?, result_json = ?, updated_at = ? WHERE job_id = ? AND step_id = ?", out.state, out.result ? JSON.stringify(out.result) : null, this.now(), jobId, stepId);
      const completed = this.#completed(jobId);
      this.store.run("UPDATE maintenance_jobs SET completed_steps = ?, updated_at = ? WHERE id = ?", completed, this.now(), jobId);
    });
  }

  /** Is the job's policy still the enabled version it was created for? (V4-J06) */
  #policyCurrent(j: JobRow): { ok: boolean; reason?: string } {
    if (!j.policy_id) return { ok: true };
    const live = this.policies.live(j.policy_id);
    if (!live) {
      const p = this.policies.get(j.policy_id, j.policy_version ?? undefined);
      return { ok: false, reason: `policy is ${p?.state ?? "gone"}` };
    }
    if (live.version !== j.policy_version) return { ok: false, reason: `policy version changed (${j.policy_version} → ${live.version})` };
    return { ok: true };
  }

  async #advance(id: string): Promise<void> {
    const j = this.getJob(id);
    if (!j || JOB_TERMINAL.includes(j.state)) return;
    const h = this.handlers.get(j.template_id);
    if (!h) {
      if (j.state !== "deferred" || j.wait_reason !== "template not available on this host") this.#setState(id, "deferred", { wait_reason: "template not available on this host" });
      return;
    }
    const st = this.state();
    const effectMode = j.mode === "automatic";
    if (j.cancel_requested === 1 && !ACTIVE_EXEC.includes(j.state) && j.state !== "diagnosing") {
      this.finish(id, "cancelled", "cancelled by the user");
      return;
    }
    if (st.epoch !== j.maintenance_epoch && j.state !== "verifying" && j.state !== "reconciling" && j.state !== "running" && j.state !== "awaiting_approval") {
      // an epoch change (pause/resume/restore) invalidates queued effects; observation-only jobs may re-run cheaply
      if (effectMode || j.state === "ready") {
        this.finish(id, "expired", "maintenance epoch changed (paused, resumed or restored) before this job took effect", "none");
        return;
      }
    }
    switch (j.state) {
      case "queued":
      case "deferred": {
        if (this.quiescing) return;
        const pc = this.#policyCurrent(j);
        if (!pc.ok) {
          this.finish(id, "expired", `POLICY_VERSION_STALE: ${pc.reason}`, "none");
          return;
        }
        if (Date.parse(j.deadline_at) <= this.nowMs()) {
          this.finish(id, "expired", "the job waited past its deadline", "none");
          return;
        }
        if (st.state === "paused" && j.mode !== "observe" && j.mode !== "manual_check") {
          if (j.state !== "deferred" || j.wait_reason !== "maintenance paused") this.#setState(id, "deferred", { wait_reason: "maintenance paused" });
          return;
        }
        this.#setState(id, "observing", { wait_reason: null });
        return this.#advance(id);
      }
      case "observing": {
        const ctx = this.#context(j);
        const stale = this.nowMs() - Date.parse(j.created_at) > V4_LIMITS.misfireStaleMs;
        const obs = await h.observe(ctx);
        if (stale) ctx.evidence({ note: "trigger older than 10 min: re-read the current state, old effect not replayed" });
        if (obs.evidence) ctx.evidence({ observe: obs.evidence });
        if (obs.incidentId) this.store.tx(() => this.store.run("UPDATE maintenance_jobs SET incident_id = ? WHERE id = ?", obs.incidentId, id));
        if (!obs.needed) {
          if (obs.incidentId) this.incidents.setState(obs.incidentId, "investigating");
          this.finish(id, "no_change", obs.reason, "none");
          return;
        }
        const tpl = MAINTENANCE_TEMPLATES[j.template_id];
        if (tpl.usesModel && h.analyze) {
          if (!st.backgroundModel) {
            this.finish(id, "no_change", "background model analysis is switched off (enable it in maintenance settings)", "none");
            return;
          }
          const r = await h.analyze(ctx);
          if (!r) {
            this.#setState(id, "deferred", { wait_reason: "no background model budget or slot now" });
            return;
          }
          this.#setState(id, "diagnosing", { run_id: r.runId, wait_reason: "background analysis running" });
          return;
        }
        if (j.mode === "observe" || (j.mode === "manual_check" && tpl.automaticActions.length === 0)) {
          if (obs.incidentId) this.incidents.setState(obs.incidentId, "open");
          this.finish(id, "succeeded", `observed: ${obs.reason} (observe only, no action)`, "none");
          return;
        }
        if (j.mode === "suggest" || j.mode === "manual_check") {
          this.#setState(id, "awaiting_approval", { wait_reason: obs.reason, outcome_reason: JSON.stringify(obs.suggestion ?? { action: tpl.actions[0], reason: obs.reason }) });
          if (obs.incidentId) this.incidents.setState(obs.incidentId, "investigating", { jobId: id });
          return;
        }
        // automatic: only the platform's automatic whitelist (anything else becomes a suggestion)
        if (tpl.automaticActions.length === 0) {
          this.#setState(id, "awaiting_approval", { wait_reason: "not in the automatic whitelist" });
          return;
        }
        if (this.clock.state === "clock_uncertain") {
          this.#setState(id, "deferred", { wait_reason: "CLOCK_UNCERTAIN: automatic effects stop until the clock is rechecked" });
          return;
        }
        this.#setState(id, "ready", { deadline_at: iso(this.nowMs() + (j.template_id === "app-optimize" ? V4_LIMITS.refactorExecMs : V4_LIMITS.maintenanceExecMs)), target_version: obs.targetVersion ?? null });
        if (obs.incidentId) this.incidents.setState(obs.incidentId, "mitigating", { jobId: id });
        return this.#advance(id);
      }
      case "awaiting_approval":
        return; // the user decides; no execution slot is taken
      case "diagnosing":
        return; // the background run reports through finishAnalysis()
      case "ready": {
        if (this.quiescing) return;
        const busy = this.store.get<{ id: string }>(`SELECT id FROM maintenance_jobs WHERE state IN ('running','verifying','reconciling') AND id <> ? LIMIT 1`, id);
        if (busy) {
          this.store.tx(() => this.store.run("UPDATE maintenance_jobs SET wait_reason = ?, updated_at = ? WHERE id = ? AND COALESCE(wait_reason,'') <> ?", "waiting for the maintenance execution slot", this.now(), id, "waiting for the maintenance execution slot"));
          return;
        }
        const pc = this.#policyCurrent(j);
        if (!pc.ok) {
          this.finish(id, "expired", `POLICY_VERSION_STALE: ${pc.reason}`, "none");
          return;
        }
        if (st.state === "paused") {
          this.#setState(id, "deferred", { wait_reason: "maintenance paused" });
          return;
        }
        if (this.clock.state === "clock_uncertain") {
          this.#setState(id, "deferred", { wait_reason: "CLOCK_UNCERTAIN: automatic effects stop until the clock is rechecked" });
          return;
        }
        const ctx = this.#context(j);
        const adm = h.admission?.(ctx) ?? { ok: true };
        if (!adm.ok) {
          if (adm.circuitOpen) {
            if (j.incident_id) this.incidents.setState(j.incident_id, "needs_attention", { circuit: "open" });
            this.finish(id, "needs_attention", `CIRCUIT_OPEN: ${adm.reason ?? "too many failed attempts"}`, "none");
          } else if (adm.defer) {
            this.#setState(id, "deferred", { wait_reason: adm.reason ?? "deferred" });
          } else {
            this.finish(id, "failed_no_effect", adm.reason ?? "refused", "none");
          }
          return;
        }
        this.#setState(id, "running", { wait_reason: null });
        return this.#advance(id);
      }
      case "running": {
        const ctx = this.#context(j);
        const r = await h.act(ctx);
        const fresh = this.requireJob(id);
        if (fresh.cancel_requested === 1) {
          this.finish(id, "cancelled", `cancelled after ${r.completed} completed step(s): ${r.reason}`, r.certainty);
          return;
        }
        if (r.certainty === "unknown") {
          if (j.incident_id) this.incidents.setState(j.incident_id, "needs_attention");
          this.finish(id, "indeterminate", r.reason, "unknown");
          return;
        }
        if (!h.verify) {
          this.finish(id, r.completed > 0 ? "succeeded" : "no_change", r.reason, r.certainty);
          return;
        }
        this.#setState(id, "verifying", { outcome_reason: r.reason });
        return this.#advance(id);
      }
      case "verifying":
      case "reconciling": {
        const ctx = this.#context(j);
        const v = await h.verify!(ctx);
        if (v.pending) return;
        if (v.healthy === true) {
          if (j.incident_id) this.incidents.resolve(j.incident_id, { jobId: id, reason: v.reason }, this.nowMs());
          this.finish(id, "succeeded", v.reason);
        } else if (v.healthy === false) {
          if (j.incident_id) this.incidents.setState(j.incident_id, "open");
          this.finish(id, "failed_no_effect", v.reason, this.requireJob(id).completed_steps > 0 ? "partial" : "none");
        } else {
          if (j.incident_id) this.incidents.setState(j.incident_id, "needs_attention");
          this.finish(id, "indeterminate", v.reason, "unknown");
        }
        return;
      }
    }
  }

  /** A background analysis run finished (report or proposal facts); the job settles from those facts only. */
  finishAnalysis(runId: string, outcome: { reportId: string | null; proposalId: string | null; status: string }): void {
    const j = this.store.get<JobRow>("SELECT * FROM maintenance_jobs WHERE run_id = ? AND state = 'diagnosing'", runId);
    if (!j) return;
    if (outcome.proposalId) {
      this.#setState(j.id, "awaiting_approval", { wait_reason: "a validated candidate waits for your decision", outcome_reason: JSON.stringify({ proposalId: outcome.proposalId }) });
    } else if (outcome.reportId) {
      this.finish(j.id, "succeeded", `diagnosis report ${outcome.reportId} saved (a hypothesis, not a repair)`, "none");
    } else {
      this.finish(j.id, "failed_no_effect", `analysis ended ${outcome.status} without a report or proposal`, "none");
    }
  }

  view(j: JobRow) {
    const steps = this.store.all<StepRow>("SELECT * FROM maintenance_steps WHERE job_id = ? ORDER BY seq", j.id);
    return {
      jobId: j.id,
      triggerKey: j.trigger_key,
      policy: j.policy_id ? { id: j.policy_id, version: j.policy_version } : null,
      templateId: j.template_id,
      target: { kind: j.target_kind, id: j.target_id, version: j.target_version },
      incidentId: j.incident_id,
      mode: j.mode,
      state: j.state,
      waitReason: j.wait_reason,
      completedSteps: j.completed_steps,
      effectCertainty: j.effect_certainty,
      outcomeReason: j.outcome_reason,
      cancelRequested: j.cancel_requested === 1,
      evidence: j.evidence_json ? JSON.parse(j.evidence_json) : [],
      runId: j.run_id,
      steps: steps.map((s) => ({ stepId: s.step_id, kind: s.kind, executor: s.executor, state: s.state, actionId: s.action_id, deleteIntentId: s.delete_intent_id, result: s.result_json ? JSON.parse(s.result_json) : null })),
      maintenanceEpoch: j.maintenance_epoch,
      createdAt: j.created_at,
      endedAt: j.ended_at,
    };
  }

  list(opts: { open?: boolean; limit?: number } = {}): JobRow[] {
    return opts.open
      ? this.store.all<JobRow>(`SELECT * FROM maintenance_jobs WHERE state NOT IN (${JOB_TERMINAL.map(() => "?").join(",")}) ORDER BY created_at DESC`, ...JOB_TERMINAL)
      : this.store.all<JobRow>(`SELECT * FROM maintenance_jobs ORDER BY created_at DESC LIMIT ${Math.min(opts.limit ?? 100, 500)}`);
  }

  /** Restore (spec §23.4): new scheduler/maintenance epochs; old schedules, triggers and outbox never run again. */
  invalidateForRestoreInTx(): void {
    this.store.run("UPDATE meta SET scheduler_epoch = scheduler_epoch + 1, maintenance_epoch = maintenance_epoch + 1, maintenance_root_state = 'pending' WHERE id = 1");
    this.policies.invalidateAllInTx();
    const open = this.store.all<JobRow>(`SELECT * FROM maintenance_jobs WHERE state NOT IN (${JOB_TERMINAL.map(() => "?").join(",")})`, ...JOB_TERMINAL);
    for (const j of open) this.#finish(j, "expired", "workspace restored from a backup: old maintenance work never resumes", undefined);
    this.store.run("UPDATE maintenance_effect_outbox SET dispatch_state = 'fenced', updated_at = ? WHERE dispatch_state IN ('pending','sent')", this.now());
    this.store.run("UPDATE root_sync_outbox SET dispatch_state = 'failed', broker_result = 'fenced by restore', updated_at = ? WHERE dispatch_state IN ('pending','sent')", this.now());
  }

  metrics(): Record<string, unknown> {
    const byState = this.store.all("SELECT state, COUNT(*) AS n FROM maintenance_jobs GROUP BY state");
    const circuits = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM maintenance_circuits WHERE state = 'open'")!.n;
    const recoveries = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM maintenance_attempts WHERE admitted_at > ?", iso(this.nowMs() - 86_400_000))!.n;
    const unknownEffects = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM maintenance_steps WHERE state IN ('unknown','dispatched')")!.n;
    const gaps = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM health_samples WHERE quality IN ('gap','unavailable') AND observed_at > ?", iso(this.nowMs() - 86_400_000))!.n;
    return { byState, openCircuits: circuits, attempts24h: recoveries, unknownEffects, observationGaps24h: gaps, ...this.state(), clock: this.clock.state };
  }
}
