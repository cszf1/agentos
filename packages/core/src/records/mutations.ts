import { randomUUID } from "node:crypto";
import {
  AgentOsError,
  CODE_LIMITS,
  LIMITS,
  canonicalJson,
  utf8Bytes,
  valueIssue,
  type CodeBundle,
  type CommandDecl,
  type DataContract,
  type Mutation,
} from "@agentos/contracts";
import { iso, type Store } from "../persistence/store.js";
import { bumpDataEpoch } from "./record-service.js";

export interface CommitResult {
  created: Record<string, string>;
  updated: string[];
  deleted: string[];
  dataEpoch: number;
  changed: boolean;
}

interface RecordRow {
  id: string;
  version: number;
  data_json: string;
}

const bad = (message: string, path: string) => new AgentOsError("INVALID_MUTATION", message, { path });

export interface PlanArgs {
  bundle: CodeBundle;
  command: CommandDecl;
  contract: DataContract;
  mutations: Mutation[];
}

/**
 * Pure validation of a mutation plan against the revision, the command declaration and a record lookup
 * (spec §10.3). Used for the real commit and for preview simulation. Returns the full data of each create.
 */
export function checkPlan(args: PlanArgs, getRecord: (id: string) => { version: number; data: Record<string, unknown> } | undefined, recordCount: number): { creates: Record<string, Record<string, unknown>> } {
  const { bundle, command, contract, mutations } = args;
  if (mutations.length > CODE_LIMITS.maxMutations) throw bad(`at most ${CODE_LIMITS.maxMutations} mutations`, "/mutations");
  if (utf8Bytes(canonicalJson(mutations)) > CODE_LIMITS.maxMutationPlanBytes) throw bad(`the plan exceeds ${CODE_LIMITS.maxMutationPlanBytes} bytes`, "/mutations");
  const visible = bundle.data.fields;
  const writable = new Set(command.writableFields);
  const seenRecords = new Set<string>();
  const seenKeys = new Set<string>();
  const creates: Record<string, Record<string, unknown>> = {};
  const checkData = (data: Record<string, unknown>, path: string) => {
    for (const [k, v] of Object.entries(data)) {
      if (!Object.hasOwn(visible, k)) throw bad(`field "${k}" is not part of this version (hidden or unknown fields cannot be written)`, `${path}/${k}`);
      if (!writable.has(k)) throw bad(`command may not write field "${k}"`, `${path}/${k}`);
      const spec = contract.fields[k];
      if (!spec) throw bad(`field "${k}" is not in the data contract`, `${path}/${k}`);
      const why = valueIssue(spec, v);
      if (why) throw bad(`field "${k}" ${why}`, `${path}/${k}`);
    }
  };
  let count = recordCount;
  mutations.forEach((m, i) => {
    const p = `/mutations/${i}`;
    if (!command.operations.includes(m.kind)) throw bad(`command may not ${m.kind} records`, `${p}/kind`);
    if (m.kind === "create") {
      if (seenKeys.has(m.localKey)) throw bad("duplicate localKey", `${p}/localKey`);
      seenKeys.add(m.localKey);
      checkData(m.data, `${p}/data`);
      const full: Record<string, unknown> = {};
      for (const [k, spec] of Object.entries(contract.fields)) {
        if (Object.hasOwn(m.data, k)) full[k] = m.data[k];
        else if (spec.default !== undefined) full[k] = spec.default;
        else throw bad(`required field "${k}" is missing`, `${p}/data/${k}`);
      }
      if (utf8Bytes(JSON.stringify(full)) > LIMITS.maxRecordBytes) throw new AgentOsError("LIMIT_EXCEEDED", `a record is limited to ${LIMITS.maxRecordBytes} bytes`, { path: p });
      count++;
      if (count > LIMITS.maxRecordsPerApp) throw new AgentOsError("LIMIT_EXCEEDED", `an app holds at most ${LIMITS.maxRecordsPerApp} records`, { path: p });
      creates[m.localKey] = full;
      return;
    }
    if (seenRecords.has(m.recordId)) throw bad("a record may appear at most once per command", `${p}/recordId`);
    seenRecords.add(m.recordId);
    const row = getRecord(m.recordId);
    if (!row) throw bad(`record ${m.recordId} does not exist`, `${p}/recordId`);
    if (row.version !== m.expectedRecordVersion) {
      throw new AgentOsError("RECORD_VERSION_STALE", `record ${m.recordId} changed`, { path: p, recordVersion: row.version });
    }
    if (m.kind === "update") {
      checkData(m.changes, `${p}/changes`);
      if (utf8Bytes(JSON.stringify({ ...row.data, ...m.changes })) > LIMITS.maxRecordBytes) throw new AgentOsError("LIMIT_EXCEEDED", `a record is limited to ${LIMITS.maxRecordBytes} bytes`, { path: p });
    }
  });
  return { creates };
}

/**
 * Host-side validation and atomic commit of a command's mutation plan (spec §10.3). Runs inside the caller's write
 * transaction: any failure throws and nothing of the batch remains. data_epoch increases once when anything changed.
 */
export function commitMutations(
  store: Store,
  args: PlanArgs & { appId: string; expectedDataEpoch: number },
): CommitResult {
  const { appId, mutations } = args;
  const app = store.get<{ data_epoch: number }>("SELECT data_epoch FROM apps WHERE id = ?", appId);
  if (!app) throw new AgentOsError("NOT_FOUND", "app not found");
  if (app.data_epoch !== args.expectedDataEpoch) {
    throw new AgentOsError("DATA_EPOCH_STALE", "records changed while the command ran; nothing was written", { dataEpoch: app.data_epoch });
  }
  const getRecord = (id: string) => {
    const r = store.get<RecordRow>("SELECT id, version, data_json FROM records WHERE app_id = ? AND id = ?", appId, id);
    return r ? { version: r.version, data: JSON.parse(r.data_json) as Record<string, unknown> } : undefined;
  };
  const count = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM records WHERE app_id = ?", appId)!.n;
  const { creates } = checkPlan(args, getRecord, count);
  const now = iso(store.clock.now());
  const result: CommitResult = { created: {}, updated: [], deleted: [], dataEpoch: app.data_epoch, changed: false };
  for (const m of mutations) {
    if (m.kind === "create") {
      const id = randomUUID();
      store.run("INSERT INTO records (app_id, id, version, data_json, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)", appId, id, JSON.stringify(creates[m.localKey]), now, now);
      result.created[m.localKey] = id;
      result.changed = true;
    } else if (m.kind === "update") {
      const row = getRecord(m.recordId)!;
      const before = JSON.stringify(row.data);
      const text = JSON.stringify({ ...row.data, ...m.changes });
      if (text !== before) {
        store.run("UPDATE records SET data_json = ?, version = version + 1, updated_at = ? WHERE app_id = ? AND id = ?", text, now, appId, m.recordId);
        result.updated.push(m.recordId);
        result.changed = true;
      }
    } else {
      store.run("DELETE FROM records WHERE app_id = ? AND id = ?", appId, m.recordId);
      result.deleted.push(m.recordId);
      result.changed = true;
    }
  }
  if (result.changed) {
    result.dataEpoch = bumpDataEpoch(store, appId);
    store.event("records.committed", { appId, created: Object.keys(result.created).length, updated: result.updated.length, deleted: result.deleted.length }, { appId });
  }
  return result;
}
