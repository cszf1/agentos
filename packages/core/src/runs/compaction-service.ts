import { randomUUID } from "node:crypto";
import { AgentOsError, V4_LIMITS, canonicalJson, sha256Hex, COMPACTION_BUDGET } from "@agentos/contracts";
import { iso, type Store } from "../persistence/store.js";
import { backgroundRunBusy, foregroundBusy } from "../model-budgets/budgets.js";
import type { AgentEngine } from "./engine.js";
import { fault } from "../faults.js";

export interface CompactionJobRow {
  id: string;
  conversation_id: string;
  run_id: string | null;
  cutoff_entry_id: string;
  context_version: string | null;
  input_scope: string;
  compaction_key: string;
  pi_task_id: string | null;
  budget_route_epoch: number | null;
  state: "queued" | "creating" | "running" | "placed" | "summary_unplaced" | "stale" | "failed" | "cancelled";
  result_json: string | null;
  requested_by: string;
  created_at: string;
  updated_at: string;
}

const OPEN = ["queued", "creating", "running"];

/**
 * Asynchronous, approved session compaction (spec §20). One job binds one ended, idle conversation and a cutoff; the
 * conversation's model route is re-pointed at the job (purpose=compaction, its own budget route epoch, background
 * budget), the Pi conversation-owned manual compaction task and its mapping document are created in one commit, the
 * route is closed again afterwards. Summaries never replace the original entries and are never a source of authority;
 * other conversations keep running. Conversations of system_plan runs (real provider content) need explicit consent.
 */
export type CompactionPlan = { conversationId: string; runId: string; cutoff: string; mode: string; allowProviderContent: boolean; instructions?: string };

export class CompactionService {
  engine: AgentEngine | null = null;
  #busy = false;
  #timer: NodeJS.Timeout | null = null;
  log: (lvl: "info" | "warn" | "error", msg: string, f?: Record<string, unknown>) => void = () => {};
  attachRoute: ((routeId: string) => void) | null = null;

  constructor(private readonly store: Store) {}

  private now(): string {
    return iso(this.store.clock.now());
  }

  get(id: string): CompactionJobRow | undefined {
    return this.store.get<CompactionJobRow>("SELECT * FROM compaction_jobs WHERE id = ?", id);
  }

  view(j: CompactionJobRow) {
    return {
      compactionId: j.id, conversationId: j.conversation_id, runId: j.run_id, cutoffEntryId: j.cutoff_entry_id, state: j.state, piTaskId: j.pi_task_id,
      scope: JSON.parse(j.input_scope), result: j.result_json ? JSON.parse(j.result_json) : null, requestedBy: j.requested_by, createdAt: j.created_at, updatedAt: j.updated_at,
      label: j.state === "placed" ? "摘要已生成并放置（原始记录保留）" : j.state === "summary_unplaced" ? (j.result_json && (JSON.parse(j.result_json) as { generated?: boolean }).generated === false ? "无需压缩：没有超出保留窗口的内容，未生成摘要" : "摘要已生成但未放置") : j.state === "stale" ? "摘要已过时（未覆盖更新的摘要）" : j.state,
    };
  }

  list(conversationId?: string): CompactionJobRow[] {
    return conversationId
      ? this.store.all<CompactionJobRow>("SELECT * FROM compaction_jobs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 50", conversationId)
      : this.store.all<CompactionJobRow>("SELECT * FROM compaction_jobs ORDER BY created_at DESC LIMIT 100");
  }

  /** User request: scope check, idempotent per conversation + cutoff, bounded queue. */
  async request(conversationId: string, opts: { allowProviderContent?: boolean; instructions?: string }, requestedBy = "user"): Promise<CompactionJobRow> {
    const plan = await this.prepare(conversationId, opts);
    const row = this.store.tx(() => this.createInTx(plan, requestedBy));
    this.kick();
    return row;
  }

