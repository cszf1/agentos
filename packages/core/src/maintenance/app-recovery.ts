import { randomBytes } from "node:crypto";
import { iso, type Store } from "../persistence/store.js";
import type { AppRuntimeService } from "../runtime/app-runtime.js";
import type { IncidentStore } from "../health/incidents.js";
import type { JobContext, TemplateHandler } from "./jobs.js";
import { fault } from "../faults.js";

const FAMILY = "instance.converge";

interface ArRow {
  app_id: string;
  enabled: number;
  health: string;
  control_epoch: number;
  restart_count: number;
  active_instance_id: string | null;
  generation: number;
  last_error_json: string | null;
}

/**
 * `app-recovery` (spec §15): a maintenance recovery is an intent handed to the ONE existing controller. The step only
 * re-opens the RuntimeManager's restart path (degraded → recovering, inside a control-epoch CAS) and the Reconciler
 * starts the instance with a new instance/generation/lease exactly as it always does. No container is created here.
 * Maintenance attempts and the controller's restart_count are counted together: a crash-loop returns to degraded on
 * its own, the per-hour / per-24 h / cooldown budget is checked against all maintenance attempts of the target (never
 * reset by a new job or policy version or a restart), and 3 consecutive recoveries that do not hold open the circuit.
 */
export class AppRecovery {
  constructor(
    private readonly store: Store,
    private readonly runtime: AppRuntimeService,
    private readonly incidents: IncidentStore,
    private readonly kickReconciler: () => void,
  ) {}

  private now(): string {
    return iso(this.store.clock.now());
  }

