import { AgentOsError, LIMITS, canonicalJson, sha256Hex, type AnyBundle, type DataContract, type ValidationIssue, isCodeBundle } from "@agentos/contracts";
import type { Store } from "../persistence/store.js";
import type { AppService, ActivateResult } from "../apps/app-service.js";
import { authorize, type CapabilityGateway, type Principal } from "../capabilities/gateway.js";
import type { RunService } from "./run-service.js";
import { fault } from "../faults.js";
import type { RuntimeSystem } from "../runtime/system.js";
import type { DeploymentDto } from "../deployments/deployment-service.js";
import type { SystemCapabilities } from "../system/system-capabilities.js";

/** Spec §20.1: build runs never touch system resources; system_plan runs never stage, prepare or publish apps. */
const BUILD_ONLY = new Set(["app_get", "app_stage", "app_validate", "runtime_catalog", "service_catalog", "app_prepare", "app_prepare_status", "app_activate"]);
const PLAN_ONLY = new Set(["system_resource_list", "system_read", "system_plan"]);
import { CODE_LIMITS, COMPONENT_TYPES, COMPONENT_TYPES_V2, UI_LIMITS } from "@agentos/contracts";

/** Identity of one agent tool call, built by the Pi adapter (never by the model). */
export interface ToolCallIdentity {
  piTaskId: string;
  toolName: string;
}

export interface AppGetResult {
  appId: string;
  expectedAppEpoch: number;
  mode: "create" | "modify";
  intent: string;
  activeRevisionId: string | null;
  activeBundle: AnyBundle | null;
  contract: DataContract;
  limits: { maxBundleBytes: number; maxFields: number; maxEnumValues: number; maxStageAttempts: number };
  dataEpoch?: number;
  codeRuntimeAvailable?: boolean;
  codeLimits?: unknown;
  runtimeHealth?: string | null;
}

export type ToolOutcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string; issues?: ValidationIssue[] };

/**
 * Domain side of the agentos-app-builder tools. Every call resolves the single active run from os.sqlite,
 * checks the run fence inside the transaction, and writes through the capability gateway with a
 * host-generated operation key (store_uuid/run_id/pi_task_id/tool_name).
 */
export class AgentOps {
  /** v0.2 runtime services (set by the host after the runtime system starts). */
  runtime: RuntimeSystem | null = null;
  /** v0.3 system capabilities (set by the host). */
  system: SystemCapabilities | null = null;

  constructor(
    private readonly store: Store,
    private readonly gateway: CapabilityGateway,
    private readonly apps: AppService,
    private readonly runs: RunService,
  ) {}

  private principal(runId: string, id: ToolCallIdentity): Principal {
    return { kind: "run", runId, piTaskId: id.piTaskId, toolName: id.toolName };
  }

  private opKey(runId: string, id: ToolCallIdentity): string {
    return `${this.store.meta().store_uuid}/${runId}/${id.piTaskId}/${id.toolName}`;
  }

  /** For logs only: the active run and the host operation key this call maps to (null when no run is active). */
  describeCall(id: ToolCallIdentity): { runId: string; operationKey: string } | null {
    try {
      const run = this.runs.currentToolRun();
      return { runId: run.id, operationKey: this.opKey(run.id, id) };
    } catch {
      return null;
    }
  }

  private enter(id: ToolCallIdentity, isStage = false): { runId: string } | ToolOutcome<never> {
    let run;
    try {
      run = this.runs.currentToolRun();
    } catch (e) {
      return { ok: false, code: "FORBIDDEN", message: (e as Error).message };
    }
    const mode = run.mode ?? "build";
    if (mode === "system_plan" && BUILD_ONLY.has(id.toolName)) return { ok: false, code: "FORBIDDEN", message: `${id.toolName} is not available in a system_plan run` };
    if (mode !== "system_plan" && PLAN_ONLY.has(id.toolName)) return { ok: false, code: "FORBIDDEN", message: `${id.toolName} is only available in a system_plan run` };
    const budget = this.runs.enterTool(run.id, id.piTaskId, id.toolName, isStage);
    if (!budget.ok) return { ok: false, code: "BUDGET_EXCEEDED", message: budget.reason };
    return { runId: run.id };
  }

