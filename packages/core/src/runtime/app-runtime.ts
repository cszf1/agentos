import { randomUUID } from "node:crypto";
import { AgentOsError, type AnyBundle, type CodeBundle, isCodeBundle } from "@agentos/contracts";
import { iso } from "../persistence/store.js";
import { fault } from "../faults.js";
import type { RuntimeContext } from "./context.js";
import type { LiveInstance } from "./instances.js";
import { RUNTIME_POLICY } from "./policy.js";

export interface AppRuntimeRow {
  app_id: string;
  enabled: number;
  active_instance_id: string | null;
  generation: number;
  health: "stopped" | "recovering" | "ready" | "degraded";
  control_epoch: number;
  restart_window_started_at: string | null;
  restart_count: number;
  next_restart_at: string | null;
  last_error_json: string | null;
  updated_at: string;
}

export interface InstanceRow {
  id: string;
  app_id: string;
  revision_id: string;
  artifact_id: string;
  deployment_id: string | null;
  role: "active" | "preview";
  generation: number;
  host_boot_id: string;
  container_name: string;
  container_id: string | null;
  desired_state: "running" | "stopped" | "removed";
  observed_state: "absent" | "starting" | "ready" | "serving" | "draining" | "stopped" | "failed" | "unknown";
  lease_digest: string;
  last_probe_at: string | null;
  exit_reason: string | null;
}

export interface RuntimeView {
  appId: string;
  runtime: "declarative-v1" | "isolated-code-v1" | "isolated-code-v2" | null;
  revisionId: string | null;
  enabled: boolean;
  generation: number;
  controlEpoch: number;
  health: AppRuntimeRow["health"] | null;
  restartCount: number;
  lastError: unknown;
  instance: { id: string; observedState: string; lastProbeAt: string | null; limits: typeof RUNTIME_POLICY.app } | null;
  diagnostics: { level: string; text: string; at: string }[];
}

/**
 * Persistent runtime lifecycle of active code revisions (spec §11.3, §14.3): desired state in os.sqlite, one active
 * instance per enabled app, generation fences, a persisted restart budget and control intents.
 */
export class AppRuntimeService {
  /** Set by the reconciler when the engine answered its last call. */
  engineReachable = true;
  #starting = new Set<string>();

  constructor(private readonly ctx: RuntimeContext) {}

  private now(): string {
    return iso(this.ctx.store.clock.now());
  }

  row(appId: string): AppRuntimeRow | undefined {
    return this.ctx.store.get<AppRuntimeRow>("SELECT * FROM app_runtime WHERE app_id = ?", appId);
  }

  /** Inside a tx: make sure the app has a runtime row. */
  ensureRow(appId: string, enabled: boolean): AppRuntimeRow {
    const r = this.row(appId);
    if (r) return r;
    this.ctx.store.run(
      "INSERT INTO app_runtime (app_id, enabled, active_instance_id, generation, health, control_epoch, restart_count, updated_at) VALUES (?, ?, NULL, 0, ?, 0, 0, ?)",
      appId, enabled ? 1 : 0, enabled ? "recovering" : "stopped", this.now(),
    );
    return this.row(appId)!;
  }

  activeCodeBundle(appId: string): { revisionId: string; bundle: CodeBundle; appEpoch: number } | null {
    const app = this.ctx.store.get<{ active_revision_id: string | null; epoch: number }>("SELECT active_revision_id, epoch FROM apps WHERE id = ?", appId);
    if (!app?.active_revision_id) return null;
    const b = this.ctx.apps.revisionBundle(appId, app.active_revision_id) as AnyBundle | null;
    if (!b || !isCodeBundle(b)) return null;
    return { revisionId: app.active_revision_id, bundle: b, appEpoch: app.epoch };
  }

