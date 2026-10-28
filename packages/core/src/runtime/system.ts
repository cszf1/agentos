import path from "node:path";
import { randomUUID } from "node:crypto";
import { AgentOsError, type AnyBundle } from "@agentos/contracts";
import type { Core } from "../index.js";
import { ArtifactStore } from "../builds/artifact-store.js";
import { BuildService } from "../builds/build-service.js";
import { iso } from "../persistence/store.js";
import type { RuntimeCatalogService } from "./catalog-service.js";
import type { RuntimeDriver } from "./driver.js";
import { InstanceHost } from "./instances.js";
import type { Logger, RuntimeContext } from "./context.js";
import { AppRuntimeService } from "./app-runtime.js";
import { Reconciler } from "./reconciler.js";
import { DeploymentService, type DeploymentDto, type DeploymentRow } from "../deployments/deployment-service.js";
import { InvocationService } from "../invocations/invocation-service.js";
import { InterAppService, type GrantDto } from "../inter-app/inter-app-service.js";
import type { UserWriteMeta } from "../user-actions.js";
import type { WriteResult } from "../capabilities/gateway.js";
import { fault } from "../faults.js";
import { RUNTIME_POLICY } from "./policy.js";

export interface RuntimeSystemOptions {
  dataDir: string;
  catalog: RuntimeCatalogService;
  driver: RuntimeDriver | null;
  log: Logger;
  /** Start the periodic reconciler (tests may drive it by hand). */
  autoReconcile?: boolean;
}

/**
 * Wires the v0.2 runtime services around the v0.1 core: builds, deployments, instances, invocations and grants,
 * with the startup sequence of spec §20.1 steps 3–5 and the shutdown of spec §20.1.
 */
export class RuntimeSystem {
  readonly ctx: RuntimeContext;
  readonly runtime: AppRuntimeService;
  readonly reconciler: Reconciler;
  readonly deployments: DeploymentService;
  readonly invocations: InvocationService;
  readonly interApp: InterAppService;
  readonly builds: BuildService;
  readonly artifacts: ArtifactStore;
  readonly bootId = randomUUID();
  environmentProblems: string[] = [];
  closed = false;

  constructor(readonly core: Core, readonly opts: RuntimeSystemOptions) {
    const storeUUID = core.store.meta().store_uuid;
    this.artifacts = new ArtifactStore(path.join(opts.dataDir, "artifacts"));
    const instances = opts.driver ? new InstanceHost(opts.driver, this.artifacts, path.join(opts.dataDir, "run"), (m, f) => opts.log("warn", m, f)) : null;
    const ctxPartial = {
      store: core.store, gateway: core.gateway, apps: core.apps, records: core.records, catalog: opts.catalog, artifacts: this.artifacts,
      driver: opts.driver, instances, bootId: this.bootId, storeUUID, log: opts.log,
    } as Omit<RuntimeContext, "builds">;
    this.builds = new BuildService({
      store: core.store, artifacts: this.artifacts, driver: opts.driver, catalog: opts.catalog, storeUUID: () => storeUUID, bootId: () => this.bootId,
      workDir: path.join(opts.dataDir, "work"), log: (m, f) => opts.log("warn", m, f),
    });
    this.ctx = { ...ctxPartial, builds: this.builds };
    core.apps.extraCheck = opts.catalog.check;
    this.runtime = new AppRuntimeService(this.ctx);
    this.reconciler = new Reconciler(this.ctx, this.runtime);
    this.deployments = new DeploymentService(this.ctx, this.runtime);
    this.invocations = new InvocationService(this.ctx, this.runtime);
    this.interApp = new InterAppService(this.ctx, this.runtime, this.invocations);
    if (instances) {
      instances.onExit = (inst, reason) => void this.runtime.onInstanceExit(inst, reason);
      instances.onServiceCall = (inst, f) => this.interApp.handleServiceCall(inst, f);
      instances.onContainerId = (id, cid) => core.store.tx(() => core.store.run("UPDATE runtime_instances SET container_id = ?, updated_at = ? WHERE id = ?", cid, iso(core.store.clock.now()), id));
    }
    this.deployments.autoActivate = (d) => this.#autoActivate(d);
    this.reconciler.extra = () => this.deployments.retryCleanups();
    // Mutual exclusion between new runs and user version switches; a stopped run cancels its deployments.
    core.runs.acceptGuard = () => {
      const open = core.store.get("SELECT 1 FROM deployments WHERE origin = 'user_history' AND status IN ('queued','preparing','ready')");
      if (open) throw new AgentOsError("DEPLOYMENT_BUSY", "a version switch is in progress; wait for it to finish");
    };
    core.runs.onStopInTx = (runId) => {
      const ids = this.deployments.cancelForRunInTx(runId);
      if (ids.length > 0) setImmediate(() => this.deployments.cleanupCancelled(ids));
    };
  }

