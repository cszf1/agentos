import { Ajv2020 } from "ajv/dist/2020.js";
import { AgentOsError } from "./errors.js";
import type { DataContract, FieldValue, ValidationIssue } from "./bundle.js";
import type { AnyBundle } from "./v2/bundle-v2.js";
import { LIMITS } from "./limits.js";

const uuid = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" } as const;
const epoch = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const recordVersion = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;
const dataObject = {
  type: "object",
  maxProperties: LIMITS.maxFields,
  propertyNames: { pattern: "^[a-z][a-z0-9_]{0,31}$" },
  additionalProperties: { type: ["string", "boolean", "integer"] },
} as const;

export const DTO_SCHEMAS = {
  authSession: {
    type: "object", additionalProperties: false, required: ["token"],
    properties: { token: { type: "string", minLength: 1, maxLength: 256 } },
  },
  activate: {
    type: "object", additionalProperties: false, required: ["revisionId", "expectedAppEpoch"],
    properties: { revisionId: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" }, expectedAppEpoch: epoch },
  },
  runCreate: {
    type: "object", additionalProperties: false, required: ["intent", "targetAppId"],
    properties: {
      intent: { type: "string", minLength: 1, maxLength: LIMITS.maxIntentCodePoints },
      targetAppId: { oneOf: [{ type: "null" }, uuid] },
      expectedAppEpoch: epoch,
    },
  },
  empty: { type: "object", additionalProperties: false, properties: {} },
  recordCreate: {
    type: "object", additionalProperties: false, required: ["expectedAppEpoch", "data"],
    properties: { expectedAppEpoch: epoch, data: dataObject },
  },
  recordPatch: {
    type: "object", additionalProperties: false, required: ["expectedAppEpoch", "expectedRecordVersion", "changes"],
    properties: { expectedAppEpoch: epoch, expectedRecordVersion: recordVersion, changes: { ...dataObject, minProperties: 1 } },
  },
  recordDelete: {
    type: "object", additionalProperties: false, required: ["expectedAppEpoch", "expectedRecordVersion"],
    properties: { expectedAppEpoch: epoch, expectedRecordVersion: recordVersion },
  },
} as const;

export type DtoName = keyof typeof DTO_SCHEMAS;

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true, coerceTypes: false, removeAdditional: false, useDefaults: false });
const compiled = Object.fromEntries(Object.entries(DTO_SCHEMAS).map(([k, s]) => [k, ajv.compile(s)])) as Record<DtoName, ReturnType<typeof ajv.compile>>;

export function parseDto<T>(name: DtoName, body: unknown): T {
  const v = compiled[name];
  if (!v(body)) {
    const issues = (v.errors ?? []).slice(0, 10).map((e) => ({
      path: e.keyword === "additionalProperties" ? `${e.instancePath}/${String(e.params.additionalProperty)}` : e.instancePath || "/",
      message: e.message ?? e.keyword,
    }));
    throw new AgentOsError("INVALID_REQUEST", "request body is invalid", { issues });
  }
  return body as T;
}

export interface AuthSessionBody { token: string }
export interface ActivateBody { revisionId: string; expectedAppEpoch: number }
export interface RunCreateBody { intent: string; targetAppId: string | null; expectedAppEpoch?: number }
export interface RecordCreateBody { expectedAppEpoch: number; data: Record<string, FieldValue> }
export interface RecordPatchBody { expectedAppEpoch: number; expectedRecordVersion: number; changes: Record<string, FieldValue> }
export interface RecordDeleteBody { expectedAppEpoch: number; expectedRecordVersion: number }

export type RunStatus = "queued" | "running" | "cancel_requested" | "blocked" | "succeeded" | "failed" | "cancelled";
export type DispatchState = "pending" | "dispatching" | "submitted";
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["queued", "running", "cancel_requested", "blocked"];

export interface AppSummary {
  appId: string;
  title: string;
  appEpoch: number;
  activeRevisionId: string | null;
  draft: boolean;
  /** v0.2: runtime of the active revision, and the runtime health of code apps (spec §19.3). */
  runtime?: "declarative-v1" | "isolated-code-v1";
  health?: "stopped" | "recovering" | "ready" | "degraded" | null;
  dataEpoch?: number;
}

export interface AppDetail {
  appId: string;
  appEpoch: number;
  activeRevisionId: string | null;
  draft: boolean;
  bundle: AnyBundle | null;
  contract: DataContract;
  dataEpoch?: number;
}

export interface RevisionSummary {
  revisionId: string;
  title: string;
  createdAt: string;
  firstActivatedAt: string;
  isActive: boolean;
  runtime?: "declarative-v1" | "isolated-code-v1";
}

export interface RecordEnvelope {
  id: string;
  appId: string;
  recordVersion: number;
  createdAt: string;
  updatedAt: string;
  data: Record<string, FieldValue>;
}

export interface RecordPage {
  appEpoch: number;
  items: RecordEnvelope[];
  total: number;
  offset: number;
  limit: number;
}

export interface RunView {
  runId: string;
  status: RunStatus;
  dispatchState: DispatchState;
  intent: string;
  mode: "create" | "modify";
  targetAppId: string;
  expectedAppEpoch: number;
  appliedRevisionId: string | null;
  modelRequestCount: number;
  stopReason: string | null;
  lastValidation: { stage?: string; issues: ValidationIssue[] } | null;
  error: { code: string; message: string; details?: Record<string, unknown> } | null;
  warning: string | null;
  progress: { stageAttempts: number; toolTasks: number; lastTool: string | null };
  deadlineAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SystemInfo {
  platform: string;
  arch: string;
  release: string;
  hostname: string;
  uptimeSeconds: number;
  memory: { totalBytes: number; freeBytes: number };
  loadAverage: [number, number, number];
  cpus: number;
  nodeVersion: string;
  hostVersion: string;
}

export interface StateView {
  clientEpoch: number;
  eventSeq: number;
  apps: AppSummary[];
  activeRun: RunView | null;
  lastRun: RunView | null;
  modelAvailable: boolean;
  model: { provider: string; modelId: string; mode: "real" | "faux" } | null;
  agentState: "ready" | "blocked" | "unavailable";
  agentDiagnostic: string | null;
  hostVersion: string;
  ready: boolean;
}
