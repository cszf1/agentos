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

  /** v0.4 (spec §18): an archived app takes no new writes; the check races archive inside the same transaction. */
  #requireActive(appId: string): void {
    const lc = this.store.get<{ state: string }>("SELECT state FROM app_lifecycle WHERE app_id = ?", appId);
    if (lc && lc.state !== "active") throw new AgentOsError("APP_ARCHIVED", "this app is archived; restore it to use it", { appId, lifecycle: lc.state });
  }

  createRecord(meta: UserWriteMeta, appId: string, expectedAppEpoch: number, data: Record<string, unknown>): WriteResult<RecordEnvelope> {
    const principal = { kind: "app" as const, appId, viaUser: true };
    return this.gateway.write("records.write", { principal, ...meta }, () => {
      this.#requireActive(appId);
      return { status: 201, body: this.records.create(principal, appId, expectedAppEpoch, data) };
    });
  }

  updateRecord(meta: UserWriteMeta, appId: string, recordId: string, expectedAppEpoch: number, expectedRecordVersion: number, changes: Record<string, unknown>): WriteResult<RecordEnvelope> {
    const principal = { kind: "app" as const, appId, viaUser: true };
    return this.gateway.write("records.write", { principal, ...meta }, () => {
      this.#requireActive(appId);
      return { status: 200, body: this.records.update(principal, appId, recordId, expectedAppEpoch, expectedRecordVersion, changes) };
    });
  }

  deleteRecord(meta: UserWriteMeta, appId: string, recordId: string, expectedAppEpoch: number, expectedRecordVersion: number): WriteResult<{ deleted: true; id: string }> {
    const principal = { kind: "app" as const, appId, viaUser: true };
    return this.gateway.write("records.write", { principal, ...meta }, () => {
      this.#requireActive(appId);
      return { status: 200, body: this.records.remove(principal, appId, recordId, expectedAppEpoch, expectedRecordVersion) };
    });
  }

  /** Manual switch to a previously activated revision; refused while a generation run is active. */
  activateHistorical(meta: UserWriteMeta, appId: string, revisionId: string, expectedAppEpoch: number): WriteResult<ActivateResult> {
    return this.gateway.write("apps.activate.history", { principal: { kind: "user" }, ...meta }, () => {
      if (this.runs.targetBusy(appId) !== undefined) throw new AgentOsError("TARGET_BUSY", "a task is changing this app; wait for it to finish before switching versions");
      return { status: 200, body: this.apps.activateInTx(appId, revisionId, expectedAppEpoch, { historicalOnly: true, runId: null }) };
    });
  }

  /** Spec §7.1: a valid request is persisted and queued (202 + runId + queue state); only a full queue refuses it. */
  submitRun(meta: UserWriteMeta, body: RunCreateBody): WriteResult<{ runId: string; targetAppId: string | null; status: string; queueState: string; waitReason: string | null }> {
    return this.gateway.write("runs.submit", { principal: { kind: "user" }, ...meta }, () => ({
      status: 202,
      body: this.runs.accept(body, meta.operationKey, meta.requestHash),
    }));
  }

  cancelRun(meta: UserWriteMeta, runId: string): WriteResult<RunView> {
    return this.gateway.write("runs.cancel", { principal: { kind: "user" }, ...meta }, () => this.runs.cancel(runId));
  }

  get storeRef(): Store {
    return this.store;
  }
}