  /**
   * Read-only part of a request (the Pi conversation state is read asynchronously). Nothing is written here, so a
   * request the gateway later refuses (stale client epoch, receipt conflict) leaves no job behind (spec §22.1).
   */
  async prepare(conversationId: string, opts: { allowProviderContent?: boolean; instructions?: string }): Promise<CompactionPlan> {
    if (!this.engine) throw new AgentOsError("MODEL_UNAVAILABLE", "the agent subsystem is not available");
    const b = this.store.get<{ run_id: string | null; purpose: string; binding_state: string; maintenance_lock: string | null }>("SELECT run_id, purpose, binding_state, maintenance_lock FROM agent_conversations WHERE conversation_id = ?", conversationId);
    if (!b || b.purpose !== "run" || !b.run_id) throw new AgentOsError("COMPACTION_SCOPE_DENIED", "only a task conversation can be compacted (never the legacy root or another job)");
    const run = this.store.get<{ status: string; mode: string }>("SELECT status, mode FROM runs WHERE id = ?", b.run_id);
    if (!run || !["succeeded", "failed", "cancelled"].includes(run.status)) throw new AgentOsError("COMPACTION_SCOPE_DENIED", "the task of this conversation has not ended; idle compaction needs an ended task");
    if (run.mode === "system_plan" && !opts.allowProviderContent) throw new AgentOsError("COMPACTION_SCOPE_DENIED", "this conversation contains real provider content; compacting sends it to the model again and needs your explicit consent (allowProviderContent)");
    const insp = await this.engine.inspectConversation(conversationId);
    if (insp.tasks > 0 || insp.submissions > 0) throw new AgentOsError("TARGET_BUSY", "the conversation still has unfinished work");
    const cutoff = await this.engine.headEntry(conversationId);
    if (!cutoff) throw new AgentOsError("COMPACTION_SCOPE_DENIED", "the conversation has no entries");
    return { conversationId, runId: b.run_id, cutoff, mode: run.mode, allowProviderContent: !!opts.allowProviderContent, instructions: opts.instructions };
  }

  /** The durable intent, inside the caller's (gateway) transaction; facts read asynchronously are re-checked here. */
  createInTx(plan: CompactionPlan, requestedBy = "user"): CompactionJobRow {
    const { conversationId, cutoff } = plan;
    const b = this.store.get<{ run_id: string | null; purpose: string }>("SELECT run_id, purpose FROM agent_conversations WHERE conversation_id = ?", conversationId);
    if (!b || b.purpose !== "run" || b.run_id !== plan.runId) throw new AgentOsError("COMPACTION_SCOPE_DENIED", "the conversation changed while the request was checked");
    const run = this.store.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", plan.runId);
    if (!run || !["succeeded", "failed", "cancelled"].includes(run.status)) throw new AgentOsError("COMPACTION_SCOPE_DENIED", "the task of this conversation has not ended");
    const key = `cmp:${sha256Hex(canonicalJson({ conversationId, cutoff })).slice(0, 40)}`;
    const scope = { conversationId, runId: plan.runId, cutoffEntryId: cutoff, mode: plan.mode, providerContentConsent: plan.allowProviderContent, crossConversation: false };
    const prior = this.store.get<CompactionJobRow>("SELECT * FROM compaction_jobs WHERE compaction_key = ?", key);
    if (prior) return prior;
    const open = this.store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM compaction_jobs WHERE state IN (${OPEN.map(() => "?").join(",")})`, ...OPEN)!.n;
    if (open >= V4_LIMITS.compactionsWorkspace) throw new AgentOsError("RESOURCE_BUSY", "compaction queue is full");
    const id = randomUUID();
    this.store.run(
      `INSERT INTO compaction_jobs (id, conversation_id, run_id, cutoff_entry_id, context_version, input_scope, compaction_key, state, result_json, requested_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
      id, conversationId, plan.runId, cutoff, null, JSON.stringify(scope), key, JSON.stringify({ instructions: plan.instructions?.slice(0, 500) ?? null }), requestedBy, this.now(), this.now(),
    );
    this.store.event("compaction.queued", { compactionId: id, conversationId }, { runId: plan.runId });
    return this.get(id)!;
  }

  start(pollMs = 1000): void {
    this.#timer = setInterval(() => void this.tick(), pollMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  kick(): void {
    setImmediate(() => void this.tick());
  }

