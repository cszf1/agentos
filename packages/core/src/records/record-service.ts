import { randomUUID } from "node:crypto";
import {
  AgentOsError,
  LIMITS,
  codePoints,
  utf8Bytes,
  valueIssue,
  type AppBundle,
  type DataContract,
  type FieldValue,
  type RecordEnvelope,
  type RecordPage,
} from "@agentos/contracts";
import { iso, type Store } from "../persistence/store.js";
import type { AppService, AppRow } from "../apps/app-service.js";
import { grantRecords, type Principal } from "../capabilities/gateway.js";

interface RecordRow {
  app_id: string;
  id: string;
  version: number;
  data_json: string;
  created_at: string;
  updated_at: string;
}

export interface ListQuery {
  q?: string;
  filters?: Record<string, unknown>;
  offset?: number;
  limit?: number;
}

/** Spec §8: every successful write of the record collection bumps apps.data_epoch once, inside its transaction. */
export function bumpDataEpoch(store: Store, appId: string): number {
  store.run("UPDATE apps SET data_epoch = data_epoch + 1 WHERE id = ?", appId);
  return store.get<{ e: number }>("SELECT data_epoch AS e FROM apps WHERE id = ?", appId)!.e;
}

export class RecordService {
  constructor(
    private readonly store: Store,
    private readonly apps: AppService,
  ) {}

  private loadActive(appId: string, opts: { expectedAppEpoch?: number } = {}): { app: AppRow; bundle: AppBundle; contract: DataContract } {
    const app = this.apps.requireApp(appId);
    const bundle = this.apps.activeBundle(app);
    if (!bundle) throw new AgentOsError("NOT_FOUND", "app has no active version yet", { appId });
    if (opts.expectedAppEpoch !== undefined && app.epoch !== opts.expectedAppEpoch) {
      throw new AgentOsError("APP_EPOCH_STALE", "the app version changed; reload before saving", { appEpoch: app.epoch });
    }
    // Spec §19.1: the records API serves declarative versions; a code version writes only through its commands.
    if (bundle.formatVersion !== 1) {
      throw new AgentOsError("FORBIDDEN", "this app version runs code; use its queries and commands", { appId, appEpoch: app.epoch });
    }
    return { app, bundle, contract: this.apps.contractOf(app) };
  }

  private envelope(row: RecordRow, bundle: AppBundle): RecordEnvelope {
    const full = JSON.parse(row.data_json) as Record<string, FieldValue>;
    const data: Record<string, FieldValue> = {};
    for (const k of Object.keys(bundle.data.fields)) if (Object.hasOwn(full, k)) data[k] = full[k]!;
    return { id: row.id, appId: row.app_id, recordVersion: row.version, createdAt: row.created_at, updatedAt: row.updated_at, data };
  }

