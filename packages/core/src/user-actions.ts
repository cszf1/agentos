import { AgentOsError, type RecordEnvelope, type RunCreateBody, type RunView } from "@agentos/contracts";
import type { Store } from "./persistence/store.js";
import type { AppService, ActivateResult } from "./apps/app-service.js";
import type { RecordService } from "./records/record-service.js";
import type { RunService } from "./runs/run-service.js";
import type { CapabilityGateway, WriteResult } from "./capabilities/gateway.js";

/** Idempotency envelope of one user write (built by the HTTP layer from headers and session). */
export interface UserWriteMeta {
  operationKey: string;
  requestHash: string;
  clientEpoch?: number;
}

/**
 * Every user-initiated domain write goes through here and therefore through the capability gateway.
 * Record actions run as the app's principal (its own records, its granted capabilities, its current epoch).
 */
export class UserActions {
  constructor(
    private readonly store: Store,
    private readonly gateway: CapabilityGateway,
    private readonly apps: AppService,
    private readonly records: RecordService,
    private readonly runs: RunService,
  ) {}

  createRecord(meta: UserWriteMeta, appId: string, expectedAppEpoch: number, data: Record<string, unknown>): WriteResult<RecordEnvelope> {
    const principal = { kind: "app" as const, appId, viaUser: true };
    return this.gateway.write("records.write", { principal, ...meta }, () => ({
      status: 201,
      body: this.records.create(principal, appId, expectedAppEpoch, data),
    }));
  }

  updateRecord(meta: UserWriteMeta, appId: string, recordId: string, expectedAppEpoch: number, expectedRecordVersion: number, changes: Record<string, unknown>): WriteResult<RecordEnvelope> {
    const principal = { kind: "app" as const, appId, viaUser: true };
    return this.gateway.write("records.write", { principal, ...meta }, () => ({
      status: 200,
      body: this.records.update(principal, appId, recordId, expectedAppEpoch, expectedRecordVersion, changes),
    }));
  }

  deleteRecord(meta: UserWriteMeta, appId: string, recordId: string, expectedAppEpoch: number, expectedRecordVersion: number): WriteResult<{ deleted: true; id: string }> {
    const principal = { kind: "app" as const, appId, viaUser: true };
    return this.gateway.write("records.write", { principal, ...meta }, () => ({
      status: 200,
      body: this.records.remove(principal, appId, recordId, expectedAppEpoch, expectedRecordVersion),
    }));
  }

  /** Manual switch to a previously activated revision; refused while a generation run is active. */
  activateHistorical(meta: UserWriteMeta, appId: string, revisionId: string, expectedAppEpoch: number): WriteResult<ActivateResult> {
    return this.gateway.write("apps.activate.history", { principal: { kind: "user" }, ...meta }, () => {
      if (this.runs.activeRun() !== undefined) throw new AgentOsError("RUN_BUSY", "wait for the running generation to finish before switching versions");
      return { status: 200, body: this.apps.activateInTx(appId, revisionId, expectedAppEpoch, { historicalOnly: true, runId: null }) };
    });
  }

  submitRun(meta: UserWriteMeta, body: RunCreateBody, engineIdle: boolean): WriteResult<{ runId: string; targetAppId: string; status: string }> {
    return this.gateway.write("runs.submit", { principal: { kind: "user" }, ...meta }, () => ({
      status: 202,
      body: this.runs.accept(body, meta.operationKey, meta.requestHash, engineIdle),
    }));
  }

  cancelRun(meta: UserWriteMeta, runId: string): WriteResult<RunView> {
    return this.gateway.write("runs.cancel", { principal: { kind: "user" }, ...meta }, () => this.runs.cancel(runId));
  }

  get storeRef(): Store {
    return this.store;
  }
}
