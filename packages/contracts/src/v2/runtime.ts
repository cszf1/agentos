import { Ajv2020 } from "ajv/dist/2020.js";
import { RESERVED_KEYS, type FieldValue, type ValidationIssue } from "../bundle.js";
import { CODE_LIMITS } from "./bundle-v2.js";

/** Runner ABI between the host and the trusted runner inside an app container (spec §7.2, §11.2). */
export const RUNNER_ABI_VERSION = 1;
/** ABI 2 (spec §9): provider reads and system-plan handlers; only used by v3 bundles on ABI-2 locks. */
export const RUNNER_ABI_V2 = 2;
export const SUPPORTED_RUNNER_ABIS = [1, 2] as const;
export const RUNNER_PROTOCOL_VERSION = 1;

/** Frame limits: only host→runner snapshot frames may be large (spec §11.2). */
export const FRAME_LIMITS = {
  absoluteMax: 24 * 1024 * 1024,
  hostToRunner: 24 * 1024 * 1024,
  runnerToHost: 1024 * 1024,
  maxPendingFrames: 64,
  logBytesPerMinute: 64 * 1024,
} as const;

export interface RecordEnvelopeV2 {
  id: string;
  recordVersion: number;
  createdAt: string;
  updatedAt: string;
  data: Record<string, FieldValue>;
}

/** Read-only call context the runner passes to handlers (spec §7.2). No authorization token. */
export interface HandlerContext {
  callId: string;
  appId: string;
  revisionId: string;
  appEpoch: number;
  dataEpoch: number;
  logicalTime: string;
  deadline: string;
  records: RecordEnvelopeV2[];
}

export type Mutation =
  | { kind: "create"; localKey: string; data: Record<string, FieldValue> }
  | { kind: "update"; recordId: string; expectedRecordVersion: number; changes: Record<string, FieldValue> }
  | { kind: "delete"; recordId: string; expectedRecordVersion: number };

export interface CommandOutput {
  result: unknown;
  mutations: Mutation[];
}

const fieldValue = { type: ["string", "boolean", "integer"] };
const dataMap = { type: "object", maxProperties: 32, propertyNames: { pattern: "^[a-z][a-z0-9_]{0,31}$" }, additionalProperties: fieldValue };
/** Fixed platform schema for a command's mutation plan; the command's outputSchema only checks `result`. */
export const MUTATION_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["result", "mutations"],
  properties: {
    result: {},
    mutations: {
      type: "array",
      maxItems: CODE_LIMITS.maxMutations,
      items: {
        oneOf: [
          { type: "object", additionalProperties: false, required: ["kind", "localKey", "data"], properties: { kind: { const: "create" }, localKey: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" }, data: dataMap } },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "recordId", "expectedRecordVersion", "changes"],
            properties: { kind: { const: "update" }, recordId: { type: "string", maxLength: 64 }, expectedRecordVersion: { type: "integer", minimum: 1 }, changes: { ...dataMap, minProperties: 1 } },
          },
          { type: "object", additionalProperties: false, required: ["kind", "recordId", "expectedRecordVersion"], properties: { kind: { const: "delete" }, recordId: { type: "string", maxLength: 64 }, expectedRecordVersion: { type: "integer", minimum: 1 } } },
        ],
      },
    },
  },
} as const;
const ajv = new Ajv2020({ allErrors: false, strict: false });
const validatePlan = ajv.compile(MUTATION_PLAN_SCHEMA);

export function checkMutationPlan(value: unknown): { ok: true; plan: CommandOutput } | { ok: false; issue: ValidationIssue } {
  if (!validatePlan(value)) {
    const e = validatePlan.errors?.[0];
    return { ok: false, issue: { path: e?.instancePath || "/", code: "INVALID_MUTATION", message: e?.message ?? "invalid mutation plan" } };
  }
  const plan = value as CommandOutput;
  for (const [i, m] of plan.mutations.entries()) {
    const keys = m.kind === "create" ? Object.keys(m.data) : m.kind === "update" ? Object.keys(m.changes) : [];
    for (const k of keys) if (RESERVED_KEYS.has(k)) return { ok: false, issue: { path: `/mutations/${i}`, code: "INVALID_MUTATION", message: "reserved field name" } };
  }
  return { ok: true, plan };
}

