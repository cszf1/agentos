import { AgentOsError, V4_LIMITS } from "@agentos/contracts";
import { iso, type Store } from "../persistence/store.js";
import type { PolicyService } from "../maintenance/policy-service.js";
import type { JobContext, TemplateHandler } from "../maintenance/jobs.js";
import type { IncidentStore } from "../health/incidents.js";

export interface LifecycleRow {
  app_id: string;
  state: "active" | "archiving" | "archived" | "restoring";
  last_used_at: string | null;
  archive_intent_json: string | null;
  control_epoch: number;
  policy_id: string | null;
  recovery_paused: number;
  updated_at: string;
}

export interface ArchiveIntent {
  origin: "user" | "maintenance";
  jobId: string | null;
  wasEnabled: boolean;
  requestedAt: string;
  steps: { calls: "closed"; instance: "stopping" | "stopped"; maintenance: "paused"; grants: "revoking" | "revoked" | "none" };
}

/**
 * Reversible archive (spec §18): a platform metadata + run intent. Archiving hides the app, closes new calls, raises
 * the control epoch, stops the instance through the runtime controller, pauses the app's maintenance and revokes its
 * provider grants; it is `archived` only when those facts are real (broker revocation confirmed). Records, revisions,
 * audits and artifacts are never deleted. Restore re-checks the current revision and runtime and re-opens calls; old
 * provider grants are never revived.
 */
export class LifecycleService {
  /** set by the system layer (provider grants of the app): revoke all in the caller's tx; returns how many */
  revokeProviderGrantsInTx: ((appId: string, reason: string) => number) | null = null;
  /** confirmed by the broker? */
  grantsRevoked: ((appId: string) => boolean) | null = null;
  /** runtime controller: stop the instance (the controller owns containers) */
  stopInstance: ((appId: string) => void) | null = null;
  /** runtime controller: may the restored app run with the current catalog/runtime? */
  runtimeCheck: ((appId: string) => string | null) | null = null;

  constructor(private readonly store: Store, private readonly policies: PolicyService) {}

  private now(): string {
    return iso(this.store.clock.now());
  }

  get(appId: string): LifecycleRow | undefined {
    return this.store.get<LifecycleRow>("SELECT * FROM app_lifecycle WHERE app_id = ?", appId);
  }

  ensureInTx(appId: string): LifecycleRow {
    const r = this.get(appId);
    if (r) return r;
    this.store.run("INSERT INTO app_lifecycle (app_id, state, last_used_at, control_epoch, updated_at) VALUES (?, 'active', ?, 1, ?) ON CONFLICT DO NOTHING", appId, this.now(), this.now());
    return this.get(appId)!;
  }

  /** Real use only: a user open/query/command or a legitimate service consumption (never probes, lists or maintenance). */
  touch(appId: string): void {
    const r = this.get(appId);
    if (!r) return;
    // at most one write a minute per app
    if (r.last_used_at && this.store.clock.now() - Date.parse(r.last_used_at) < 60_000) return;
    this.store.tx(() => this.store.run("UPDATE app_lifecycle SET last_used_at = ? WHERE app_id = ?", this.now(), appId));
  }

  /** Inside the tx that accepts a call: archive and the call race in one transaction (spec §18). */
  requireActiveInTx(appId: string): void {
    const r = this.get(appId);
    if (r && r.state !== "active") throw new AgentOsError("APP_ARCHIVED", r.state === "restoring" ? "this app is being restored" : "this app is archived; restore it to use it", { appId, lifecycle: r.state });
  }

  /** Why the app cannot be archived now (null = eligible). */
  blocker(appId: string, origin: "user" | "maintenance", idleDays?: number): string | null {
    const s = this.store;
    const r = this.get(appId);
    if (!r) return "unknown app";
    if (r.state !== "active") return `the app is ${r.state}`;
    if (origin === "maintenance") {
      const days = idleDays ?? V4_LIMITS.archiveIdleDays;
      if (r.last_used_at && this.store.clock.now() - Date.parse(r.last_used_at) < days * 86_400_000) return "used recently";
    }
    if (s.get("SELECT 1 FROM service_grants WHERE target_app_id = ? AND revoked_at IS NULL", appId)) return "another app consumes its services (inbound service grant)";
    if (s.get("SELECT 1 FROM runs WHERE target_app_id = ? AND status IN ('queued','running','cancel_requested','blocked')", appId)) return "a task is changing this app";
    if (s.get("SELECT 1 FROM deployments WHERE app_id = ? AND status IN ('queued','preparing','ready')", appId)) return "a deployment is in progress";
    if (s.get("SELECT 1 FROM invocations WHERE app_id = ? AND status IN ('accepted','executing')", appId)) return "a command is still running";
    if (s.get("SELECT 1 FROM system_actions WHERE app_id = ? AND state IN ('awaiting_approval','ready','dispatching','running','reconciling','indeterminate')", appId)) return "a system operation of this app is not settled";
    if (s.get("SELECT 1 FROM maintenance_jobs WHERE target_kind = 'app' AND target_id = ? AND state IN ('running','verifying','reconciling') AND template_id <> 'app-archive'", appId)) return "a maintenance step is acting on this app";
    if (s.get("SELECT 1 FROM target_leases WHERE target_kind = 'app' AND target_id = ? AND state IN ('held','reclaiming','unknown')", appId)) return "the app is leased by a task";
    return null;
  }