  async tick(): Promise<void> {
    if (this.#busy || !this.engine) return;
    this.#busy = true;
    try {
      const active = this.store.get<CompactionJobRow>("SELECT * FROM compaction_jobs WHERE state IN ('creating','running') ORDER BY created_at LIMIT 1");
      if (active) return await this.#advance(active);
      if (this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM compaction_jobs WHERE state IN ('creating','running')")!.n >= V4_LIMITS.compactionsWorkspace) return;
      // Do not start a summary while foreground work is waiting to dispatch, or while a background model run holds the
      // one shared slot (spec §7.2). An already-started job keeps advancing; its model request still yields in budgets.
      if (foregroundBusy(this.store) || backgroundRunBusy(this.store)) return;
      // a global maintenance pause stops new background model work, compaction included (spec §13.2, §9.3)
      if (this.#paused()) return;
      const next = this.store.get<CompactionJobRow>("SELECT * FROM compaction_jobs WHERE state = 'queued' ORDER BY created_at LIMIT 1");
      if (next) await this.#advance(next);
    } catch (e) {
      this.log("warn", "compaction step failed", { error: (e as Error).message });
    } finally {
      this.#busy = false;
    }
  }

  #paused(): boolean {
    return this.store.get<{ s: string }>("SELECT maintenance_state AS s FROM meta WHERE id = 1")?.s === "paused";
  }

  /**
   * Global pause (spec §13.2): open compaction jobs that have not yet had their one model request admitted are
   * stopped now (their route closes); queued ones stay queued and start only after resume. A request already admitted
   * before the pause may still finish.
   */
  async pauseOpen(): Promise<number> {
    let n = 0;
    for (const j of this.store.all<CompactionJobRow>("SELECT * FROM compaction_jobs WHERE state IN ('creating','running')")) {
      if (this.store.get("SELECT 1 FROM model_attempts WHERE compaction_job_id = ? AND state <> 'denied'", j.id)) continue;
      if (j.state === "running") await this.engine?.abortCompaction(j.compaction_key).catch(() => undefined);
      this.#end(j, "cancelled", { cancelledBy: "maintenance_paused" });
      n++;
    }
    return n;
  }

  #closeRoute(j: CompactionJobRow): void {
    this.store.run("UPDATE agent_conversations SET route_purpose = 'closed', route_subject_id = NULL, maintenance_lock = NULL, updated_at = ? WHERE conversation_id = ? AND maintenance_lock = ?", this.now(), j.conversation_id, j.id);
  }

  #end(j: CompactionJobRow, state: CompactionJobRow["state"], result: Record<string, unknown>): void {
    this.store.tx(() => {
      const prev = j.result_json ? (JSON.parse(j.result_json) as Record<string, unknown>) : {};
      this.store.run(`UPDATE compaction_jobs SET state = ?, result_json = ?, updated_at = ? WHERE id = ? AND state IN (${OPEN.map(() => "?").join(",")})`, state, JSON.stringify({ ...prev, ...result }), this.now(), j.id, ...OPEN);
      this.#closeRoute(j);
      this.store.event(`compaction.${state}`, { compactionId: j.id, conversationId: j.conversation_id }, { runId: j.run_id });
    });
  }

