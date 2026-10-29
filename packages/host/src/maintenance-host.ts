import path from "node:path";
import {
  AppRecovery,
  CandidateService,
  OnlineGc,
  ServiceMaintenance,
  cacheGcHandler,
  logCleanupHandler,
  type Core,
  type RuntimeSystem,
  type SystemCapabilities,
} from "@agentos/core";
import { canonicalJson, sha256Hex } from "@agentos/contracts";
import type { PiAgentEngine } from "@agentos/agent-pi";
import type { Logger } from "./log.js";

/**
 * v0.4 background control loops (spec §5, §11–§20, §23.1). Built once the runtime and system layers exist. Startup
 * follows §23.1: GC intents, pins and staging owners are resumed (step 3) before Pi bindings (step 4); time, incidents
 * and cursors are read again (step 5); background scheduling opens last (step 6), only for currently approved policies.
 */
export class MaintenanceHost {
  gc: OnlineGc | null = null;
  candidates: CandidateService | null = null;
  service: ServiceMaintenance | null = null;
  appRecovery: AppRecovery | null = null;
  #periodic: NodeJS.Timeout | null = null;
  started = false;

  constructor(
    readonly core: Core,
    readonly sys: RuntimeSystem | null,
    readonly caps: SystemCapabilities | null,
    readonly dataDir: string,
    readonly log: Logger,
  ) {}

  /** Step 3: resume every delete intent from its phase before online GC (or anything else) runs. */
  async recoverStorage(): Promise<void> {
    const core = this.core;
    const jobs = core.maintenance.jobs;
    jobs.log = (l, m, f) => this.log[l](m, f);
    core.maintenance.health.log = (l, m, f) => this.log[l](m, f);
    core.compactions.log = (l, m, f) => this.log[l](m, f);
    if (this.sys) {
      const gc = new OnlineGc(core.store, this.sys.artifacts, path.join(this.dataDir, "logs"));
      this.gc = gc;
      gc.busy = () => !!core.store.get("SELECT 1 FROM runs WHERE background = 0 AND scheduling_state IN ('waiting_slot','waiting_target','waiting_build') LIMIT 1") || !!core.store.get("SELECT 1 FROM deployments WHERE status IN ('queued','preparing') LIMIT 1");
      const r = await gc.recover();
      if (r.resumed > 0) this.log.info("gc delete intents resumed", r);
      core.maintenance.health.cacheUsage = () => gc.usage();
      jobs.register("cache-gc", cacheGcHandler(gc, core.store));
      jobs.register("log-cleanup", logCleanupHandler(gc));
      // proposals keep their candidate pinned until decided / expired
      core.proposals.releasePin = (k, id) => gc.releaseOwner(k, id);
    } else {
      // closed host logs can be cleaned without a code runtime
      const gc = new OnlineGc(core.store, { root: path.join(this.dataDir, "artifacts"), sizeOnDisk: () => 0, scan: () => ({ artifacts: [], staging: [] }) } as never, path.join(this.dataDir, "logs"));
      this.gc = gc;
      jobs.register("log-cleanup", logCleanupHandler(gc));
    }
  }