  private wrap<T>(fn: () => T): ToolOutcome<T> {
    try {
      return { ok: true, value: fn() };
    } catch (e) {
      if (e instanceof AgentOsError) {
        const issues = (e.details?.issues as ValidationIssue[] | undefined) ?? undefined;
        return { ok: false, code: e.code, message: e.message, ...(issues ? { issues } : {}) };
      }
      throw e;
    }
  }

  systemInfo(id: ToolCallIdentity, read: () => unknown): ToolOutcome<unknown> {
    const entered = this.enter(id);
    if ("ok" in entered) return entered;
    authorize("system.info", this.principal(entered.runId, id));
    return { ok: true, value: read() };
  }

  appList(id: ToolCallIdentity): ToolOutcome<unknown> {
    const entered = this.enter(id);
    if ("ok" in entered) return entered;
    authorize("apps.list", this.principal(entered.runId, id));
    return {
      ok: true,
      value: {
        apps: this.apps.listApps().map((a) => {
          const b = this.apps.activeBundle(this.apps.requireApp(a.appId));
          return { appId: a.appId, title: a.title, appEpoch: a.appEpoch, activeRevisionId: a.activeRevisionId, runtime: b?.manifest.runtime ?? null, health: b && isCodeBundle(b) ? (this.runtime?.runtime.row(a.appId)?.health ?? "stopped") : null };
        }),
      },
    };
  }

  appGet(id: ToolCallIdentity): ToolOutcome<AppGetResult> {
    const entered = this.enter(id);
    if ("ok" in entered) return entered;
    authorize("apps.get", this.principal(entered.runId, id));
    return this.wrap(() =>
      this.store.read(() => {
        const run = this.runs.requireRun(entered.runId);
        const frozen = this.runs.frozen(run);
        const app = this.apps.requireApp(run.target_app_id);
        return {
          appId: app.id,
          expectedAppEpoch: run.expected_app_epoch,
          mode: frozen.mode,
          intent: run.intent,
          activeRevisionId: app.active_revision_id,
          activeBundle: this.apps.activeBundle(app),
          contract: this.apps.contractOf(app),
          limits: { maxBundleBytes: LIMITS.maxBundleBytes, maxFields: LIMITS.maxFields, maxEnumValues: LIMITS.maxEnumValues, maxStageAttempts: this.runs.settings.maxStageAttempts },
          dataEpoch: (app as { data_epoch?: number }).data_epoch ?? 0,
          codeRuntimeAvailable: this.runtime?.runtimeReady ?? false,
          codeLimits: { ...CODE_LIMITS, ui: UI_LIMITS, components: COMPONENT_TYPES, componentsV2: COMPONENT_TYPES_V2 },
          runtimeHealth: this.runtime?.runtime.row(app.id)?.health ?? null,
        };
      }),
    );
  }

  appStage(id: ToolCallIdentity, bundle: unknown): ToolOutcome<{ revisionId: string; valid: boolean; errors: ValidationIssue[] }> {
    const entered = this.enter(id, true);
    if ("ok" in entered) return entered;
    const runId = entered.runId;
    const principal = this.principal(runId, id);
    const out = this.wrap(() =>
      this.gateway.write("apps.stage", { principal, operationKey: this.opKey(runId, id), requestHash: sha256Hex(canonicalJson({ bundle: bundle ?? null })) }, () => {
        const run = this.runs.assertWritable(runId);
        const r = this.apps.stage(run.target_app_id, bundle, runId);
        return { status: 200, body: { revisionId: r.revisionId, valid: r.issues.length === 0, errors: r.issues } };
      }).body,
    );
    if (out.ok) this.runs.recordValidation(runId, "stage", out.value.errors);
    else if (out.issues) this.runs.recordValidation(runId, "stage", out.issues);
    return out;
  }

  appValidate(id: ToolCallIdentity, revisionId: string): ToolOutcome<{ revisionId: string; valid: boolean; errors: ValidationIssue[] }> {
    const entered = this.enter(id);
    if ("ok" in entered) return entered;
    const runId = entered.runId;
    authorize("apps.validate", this.principal(runId, id));
    const out = this.wrap(() =>
      this.store.read(() => {
        const run = this.runs.requireRun(runId);
        const r = this.apps.validate(run.target_app_id, revisionId);
        return { revisionId, valid: r.valid, errors: r.issues };
      }),
    );
    if (out.ok) this.runs.recordValidation(runId, "validate", out.value.errors);
    return out;
  }