  async #advance(j: CompactionJobRow): Promise<void> {
    const engine = this.engine!;
    if (j.state === "queued") {
      if (this.store.clock.now() - Date.parse(j.created_at) > 3_600_000) return this.#end(j, "failed", { error: "waited too long for the compaction slot" });
      // bind the conversation's route to this job (own budget route epoch); the run's write route never comes back
      const ok = this.store.tx(() => {
        // Take the write lock, then re-read: the scheduler's admission transaction does the same for compaction rows,
        // so the two cannot both win the single background slot.
        if (this.store.run("UPDATE compaction_jobs SET updated_at = ? WHERE id = ? AND state = 'queued'", this.now(), j.id).changes !== 1) return null;
        if (foregroundBusy(this.store) || backgroundRunBusy(this.store) || this.#paused()) return null;
        const b = this.store.get<{ maintenance_lock: string | null; model_route_id: string; route_epoch: number }>("SELECT maintenance_lock, model_route_id, route_epoch FROM agent_conversations WHERE conversation_id = ?", j.conversation_id);
        if (!b || (b.maintenance_lock && b.maintenance_lock !== j.id)) return null;
        this.store.run("UPDATE agent_conversations SET maintenance_lock = ?, route_purpose = 'compaction', route_subject_id = ?, route_epoch = route_epoch + 1, updated_at = ? WHERE conversation_id = ?", j.id, j.id, this.now(), j.conversation_id);
        this.store.run("UPDATE compaction_jobs SET state = 'creating', budget_route_epoch = ?, updated_at = ? WHERE id = ?", b.route_epoch + 1, this.now(), j.id);
        return b.model_route_id;
      });
      if (!ok) return;
      this.attachRoute?.(ok);
      j = this.get(j.id)!;
    }
    if (j.state === "creating") {
      fault("compaction.before_create");
      const instructions = j.result_json ? ((JSON.parse(j.result_json) as { instructions?: string }).instructions ?? undefined) : undefined;
      const taskId = await engine.startCompaction({ compactionKey: j.compaction_key, conversationId: j.conversation_id, instructions: instructions ?? "Keep only: the current goal, verified conclusions, open items and source ids. Never restate permissions, budgets or operation states." });
      fault("compaction.after_create");
      const moved = this.store.tx(() => this.store.run("UPDATE compaction_jobs SET pi_task_id = COALESCE(pi_task_id, ?), state = 'running', updated_at = ? WHERE id = ? AND state = 'creating'", taskId, this.now(), j.id).changes);
      if (moved !== 1) {
        // cancelled (user or pause) while the Pi task was being created: abort it, never resurrect the job
        await engine.abortCompaction(j.compaction_key).catch(() => undefined);
        return;
      }
      j = this.get(j.id)!;
    }
    if (j.state === "running") {
      const st = await engine.compactionState(j.compaction_key);
      if (st.state === "running") {
        if (this.store.clock.now() - Date.parse(j.updated_at) > COMPACTION_BUDGET.deadlineMs + 30_000) {
          await engine.abortCompaction(j.compaction_key).catch(() => undefined);
          this.#end(j, "failed", { error: "compaction exceeded its 120 s execution limit" });
        }
        return;
      }
      if (st.state === "done") return this.#end(j, "placed", { entryId: st.entryId ?? null, sourceCutoff: j.cutoff_entry_id });
      // Pi completes with an empty result when nothing lies before its kept-recent window (or a hook declined): no
      // summary was produced and nothing was placed. Recorded as such, never shown as a generated summary.
      if (st.state === "done_unplaced") return this.#end(j, "summary_unplaced", { sourceCutoff: j.cutoff_entry_id, generated: false, reason: "nothing older than the kept-recent window to summarise" });
      if (st.state === "cancelled") return this.#end(j, "cancelled", {});
      if (st.state === "missing") {
        // the mapping commit did not happen: create again with the same key (read-before-create finds no duplicate)
        this.store.tx(() => this.store.run("UPDATE compaction_jobs SET state = 'creating', updated_at = ? WHERE id = ?", this.now(), j.id));
        return;
      }
      const stale = /stale|cutoff|newer/i.test(st.error ?? "");
      return this.#end(j, stale ? "stale" : "failed", { error: st.error ?? "failed" });
    }
  }

  async cancel(id: string): Promise<CompactionJobRow> {
    const { row, abort } = this.store.tx(() => this.cancelInTx(id));
    if (abort) await this.engine?.abortCompaction(row.compaction_key).catch(() => undefined);
    return this.get(id)!;
  }

  async abortTask(compactionKey: string): Promise<void> {
    await this.engine?.abortCompaction(compactionKey).catch(() => undefined);
  }

  /** User cancel inside the caller's (gateway) tx: the job ends and its route closes first; the Pi abort follows. */
  cancelInTx(id: string): { row: CompactionJobRow; abort: boolean } {
    const j = this.get(id);
    if (!j) throw new AgentOsError("NOT_FOUND", "compaction job not found");
    if (!OPEN.includes(j.state)) return { row: j, abort: false };
    const abort = j.state === "running" || j.state === "creating";
    this.#end(j, "cancelled", { cancelledBy: "user" });
    return { row: this.get(id)!, abort };
  }


  /** Startup: an unfinished job resumes on its own binding; never re-run as the old run, never a second summary. */
  async recover(): Promise<number> {
    const open = this.store.all<CompactionJobRow>("SELECT * FROM compaction_jobs WHERE state IN ('creating','running')");
    for (const j of open) {
      const b = this.store.get<{ model_route_id: string }>("SELECT model_route_id FROM agent_conversations WHERE conversation_id = ?", j.conversation_id);
      if (b) this.attachRoute?.(b.model_route_id);
    }
    return open.length;
  }

  /** Restore: compaction jobs of the old database never run again. */
  invalidateForRestoreInTx(): void {
    for (const j of this.store.all<CompactionJobRow>(`SELECT * FROM compaction_jobs WHERE state IN (${OPEN.map(() => "?").join(",")})`, ...OPEN)) {
      this.store.run("UPDATE compaction_jobs SET state = 'cancelled', result_json = ?, updated_at = ? WHERE id = ?", JSON.stringify({ reason: "workspace restored" }), this.now(), j.id);
      this.#closeRoute(j);
    }
  }
}