  get runtimeReady(): boolean {
    return !!this.opts.driver && this.environmentProblems.length === 0 && this.runtime.engineReachable;
  }

  /** Startup steps 3–5 (spec §20.1). Never throws for runtime problems: the host stays up in a degraded state. */
  async boot(): Promise<void> {
    const s = this.core.store;
    s.tx(() => s.run("UPDATE meta SET host_boot_id = ?, catalog_hash = ? WHERE id = 1", this.bootId, this.opts.catalog.hash));
    this.runtime.revokePreviousBoot();
    this.builds.recoverAfterBoot();
    if (this.opts.driver) {
      try {
        const env = await this.opts.driver.checkEnvironment();
        this.environmentProblems = env.problems;
        if (env.platform !== this.opts.catalog.platform) this.environmentProblems.push(`engine platform ${env.platform} != catalog platform ${this.opts.catalog.platform}`);
      } catch (e) {
        this.environmentProblems = [(e as Error).message];
      }
    } else {
      this.environmentProblems = ["no container runtime configured"];
    }
    if (this.environmentProblems.length === 0) {
      const probe = await this.sandboxProbe();
      if (probe) this.environmentProblems.push(probe);
    }
    if (this.environmentProblems.length > 0) {
      // Spec §20.2 / V2-S07: never fall back to unisolated execution; code apps answer SANDBOX_UNAVAILABLE.
      this.ctx.driver = null;
      this.ctx.instances = null;
      this.opts.log("warn", "code runtime disabled", { problems: this.environmentProblems });
    }
    // Unreferenced staging directories from an interrupted artifact write.
    for (const st of this.artifacts.scan().staging) this.artifacts.removeStaging(st);
    if (this.runtimeReady) {
      await this.reconciler.runOnce().catch((e) => this.opts.log("error", "initial reconcile failed", { error: (e as Error).message }));
    }
    this.deployments.recoverAfterBoot();
    this.invocations.recoverAfterBoot();
    if (this.opts.autoReconcile !== false) this.reconciler.start();
  }