  /** Wire runtime, lifecycle, proposals, candidates, root sync and compaction (before the agent resumes). */
  wire(engine: PiAgentEngine | null): void {
    const core = this.core;
    const sys = this.sys;
    const caps = this.caps;
    const jobs = core.maintenance.jobs;
    if (sys) {
      // the ONE runtime controller: maintenance only hands it an intent and nudges the reconciler
      this.appRecovery = new AppRecovery(core.store, sys.runtime, core.maintenance.incidents, () => void sys.reconciler.runOnce().catch(() => undefined));
      jobs.register("app-recovery", this.appRecovery.handler());
      sys.onUserControlInTx = (appId, action) => {
        if (action === "stop") {
          core.maintenance.policies.pauseTargetInTx("app", appId, "user stopped the app");
          core.store.run("UPDATE app_lifecycle SET control_epoch = control_epoch + 1, updated_at = ? WHERE app_id = ?", new Date(core.store.clock.now()).toISOString(), appId);
        }
      };
      core.lifecycle.stopInstance = (appId) => {
        const inst = sys.ctx.instances;
        if (inst) for (const live of [...inst.live.values()].filter((l) => l.appId === appId)) void inst.destroy(live, "app archived");
        core.store.tx(() => core.store.run("UPDATE runtime_instances SET desired_state = 'removed', observed_state = CASE WHEN observed_state IN ('stopped','failed','absent') THEN observed_state ELSE 'stopped' END, updated_at = ? WHERE app_id = ? AND desired_state <> 'removed'", new Date(core.store.clock.now()).toISOString(), appId));
        void sys.reconciler.runOnce().catch(() => undefined);
      };
      core.lifecycle.runtimeCheck = (appId) => {
        const b = sys.runtime.activeCodeBundle(appId);
        if (!b) return null;
        try {
          sys.opts.catalog.requireLock(b.bundle.runtimeLockId);
          return sys.runtimeReady ? null : "code runtime unavailable";
        } catch (e) {
          return (e as Error).message;
        }
      };
      this.candidates = new CandidateService(core.store, sys, this.gc);
      this.candidates.recover();
      core.agentOps.candidates = this.candidates;
      core.proposals.lockApproved = (lockId) => {
        try {
          sys.opts.catalog.requireLock(lockId);
          return true;
        } catch {
          return false;
        }
      };
      core.proposals.startDeploymentInTx = (p, requestKey, requestHash) => {
        const d = sys.deployments.prepareInTx({ appId: p.app_id, revisionId: p.candidate_revision_id, expectedAppEpoch: p.base_app_epoch, origin: "proposal_accept", ownerRunId: null, requestKey, requestHash });
        core.store.run("UPDATE deployments SET proposal_id = ?, job_id = ? WHERE id = ?", p.id, p.job_id, d.id);
        setImmediate(() => void sys.deployments.drive(d.id));
        return d.id;
      };
      sys.deployments.onCommittedInTx = (depId, revisionId) => core.proposals.onDeploymentCommittedInTx(depId, revisionId);
      sys.deployments.onEndedInTx = (depId) => core.proposals.onDeploymentEndedInTx(depId);
      core.proposals.recover();
    }
    if (caps) {
      core.lifecycle.revokeProviderGrantsInTx = (appId, reason) => caps.grants.invalidateAppInTx(appId, reason).length;
      core.lifecycle.grantsRevoked = (appId) => caps.grants.revocationsConfirmed(appId);
      this.service = new ServiceMaintenance(core.store, caps, core.maintenance.policies, jobs, core.maintenance.incidents);
      this.service.log = (l, m, f) => this.log[l](m, f);
      this.service.attachHealth(core.maintenance.health);
    }
    if (engine) {
      core.compactions.engine = engine;
      core.compactions.attachRoute = (routeId) => engine.attachCompactionRoute(routeId);
    }
  }

  /** Step 5: time and incidents are read again; lost observations are a gap, never an effect. */
  async observeAgain(): Promise<void> {
    const core = this.core;
    const clock = core.maintenance.clock.startup();
    if (clock !== "ok") this.log.warn("clock uncertain at startup: automatic effects stay stopped until rechecked");
    core.lifecycle.settleAll();
    await core.compactions.recover();
  }

  /** Step 6 (last): background scheduling for the currently approved policies. */
  start(): void {
    const core = this.core;
    this.service?.start();
    core.maintenance.jobs.start(1000);
    core.maintenance.health.start(5000);
    core.compactions.start(1000);
    this.#periodic = setInterval(() => {
      try {
        core.lifecycle.settleAll();
        core.proposals.refresh();
      } catch (e) {
        this.log.warn("maintenance periodic check failed", { error: (e as Error).message });
      }
    }, 10_000);
    this.#periodic.unref();
    this.started = true;
  }

  /** Normal shutdown / backup (spec §23.2–§23.3): no new trigger or step; bounded drain; I/O worker stopped. */
  async quiesce(timeoutMs = 10_000): Promise<{ drained: boolean }> {
    const core = this.core;
    core.maintenance.jobs.quiescing = true;
    core.maintenance.jobs.stop();
    core.maintenance.health.stop();
    core.compactions.stop();
    this.service?.stop();
    if (this.#periodic) clearInterval(this.#periodic);
    const drained = await core.maintenance.jobs.drain(timeoutMs);
    if (this.gc) {
      this.gc.stopped = true;
      await this.gc.worker.stop();
    }
    return { drained };
  }

  /** metrics for /api/state and the doctors (spec §24.2) */
  metrics(): Record<string, unknown> {
    return {
      jobs: this.core.maintenance.jobs.metrics(),
      gc: this.gc?.metrics() ?? null,
      service: this.service?.view() ?? null,
      budgets: this.core.budgets.summary(),
      policyHashes: this.core.store.all<{ id: string; version: number; policy_hash: string; state: string }>("SELECT id, version, policy_hash, state FROM maintenance_policies WHERE state IN ('enabled','syncing','paused')").map((p) => ({ ...p, digest: sha256Hex(canonicalJson(p)).slice(0, 12) })),
    };
  }
}