  list(principal: Principal, appId: string, query: ListQuery): RecordPage {
    const offset = query.offset ?? 0;
    const limit = query.limit ?? LIMITS.defaultLimit;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AgentOsError("INVALID_REQUEST", "offset must be a non-negative integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.maxLimit) throw new AgentOsError("INVALID_REQUEST", `limit must be 1..${LIMITS.maxLimit}`);
    if (query.q !== undefined && codePoints(query.q) > LIMITS.maxSearchChars) {
      throw new AgentOsError("INVALID_REQUEST", `search is limited to ${LIMITS.maxSearchChars} characters`);
    }
    return this.store.read(() => {
      const { app, bundle } = this.loadActive(appId);
      grantRecords(principal, appId, bundle.manifest.capabilities, "records.read");
      const filters = query.filters ?? {};
      if (filters === null || typeof filters !== "object" || Array.isArray(filters)) throw new AgentOsError("INVALID_REQUEST", "filters must be an object");
      for (const [k, v] of Object.entries(filters)) {
        if (!bundle.view.filters.includes(k)) throw new AgentOsError("INVALID_REQUEST", `"${k}" is not a filter of this app`, { path: `/filters/${k}` });
        const spec = this.apps.contractOf(app).fields[k]!;
        const why = valueIssue(spec, v);
        if (why) throw new AgentOsError("INVALID_REQUEST", `filter "${k}" ${why}`, { path: `/filters/${k}` });
      }
      const rows = this.store.all<RecordRow>(
        "SELECT * FROM records WHERE app_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
        appId,
        LIMITS.maxRecordsPerApp,
      );
      const q = query.q !== undefined && query.q !== "" ? query.q : undefined;
      const matched: RecordRow[] = [];
      for (const r of rows) {
        const data = JSON.parse(r.data_json) as Record<string, unknown>;
        if (q !== undefined && bundle.view.searchField !== undefined) {
          const v = data[bundle.view.searchField];
          if (typeof v !== "string" || !v.includes(q)) continue;
        }
        let ok = true;
        for (const [k, v] of Object.entries(filters)) if (data[k] !== v) ok = false;
        if (ok) matched.push(r);
      }
      return {
        appEpoch: app.epoch,
        items: matched.slice(offset, offset + limit).map((r) => this.envelope(r, bundle)),
        total: matched.length,
        offset,
        limit,
      };
    });
  }

  private checkWritable(principal: Principal, appId: string, expectedAppEpoch: number) {
    const loaded = this.loadActive(appId, { expectedAppEpoch });
    grantRecords(principal, appId, loaded.bundle.manifest.capabilities, "records.write");
    if (loaded.app.epoch !== expectedAppEpoch) {
      throw new AgentOsError("APP_EPOCH_STALE", "the app version changed; reload before saving", { appEpoch: loaded.app.epoch });
    }
    return loaded;
  }

  private checkFields(bundle: AppBundle, contract: DataContract, input: Record<string, unknown>, root: string): void {
    const issues: { path: string; message: string }[] = [];
    for (const [k, v] of Object.entries(input)) {
      if (!bundle.view.formFields.includes(k)) {
        issues.push({ path: `${root}/${k}`, message: Object.hasOwn(contract.fields, k) ? "field is not editable in this version" : "unknown field" });
        continue;
      }
      const why = valueIssue(contract.fields[k]!, v);
      if (why) issues.push({ path: `${root}/${k}`, message: `${bundle.data.fields[k]?.label ?? k} ${why}` });
    }
    if (issues.length > 0) throw new AgentOsError("INVALID_RECORD", issues[0]!.message, { issues });
  }

  /** Inside a gateway write transaction. */
  create(principal: Principal, appId: string, expectedAppEpoch: number, input: Record<string, unknown>): RecordEnvelope {
    const { bundle, contract } = this.checkWritable(principal, appId, expectedAppEpoch);
    this.checkFields(bundle, contract, input, "/data");
    const data: Record<string, unknown> = {};
    const missing: { path: string; message: string }[] = [];
    for (const [k, spec] of Object.entries(contract.fields)) {
      if (Object.hasOwn(input, k)) data[k] = input[k];
      else if (spec.default !== undefined) data[k] = spec.default;
      else missing.push({ path: `/data/${k}`, message: `${bundle.data.fields[k]?.label ?? k} is required` });
    }
    if (missing.length > 0) throw new AgentOsError("INVALID_RECORD", missing[0]!.message, { issues: missing });
    const text = JSON.stringify(data);
    if (utf8Bytes(text) > LIMITS.maxRecordBytes) throw new AgentOsError("LIMIT_EXCEEDED", `a record is limited to ${LIMITS.maxRecordBytes} bytes`);
    const n = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM records WHERE app_id = ?", appId)!.n;
    if (n >= LIMITS.maxRecordsPerApp) throw new AgentOsError("LIMIT_EXCEEDED", `an app holds at most ${LIMITS.maxRecordsPerApp} records`);
    const id = randomUUID();
    const now = iso(this.store.clock.now());
    this.store.run("INSERT INTO records (app_id, id, version, data_json, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)", appId, id, text, now, now);
    bumpDataEpoch(this.store, appId);
    this.store.event("record.created", { appId, recordId: id }, { appId });
    return this.envelope(this.store.get<RecordRow>("SELECT * FROM records WHERE app_id = ? AND id = ?", appId, id)!, bundle);
  }

  private requireRecord(appId: string, id: string, expectedVersion: number): RecordRow {
    const row = this.store.get<RecordRow>("SELECT * FROM records WHERE app_id = ? AND id = ?", appId, id);
    if (!row) throw new AgentOsError("NOT_FOUND", "record not found", { recordId: id });
    if (row.version !== expectedVersion) {
      throw new AgentOsError("RECORD_VERSION_STALE", "the record changed since you opened it; reload and retry", { recordVersion: row.version });
    }
    return row;
  }

  update(principal: Principal, appId: string, id: string, expectedAppEpoch: number, expectedVersion: number, changes: Record<string, unknown>): RecordEnvelope {
    const { bundle, contract } = this.checkWritable(principal, appId, expectedAppEpoch);
    if (Object.keys(changes).length === 0) throw new AgentOsError("INVALID_RECORD", "changes must not be empty");
    this.checkFields(bundle, contract, changes, "/changes");
    const row = this.requireRecord(appId, id, expectedVersion);
    const data = { ...(JSON.parse(row.data_json) as Record<string, unknown>), ...changes };
    const text = JSON.stringify(data);
    if (utf8Bytes(text) > LIMITS.maxRecordBytes) throw new AgentOsError("LIMIT_EXCEEDED", `a record is limited to ${LIMITS.maxRecordBytes} bytes`);
    const now = iso(this.store.clock.now());
    this.store.run("UPDATE records SET data_json = ?, version = version + 1, updated_at = ? WHERE app_id = ? AND id = ?", text, now, appId, id);
    bumpDataEpoch(this.store, appId);
    this.store.event("record.updated", { appId, recordId: id }, { appId });
    return this.envelope(this.store.get<RecordRow>("SELECT * FROM records WHERE app_id = ? AND id = ?", appId, id)!, bundle);
  }

  remove(principal: Principal, appId: string, id: string, expectedAppEpoch: number, expectedVersion: number): { deleted: true; id: string } {
    this.checkWritable(principal, appId, expectedAppEpoch);
    this.requireRecord(appId, id, expectedVersion);
    this.store.run("DELETE FROM records WHERE app_id = ? AND id = ?", appId, id);
    bumpDataEpoch(this.store, appId);
    this.store.event("record.deleted", { appId, recordId: id }, { appId });
    return { deleted: true, id };
  }
}
