import { canonicalJson, sha256Hex, TOOLSET_VERSION_V4, type AgentProfileId } from "@agentos/contracts";
import type { AgentEngine, AgentSubmissionStatus, ConversationBinding } from "./engine.js";
import type { RunRow, RunService } from "./run-service.js";
import type { RunScheduler } from "../scheduling/run-scheduler.js";
import { fault } from "../faults.js";
import { iso } from "../persistence/store.js";

export interface CoordinatorLog {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const silent: CoordinatorLog = { info() {}, warn() {}, error() {} };

/**
 * Drives every started run across the two databases (spec §6.2, §10): conversation creation from the frozen outbox,
 * route attachment, submission with requestId=runId, per-conversation cancel, blocked detection and the final
 * reconciliation by completion fact. Each run is handled on its own: one run's failure, block or slow abort never
 * holds another. All decisions are re-read from os.sqlite.
 */
export class RunCoordinator {
  #timer: NodeJS.Timeout | undefined;
  #busy = false;
  #again = false;
  #stopped = false;
  #perRun = new Map<string, Promise<void>>();
  #abortIssued = new Map<string, number>();
  #abortFailures = new Map<string, number>();
  #recoveryBlocked: string | null = null;
  /** routes attached in this process (re-attached after every restart before resume) */
  #routes = new Set<string>();
  /** woken when scheduling state changes (budgets pump, background slot) */
  onChange: (() => void) | null = null;

  constructor(
    private readonly runs: RunService,
    private readonly engine: AgentEngine | null,
    private readonly log: CoordinatorLog = silent,
    private readonly pollMs = 500,
    readonly scheduler: RunScheduler | null = null,
  ) {}

  get recoveryBlocked(): string | null {
    return this.#recoveryBlocked;
  }

  private get store() {
    return this.runs.store;
  }

