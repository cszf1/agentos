import { V1_LIMITS } from "./limits.js";
import { parseStrictJson } from "./json.js";
import { isPositiveInt, isUuid } from "./ids.js";

export const NATIVE_RPC_VERSION = "native-rpc/1";

export const NATIVE_ROUTES = [
  "session.bind",
  "session.status",
  "session.end",
  "workspaces.list",
  "workspaces.get",
  "workspaces.create",
  "workspaces.start",
  "workspaces.stop",
  "workspaces.archive",
  "workspaces.attach",
  "members.list",
  "members.setRole",
  "members.revoke",
  "members.transferOwner",
  "workspace.forward",
  "events.subscribe",
  "events.ack",
  "machine.status",
  "machine.capabilities",
  "machine.actions.plan",
  "machine.actions.confirm",
  "machine.actions.get",
  "machine.actions.cancel",
  "machine.users.create",
  "machine.users.disable",
  "updates.check",
  "updates.prepare",
  "updates.activate",
  "updates.status",
  "updates.cancel",
  "backups.create",
  "backups.list",
  "backups.export",
  "backups.inspect",
  "restores.plan",
  "restores.confirm",
  "restores.status",
  "diagnostics.collect",
] as const;
export type NativeRouteId = (typeof NATIVE_ROUTES)[number];

const ROUTE_SET = new Set<string>(NATIVE_ROUTES);

export const WRITE_ROUTES: ReadonlySet<NativeRouteId> = new Set([
  "session.end",
  "workspaces.create",
  "workspaces.start",
  "workspaces.stop",
  "workspaces.archive",
  "workspaces.attach",
  "members.setRole",
  "members.revoke",
  "members.transferOwner",
  "workspace.forward",
  "events.ack",
  "machine.actions.plan",
  "machine.actions.confirm",
  "machine.actions.cancel",
  "machine.users.create",
  "machine.users.disable",
  "updates.prepare",
  "updates.activate",
  "updates.cancel",
  "backups.create",
  "backups.export",
  "restores.plan",
  "restores.confirm",
  "diagnostics.collect",
]);

const ENVELOPE_KEYS = new Set(["requestId", "workspaceId", "clientEpoch", "sessionEpoch", "methodId", "params", "body", "idempotencyKey"]);

export interface NativeRequest {
  requestId: string;
  workspaceId: string;
  clientEpoch: number;
  sessionEpoch: number;
  methodId: NativeRouteId;
  params: unknown;
  body: unknown;
  idempotencyKey: string | null;
}

export function encodeNativeFrame(payload: Uint8Array): Buffer {
  if (payload.byteLength > V1_LIMITS.nativeFrameBytes) throw new Error("frame too large");
  const out = Buffer.alloc(4 + payload.byteLength);
  out.writeUInt32BE(payload.byteLength, 0);
  Buffer.from(payload).copy(out, 4);
  return out;
}

export function decodeNativeFrame(frame: Uint8Array): Uint8Array {
  if (frame.byteLength < 4) throw new Error("truncated frame");
  const view = Buffer.from(frame);
  const len = view.readUInt32BE(0);
  if (len > V1_LIMITS.nativeFrameBytes) throw new Error("frame too large");
  if (view.byteLength !== 4 + len) throw new Error("frame length mismatch");
  return view.subarray(4);
}

export function parseNativeRequest(text: string): NativeRequest {
  const value = parseStrictJson(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("request must be an object");
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ENVELOPE_KEYS.has(key)) throw new Error(`unknown field ${key}`);
  }
  if (!isUuid(obj.requestId) || !isUuid(obj.workspaceId)) throw new Error("requestId and workspaceId must be lowercase uuids");
  if (!isPositiveInt(obj.clientEpoch) || !isPositiveInt(obj.sessionEpoch)) throw new Error("epochs must be positive integers");
  if (typeof obj.methodId !== "string" || !ROUTE_SET.has(obj.methodId)) throw new Error("unknown method");
  const methodId = obj.methodId as NativeRouteId;
  const idem = obj.idempotencyKey;
  if (idem !== undefined && (typeof idem !== "string" || idem.length < 1 || idem.length > 200)) throw new Error("bad idempotency key");
  if (WRITE_ROUTES.has(methodId) && typeof idem !== "string") throw new Error("write requires an idempotency key");
  return {
    requestId: obj.requestId,
    workspaceId: obj.workspaceId,
    clientEpoch: obj.clientEpoch,
    sessionEpoch: obj.sessionEpoch,
    methodId,
    params: obj.params ?? null,
    body: obj.body ?? null,
    idempotencyKey: typeof idem === "string" ? idem : null,
  };
}

const FORWARD_FORBIDDEN = new Set(["url", "path", "method", "header", "headers", "principal", "socket", "userId", "executionUid"]);

export function parseForwardBody(body: unknown): { routeId: string; params: Record<string, unknown>; body: unknown } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("forward body must be an object");
  const obj = body as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (FORWARD_FORBIDDEN.has(key)) throw new Error(`forward cannot carry ${key}`);
  }
  const allowed = new Set(["routeId", "params", "body"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new Error(`unknown forward field ${key}`);
  }
  if (typeof obj.routeId !== "string" || obj.routeId.includes("://") || obj.routeId.startsWith("/")) throw new Error("routeId is not a URL");
  if (!/^[a-z0-9]+(\.[a-z0-9]+)+$/.test(obj.routeId)) throw new Error("routeId is not registered");
  const params = obj.params ?? {};
  if (params === null || typeof params !== "object" || Array.isArray(params)) throw new Error("params must be an object");
  return { routeId: obj.routeId, params: params as Record<string, unknown>, body: obj.body ?? null };
}