  /**
   * Start one throw-away container with the full app policy (no network, read-only, caps dropped, limits) and check
   * it runs. Skipped when no runtime image is present yet (prefetch builds them). Returns a problem or null.
   */
  async sandboxProbe(): Promise<string | null> {
    const driver = this.opts.driver;
    const lock = this.opts.catalog.locks()[0];
    if (!driver || !lock) return null;
    try {
      const img = await driver.inspectImage(lock.runtimeImage.name);
      if (!img.present) return null;
      const name = `agentos-probe-${this.bootId.slice(0, 8)}`;
      const bridge = path.join(this.opts.dataDir, "run", "probe");
      const { mkdirSync, rmSync } = await import("node:fs");
      mkdirSync(bridge, { recursive: true, mode: 0o700 });
      try {
        await driver.remove(name).catch(() => undefined);
        const { id } = await driver.create({
          name, image: lock.runtimeImage.name, role: "preview",
          labels: { "agentos.store": this.ctx.storeUUID, "agentos.role": "preview", "agentos.app": "probe", "agentos.revision": "probe", "agentos.instance": "probe", "agentos.boot": this.bootId },
          readOnlyMount: { hostPath: this.artifacts.root, containerPath: "/app" }, bridgeDir: bridge,
          command: ["node", "-e", "process.exit(0)"], env: { TZ: "UTC" }, limits: { ...RUNTIME_POLICY.app },
        });
        await driver.start(id);
        const st = await driver.wait(id, 20_000);
        const tail = st.exitCode === 0 ? "" : await driver.diagnostics(id, 500).catch(() => "");
        await driver.remove(id).catch(() => undefined);
        return st.exitCode === 0 ? null : `sandbox probe container failed (exit ${st.exitCode ?? "?"}): ${tail}`;
      } finally {
        rmSync(bridge, { recursive: true, force: true });
      }
    } catch (e) {
      return `sandbox probe failed: ${(e as Error).message}`;
    }
  }