  runtimeCatalog(id: ToolCallIdentity): ToolOutcome<unknown> {
    const entered = this.enter(id);
    if ("ok" in entered) return entered;
    authorize("runtime.catalog", this.principal(entered.runId, id));
    const sys = this.runtime;
    if (!sys) return { ok: true, value: { codeRuntimeAvailable: false, locks: [] } };
    return {
      ok: true,
      value: {
        codeRuntimeAvailable: sys.runtimeReady,
        problems: sys.environmentProblems.slice(0, 5),
        platform: sys.opts.catalog.platform,
        locks: sys.opts.catalog.locks().map((l) => ({
          runtimeLockId: l.id,
          profileId: l.profileId,
          sdk: { module: "@agentos/app-sdk", version: l.sdkVersion, abiVersion: l.abiVersion },
          approvedModules: l.modules.map((m) => ({ name: m.name, version: m.version, import: m.specifiers })),
          compiler: l.compiler,
        })),
      },
    };
  }

  serviceCatalog(id: ToolCallIdentity): ToolOutcome<unknown> {
    const entered = this.enter(id);
    if ("ok" in entered) return entered;
    authorize("services.read", this.principal(entered.runId, id));
    const items = this.runtime?.interApp.catalog() ?? [];
    // Names, descriptions and schemas only: never business data or grant secrets.
    return { ok: true, value: { services: items.map((e) => ({ appId: e.appId, appTitle: e.appTitle, exportName: e.exportName, contractVersion: e.contractVersion, description: e.description, inputSchema: e.inputSchema, outputSchema: e.outputSchema })) } };
  }

  /** app_prepare: idempotent deployment registration, then a bounded wait (≤30 s) outside any transaction. */
  async appPrepare(id: ToolCallIdentity, revisionId: string): Promise<ToolOutcome<DeploymentDto>> {
    const entered = this.enter(id);
    if ("ok" in entered) return entered;
    const runId = entered.runId;
    const sys = this.runtime;
    if (!sys) return { ok: false, code: "SANDBOX_UNAVAILABLE", message: "the code runtime is not available on this host" };
    const principal = this.principal(runId, id);
    const opKey = this.opKey(runId, id);
    const out = this.wrap(() =>
      this.gateway.write("apps.prepare.agent", { principal, operationKey: opKey, requestHash: sha256Hex(canonicalJson({ revisionId })) }, () => {
        const run = this.runs.assertWritable(runId);
        const d = sys.deployments.prepareInTx({
          appId: run.target_app_id, revisionId, expectedAppEpoch: run.expected_app_epoch, origin: "agent_prepare", ownerRunId: runId,
          requestKey: opKey, requestHash: sha256Hex(canonicalJson({ revisionId })), deadlineMs: Date.parse(run.deadline_at),
        });
        return { status: 202, body: { deploymentId: d.id } };
      }).body,
    );
    if (!out.ok) return out;
    fault("tool.app_prepare.after_accept");
    // Replays find the same deployment; a finished one is never restarted by its old acceptance receipt.
    void sys.deployments.drive(out.value.deploymentId);
    const d = await sys.deployments.waitSettled(out.value.deploymentId, 30_000);
    return { ok: true, value: sys.deployments.dto(d) };
  }

  /** app_prepare_status: read-only projection, may wait up to 10 s; never advances or rebuilds anything. */
  async appPrepareStatus(id: ToolCallIdentity, deploymentId: string): Promise<ToolOutcome<DeploymentDto>> {
    const entered = this.enter(id);
    if ("ok" in entered) return entered;
    const runId = entered.runId;
    authorize("deployments.read", this.principal(runId, id));
    const sys = this.runtime;
    if (!sys) return { ok: false, code: "SANDBOX_UNAVAILABLE", message: "the code runtime is not available on this host" };
    const d = sys.deployments.get(deploymentId);
    if (!d || d.owner_run_id !== runId) return { ok: false, code: "NOT_FOUND", message: "deployment not found for this run" };
    const settled = await sys.deployments.waitSettled(deploymentId, 10_000);
    return { ok: true, value: sys.deployments.dto(settled) };
  }