  /** Begin archiving (user, or an approved archive policy). Returns the lifecycle row (archiving or archived). */
  archive(appId: string, origin: "user" | "maintenance", jobId: string | null = null, idleDays?: number): LifecycleRow {
    const row = this.store.tx(() => {
      const app = this.store.get<{ id: string }>("SELECT id FROM apps WHERE id = ?", appId);
      if (!app) throw new AgentOsError("NOT_FOUND", "app not found");
      const cur = this.ensureInTx(appId);
      if (cur.state === "archived" || cur.state === "archiving") return cur;
      const why = this.blocker(appId, origin, idleDays);
      if (why) throw new AgentOsError("TARGET_BUSY", `cannot archive now: ${why}`, { appId });
      const ar = this.store.get<{ enabled: number; control_epoch: number }>("SELECT enabled, control_epoch FROM app_runtime WHERE app_id = ?", appId);
      // 1. close new calls + raise the control epoch (late recovery or calls lose)
      if (ar) this.store.run("UPDATE app_runtime SET enabled = 0, health = 'stopped', next_restart_at = NULL, control_epoch = control_epoch + 1, updated_at = ? WHERE app_id = ?", this.now(), appId);
      // 2. pause this app's maintenance
      this.policies.pauseTargetInTx("app", appId, "app archived");
      // 3. provider grants
      const n = this.revokeProviderGrantsInTx?.(appId, "app archived") ?? 0;
      const intent: ArchiveIntent = { origin, jobId, wasEnabled: ar?.enabled === 1, requestedAt: this.now(), steps: { calls: "closed", instance: "stopping", maintenance: "paused", grants: n > 0 ? "revoking" : "none" } };
      this.store.run(
        "UPDATE app_lifecycle SET state = 'archiving', archive_intent_json = ?, control_epoch = control_epoch + 1, recovery_paused = 1, updated_at = ? WHERE app_id = ?",
        JSON.stringify(intent), this.now(), appId,
      );
      this.store.event("app.archiving", { appId, origin, jobId }, { appId });
      return this.get(appId)!;
    });
    this.stopInstance?.(appId);
    return this.settle(appId);
  }

  /** Archiving → archived once the instance is gone and every grant revocation is confirmed (never claimed earlier). */
  settle(appId: string): LifecycleRow {
    return this.store.tx(() => {
      const r = this.get(appId);
      if (!r || r.state !== "archiving") return r!;
      const inst = this.store.get("SELECT 1 FROM runtime_instances WHERE app_id = ? AND desired_state <> 'removed' AND observed_state IN ('starting','ready','serving')", appId);
      const grantsOk = this.grantsRevoked?.(appId) ?? true;
      const intent = JSON.parse(r.archive_intent_json ?? "{}") as ArchiveIntent;
      intent.steps.instance = inst ? "stopping" : "stopped";
      if (intent.steps.grants !== "none") intent.steps.grants = grantsOk ? "revoked" : "revoking";
      if (!inst && grantsOk) {
        this.store.run("UPDATE app_lifecycle SET state = 'archived', archive_intent_json = ?, updated_at = ? WHERE app_id = ?", JSON.stringify(intent), this.now(), appId);
        this.store.event("app.archived", { appId }, { appId });
      } else {
        this.store.run("UPDATE app_lifecycle SET archive_intent_json = ?, updated_at = ? WHERE app_id = ?", JSON.stringify(intent), this.now(), appId);
      }
      return this.get(appId)!;
    });
  }

  settleAll(): void {
    for (const r of this.store.all<{ app_id: string }>("SELECT app_id FROM app_lifecycle WHERE state IN ('archiving','restoring')")) {
      const row = this.get(r.app_id)!;
      if (row.state === "archiving") this.settle(r.app_id);
      else this.restoreFinish(r.app_id);
    }
  }

