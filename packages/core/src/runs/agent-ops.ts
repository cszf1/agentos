import { AgentOsError, LIMITS, canonicalJson, sha256Hex, type AnyBundle, type DataContract, type ValidationIssue } from "@agentos/contracts";
import type { Store } from "../persistence/store.js";
import type { AppService, ActivateResult } from "../apps/app-service.js";
import { authorize, type CapabilityGateway, type Principal } from "../capabilities/gateway.js";
import type { RunService } from "./run-service.js";
import { fault } from "../faults.js";

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
}

export type ToolOutcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string; issues?: ValidationIssue[] };

/**
 * Domain side of the agentos-app-builder tools. Every call resolves the single active run from os.sqlite,
 * checks the run fence inside the transaction, and writes through the capability gateway with a
 * host-generated operation key (store_uuid/run_id/pi_task_id/tool_name).
 */
export class AgentOps {
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
    return { ok: true, value: { apps: this.apps.listApps().map((a) => ({ appId: a.appId, title: a.title, appEpoch: a.appEpoch, activeRevisionId: a.activeRevisionId })) } };
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

  appValidate(id: ToolCallIdentity, revisionId: string): ToolOutcome<{ valid: boolean; errors: ValidationIssue[] }> {
    const entered = this.enter(id);
    if ("ok" in entered) return entered;
    const runId = entered.runId;
    authorize("apps.validate", this.principal(runId, id));
    const out = this.wrap(() =>
      this.store.read(() => {
        const run = this.runs.requireRun(runId);
        const r = this.apps.validate(run.target_app_id, revisionId);
        return { valid: r.valid, errors: r.issues };
      }),
    );
    if (out.ok) this.runs.recordValidation(runId, "validate", out.value.errors);
    return out;
  }

  appActivate(id: ToolCallIdentity, revisionId: string): ToolOutcome<ActivateResult> {
    const entered = this.enter(id);
    if ("ok" in entered) return entered;
    const runId = entered.runId;
    const principal = this.principal(runId, id);
    const out = this.wrap(() =>
      this.gateway.write("apps.activate.agent", { principal, operationKey: this.opKey(runId, id), requestHash: sha256Hex(canonicalJson({ revisionId })) }, () => {
        const run = this.runs.assertWritable(runId);
        const r = this.apps.activateInTx(run.target_app_id, revisionId, run.expected_app_epoch, { historicalOnly: false, runId });
        this.runs.setApplied(runId, revisionId);
        return { status: 200, body: r };
      }).body,
    );
    if (out.ok) fault("activate.after_commit");
    return out;
  }
}
