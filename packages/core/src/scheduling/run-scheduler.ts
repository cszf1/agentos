import { V4_LIMITS } from "@agentos/contracts";
import { compactionBusy } from "../model-budgets/budgets.js";
import { iso, type Store } from "../persistence/store.js";
import type { RunRow, RunService } from "../runs/run-service.js";
import type { AppService } from "../apps/app-service.js";
import { TargetLeases } from "./target-leases.js";

/**
 * Foreground/background run admission (spec §7). Acceptance and execution are separate: a request is persisted and
 * queued at once (202); this scheduler decides when a queued run gets an execution slot.
 *
 *  - 2 foreground slots (user build/system_plan), FIFO by priority then acceptance; different targets run in parallel,
 *    the same app target never runs twice at once (target lease);
 *  - 1 background slot (maintenance analysis), only while no foreground run waits for a slot and the host is idle;
 *  - when a run gets its slot the target is re-checked: a changed appEpoch ends it with TARGET_CHANGED instead of
 *    applying an old intent to a later version; the execution deadline starts at dispatch, the queue deadline is separate.
 * Everything is decided in one short write transaction from os.sqlite; nothing here awaits Pi or the network.
 */
export class RunScheduler {
  readonly leases: TargetLeases;
  /** extra idle conditions for background runs (no prepare waiting for the build slot, resources available) */
  backgroundIdle: () => boolean = () => true;
  /** paused by quiesce / restore / startup (spec §23.1: new scheduling stays off until recovery finished) */
  paused = false;

  constructor(
    private readonly store: Store,
    private readonly runs: RunService,
    private readonly apps: AppService,
  ) {
    this.leases = new TargetLeases(store);
  }

  private now(): number {
    return this.store.clock.now();
  }

  /** Queued runs in admission order. */
  queued(): RunRow[] {
    return this.store.all<RunRow>(
      "SELECT * FROM runs WHERE scheduling_state IN ('waiting_slot','waiting_target') ORDER BY background ASC, priority DESC, created_at ASC, id ASC",
    );
  }

  /**
   * One admission pass. Returns the runs that were given a slot (now `dispatching`) and the runs ended before start
   * (cancelled while queued, queue deadline, target changed) so the caller can finish them.
   */
  admit(): { started: string[]; ended: { runId: string; code: string; message: string }[] } {
    const started: string[] = [];
    const ended: { runId: string; code: string; message: string }[] = [];
    if (this.paused) return { started, ended };
    this.store.tx(() => {
      this.reclaimLeasesInTx();
      const nowMs = this.now();
      const running = this.store.all<{ background: number; n: number }>(
        "SELECT background, COUNT(*) AS n FROM runs WHERE scheduling_state IN ('dispatching','active','waiting_build','waiting_model','draining') GROUP BY background",
      );
      let fgBusy = running.find((r) => r.background === 0)?.n ?? 0;
      let bgBusy = running.find((r) => r.background === 1)?.n ?? 0;
      const fgSlots = this.runs.foregroundSlots;
      const queue = this.queued();
      const fgWaiting = queue.some((r) => r.background === 0 && r.status === "queued");
      /** targets an earlier queued run is waiting for: later runs of the same target keep the order */
      const blockedTargets = new Set<string>();
      for (const r of queue) {
        if (r.status === "cancel_requested") {
          ended.push({ runId: r.id, code: "CANCELLED", message: "cancelled before it started" });
          continue;
        }
        if (r.status !== "queued") continue;
        if (r.queue_deadline_at !== null && Date.parse(r.queue_deadline_at) <= nowMs) {
          ended.push({ runId: r.id, code: "QUEUE_EXPIRED", message: "the task waited longer than the queue allows (1 h)" });
          continue;
        }
        const bg = r.background === 1;
        if (bg) {
          // Spec §7.2: one slot for a background model run and session compaction together, not one of each.
          if (bgBusy >= V4_LIMITS.backgroundModelSlots || compactionBusy(this.store)) {
            this.runs.setWaiting(r.id, "waiting_slot", compactionBusy(this.store) ? "waiting for the background slot (a conversation summary is running)" : "waiting for the background slot");
            continue;
          }
          if (fgWaiting || !this.backgroundIdle()) {
            this.runs.setWaiting(r.id, "waiting_slot", "deferred: foreground work has priority");
            continue;
          }
        } else if (fgBusy >= fgSlots) {
          this.runs.setWaiting(r.id, "waiting_slot", `waiting for a free task slot (${fgSlots} running)`);
          continue;
        }
        const target = r.target_app_id;
        if (target !== null) {
          if (blockedTargets.has(target)) {
            this.runs.setWaiting(r.id, "waiting_target", "waiting for an earlier task on the same app");
            continue;
          }
          const app = this.apps.getAppRow(target);
          if (!app) {
            ended.push({ runId: r.id, code: "TARGET_CHANGED", message: "the target app no longer exists" });
            continue;
          }
          const lc = this.store.get<{ state: string }>("SELECT state FROM app_lifecycle WHERE app_id = ?", target);
          if (lc && lc.state !== "active") {
            blockedTargets.add(target);
            this.runs.setWaiting(r.id, "waiting_target", `the app is ${lc.state}`);
            continue;
          }
          const lease = this.leases.tryAcquire("app", target, { kind: "run", id: r.id }, Math.max(this.runs.settingsFor(r).deadlineMs, 60_000) + 120_000, r.expected_app_epoch);
          if (!lease.ok) {
            blockedTargets.add(target);
            const h = lease.holder;
            this.runs.setWaiting(r.id, "waiting_target", h.owner_kind === "run" ? "waiting for another task on the same app" : `the app is busy (${h.owner_kind})`);
            continue;
          }
          // Re-check the target after the slot is won (spec §7.1): an app changed while queued is never silently rebased.
          if (app.epoch !== r.expected_app_epoch) {
            this.leases.release("app", target, { kind: "run", id: r.id });
            ended.push({ runId: r.id, code: "TARGET_CHANGED", message: `the app changed while this task waited (epoch ${r.expected_app_epoch} → ${app.epoch}); submit it again` });
            continue;
          }
        }
        this.runs.startInTx(r.id);
        started.push(r.id);
        if (bg) bgBusy++;
        else fgBusy++;
      }
      for (const e of ended) {
        if (e.code !== "CANCELLED") {
          this.store.run(
            "UPDATE runs SET status = 'failed', error_json = ?, scheduling_state = 'done', wait_reason = NULL, updated_at = ? WHERE id = ? AND status IN ('queued','cancel_requested')",
            JSON.stringify({ code: e.code, message: e.message }), iso(nowMs), e.runId,
          );
        } else {
          this.store.run(
            "UPDATE runs SET status = 'cancelled', error_json = ?, scheduling_state = 'done', wait_reason = NULL, updated_at = ? WHERE id = ? AND status = 'cancel_requested'",
            JSON.stringify({ code: "CANCELLED", message: "cancelled by the user before it started" }), iso(nowMs), e.runId,
          );
        }
        this.store.run("UPDATE agent_dispatch_outbox SET dispatch_state = 'fenced', updated_at = ? WHERE run_id = ? AND dispatch_state = 'pending'", iso(nowMs), e.runId);
        this.store.event(`run.${e.code === "CANCELLED" ? "cancelled" : "failed"}`, { runId: e.runId, code: e.code }, { runId: e.runId });
        const row = this.runs.getRow(e.runId);
        if (row) this.runs.onFinalizedInTx?.(row);
      }
    });
    return { started, ended };
  }

