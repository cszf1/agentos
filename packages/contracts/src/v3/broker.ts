import { Ajv2020 } from "ajv/dist/2020.js";
import { canonicalJson, sha256Hex } from "../bundle.js";

/**
 * Broker protocol v1 DTOs (spec §12.2), mirrored from native/crates/protocol/src/dto.rs. Optional fields the Rust
 * side always serializes (`paramsHash`, `compensatesOperationId`) must be present as null here so both sides hash the
 * same canonical value; Principal optional ids are omitted when absent (Rust skips them).
 */
export const BROKER_PROTOCOL_VERSION = 1;
export const BROKER_SOCKET = "/run/agentos-broker/broker.sock";
export const TELEMETRY_SOCKET = "/run/agentos-telemetry/telemetry.sock";
export const BROKER_METHODS = [
  "handshake", "describe", "read", "grant-sync", "grant-revoke", "submit", "operation-get", "operation-cancel",
  "operation-resolve", "history-sync", "workspace-quiesce", "workspace-resume", "restore-begin", "restore-status", "restore-complete",
] as const;
export type BrokerMethod = (typeof BROKER_METHODS)[number];

/** Protocol values carry only safe integers (identical to the Rust canonical encoder, which rejects the rest). */
export function protocolCanonical(v: unknown): string {
  const walk = (x: unknown, depth: number): void => {
    if (depth > 64) throw new Error("value nested too deeply");
    if (typeof x === "number") {
      if (!Number.isSafeInteger(x)) throw new Error("protocol numbers must be safe integers");
    } else if (Array.isArray(x)) x.forEach((y) => walk(y, depth + 1));
    else if (x !== null && typeof x === "object") for (const y of Object.values(x)) walk(y, depth + 1);
  };
  walk(v, 0);
  return canonicalJson(v);
}

export function domainHash(domain: string, v: unknown): string {
  return `sha256:${sha256Hex(`${domain}\n${protocolCanonical(v)}`)}`;
}

export interface BrokerIdentity {
  machineInstallId: string;
  storeUuid: string;
  workspaceIncarnation: number;
}

export interface BrokerPrincipal {
  kind: "app" | "system_action" | "run";
  appId?: string;
  revisionId?: string;
  actionId?: string;
  runId?: string;
}

export interface GrantSyncBody {
  identity: BrokerIdentity;
  grantId: string;
  grantVersion: number;
  principal: BrokerPrincipal;
  capabilityId: string;
  contractVersion: number;
  resourceId: string;
  resourceGeneration: number;
  limits: Record<string, unknown>;
  paramsHash: string | null;
  expiresAtMs: number;
  requestHash: string;
}

export interface WriteEnvelope {
  protocolVersion: number;
  machineInstallId: string;
  storeUuid: string;
  workspaceIncarnation: number;
  operationId: string;
  actionId: string;
  planHash: string;
  capabilityId: string;
  contractVersion: number;
  resourceId: string;
  resourceGeneration: number;
  grantId: string;
  grantVersion: number;
  preconditions: Record<string, unknown>;
  deadlineMs: number;
  params: Record<string, unknown>;
  compensatesOperationId: string | null;
  requestHash: string;
}

export function sealGrant(b: Omit<GrantSyncBody, "requestHash">): GrantSyncBody {
  return { ...b, requestHash: domainHash("agentos.broker.grant.v1", b) };
}

export function sealEnvelope(e: Omit<WriteEnvelope, "requestHash">): WriteEnvelope {
  return { ...e, requestHash: domainHash("agentos.broker.write.v1", e) };
}

/** Hash bound into one-time action grants (`paramsHash`): the broker recomputes it from the envelope params. */
export const paramsHash = (params: Record<string, unknown>) => domainHash("agentos.system-params.v1", params);

const token = (max: number) => ({ type: "string", minLength: 1, maxLength: max, pattern: "^[A-Za-z0-9_:.@-]+$" });
const hash = { type: "string", pattern: "^sha256:[0-9a-f]{64}$" };
const u = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const identity = { type: "object", additionalProperties: false, required: ["machineInstallId", "storeUuid", "workspaceIncarnation"], properties: { machineInstallId: token(64), storeUuid: token(64), workspaceIncarnation: u } };

export const WRITE_ENVELOPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["protocolVersion", "machineInstallId", "storeUuid", "workspaceIncarnation", "operationId", "actionId", "planHash", "capabilityId", "contractVersion", "resourceId", "resourceGeneration", "grantId", "grantVersion", "preconditions", "deadlineMs", "params", "compensatesOperationId", "requestHash"],
  properties: {
    protocolVersion: { const: 1 }, machineInstallId: token(64), storeUuid: token(64), workspaceIncarnation: u, operationId: token(64), actionId: token(64), planHash: hash,
    capabilityId: token(64), contractVersion: { type: "integer", minimum: 0, maximum: 4294967295 }, resourceId: token(96), resourceGeneration: u, grantId: token(64), grantVersion: u,
    preconditions: { type: "object" }, deadlineMs: u, params: { type: "object" }, compensatesOperationId: { anyOf: [{ type: "null" }, token(64)] }, requestHash: hash,
  },
} as const;

export const GRANT_SYNC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["identity", "grantId", "grantVersion", "principal", "capabilityId", "contractVersion", "resourceId", "resourceGeneration", "limits", "expiresAtMs", "requestHash"],
  properties: {
    identity, grantId: token(64), grantVersion: u,
    principal: { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { type: "string" }, appId: { type: "string" }, revisionId: { type: "string" }, actionId: { type: "string" }, runId: { type: "string" } } },
    capabilityId: { type: "string" }, contractVersion: { type: "integer", minimum: 0, maximum: 4294967295 }, resourceId: { type: "string" }, resourceGeneration: u, limits: { type: "object" },
    paramsHash: { anyOf: [{ type: "null" }, { type: "string" }] }, expiresAtMs: u, requestHash: { type: "string" },
  },
} as const;

const ajv = new Ajv2020({ strict: false, allErrors: false });
const vEnv = ajv.compile(WRITE_ENVELOPE_SCHEMA);
const vGrant = ajv.compile(GRANT_SYNC_SCHEMA);

/** JSON nesting depth (brackets outside strings), the same scan the Rust frame reader performs. */
export function jsonDepth(text: string): number {
  let depth = 0, max = 0, inStr = false, esc = false;
  for (const ch of text) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") max = Math.max(max, ++depth);
    else if (ch === "}" || ch === "]") depth = Math.max(0, depth - 1);
  }
  return max;
}

export const MAX_BROKER_FRAME = 512 * 1024;
export const MAX_JSON_DEPTH = 8;

/** Strict structural check (unknown fields, integer ranges, hashes) used before anything is sent to the broker. */
export function checkWriteEnvelope(v: unknown): string | null {
  if (!vEnv(v)) return vEnv.errors?.[0]?.message ?? "invalid envelope";
  const e = v as WriteEnvelope;
  const { requestHash, ...body } = e;
  if (domainHash("agentos.broker.write.v1", body) !== requestHash) return "requestHash does not match the envelope body";
  return null;
}

export function checkGrantSync(v: unknown): string | null {
  if (!vGrant(v)) return vGrant.errors?.[0]?.message ?? "invalid grant";
  const g = v as GrantSyncBody;
  const { requestHash, ...body } = g;
  if (domainHash("agentos.broker.grant.v1", body) !== requestHash) return "requestHash does not match the grant body";
  return null;
}