  /** Shutdown (spec §20.1): stop admission, revoke instances, stop this workspace's containers. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.reconciler.stop();
    const inst = this.ctx.instances;
    if (inst) {
      for (const live of [...inst.live.values()]) await inst.destroy(live, "host shutdown");
    }
    if (this.opts.driver) {
      try {
        for (const c of await this.opts.driver.list(this.ctx.storeUUID)) await this.opts.driver.remove(c.id).catch(() => undefined);
      } catch {
        /* engine unreachable: the next boot reconciles */
      }
    }
  }

  // ---------------------------------------------------------------- user actions (through the gateway)

  /** POST /api/apps/:id/deployments — user history switch; 202 with the deployment id (spec §19.1). */
  switchVersion(meta: UserWriteMeta, appId: string, revisionId: string, expectedAppEpoch: number): WriteResult<DeploymentDto> {
    const r = this.core.gateway.write("apps.activate.history", { principal: { kind: "user" }, ...meta }, () => {
      const d = this.deployments.prepareInTx({ appId, revisionId, expectedAppEpoch, origin: "user_history", ownerRunId: null, requestKey: meta.operationKey, requestHash: meta.requestHash });
      return { status: 202, body: this.deployments.dto(d) };
    });
    void this.deployments.drive(r.body.deploymentId);
    return r;
  }

  async #autoActivate(d: DeploymentRow): Promise<void> {
    await this.deployments.freshProbe(d);
    try {
      this.core.gateway.write("apps.activate.history", { principal: { kind: "user" }, operationKey: `deployment:${d.id}:activate`, requestHash: d.request_hash }, () => ({
        status: 200,
        body: this.deployments.activateInTx(d.id, { runId: null }),
      }));
      fault("deploy.user_after_commit");
    } catch (e) {
      const ae = e as AgentOsError;
      if (ae.code !== "ALREADY_APPLIED") {
        this.core.store.tx(() => {
          const cur = this.deployments.get(d.id);
          if (cur && (cur.status === "ready" || cur.status === "preparing" || cur.status === "queued")) {
            this.core.store.run("UPDATE deployments SET status = 'failed', error_json = ?, updated_at = ? WHERE id = ?", JSON.stringify({ stage: "activate", code: ae.code ?? "PREPARE_FAILED", message: ae.message }), iso(this.core.store.clock.now()), d.id);
          }
        });
        const cand = d.candidate_instance_id ? this.ctx.instances?.get(d.candidate_instance_id) : undefined;
        if (cand) await this.ctx.instances!.destroy(cand, "activation failed");
        return;
      }
    }
    await this.deployments.afterCommit(d.id);
  }

  /**
   * Old POST /api/apps/:id/activate (spec §19.1): declarative history targets still answer the v0.1 200 result,
   * through a synchronous user_history deployment and the unified activation; code targets get DEPLOYMENT_REQUIRED.
   */
  activateDeclarativeHistory(meta: UserWriteMeta, appId: string, revisionId: string, expectedAppEpoch: number) {
    const r = this.core.gateway.write("apps.activate.history", { principal: { kind: "user" }, ...meta }, () => {
      const b = this.core.apps.revisionBundle(appId, revisionId) as AnyBundle | null;
      if (!b) throw new AgentOsError("NOT_FOUND", "revision not found", { revisionId });
      if (b.formatVersion === 2) throw new AgentOsError("DEPLOYMENT_REQUIRED", "code versions are switched through POST /api/apps/:appId/deployments");
      if (this.core.runs.activeRun() !== undefined) throw new AgentOsError("RUN_BUSY", "wait for the running generation to finish before switching versions");
      const d = this.deployments.prepareInTx({ appId, revisionId, expectedAppEpoch, origin: "user_history", ownerRunId: null, requestKey: meta.operationKey, requestHash: meta.requestHash });
      const v = this.core.apps.validate(appId, revisionId);
      if (!v.valid) throw new AgentOsError("SCHEMA_INCOMPATIBLE", "revision is not valid for this app", { issues: v.issues });
      this.core.store.run("UPDATE deployments SET status = 'ready', updated_at = ? WHERE id = ?", iso(this.core.store.clock.now()), d.id);
      const a = this.deployments.activateInTx(d.id, { runId: null });
      return { status: 200, body: { appId: a.appId, revisionId: a.revisionId, appEpoch: a.appEpoch, changed: a.changed, deploymentId: d.id } };
    });
    if (r.body.deploymentId) void this.deployments.afterCommit(r.body.deploymentId);
    return r;
  }

  control(meta: UserWriteMeta, appId: string, action: "start" | "stop" | "restart", expectedAppEpoch: number): WriteResult<{ controlEpoch: number; appEpoch: number }> {
    const r = this.core.gateway.write("apps.runtime.control", { principal: { kind: "user" }, ...meta }, () => ({
      status: 202,
      body: this.runtime.control(appId, action, expectedAppEpoch),
    }));
    if (!r.replayed) {
      // Stop: revoke now. Start/restart: the reconciler converges; nudge it.
      const ar = this.runtime.row(appId);
      const inst = this.ctx.instances;
      if (inst) {
        for (const row of this.core.store.all<{ id: string }>("SELECT id FROM runtime_instances WHERE app_id = ? AND observed_state = 'draining'", appId)) {
          const live = inst.get(row.id);
          if (live) void inst.destroy(live, `user ${action}`);
        }
      }
      if (ar?.enabled === 1) void this.reconciler.runOnce();
    }
    return r;
  }

  submitCommand(meta: UserWriteMeta, appId: string, commandId: string, input: unknown, expectedAppEpoch: number): WriteResult<{ invocationId: string; status: string }> {
    const principal = { kind: "user" as const };
    const r = this.core.gateway.write("apps.command", { principal, ...meta }, () => ({
      status: 202,
      body: this.invocations.acceptInTx(principal, appId, commandId, input, expectedAppEpoch, meta.operationKey),
    }));
    void this.invocations.dispatch(r.body.invocationId);
    return r;
  }

  createGrant(meta: UserWriteMeta, req: Parameters<InterAppService["createGrantInTx"]>[0]): WriteResult<GrantDto> {
    return this.core.gateway.write("grants.manage", { principal: { kind: "user" }, ...meta }, () => ({ status: 201, body: this.interApp.createGrantInTx(req) }));
  }

  revokeGrant(meta: UserWriteMeta, grantId: string): WriteResult<GrantDto> {
    return this.core.gateway.write("grants.manage", { principal: { kind: "user" }, ...meta }, () => ({ status: 200, body: this.interApp.revokeInTx(grantId) }));
  }
}
