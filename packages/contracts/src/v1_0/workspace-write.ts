import { domainHash } from "../v3/broker.js";
import { isPositiveInt, isSha256, isUint32, isUuid } from "./ids.js";
import { parseStrictJson } from "./json.js";

export const WORKSPACE_WRITE_DOMAIN = "agentos.broker.workspace-write.v3";
export const WORKSPACE_BODY_DOMAIN = "agentos.broker.body.v3";

export type PrincipalKindV3 = "user" | "maintenance";

export interface WorkspaceWrite {
  machineInstallId: string;
  workspaceId: string;
  storeUUID: string;
  workspaceIncarnation: number;
  executionUid: number;
  principalKind: PrincipalKindV3;
  userId: string | null;
  memberVersion: number | null;
  runId: string | null;
  executionEpoch: number | null;
  machineControlEpoch: number;
  requestId: string;
  deadline: number;
  body: unknown;
  bodyHash: string;
  requestHash: string;
}

const WRITE_KEYS = [
  "machineInstallId",
  "workspaceId",
  "storeUUID",
  "workspaceIncarnation",
  "executionUid",
  "principalKind",
  "userId",
  "memberVersion",
  "runId",
  "executionEpoch",
  "machineControlEpoch",
  "requestId",
  "deadline",
  "body",
  "bodyHash",
  "requestHash",
] as const;

function outer(w: Omit<WorkspaceWrite, "requestHash">): Record<string, unknown> {
  return {
    machineInstallId: w.machineInstallId,
    workspaceId: w.workspaceId,
    storeUUID: w.storeUUID,
    workspaceIncarnation: w.workspaceIncarnation,
    executionUid: w.executionUid,
    principalKind: w.principalKind,
    userId: w.userId,
    memberVersion: w.memberVersion,
    runId: w.runId,
    executionEpoch: w.executionEpoch,
    machineControlEpoch: w.machineControlEpoch,
    requestId: w.requestId,
    deadline: w.deadline,
    bodyHash: w.bodyHash,
  };
}

export function sealWorkspaceWrite(input: Omit<WorkspaceWrite, "bodyHash" | "requestHash">): WorkspaceWrite {
  const bodyHash = domainHash(WORKSPACE_BODY_DOMAIN, input.body);
  const draft = { ...input, bodyHash };
  const requestHash = domainHash(WORKSPACE_WRITE_DOMAIN, outer(draft));
  return { ...draft, requestHash };
}

export function checkWorkspaceWrite(text: string): { ok: true; write: WorkspaceWrite } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = parseStrictJson(text);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "invalid json" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "envelope must be an object" };
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  for (const key of keys) {
    if (!WRITE_KEYS.includes(key as (typeof WRITE_KEYS)[number])) return { ok: false, reason: `unknown field ${key}` };
  }
  for (const key of WRITE_KEYS) {
    if (!(key in obj)) return { ok: false, reason: `missing ${key}` };
  }
  if (!isUuid(obj.machineInstallId) || !isUuid(obj.workspaceId) || !isUuid(obj.storeUUID) || !isUuid(obj.requestId)) {
    return { ok: false, reason: "identity fields must be lowercase uuids" };
  }
  if (obj.principalKind !== "user" && obj.principalKind !== "maintenance") return { ok: false, reason: "bad principal kind" };
  if (obj.userId !== null && !isUuid(obj.userId)) return { ok: false, reason: "bad userId" };
  if (obj.runId !== null && !isUuid(obj.runId)) return { ok: false, reason: "bad runId" };
  if (!isPositiveInt(obj.workspaceIncarnation) || !isPositiveInt(obj.machineControlEpoch) || !isPositiveInt(obj.deadline)) {
    return { ok: false, reason: "epochs and deadline must be positive integers" };
  }
  if (!isUint32(obj.executionUid)) return { ok: false, reason: "bad execution uid" };
  if (obj.memberVersion !== null && !isPositiveInt(obj.memberVersion)) return { ok: false, reason: "bad member version" };
  if (obj.executionEpoch !== null && !isPositiveInt(obj.executionEpoch)) return { ok: false, reason: "bad execution epoch" };
  if (obj.principalKind === "user" && (obj.userId === null || obj.memberVersion === null)) return { ok: false, reason: "user principal needs userId and memberVersion" };
  if (obj.principalKind === "maintenance" && (obj.userId !== null || obj.memberVersion !== null)) {
    return { ok: false, reason: "maintenance principal has no user" };
  }
  if (!isSha256(obj.bodyHash) || !isSha256(obj.requestHash)) return { ok: false, reason: "bad hash" };
  const write: WorkspaceWrite = {
    machineInstallId: obj.machineInstallId,
    workspaceId: obj.workspaceId,
    storeUUID: obj.storeUUID,
    workspaceIncarnation: obj.workspaceIncarnation as number,
    executionUid: obj.executionUid as number,
    principalKind: obj.principalKind,
    userId: obj.userId as string | null,
    memberVersion: obj.memberVersion as number | null,
    runId: obj.runId as string | null,
    executionEpoch: obj.executionEpoch as number | null,
    machineControlEpoch: obj.machineControlEpoch as number,
    requestId: obj.requestId,
    deadline: obj.deadline as number,
    body: obj.body,
    bodyHash: obj.bodyHash,
    requestHash: obj.requestHash,
  };
  const expectBody = domainHash(WORKSPACE_BODY_DOMAIN, write.body);
  if (expectBody !== write.bodyHash) return { ok: false, reason: "body hash mismatch" };
  const expectReq = domainHash(WORKSPACE_WRITE_DOMAIN, outer(write));
  if (expectReq !== write.requestHash) return { ok: false, reason: "request hash mismatch" };
  return { ok: true, write };
}

/** Protocol 1 and 2 cannot write once a workspace requires protocol 3. */
export function admitWriteProtocol(minWriteProtocol: number, requestProtocol: number): "ok" | "rejected" {
  if (minWriteProtocol >= 3 && requestProtocol < 3) return "rejected";
  if (requestProtocol !== 1 && requestProtocol !== 2 && requestProtocol !== 3) return "rejected";
  return "ok";
}
