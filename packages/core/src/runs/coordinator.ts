import type { AgentEngine, AgentInspection, AgentSubmissionStatus } from "./engine.js";
import type { RunRow, RunService } from "./run-service.js";
import { fault } from "../faults.js";

export interface CoordinatorLog {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const silent: CoordinatorLog = { info() {}, warn() {}, error() {} };

/**
 * Drives the single active run across the two databases (spec §11): outbox dispatch, cancel,
 * deadline, blocked detection and final reconciliation. All decisions are re-read from os.sqlite.
 */
export class RunCoordinator {
  #timer: NodeJS.Timeout | undefined;
  #busy = false;
  #again = false;
  #stopped = false;
  #abortIssued = new Set<string>();
  #abortFailures = new Map<string, number>();
  #recoveryBlocked: string | null = null;

  constructor(
    private readonly runs: RunService,
    private readonly engine: AgentEngine | null,
    private readonly log: CoordinatorLog = silent,
    private readonly pollMs = 500,
  ) {}

  get recoveryBlocked(): string | null {
    return this.#recoveryBlocked;
  }

  /** Startup reconciliation before scheduling resumes (spec §14 step 5). */
  async recover(): Promise<void> {
    const active = this.runs.activeRun();
    if (!this.engine) return;
    const insp = await this.engine.inspect();
    if (!active) {
      if (insp.tasks > 0 || insp.submissions > 0) {
        this.#recoveryBlocked = `agent.sqlite has ${insp.tasks} unfinished task(s) and ${insp.submissions} submission(s) without an active run in os.sqlite`;
        this.log.error("recovery blocked", { reason: this.#recoveryBlocked });
      }
      return;
    }
    if (active.applied_revision_id === null && Date.parse(active.deadline_at) <= this.runs.nowMs() && active.status !== "cancel_requested") {
      this.runs.requestStop(active.id, "deadline");
    }
    this.log.info("recovering active run", { runId: active.id, status: active.status, dispatchState: active.dispatch_state });
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

  /** Run one reconciliation pass now (serialized). */
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

  /** Resolves once the current pass (if any) is finished. */
  async drain(): Promise<void> {
    while (this.#busy) await new Promise((r) => setTimeout(r, 10));
  }

  private async step(): Promise<void> {
    const run = this.runs.activeRun();
    if (!run || !this.engine || this.#recoveryBlocked) return;
    if (run.applied_revision_id === null && (run.status === "queued" || run.status === "running") && Date.parse(run.deadline_at) <= this.runs.nowMs()) {
      this.runs.requestStop(run.id, "deadline");
      this.#again = true;
      return;
    }
    switch (run.dispatch_state) {
      case "pending":
        return this.dispatchPending(run);
      case "dispatching":
        return this.redeliver(run);
      case "submitted":
        return this.watch(run);
    }
  }

  private async dispatchPending(run: RunRow): Promise<void> {
    if (run.status === "cancel_requested") {
      // Cancel won before dispatch: Pi never sees this run.
      this.runs.finalize(run.id, { state: "missing" });
      return;
    }
    if (!this.runs.beginDispatch(run.id)) {
      this.#again = true;
      return;
    }
    fault("dispatch.before_submit");
    const { submissionId } = await this.engine!.submit(this.runs.frozen(run));
    fault("dispatch.after_submit");
    this.runs.markSubmitted(run.id, submissionId);
    this.log.info("run dispatched", { runId: run.id, submissionId });
    this.#again = true;
  }

  /** Dispatch outcome unknown (crash between dispatching and saving the id): resubmit the frozen input with the same requestId. */
  private async redeliver(run: RunRow): Promise<void> {
    const { submissionId } = await this.engine!.submit(this.runs.frozen(run));
    this.runs.markSubmitted(run.id, submissionId);
    this.log.info("run redelivered", { runId: run.id, submissionId });
    this.#again = true;
  }

  private async watch(run: RunRow): Promise<void> {
    const engine = this.engine!;
    if (run.status === "cancel_requested" && !this.#abortIssued.has(run.id)) {
      this.#abortIssued.add(run.id);
      this.log.info("aborting agent conversation", { runId: run.id, reason: run.stop_reason });
      // A failed abort is retried on a later pass (with a backoff), never forgotten.
      engine.cancelConversation().catch((e) => {
        this.log.warn("abort failed; will retry", { runId: run.id, error: (e as Error).message });
        setTimeout(() => {
          this.#abortIssued.delete(run.id);
          this.#again = true;
        }, Math.min(30_000, 1000 * 2 ** Math.min(5, (this.#abortFailures.get(run.id) ?? 0))));
        this.#abortFailures.set(run.id, (this.#abortFailures.get(run.id) ?? 0) + 1);
      });
    }
    const sub: AgentSubmissionStatus = run.pi_submission_id === null ? { state: "missing" } : await engine.status(run.pi_submission_id);
    const insp: AgentInspection = await engine.inspect();
    if (insp.blocked.length > 0 && (run.status === "running" || run.status === "queued")) {
      this.runs.markBlocked(run.id, { tasks: insp.blocked });
      return;
    }
    const settled = sub.state === "done" || sub.state === "unanswered" || sub.state === "missing";
    if (!settled) return;
    if (insp.tasks > 0 || insp.submissions > 0) return;
    // Re-check right before releasing the slot.
    if (!(await engine.isIdle())) return;
    const final = this.runs.finalize(run.id, sub);
    this.#abortIssued.delete(run.id);
    this.log.info("run finished", { runId: run.id, status: final.status, appliedRevisionId: final.applied_revision_id });
  }
}