/** Length-prefixed strict JSON frames (4-byte big-endian length). */
export interface Frame {
  protocolVersion: typeof RUNNER_PROTOCOL_VERSION;
  messageId: string;
  replyTo?: string;
  type: FrameType;
  payload: unknown;
}
export type FrameType =
  // host → runner
  | "hello" | "call" | "ping" | "serviceResult" | "providerResult" | "shutdown"
  // runner → host
  | "ready" | "result" | "pong" | "serviceCall" | "providerRead" | "log"
  // build bridge
  | "buildOutput" | "buildFailed";

export interface HelloPayload {
  challenge: string;
  instanceId: string;
  revisionId: string;
  artifactId: string;
  mode: "active" | "preview";
}
export interface ReadyPayload {
  abiVersion: number;
  instanceId: string;
  revisionId: string;
  artifactId: string;
  /** HMAC-free echo of the challenge; identity is decided by the host from the socket, this only binds the session. */
  challenge: string;
  /** sha256 of the mounted app.mjs, computed by the runner. */
  appSha256: string;
  handlers: { queries: string[]; commands: string[]; systemActions?: string[] };
}
export interface CallPayload {
  callId: string;
  kind: "query" | "command" | "systemPlan";
  handlerId: string;
  input: unknown;
  context: HandlerContext;
}
export type ResultPayload =
  | { callId: string; ok: true; output: unknown }
  | { callId: string; ok: false; error: { code: "HANDLER_ERROR" | "UNKNOWN_HANDLER" | "BAD_OUTPUT"; message: string } };
export interface ServiceCallPayload {
  callId: string;
  parentCallId: string;
  alias: string;
  input: unknown;
}
/** ABI 2: a provider read requested by the app inside a query or system-plan call (spec §9, §10). */
export interface ProviderReadPayload {
  callId: string;
  parentCallId: string;
  bindingAlias: string;
  capabilityId: string;
  params: unknown;
}
export type ProviderResultPayload =
  | { callId: string; ok: true; envelope: unknown }
  | { callId: string; ok: false; error: { code: string; message: string } };
export type ServiceResultPayload =
  | { callId: string; ok: true; output: unknown; target: { appId: string; revisionId: string; dataEpoch: number } }
  | { callId: string; ok: false; error: { code: string; message: string } };

export function encodeFrame(f: Frame): Buffer {
  const body = Buffer.from(JSON.stringify(f), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Incremental decoder that checks the length before buffering the body. */
export class FrameDecoder {
  #buf: Buffer = Buffer.alloc(0);
  constructor(private readonly maxFrame: number) {}
  push(chunk: Buffer): Frame[] {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    const out: Frame[] = [];
    for (;;) {
      if (this.#buf.length < 4) break;
      const len = this.#buf.readUInt32BE(0);
      if (len > this.maxFrame) throw new Error(`frame of ${len} bytes exceeds ${this.maxFrame}`);
      if (this.#buf.length < 4 + len) break;
      const body = this.#buf.subarray(4, 4 + len).toString("utf8");
      this.#buf = this.#buf.subarray(4 + len);
      const f = JSON.parse(body) as Frame;
      if (f === null || typeof f !== "object" || f.protocolVersion !== RUNNER_PROTOCOL_VERSION || typeof f.messageId !== "string" || typeof f.type !== "string") {
        throw new Error("malformed frame");
      }
      out.push(f);
    }
    return out;
  }
  get buffered(): number {
    return this.#buf.length;
  }
}