  /**
   * Startup reconciliation before Pi scheduling resumes (spec §10.3, §23.1 step 4): every binding in the trusted Pi
   * directory must map to a run in os.sqlite and back; routes of every started run are re-attached; conversations with
   * live work but no business run keep the Harness paused (recovery blocked) instead of running unauthorised.
   */
  async recover(): Promise<void> {
    if (!this.engine) return;
    const dir = await this.engine.directory();
    const byKey = new Map(dir.map((d) => [d.createKey, d]));
    const rows = this.store.all<{ create_key: string; conversation_id: string | null; run_id: string | null; binding_hash: string; binding_state: string; purpose: string; model_route_id: string; profile_id: string }>(
      "SELECT create_key, conversation_id, run_id, binding_hash, binding_state, purpose, model_route_id, profile_id FROM agent_conversations WHERE purpose IN ('run','compaction')",
    );
    const known = new Set(rows.map((r) => r.create_key));
    const problems: string[] = [];
    // os.sqlite side: a 'creating' binding whose Pi commit happened gets its id back; mismatches are fatal for the run.
    for (const r of rows) {
      const d = byKey.get(r.create_key);
      if (!d) continue;
      if (d.bindingHash !== r.binding_hash) problems.push(`conversation ${d.conversationId}: binding hash differs from os.sqlite`);
      else if (r.conversation_id === null && r.run_id) {
        this.runs.bindConversation(r.run_id, d.conversationId);
        this.log.info("recovered conversation mapping", { runId: r.run_id, conversationId: d.conversationId });
      } else if (r.conversation_id !== null && r.conversation_id !== d.conversationId) problems.push(`createKey ${r.create_key}: two conversations`);
    }
    // Pi side: a directory entry without a host binding is an orphan; if it has live work we must not resume.
    const insp = await this.engine.inspect();
    for (const d of dir) {
      if (known.has(d.createKey)) continue;
      const live = insp.byConversation[d.conversationId] ?? 0;
      if (live > 0) problems.push(`conversation ${d.conversationId} has ${live} live task(s) but no run in os.sqlite`);
      else this.log.warn("orphan conversation without live work (kept, never scheduled)", { conversationId: d.conversationId });
    }
    // Live work on conversations that are neither in the directory nor the root: refuse to resume.
    const dirIds = new Set(dir.map((d) => d.conversationId));
    for (const [conv, n] of Object.entries(insp.byConversation)) {
      if (n > 0 && !dirIds.has(conv) && conv !== "root") problems.push(`conversation ${conv} has ${n} live task(s) outside the trusted directory`);
    }
    if ((insp.byConversation.root ?? 0) > 0) problems.push(`the legacy root conversation has ${insp.byConversation.root} unfinished task(s)`);
    if (problems.length > 0) {
      this.#recoveryBlocked = problems.slice(0, 5).join("; ");
      this.log.error("recovery blocked", { reason: this.#recoveryBlocked });
      return;
    }
    // Re-attach every route of a started run before resume (no request may arrive without its route).
    for (const run of this.runs.started()) {
      if (run.conversation_id) await this.#attach(run);
      if (run.applied_revision_id === null && run.deadline_at !== null && Date.parse(run.deadline_at) <= this.runs.nowMs() && run.status !== "cancel_requested") {
        this.runs.requestStop(run.id, "deadline");
      }
    }
    this.log.info("agent recovery done", { started: this.runs.started().length, conversations: dir.length });
  }

  async #attach(run: RunRow): Promise<void> {
    const b = this.store.get<{ model_route_id: string; profile_id: string }>("SELECT model_route_id, profile_id FROM agent_conversations WHERE run_id = ?", run.id);
    if (!b || !run.conversation_id) return;
    if (this.#routes.has(b.model_route_id)) return;
    await this.engine!.attachRoute(run.conversation_id, b.model_route_id, b.profile_id as AgentProfileId);
    this.#routes.add(b.model_route_id);
  }

  start(): void {
    this.#stopped = false;
    this.#timer = setInterval(() => void this.kick(), this.pollMs);
    this.#timer.unref?.();
    void this.kick();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Run one reconciliation pass now (serialized pass; per-run work runs concurrently). */
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
        await this.step();
      } while (this.#again && !this.#stopped);
    } catch (e) {
      this.log.error("coordinator step failed", { error: (e as Error).message });
    } finally {
      this.#busy = false;
    }
  }

  /** Resolves once the current pass and every per-run task are finished. */
  async drain(): Promise<void> {
    while (this.#busy || this.#perRun.size > 0) {
      await Promise.allSettled([...this.#perRun.values()]);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private async step(): Promise<void> {
    if (!this.engine || this.#recoveryBlocked) return;
    if (this.scheduler) {
      const { started, ended } = this.scheduler.admit();
      if (started.length > 0 || ended.length > 0) this.onChange?.();
      for (const id of started) this.log.info("run started", { runId: id });
      for (const e of ended) this.log.info("run ended before start", e);
    }
    for (const run of this.runs.started()) {
      if (this.#perRun.has(run.id)) continue;
      const p = this.#drive(run.id)
        .catch((e) => this.log.error("run step failed (only this run is affected)", { runId: run.id, error: (e as Error).message }))
        .finally(() => {
          this.#perRun.delete(run.id);
        });
      this.#perRun.set(run.id, p);
    }
  }

  async #drive(runId: string): Promise<void> {
    const run = this.runs.getRow(runId);
    if (!run) return;
    if (run.applied_revision_id === null && (run.status === "queued" || run.status === "running") && run.deadline_at !== null && Date.parse(run.deadline_at) <= this.runs.nowMs()) {
      this.runs.requestStop(run.id, "deadline");
      this.#again = true;
      return;
    }
    if (run.conversation_id === null) return this.#createConversation(run);
    await this.#attach(run);
    switch (run.dispatch_state) {
      case "pending":
        return this.#dispatchPending(run);
      case "dispatching":
        return this.#redeliver(run);
      case "submitted":
        return this.watch(run);
    }
  }

  /** Spec §6.2 steps 2–3: binding row first (os.sqlite), then the Pi commit by createKey, then the mapping write-back. */
  async #createConversation(run: RunRow): Promise<void> {
    if (run.status === "cancel_requested") {
      this.runs.finalize(run.id, { state: "missing" });
      this.onChange?.();
      return;
    }
    const outbox = this.store.get<{ create_key: string; request_hash: string }>("SELECT create_key, request_hash FROM agent_dispatch_outbox WHERE run_id = ? AND phase = 'create'", run.id);
    if (!outbox) {
      this.runs.finalize(run.id, { state: "missing" }, { code: "RECOVERY_BLOCKED", message: "the run has no frozen conversation-create intent" });
      return;
    }
    const storeUUID = this.store.meta().store_uuid;
    const routeId = sha256Hex(`route:${outbox.create_key}`).slice(0, 24);
    const body: Omit<ConversationBinding, "bindingHash"> = {
      storeUUID, createKey: outbox.create_key, purpose: "run", runId: run.id, profileId: run.agent_profile_id, routeId, toolsetVersion: TOOLSET_VERSION_V4,
    };
    const binding: ConversationBinding = { ...body, bindingHash: sha256Hex(canonicalJson({ ...body, frozen: outbox.request_hash })) };
    this.store.tx(() => {
      const now = iso(this.runs.nowMs());
      this.store.run(
        `INSERT INTO agent_conversations (create_key, run_id, purpose, profile_id, binding_hash, toolset_version, model_route_id, route_epoch, route_purpose, route_subject_id, binding_state, created_at, updated_at)
         VALUES (?, ?, 'run', ?, ?, ?, ?, ?, 'run', ?, 'creating', ?, ?) ON CONFLICT (create_key) DO NOTHING`,
        binding.createKey, run.id, binding.profileId, binding.bindingHash, binding.toolsetVersion, routeId, run.execution_epoch, run.id, now, now,
      );
      this.store.run("UPDATE agent_dispatch_outbox SET dispatch_state = 'sent', attempts = attempts + 1, updated_at = ? WHERE run_id = ? AND phase = 'create' AND dispatch_state IN ('pending','sent')", now, run.id);
    });
    const existing = this.store.get<{ binding_hash: string }>("SELECT binding_hash FROM agent_conversations WHERE create_key = ?", binding.createKey);
    if (existing && existing.binding_hash !== binding.bindingHash) {
      this.runs.finalize(run.id, { state: "missing" }, { code: "RECOVERY_BLOCKED", message: "conversation binding differs from the frozen intent" });
      return;
    }
    fault("conversation.before_create");
    const conversationId = await this.engine!.ensureConversation(binding);
    fault("conversation.after_create");
    this.runs.bindConversation(run.id, conversationId);
    this.log.info("conversation bound", { runId: run.id, conversationId });
    this.#again = true;
  }

  async #dispatchPending(run: RunRow): Promise<void> {
    if (run.status === "cancel_requested") {
      // Cancel won before dispatch: Pi never sees this run's input.
      this.runs.finalize(run.id, { state: "missing" });
      this.onChange?.();
      return;
    }
    if (!this.runs.beginDispatch(run.id)) {
      this.#again = true;
      return;
    }
    fault("dispatch.before_submit");
    const { submissionId } = await this.engine!.submit(run.conversation_id!, this.runs.frozen(run));
    fault("dispatch.after_submit");
    this.runs.markSubmitted(run.id, submissionId);
    this.log.info("run dispatched", { runId: run.id, conversationId: run.conversation_id, submissionId });
    this.#again = true;
  }

  /** Dispatch outcome unknown: resubmit the frozen input to the SAME conversation with the same requestId. */
  async #redeliver(run: RunRow): Promise<void> {
    const { submissionId } = await this.engine!.submit(run.conversation_id!, this.runs.frozen(run));
    this.runs.markSubmitted(run.id, submissionId);
    this.log.info("run redelivered", { runId: run.id, submissionId });
    this.#again = true;
  }

  /** One watch pass of a submitted run (exposed for regression tests). */
  async watch(run: RunRow): Promise<void> {
    const engine = this.engine!;
    const conv = run.conversation_id!;
    if (run.status === "cancel_requested" && (this.#abortIssued.get(run.id) ?? -1) < run.execution_epoch) {
      this.#abortIssued.set(run.id, run.execution_epoch);
      this.log.info("aborting the run's conversation", { runId: run.id, conversationId: conv, reason: run.stop_reason });
      // Only this conversation; a failed abort is retried with a backoff, never forgotten.
      engine.abortConversation(conv).catch((e) => {
        this.log.warn("abort failed; will retry", { runId: run.id, error: (e as Error).message });
        const n = this.#abortFailures.get(run.id) ?? 0;
        this.#abortFailures.set(run.id, n + 1);
        setTimeout(() => {
          this.#abortIssued.delete(run.id);
          this.#again = true;
        }, Math.min(30_000, 1000 * 2 ** Math.min(5, n))).unref?.();
      });
    }
    const sub: AgentSubmissionStatus = run.pi_submission_id === null ? { state: "missing" } : await engine.status(run.pi_submission_id);
    const insp = await engine.inspectConversation(conv);
    if (insp.blocked.length > 0 && (run.status === "running" || run.status === "queued")) {
      this.runs.markBlocked(run.id, { tasks: insp.blocked });
      return;
    }
    const settled = sub.state === "done" || sub.state === "unanswered" || sub.state === "missing";
    if (!settled) return;
    // Only this conversation's own tasks count; other conversations being busy never holds this run open.
    if (insp.tasks > 0 || insp.submissions > 0) return;
    const again = await engine.inspectConversation(conv);
    if (again.tasks > 0 || again.submissions > 0) return;
    fault("run.before_finalize");
    const final = this.runs.finalize(run.id, sub);
    this.#abortIssued.delete(run.id);
    this.onChange?.();
    this.log.info("run finished", { runId: run.id, status: final.status, appliedRevisionId: final.applied_revision_id });
    this.#again = true;
  }
}