  enabledCodeApps(): number {
    return this.ctx.store.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM app_runtime ar JOIN apps a ON a.id = ar.app_id JOIN revisions r ON r.app_id = a.id AND r.id = a.active_revision_id WHERE ar.enabled = 1 AND json_extract(r.bundle_json, '$.formatVersion') = 2",
    )!.n;
  }

  /** Containers this workspace holds or is about to hold (active, candidate, draining, builds), leftovers included. */
  containerCount(): number {
    const inst = this.ctx.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_instances WHERE desired_state <> 'removed' OR observed_state NOT IN ('absent','stopped','failed')")!.n;
    const builds = this.ctx.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM build_jobs WHERE status IN ('queued','building')")!.n;
    return inst + builds;
  }

  /**
   * Route a call to the active instance. Every call re-checks the database: active revision, active instance,
   * generation, boot and lease; an in-process handle alone never grants the right to serve (spec §14.2).
   */
  route(appId: string, expected?: { revisionId: string }): { inst: LiveInstance; row: InstanceRow; generation: number } {
    if (!this.ctx.instances || !this.ctx.driver) throw new AgentOsError("SANDBOX_UNAVAILABLE", "the code runtime is not available on this host");
    const s = this.ctx.store;
    const ar = this.row(appId);
    const app = s.get<{ active_revision_id: string | null }>("SELECT active_revision_id FROM apps WHERE id = ?", appId);
    if (!app) throw new AgentOsError("NOT_FOUND", "app not found");
    if (!ar || ar.enabled === 0) throw new AgentOsError("RUNTIME_STOPPED", "this app is stopped; start it to use it");
    if (ar.health === "degraded") throw new AgentOsError("INSTANCE_NOT_READY", "this app keeps failing; see diagnostics, restart it or switch to another version", { health: "degraded" });
    if (!ar.active_instance_id) throw new AgentOsError("INSTANCE_NOT_READY", "the app is starting", { health: ar.health });
    const row = s.get<InstanceRow>("SELECT * FROM runtime_instances WHERE id = ?", ar.active_instance_id)!;
    const inst = this.ctx.instances.get(row.id);
    if (
      !inst || inst.revoked || inst.dead || row.host_boot_id !== this.ctx.bootId || row.generation !== ar.generation ||
      row.revision_id !== app.active_revision_id || inst.leaseDigest !== row.lease_digest || (expected && expected.revisionId !== row.revision_id)
    ) {
      throw new AgentOsError("INSTANCE_NOT_READY", "the app is recovering", { health: "recovering" });
    }
    return { inst, row, generation: ar.generation };
  }

  /** Re-check after a call that the instance still holds the active generation (spec §10.1, §14.2). */
  stillActive(appId: string, instanceId: string, generation: number): boolean {
    const ar = this.row(appId);
    return !!ar && ar.enabled === 1 && ar.active_instance_id === instanceId && ar.generation === generation;
  }

  view(appId: string): RuntimeView {
    const s = this.ctx.store;
    return s.read(() => {
      const app = s.get<{ active_revision_id: string | null }>("SELECT active_revision_id FROM apps WHERE id = ?", appId);
      if (!app) throw new AgentOsError("NOT_FOUND", "app not found");
      const bundle = app.active_revision_id ? this.ctx.apps.revisionBundle(appId, app.active_revision_id) : null;
      const ar = this.row(appId);
      const inst = ar?.active_instance_id ? s.get<InstanceRow>("SELECT * FROM runtime_instances WHERE id = ?", ar.active_instance_id) : undefined;
      const live = inst ? this.ctx.instances?.get(inst.id) : undefined;
      return {
        appId,
        runtime: bundle ? bundle.manifest.runtime : null,
        revisionId: app.active_revision_id,
        enabled: ar ? ar.enabled === 1 : false,
        generation: ar?.generation ?? 0,
        controlEpoch: ar?.control_epoch ?? 0,
        health: bundle && isCodeBundle(bundle) ? (ar?.health ?? "stopped") : null,
        restartCount: ar?.restart_count ?? 0,
        lastError: ar?.last_error_json ? JSON.parse(ar.last_error_json) : null,
        instance: inst ? { id: inst.id, observedState: inst.observed_state, lastProbeAt: inst.last_probe_at, limits: RUNTIME_POLICY.app } : null,
        diagnostics: live ? live.logs.slice(-20) : [],
      };
    });
  }

  /**
   * Start a new active instance for the app's active code revision (reconciler-driven). Increments generation,
   * never the app epoch, never re-runs data backfill or publication (spec §14.3).
   */
  async startActive(appId: string): Promise<void> {
    if (this.#starting.has(appId) || !this.ctx.instances) return;
    this.#starting.add(appId);
    try {
      await this.#startActive(appId);
    } finally {
      this.#starting.delete(appId);
    }
  }

  async #startActive(appId: string): Promise<void> {
    const s = this.ctx.store;
    const host = this.ctx.instances!;
    const plan = s.tx(() => {
      const active = this.activeCodeBundle(appId);
      const ar = this.row(appId);
      if (!active || !ar || ar.enabled === 0 || ar.active_instance_id !== null || ar.health === "degraded" || ar.health === "stopped") return null;
      if (ar.next_restart_at && Date.parse(ar.next_restart_at) > s.clock.now()) return null;
      if (this.containerCount() >= RUNTIME_POLICY.maxContainers) {
        s.run("UPDATE app_runtime SET last_error_json = ?, updated_at = ? WHERE app_id = ?", JSON.stringify({ code: "APP_RESOURCE_LIMIT", message: "container quota reached" }), this.now(), appId);
        return null;
      }
      const id = randomUUID();
      const generation = ar.generation + 1;
      s.run(
        "INSERT INTO runtime_instances (id, app_id, revision_id, artifact_id, deployment_id, role, generation, host_boot_id, container_name, container_id, desired_state, observed_state, lease_digest, last_probe_at, exit_reason, created_at, updated_at) SELECT ?, ?, ?, artifact_id, NULL, 'active', ?, ?, ?, NULL, 'running', 'starting', '', NULL, NULL, ?, ? FROM revision_artifacts WHERE app_id = ? AND revision_id = ?",
        id, appId, active.revisionId, generation, this.ctx.bootId, `agentos-i-${id.slice(0, 12)}`, this.now(), this.now(), appId, active.revisionId,
      );
      const inserted = s.get<InstanceRow>("SELECT * FROM runtime_instances WHERE id = ?", id);
      return { inserted: inserted ?? null, id, generation, active, controlEpoch: ar.control_epoch };
    });
    if (!plan) return;
    let artifactId: string;
    try {
      // Missing or damaged artifacts are rebuilt from the fixed recipe when possible (spec §14.4).
      const ensured = await this.ctx.builds.ensureArtifact(appId, plan.active.revisionId, s.clock.now() + RUNTIME_POLICY.prepareTimeoutMs);
      artifactId = ensured.artifactId;
    } catch (e) {
      s.tx(() => {
        if (plan.inserted) s.run("UPDATE runtime_instances SET desired_state = 'removed', observed_state = 'failed', exit_reason = ?, updated_at = ? WHERE id = ?", (e as Error).message.slice(0, 300), this.now(), plan.id);
        this.#recordFailure(appId, { code: (e as { code?: string }).code ?? "ARTIFACT_UNAVAILABLE", message: (e as Error).message });
      });
      return;
    }
    if (!plan.inserted) {
      s.tx(() =>
        s.run(
          "INSERT INTO runtime_instances (id, app_id, revision_id, artifact_id, deployment_id, role, generation, host_boot_id, container_name, container_id, desired_state, observed_state, lease_digest, last_probe_at, exit_reason, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 'active', ?, ?, ?, NULL, 'running', 'starting', '', NULL, NULL, ?, ?)",
          plan.id, appId, plan.active.revisionId, artifactId, plan.generation, this.ctx.bootId, `agentos-i-${plan.id.slice(0, 12)}`, this.now(), this.now(),
        ),
      );
    }
    let live: LiveInstance;
    try {
      live = await host.launch({
        id: plan.id, appId, revisionId: plan.active.revisionId, artifactId, generation: plan.generation, bootId: this.ctx.bootId,
        containerName: `agentos-i-${plan.id.slice(0, 12)}`, role: "app", bundle: plan.active.bundle,
        lock: this.ctx.catalog.requireLock(plan.active.bundle.runtimeLockId), storeUUID: this.ctx.storeUUID,
      });
    } catch (e) {
      s.tx(() => {
        s.run("UPDATE runtime_instances SET desired_state = 'removed', observed_state = 'failed', exit_reason = ?, updated_at = ? WHERE id = ?", (e as Error).message.slice(0, 300), this.now(), plan.id);
        this.#recordFailure(appId, { code: (e as AgentOsError).code ?? "INSTANCE_NOT_READY", message: (e as Error).message, details: (e as AgentOsError).details });
      });
      return;
    }
    fault("runtime.after_instance_ready");
    const ok = s.tx(() => {
      const ar = this.row(appId);
      const active = this.activeCodeBundle(appId);
      // A later stop/start/deployment changed the intent: this start lost.
      if (!ar || ar.control_epoch !== plan.controlEpoch || ar.enabled === 0 || ar.active_instance_id !== null || !active || active.revisionId !== plan.active.revisionId) {
        s.run("UPDATE runtime_instances SET desired_state = 'removed', observed_state = 'stopped', exit_reason = 'superseded', updated_at = ? WHERE id = ?", this.now(), plan.id);
        return false;
      }
      s.run(
        "UPDATE runtime_instances SET observed_state = 'serving', lease_digest = ?, last_probe_at = ?, updated_at = ? WHERE id = ?",
        live.leaseDigest, this.now(), this.now(), plan.id,
      );
      s.run("UPDATE app_runtime SET active_instance_id = ?, generation = ?, health = 'ready', last_error_json = NULL, updated_at = ? WHERE app_id = ?", plan.id, plan.generation, this.now(), appId);
      s.event("runtime.started", { appId, instanceId: plan.id, generation: plan.generation }, { appId });
      return true;
    });
    if (!ok) await host.destroy(live, "superseded");
  }

  /** Inside a tx: count a failure against the persisted restart budget (spec §11.3). */
  #recordFailure(appId: string, error: { code: string; message: string; details?: unknown }): void {
    const s = this.ctx.store;
    const ar = this.row(appId);
    if (!ar) return;
    const now = s.clock.now();
    let windowStart = ar.restart_window_started_at ? Date.parse(ar.restart_window_started_at) : now;
    let count = ar.restart_count;
    if (now - windowStart > RUNTIME_POLICY.restartWindowMs) {
      windowStart = now;
      count = 0;
    }
    count++;
    const degraded = count > RUNTIME_POLICY.maxRestartsPerWindow;
    const backoff = RUNTIME_POLICY.restartBackoffMs[Math.min(count - 1, RUNTIME_POLICY.restartBackoffMs.length - 1)]!;
    s.run(
      "UPDATE app_runtime SET active_instance_id = NULL, health = ?, restart_window_started_at = ?, restart_count = ?, next_restart_at = ?, last_error_json = ?, updated_at = ? WHERE app_id = ?",
      degraded ? "degraded" : "recovering", iso(windowStart), count, degraded ? null : iso(now + backoff),
      JSON.stringify({ code: error.code, message: error.message.slice(0, 500), details: error.details ?? null, at: iso(now) }), iso(now), appId,
    );
    s.event(degraded ? "runtime.degraded" : "runtime.recovering", { appId, restartCount: count, code: error.code }, { appId });
  }

  /** The instance exited or was killed without the host asking (crash, OOM, timeout kill). */
  async onInstanceExit(inst: LiveInstance, reasonIn: string): Promise<void> {
    let reason = reasonIn;
    if (inst.stopping) return;
    const s = this.ctx.store;
    let oom = false;
    let exitCode: number | null = null;
    try {
      if (this.ctx.driver && inst.containerId) {
        const st = await this.ctx.driver.wait(inst.containerId, 3000);
        exitCode = st.exitCode;
        // cgroup OOM kill, or the runtime's own heap limit (V8 aborts with 134) inside the 256 MiB budget.
        oom = st.oomKilled || (st.exitCode === 137 && !inst.killedByHost);
        if (!oom && st.exitCode !== null && st.exitCode !== 0) {
          // V8 hitting the heap budget aborts (134) or faults (139) after printing its fatal message.
          const tail = await this.ctx.driver.diagnostics(inst.containerId, 4096).catch(() => "");
          oom = /heap out of memory|Reached heap limit|Allocation failed|Fatal JavaScript out of memory/i.test(tail);
        }
      }
    } catch {
      /* engine unreachable */
    }
    reason = exitCode !== null ? `${reason} (exit ${exitCode})` : reason;
    inst.exitInfo = { exitCode, oom };
    s.tx(() => {
      const row = s.get<InstanceRow>("SELECT * FROM runtime_instances WHERE id = ?", inst.id);
      if (!row) return;
      s.run("UPDATE runtime_instances SET desired_state = 'removed', observed_state = 'failed', exit_reason = ?, updated_at = ? WHERE id = ?", (oom ? "out of memory" : reason).slice(0, 300), this.now(), inst.id);
      const ar = this.row(inst.appId);
      if (ar?.active_instance_id === inst.id) {
        this.#recordFailure(inst.appId, { code: oom ? "APP_RESOURCE_LIMIT" : "INSTANCE_NOT_READY", message: oom ? "the app exceeded its memory limit" : `the app stopped: ${reason}`, details: { logs: inst.logs.slice(-10) } });
      }
    });
    await this.ctx.instances?.destroy(inst, reason);
  }

  /** User control intents (spec §19.1): start/stop/restart; each bumps control_epoch so stale actions lose. */
  control(appId: string, action: "start" | "stop" | "restart", expectedAppEpoch: number): { controlEpoch: number; appEpoch: number } {
    const s = this.ctx.store;
    const app = s.get<{ epoch: number }>("SELECT epoch FROM apps WHERE id = ?", appId);
    if (!app) throw new AgentOsError("NOT_FOUND", "app not found");
    if (app.epoch !== expectedAppEpoch) throw new AgentOsError("APP_EPOCH_STALE", "the app changed; reload", { appEpoch: app.epoch });
    if (!this.activeCodeBundle(appId)) throw new AgentOsError("INVALID_REQUEST", "only code versions have a runtime to control");
    const busy = s.get("SELECT 1 FROM deployments WHERE app_id = ? AND status IN ('queued','preparing','ready')", appId);
    if (busy) throw new AgentOsError("DEPLOYMENT_BUSY", "a version change for this app is in progress");
    const ar = this.ensureRow(appId, false);
    if (action !== "stop" && ar.enabled === 0 && this.enabledCodeApps() >= RUNTIME_POLICY.maxEnabledCodeApps) {
      throw new AgentOsError("APP_RESOURCE_LIMIT", `at most ${RUNTIME_POLICY.maxEnabledCodeApps} code apps can run at once; stop another one first`);
    }
    const epoch = ar.control_epoch + 1;
    if (ar.active_instance_id) {
      s.run("UPDATE runtime_instances SET desired_state = 'removed', observed_state = 'draining', exit_reason = ?, updated_at = ? WHERE id = ?", `user ${action}`, this.now(), ar.active_instance_id);
    }
    if (action === "stop") {
      s.run("UPDATE app_runtime SET enabled = 0, active_instance_id = NULL, health = 'stopped', control_epoch = ?, next_restart_at = NULL, updated_at = ? WHERE app_id = ?", epoch, this.now(), appId);
    } else {
      s.run(
        "UPDATE app_runtime SET enabled = 1, active_instance_id = NULL, health = 'recovering', control_epoch = ?, restart_count = 0, restart_window_started_at = NULL, next_restart_at = NULL, last_error_json = NULL, updated_at = ? WHERE app_id = ?",
        epoch, this.now(), appId,
      );
    }
    s.event(`runtime.${action}`, { appId, controlEpoch: epoch }, { appId });
    return { controlEpoch: epoch, appEpoch: app.epoch };
  }

  /** Startup (spec §14.3, §20.1 step 3): every instance of an earlier boot loses its lease; apps restart fresh. */
  revokePreviousBoot(): void {
    const s = this.ctx.store;
    s.tx(() => {
      s.run(
        "UPDATE runtime_instances SET desired_state = 'removed', observed_state = CASE WHEN observed_state IN ('stopped','failed','absent') THEN observed_state ELSE 'unknown' END, exit_reason = COALESCE(exit_reason, 'host restarted'), updated_at = ? WHERE host_boot_id <> ? AND desired_state <> 'removed'",
        this.now(), this.ctx.bootId,
      );
      s.run(
        "UPDATE app_runtime SET active_instance_id = NULL, health = CASE WHEN enabled = 1 AND health <> 'degraded' THEN 'recovering' WHEN enabled = 1 THEN 'degraded' ELSE 'stopped' END, next_restart_at = NULL, updated_at = ? WHERE active_instance_id IS NOT NULL OR health = 'ready'",
        this.now(),
      );
    });
  }
}