  /** app_activate: consume a ready deployment of this run (spec §14.2). */
  async appActivate(id: ToolCallIdentity, deploymentId: string): Promise<ToolOutcome<ActivateResult & { deploymentId: string; noOp: boolean; health: string | null }>> {
    const entered = this.enter(id);
    if ("ok" in entered) return entered;
    const runId = entered.runId;
    const sys = this.runtime;
    if (!sys) return { ok: false, code: "SANDBOX_UNAVAILABLE", message: "the runtime services are not available" };
    const principal = this.principal(runId, id);
    const d0 = sys.deployments.get(deploymentId);
    // An expired candidate is terminated (and its slot released) in a committed transaction first.
    if (d0 && d0.owner_run_id === runId) sys.deployments.expireIfDue(deploymentId);
    if (d0) {
      try {
        await sys.beforeActivate?.(d0.app_id);
      } catch (e) {
        if (e instanceof AgentOsError) return { ok: false, code: e.code, message: e.message };
        throw e;
      }
      await sys.deployments.freshProbe(sys.deployments.get(deploymentId) ?? d0);
    }
    const out = this.wrap(() =>
      this.gateway.write("apps.activate.agent", { principal, operationKey: this.opKey(runId, id), requestHash: sha256Hex(canonicalJson({ deploymentId })) }, () => {
        this.runs.assertWritable(runId);
        const r = sys.deployments.activateInTx(deploymentId, { runId });
        this.runs.setApplied(runId, r.revisionId);
        return { status: 200, body: { appId: r.appId, revisionId: r.revisionId, appEpoch: r.appEpoch, changed: r.changed, deploymentId, noOp: r.noOp } };
      }).body,
    );
    if (!out.ok) {
      // Expired between the check above and the activation: persist the failure now (the activate tx rolled it back).
      if (out.code === "PREPARE_EXPIRED" && d0?.owner_run_id === runId) sys.deployments.expireIfDue(deploymentId);
      return out;
    }
    fault("activate.after_commit");
    void sys.deployments.afterCommit(deploymentId);
    return { ok: true, value: { ...out.value, health: sys.runtime.row(out.value.appId)?.health ?? null } };
  }

  // ---------------------------------------------------------------- v0.3 system_plan tools (spec §20.2)

  private async wrapAsync<T>(fn: () => Promise<T>): Promise<ToolOutcome<T>> {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      if (e instanceof AgentOsError) return { ok: false, code: e.code, message: e.message };
      throw e;
    }
  }

  systemResourceList(id: ToolCallIdentity): ToolOutcome<unknown> {
    const entered = this.enter(id);
    if ("ok" in entered) return entered;
    return this.wrap(() => {
      if (!this.system) throw new AgentOsError("PROVIDER_UNAVAILABLE", "system capabilities are not available");
      const scope = this.system.runScope(entered.runId).scope;
      return { resources: this.system.runResources(entered.runId), readCapabilities: scope?.readCapabilities ?? [], proposeCapabilities: scope?.proposeCapabilities ?? [], broker: { ready: this.system.broker.status.brokerReady } };
    });
  }

  async systemRead(id: ToolCallIdentity, args: { resourceId: string; capabilityId: string; params?: unknown }): Promise<ToolOutcome<unknown>> {
    const entered = this.enter(id);
    if ("ok" in entered) return entered;
    return this.wrapAsync(async () => {
      if (!this.system) throw new AgentOsError("PROVIDER_UNAVAILABLE", "system capabilities are not available");
      return this.system.runRead(entered.runId, id.piTaskId, String(args.resourceId), String(args.capabilityId), args.params ?? {});
    });
  }

  /** Freezes at most one action for this run; never executes it (the user confirms in the Shell). */
  async systemPlan(id: ToolCallIdentity, args: { resourceId: string; capabilityId: string; params?: unknown; observationIds?: unknown }): Promise<ToolOutcome<unknown>> {
    const entered = this.enter(id, true);
    if ("ok" in entered) return entered;
    authorize("system.actions.plan", this.principal(entered.runId, id));
    return this.wrapAsync(async () => {
      if (!this.system) throw new AgentOsError("PROVIDER_UNAVAILABLE", "system capabilities are not available");
      const obs = Array.isArray(args.observationIds) ? args.observationIds.map(String) : [];
      const a = await this.system.runPlan(entered.runId, id.piTaskId, { resourceId: String(args.resourceId), capabilityId: String(args.capabilityId), params: args.params ?? {}, observationIds: obs });
      const v = this.system.actions.view(a);
      return { actionId: v.actionId, state: v.state, planHash: v.planHash, preview: v.preview, expiresAt: v.expiresAt, note: "The plan waits for the user's confirmation in the AgentOS Shell. It has NOT been executed. Finish now." };
    });
  }
}
