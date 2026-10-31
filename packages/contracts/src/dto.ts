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
      mode: { enum: ["build", "system_plan"] },
      resourceIds: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string", pattern: "^res_[a-z0-9_]{4,64}$" } },
      capabilityScopes: { type: "array", maxItems: 17, uniqueItems: true, items: { type: "string", pattern: "^[a-z]+\\.[a-z_]+$" } },
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
  // v0.2 (spec §19.1); every DTO rejects unknown fields.
  runtimeControl: {
    type: "object", additionalProperties: false, required: ["expectedAppEpoch"],
    properties: { expectedAppEpoch: epoch },
  },
  deploymentCreate: {
    type: "object", additionalProperties: false, required: ["revisionId", "expectedAppEpoch"],
    properties: { revisionId: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" }, expectedAppEpoch: epoch },
  },
  queryCall: {
    type: "object", additionalProperties: false, required: ["expectedAppEpoch", "input"],
    properties: { expectedAppEpoch: epoch, input: {} },
  },
  commandCall: {
    type: "object", additionalProperties: false, required: ["expectedAppEpoch", "input"],
    properties: { expectedAppEpoch: epoch, input: {} },
  },
  grantCreate: {
    type: "object", additionalProperties: false,
    required: ["sourceAppId", "sourceRevisionId", "alias", "targetAppId", "targetRevisionId", "exportName", "contractHash"],
    properties: {
      sourceAppId: uuid,
      sourceRevisionId: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
      alias: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" },
      targetAppId: uuid,
      targetRevisionId: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
      exportName: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" },
      contractHash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    },
  },
  // v0.3 (spec §21.1)
  importRootCreate: {
    type: "object", additionalProperties: false, required: ["path"],
    properties: { path: { type: "string", minLength: 1, maxLength: 1024 }, displayName: { type: "string", minLength: 1, maxLength: 80 } },
  },
  providerGrantCreate: {
    type: "object", additionalProperties: false, required: ["appId", "bindingAlias", "resourceId", "confirmationPolicy"],
    properties: {
      appId: uuid,
      bindingAlias: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" },
      resourceId: { type: "string", pattern: "^res_[a-z0-9_]{4,64}$" },
      confirmationPolicy: { enum: ["per_plan", "standing"] },
      expiresInDays: { type: "integer", minimum: 1, maximum: 365 },
      bounds: {
        type: "object", maxProperties: 8, propertyNames: { pattern: "^[a-z]+\\.[a-z_]+$" },
        additionalProperties: { type: "object", maxProperties: 4 },
      },
    },
  },
  systemActionPlan: {
    type: "object", additionalProperties: false, required: ["expectedAppEpoch", "input"],
    properties: { expectedAppEpoch: epoch, input: {} },
  },
  systemActionConfirm: {
    type: "object", additionalProperties: false, required: ["planHash"],
    properties: { planHash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" } },
  },
  systemActionCancel: {
    type: "object", additionalProperties: false, properties: { reason: { type: "string", maxLength: 200 } },
  },
  systemActionResolve: {
    type: "object", additionalProperties: false, required: ["decision", "note"],
    properties: {
      decision: { enum: ["confirmed_applied", "confirmed_not_applied", "accept_unknown"] },
      note: { type: "string", minLength: 1, maxLength: 500 },
      releaseQuarantine: { type: "boolean" },
    },
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
export interface RunCreateBody { intent: string; targetAppId: string | null; expectedAppEpoch?: number; mode?: "build" | "system_plan"; resourceIds?: string[]; capabilityScopes?: string[] }
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
  runtime?: "declarative-v1" | "isolated-code-v1" | "isolated-code-v2";
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
  runtime?: "declarative-v1" | "isolated-code-v1" | "isolated-code-v2";
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
  /** v0.2: the run's latest deployment and its real stage from the database (spec §19.3). */
  deployment?: { deploymentId: string; status: string; stage: string | null; error: { stage?: string; code: string; message: string } | null } | null;
  runId: string;
  status: RunStatus;
  dispatchState: DispatchState;
  intent: string;
  mode: "create" | "modify";
  /** v0.3 run mode and, for system_plan, the frozen scope and the prepared action (not an executed one). */
  runMode?: "build" | "system_plan" | "maintenance_diagnose" | "maintenance_refactor";
  preparedActionId?: string | null;
  systemScope?: unknown;
  /** null for a non-app task (v0.4) */
  targetAppId: string | null;
  expectedAppEpoch: number;
  appliedRevisionId: string | null;
  modelRequestCount: number;
  stopReason: string | null;
  lastValidation: { stage?: string; issues: ValidationIssue[] } | null;
  error: { code: string; message: string; details?: Record<string, unknown> } | null;
  warning: string | null;
  progress: { stageAttempts: number; toolTasks: number; lastTool: string | null };
  /** execution deadline (null while queued) */
  deadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
  // v0.4 (spec §7, §22.2): queue, role, permissions and budget of THIS task
  agentProfileId?: string;
  background?: boolean;
  schedulingState?: string;
  waitReason?: string | null;
  queuePosition?: number | null;
  queueDeadlineAt?: string | null;
  startedAt?: string | null;
  executionEpoch?: number;
  conversationId?: string | null;
  reportId?: string | null;
  proposalId?: string | null;
  jobId?: string | null;
  permissions?: string[];
  budget?: {
    maxModelRequests: number; maxToolTasks: number; maxStageAttempts: number; deadlineMs: number; maxOutputTokens: number;
    modelRequests: number; outputTokensReservedOrUsed: number; usageUnknownAttempts: number;
  };
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
  /** review F13: the product release (hostVersion is the Host runtime compatibility line) */
  productVersion?: string;
}

export interface StateView {
  clientEpoch: number;
  eventSeq: number;
  apps: AppSummary[];
  /** v0.3 compatibility: the oldest unfinished foreground run (v0.4 shells read `runs`). */
  activeRun: RunView | null;
  lastRun: RunView | null;
  /** v0.4: every unfinished task (foreground and background) with its queue state */
  runs?: RunView[];
  foregroundSlots?: number;
  modelAvailable: boolean;
  model: { provider: string; modelId: string; mode: "real" | "faux" } | null;
  agentState: "ready" | "blocked" | "unavailable";
  agentDiagnostic: string | null;
  hostVersion: string;
  /** review F13: the product release (hostVersion is the Host runtime compatibility line) */
  productVersion?: string;
  ready: boolean;
  /** v0.2: whether code apps can run on this host, and why not (spec §20.1). */
  runtimeReady?: boolean;
  runtimeProblems?: string[];
  /** v0.3 (spec §22.1): separate component states, never one boolean hiding the reason. */
  hostReady?: boolean;
  brokerReady?: boolean;
  telemetryAvailable?: boolean;
  system?: Record<string, unknown>;
}