  /** User restore: re-check the current revision/runtime, re-open calls; provider grants stay revoked. */
  restore(appId: string): LifecycleRow {
    this.store.tx(() => {
      const r = this.get(appId);
      if (!r) throw new AgentOsError("NOT_FOUND", "app not found");
      if (r.state === "active") return;
      if (r.state === "archiving") throw new AgentOsError("TARGET_BUSY", "archiving is still being confirmed (instance stop / grant revocation); restore after it settles", { appId });
      this.store.run("UPDATE app_lifecycle SET state = 'restoring', control_epoch = control_epoch + 1, updated_at = ? WHERE app_id = ?", this.now(), appId);
      this.store.event("app.restoring", { appId }, { appId });
    });
    return this.restoreFinish(appId);
  }

  restoreFinish(appId: string): LifecycleRow {
    return this.store.tx(() => {
      const r = this.get(appId)!;
      if (r.state !== "restoring") return r;
      const problem = this.runtimeCheck?.(appId) ?? null;
      const intent = r.archive_intent_json ? (JSON.parse(r.archive_intent_json) as ArchiveIntent) : null;
      this.store.run("UPDATE app_lifecycle SET state = 'active', recovery_paused = 0, archive_intent_json = NULL, last_used_at = ?, updated_at = ? WHERE app_id = ?", this.now(), this.now(), appId);
      if (intent?.wasEnabled && !problem) {
        this.store.run(
          "UPDATE app_runtime SET enabled = 1, health = 'recovering', control_epoch = control_epoch + 1, restart_count = 0, restart_window_started_at = NULL, next_restart_at = NULL, last_error_json = NULL, updated_at = ? WHERE app_id = ?",
          this.now(), appId,
        );
      }
      this.store.event("app.restored", { appId, runtimeProblem: problem }, { appId });
      return this.get(appId)!;
    });
  }

  view(appId: string) {
    const r = this.get(appId);
    if (!r) return null;
    return { appId, state: r.state, lastUsedAt: r.last_used_at, controlEpoch: r.control_epoch, recoveryPaused: r.recovery_paused === 1, archive: r.archive_intent_json ? JSON.parse(r.archive_intent_json) : null };
  }

  /** `app-archive` template: archive only an idle app with an explicit policy; anything doubtful is skipped. */
  handler(incidents: IncidentStore): TemplateHandler {
    const self = this;
    return {
      async observe(ctx: JobContext) {
        const appId = ctx.job.target_id;
        const days = ctx.bounds.idleDays ?? V4_LIMITS.archiveIdleDays;
        const why = self.blocker(appId, "maintenance", days);
        const r = self.get(appId);
        if (why) return { needed: false, reason: `skip: ${why}`, evidence: { lastUsedAt: r?.last_used_at ?? null } };
        return { needed: true, reason: `unused for ${days}+ days`, evidence: { lastUsedAt: r?.last_used_at ?? null, idleDays: days }, targetVersion: String(r?.control_epoch ?? 0), incidentId: ctx.job.incident_id, suggestion: { action: "app.archive", appId } };
      },
      async act(ctx) {
        const out = await ctx.step("archive", "app.archive", "lifecycle", { appId: ctx.job.target_id, controlEpoch: ctx.job.target_version }, async () => {
          try {
            const row = self.archive(ctx.job.target_id, "maintenance", ctx.job.id, ctx.bounds.idleDays);
            return { state: "succeeded", result: { state: row.state } };
          } catch (e) {
            return { state: "failed_no_effect", result: { reason: (e as Error).message } };
          }
        }, async () => {
          const row = self.get(ctx.job.target_id);
          return row && row.state !== "active" ? { state: "succeeded", result: { state: row.state, recovered: true } } : { state: "failed_no_effect", result: { reason: "interrupted before the archive intent committed" } };
        });
        if (out.state !== "succeeded") return { certainty: "none", reason: String((out.result as { reason?: string })?.reason ?? out.state), completed: 0 };
        return { certainty: "confirmed", reason: "archive intent recorded; waiting for the instance stop and grant revocation", completed: 1 };
      },
      async verify(ctx) {
        const r = self.settle(ctx.job.target_id);
        if (r.state === "archived") {
          if (ctx.job.incident_id) incidents.resolve(ctx.job.incident_id, { jobId: ctx.job.id, reason: "archived" }, self.store.clock.now());
          return { healthy: true, reason: "archived: calls closed, instance stopped, provider grants revoked (confirmed)" };
        }
        if (r.state === "archiving") {
          const st = self.store.get<{ updated_at: string }>("SELECT updated_at FROM maintenance_steps WHERE job_id = ? AND step_id = 'archive'", ctx.job.id);
          if (st && self.store.clock.now() - Date.parse(st.updated_at) > 600_000) return { healthy: null, reason: "the broker has not confirmed the grant revocation; the app stays archiving (not reported as archived)" };
          return { healthy: null, reason: "waiting for the broker to confirm the grant revocation", pending: true };
        }
        return { healthy: null, reason: `lifecycle is ${r.state}` };
      },
    };
  }
}