  /** Metrics (spec §24.2). */
  /**
   * V4-R05: a lease past its deadline becomes `reclaiming`; it is released (with a raised epoch) only once its owner is
   * confirmed to have stopped writing: a run that reached a terminal state, or a maintenance job in a finished state
   * other than `indeterminate` (an unknown external result stays fenced; time never releases an `unknown` lease).
   */
  reclaimLeasesInTx(): number {
    let n = 0;
    for (const l of this.leases.expired()) {
      let stopped = false;
      if (l.owner_kind === "run") stopped = !!this.store.get("SELECT 1 FROM runs WHERE id = ? AND status IN ('succeeded','failed','cancelled')", l.owner_id) || !this.store.get("SELECT 1 FROM runs WHERE id = ?", l.owner_id);
      else if (l.owner_kind === "job") {
        // needs_attention has stopped executing. indeterminate is an unknown external result: time never releases it
        // (spec §8.2). A missing job row is not "stopped" either.
        stopped = !!this.store.get("SELECT 1 FROM maintenance_jobs WHERE id = ? AND state IN ('succeeded','no_change','failed_no_effect','cancelled','expired','needs_attention')", l.owner_id);
      }
      if (stopped) {
        this.leases.reclaim(l.target_kind, l.target_id);
        this.store.event("lease.reclaimed", { targetKind: l.target_kind, targetId: l.target_id, ownerKind: l.owner_kind, ownerId: l.owner_id });
        n++;
      }
    }
    return n;
  }

  metrics(): Record<string, unknown> {
    const q = this.store.all<{ background: number; state: string; n: number }>(
      "SELECT background, scheduling_state AS state, COUNT(*) AS n FROM runs WHERE scheduling_state <> 'done' GROUP BY background, scheduling_state",
    );
    const waits = this.store.get<{ avg: number | null; max: number | null }>(
      "SELECT AVG((julianday(started_at) - julianday(created_at)) * 86400000) AS avg, MAX((julianday(started_at) - julianday(created_at)) * 86400000) AS max FROM runs WHERE started_at IS NOT NULL AND created_at > ?",
      iso(this.now() - 86_400_000),
    );
    return {
      foregroundSlots: this.runs.foregroundSlots,
      byState: q,
      queueWaitMs24h: { avg: waits?.avg ?? null, max: waits?.max ?? null },
      leases: this.leases.list().length,
    };
  }
}