  #ar(appId: string): ArRow | undefined {
    return this.store.get<ArRow>("SELECT * FROM app_runtime WHERE app_id = ?", appId);
  }

  /** Why recovery must not run now (null = eligible). Checks every precondition of spec §15. */
  blocker(appId: string, expectControlEpoch?: number): string | null {
    const ar = this.#ar(appId);
    if (!ar) return "no runtime row";
    if (ar.enabled !== 1) return "the app is stopped by the user";
    if (expectControlEpoch !== undefined && ar.control_epoch !== expectControlEpoch) return `control epoch changed (${expectControlEpoch} → ${ar.control_epoch}): a newer user/control intent wins`;
    const lc = this.store.get<{ state: string; recovery_paused: number }>("SELECT state, recovery_paused FROM app_lifecycle WHERE app_id = ?", appId);
    if (lc && lc.state !== "active") return `the app is ${lc.state}`;
    if (lc?.recovery_paused === 1) return "automatic recovery is paused for this app";
    if (this.store.get("SELECT 1 FROM deployments WHERE app_id = ? AND status IN ('queued','preparing','ready')", appId)) return "a deployment of this app is in progress";
    if (this.store.get("SELECT 1 FROM invocations WHERE app_id = ? AND status = 'executing'", appId)) return "an invocation with an unknown outcome is not reconciled yet";
    if (this.store.get("SELECT 1 FROM system_actions WHERE app_id = ? AND state IN ('dispatching','running','reconciling','indeterminate')", appId)) return "a system operation of this app is not settled";
    if (this.store.get("SELECT 1 FROM runtime_instances WHERE app_id = ? AND observed_state = 'unknown' AND desired_state <> 'removed'", appId)) return "an instance is in an unknown state (never treated as absent)";
    return null;
  }

  #counts(appId: string): { hour: number; day: number; last: number | null } {
    const t = this.store.clock.now();
    const q = (since: number) => this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM maintenance_attempts WHERE target_kind = 'app' AND target_id = ? AND action_family = ? AND admitted_at > ?", appId, FAMILY, iso(since))!.n;
    const last = this.store.get<{ t: string | null }>("SELECT MAX(admitted_at) AS t FROM maintenance_attempts WHERE target_kind = 'app' AND target_id = ? AND action_family = ?", appId, FAMILY)!.t;
    return { hour: q(t - 3_600_000), day: q(t - 86_400_000), last: last ? Date.parse(last) : null };
  }

  circuit(appId: string): { state: "open" | "closed"; consecutive: number; reason: string | null } {
    const c = this.store.get<{ state: "open" | "closed"; consecutive_failures: number; reason: string | null }>("SELECT * FROM maintenance_circuits WHERE target_kind = 'app' AND target_id = ? AND action_family = ?", appId, FAMILY);
    return { state: c?.state ?? "closed", consecutive: c?.consecutive_failures ?? 0, reason: c?.reason ?? null };
  }

  /** The user (never the model) closes an open circuit. */
  resetCircuit(appId: string): void {
    this.store.tx(() => this.store.run("UPDATE maintenance_circuits SET state = 'closed', consecutive_failures = 0, reason = 'reset by the user', updated_at = ? WHERE target_kind = 'app' AND target_id = ?", this.now(), appId));
  }

  #recordOutcome(jobId: string, appId: string, outcome: "succeeded" | "failed", circuitAfter: number): void {
    this.store.tx(() => {
      const a = this.store.get<{ id: string; outcome: string }>("SELECT id, outcome FROM maintenance_attempts WHERE job_id = ? AND action_family = ? ORDER BY admitted_at DESC LIMIT 1", jobId, FAMILY);
      if (!a || a.outcome !== "pending") return;
      this.store.run("UPDATE maintenance_attempts SET outcome = ?, verified_at = ? WHERE id = ?", outcome, this.now(), a.id);
      const c = this.circuit(appId);
      const fails = outcome === "failed" ? c.consecutive + 1 : 0;
      const open = fails >= circuitAfter || c.state === "open";
      this.store.run(
        `INSERT INTO maintenance_circuits (target_kind, target_id, action_family, state, consecutive_failures, opened_at, reason, updated_at) VALUES ('app', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (target_kind, target_id, action_family) DO UPDATE SET state = excluded.state, consecutive_failures = excluded.consecutive_failures,
           opened_at = COALESCE(excluded.opened_at, maintenance_circuits.opened_at), reason = COALESCE(excluded.reason, maintenance_circuits.reason), updated_at = excluded.updated_at`,
        appId, FAMILY, open ? "open" : "closed", fails, open && c.state !== "open" ? this.now() : null, open ? `${fails} consecutive maintenance recoveries did not hold` : null, this.now(),
      );
      if (open && c.state !== "open") this.store.event("maintenance.circuit_open", { targetKind: "app", targetId: appId, failures: fails }, { appId });
    });
  }

  handler(): TemplateHandler {
    const self = this;
    return {
      async observe(ctx: JobContext) {
        const appId = ctx.job.target_id;
        const ar = self.#ar(appId);
        const ev = { health: ar?.health, restartCount: ar?.restart_count, controlEpoch: ar?.control_epoch, activeInstance: ar?.active_instance_id };
        if (!ar) return { needed: false, reason: "no runtime row", evidence: ev };
        if (ar.health === "ready" && ar.active_instance_id) {
          if (ctx.job.incident_id) self.incidents.resolve(ctx.job.incident_id, { jobId: ctx.job.id, reason: "instance ready" }, self.store.clock.now());
          return { needed: false, reason: "the app is running (no_change)", evidence: ev };
        }
        if (ar.health === "recovering") return { needed: false, reason: "the existing controller is already restarting it (no second recovery)", evidence: ev, incidentId: ctx.job.incident_id };
        if (ar.health !== "degraded") return { needed: false, reason: `health is ${ar.health}`, evidence: ev };
        const why = self.blocker(appId);
        if (why) return { needed: false, reason: `not eligible: ${why}`, evidence: ev, incidentId: ctx.job.incident_id };
        return { needed: true, reason: "the controller's restart budget is exhausted (degraded)", evidence: ev, targetVersion: String(ar.control_epoch), incidentId: ctx.job.incident_id, suggestion: { action: FAMILY, appId } };
      },
      admission(ctx) {
        const appId = ctx.job.target_id;
        const c = self.circuit(appId);
        if (c.state === "open") return { ok: false, circuitOpen: true, reason: c.reason ?? "circuit open" };
        const n = self.#counts(appId);
        const perHour = ctx.bounds.perHour ?? 2;
        const per24h = ctx.bounds.per24h ?? 3;
        const cooldown = (ctx.bounds.cooldownSeconds ?? 600) * 1000;
        if (n.day >= per24h) return { ok: false, circuitOpen: true, reason: `${n.day} recoveries in 24 h reach the limit of ${per24h}` };
        if (n.hour >= perHour) return { ok: false, defer: true, reason: `${n.hour} recoveries in the last hour reach the limit of ${perHour}` };
        if (n.last !== null && self.store.clock.now() - n.last < cooldown) return { ok: false, defer: true, reason: `cooldown until ${iso(n.last + cooldown)}` };
        return { ok: true };
      },
      async act(ctx) {
        const appId = ctx.job.target_id;
        const expectEpoch = Number(ctx.job.target_version ?? NaN);
        const out = await ctx.step("converge", FAMILY, "runtime-manager", { appId, controlEpoch: expectEpoch }, async () => {
          // One CAS transaction: re-check every precondition, reserve the attempt, hand the intent to the controller.
          const r = self.store.tx(() => {
            const why = self.blocker(appId, Number.isFinite(expectEpoch) ? expectEpoch : undefined);
            if (why) return { ok: false as const, why };
            const ar = self.#ar(appId)!;
            if (ar.health !== "degraded") return { ok: false as const, why: `health is ${ar.health} (no_change)` };
            self.store.run(
              "INSERT INTO maintenance_attempts (id, target_kind, target_id, action_family, job_id, step_id, policy_id, policy_version, admitted_at) VALUES (?, 'app', ?, ?, ?, 'converge', ?, ?, ?)",
              `ma_${randomBytes(10).toString("hex")}`, appId, FAMILY, ctx.job.id, ctx.job.policy_id, ctx.job.policy_version, self.now(),
            );
            // restart_count is kept (not zeroed): one more failure inside the controller's window degrades at once.
            self.store.run("UPDATE app_runtime SET health = 'recovering', next_restart_at = ?, updated_at = ? WHERE app_id = ? AND control_epoch = ? AND health = 'degraded'", self.now(), self.now(), appId, ar.control_epoch);
            self.store.event("maintenance.app_recovery", { appId, jobId: ctx.job.id, controlEpoch: ar.control_epoch, restartCount: ar.restart_count }, { appId });
            return { ok: true as const, controlEpoch: ar.control_epoch, generation: ar.generation };
          });
          fault("maintenance.app.after_intent");
          if (!r.ok) return { state: r.why.includes("no_change") ? "no_change" : "failed_no_effect", result: { reason: r.why } };
          self.kickReconciler();
          return { state: "succeeded", result: { controlEpoch: r.controlEpoch, generationBefore: r.generation, at: self.now() } };
        }, async (s) => {
          // interrupted after the intent: the transaction either committed (attempt row exists) or not.
          const a = self.store.get("SELECT 1 FROM maintenance_attempts WHERE job_id = ? AND step_id = 'converge'", ctx.job.id);
          if (a) {
            self.kickReconciler();
            return { state: "succeeded", result: { recovered: "intent found after restart", at: self.now(), step: s.step_id } };
          }
          return { state: "failed_no_effect", result: { reason: "interrupted before the intent committed" } };
        });
        if (out.state === "failed_no_effect") return { certainty: "none", reason: String((out.result as { reason?: string })?.reason ?? "not executed"), completed: 0 };
        if (out.state === "no_change") return { certainty: "none", reason: "no_change", completed: 0 };
        if (out.state === "unknown") return { certainty: "unknown", reason: "intent outcome unknown", completed: 0 };
        return { certainty: "confirmed", reason: "recovery intent handed to the runtime controller; verifying handshake, probe and the observation window", completed: 1 };
      },
      async verify(ctx) {
        const appId = ctx.job.target_id;
        const step = self.store.get<{ result_json: string | null; updated_at: string }>("SELECT result_json, updated_at FROM maintenance_steps WHERE job_id = ? AND step_id = 'converge'", ctx.job.id);
        const res = step?.result_json ? (JSON.parse(step.result_json) as { generationBefore?: number }) : {};
        const since = step ? Date.parse(step.updated_at) : self.store.clock.now();
        const windowMs = (ctx.bounds.observeSeconds ?? 60) * 1000;
        const ar = self.#ar(appId);
        const circuitAfter = ctx.bounds.circuitAfter ?? 3;
        if (!ar || ar.enabled !== 1) {
          self.#recordOutcome(ctx.job.id, appId, "failed", circuitAfter);
          return { healthy: null, reason: "the app was stopped during verification" };
        }
        if (ar.health === "degraded") {
          self.#recordOutcome(ctx.job.id, appId, "failed", circuitAfter);
          return { healthy: false, reason: "the app failed again (crash-loop): recovery did not hold" };
        }
        const inst = ar.active_instance_id ? self.store.get<{ observed_state: string; generation: number; last_probe_at: string | null }>("SELECT observed_state, generation, last_probe_at FROM runtime_instances WHERE id = ?", ar.active_instance_id) : undefined;
        const started = ar.health === "ready" && !!inst && (res.generationBefore === undefined || ar.generation > res.generationBefore);
        if (!started) {
          if (self.store.clock.now() - since > windowMs * 3) {
            self.#recordOutcome(ctx.job.id, appId, "failed", circuitAfter);
            return { healthy: false, reason: "no new ready instance within three observation windows" };
          }
          return { healthy: null, reason: "waiting for the new instance handshake", pending: true };
        }
        ctx.evidence({ verify: { health: ar.health, generation: ar.generation, instance: ar.active_instance_id, lastProbeAt: inst?.last_probe_at } });
        if (self.store.clock.now() - since < windowMs) return { healthy: null, reason: "observation window", pending: true };
        if (!inst?.last_probe_at || Date.parse(inst.last_probe_at) < since) return { healthy: null, reason: "waiting for a health probe after the restart", pending: true };
        self.#recordOutcome(ctx.job.id, appId, "succeeded", circuitAfter);
        return { healthy: true, reason: `new instance generation ${ar.generation} handshaked, probed and stayed up for ${windowMs / 1000} s` };
      },
    };
  }
}
