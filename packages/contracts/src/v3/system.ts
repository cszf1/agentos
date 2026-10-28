import { Ajv2020 } from "ajv/dist/2020.js";

/** System action / resource / observation DTOs shared by host, web and Pi tools (spec §7, §17, §19, §21). */
export type ObservationQuality = "fresh" | "stale" | "gap" | "unavailable";

export interface ObservationEnvelope<T = unknown> {
  resourceId: string;
  resourceGeneration: number;
  observedAt: string;
  observationId: string;
  resourceVersion: string | null;
  data: T | null;
  quality: ObservationQuality;
}

export type SystemActionState =
  | "awaiting_approval"
  | "ready"
  | "dispatching"
  | "running"
  | "reconciling"
  | "succeeded"
  | "failed_no_effect"
  | "cancelled_no_effect"
  | "expired_no_effect"
  | "indeterminate"
  | "rejected";

export const TERMINAL_ACTION_STATES: readonly SystemActionState[] = ["succeeded", "failed_no_effect", "cancelled_no_effect", "expired_no_effect", "rejected"];
/** States that block app version activation (spec §11.4). Unresolved indeterminate also blocks. */
export const PENDING_ACTION_STATES: readonly SystemActionState[] = ["ready", "dispatching", "running", "reconciling"];

/** What an app system-action handler returns (spec §9): a plan, never mutations or effects. */
export interface SystemPlanOutput {
  bindingAlias: string;
  capabilityId: string;
  params: Record<string, unknown>;
  observationIds: string[];
  preview: unknown;
}

export const SYSTEM_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["bindingAlias", "capabilityId", "params", "observationIds", "preview"],
  properties: {
    bindingAlias: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" },
    capabilityId: { type: "string", maxLength: 64 },
    params: { type: "object" },
    observationIds: { type: "array", maxItems: 4, items: { type: "string", pattern: "^obs_[0-9a-f]{16,40}$" } },
    preview: {},
  },
} as const;
const ajv = new Ajv2020({ strict: false });
export const validateSystemPlanOutput = ajv.compile(SYSTEM_PLAN_SCHEMA);

export const SYSTEM_LIMITS = {
  importRoots: 8,
  managedRoots: 2,
  units: 8,
  labNetworks: 1,
  serial: 2,
  pendingPlansPerApp: 4,
  pendingPlansPerWorkspace: 16,
  planTtlMs: 5 * 60 * 1000,
  handlerMs: 5000,
  planBytes: 256 * 1024,
  providerReadsPerCall: 4,
  providerReadMs: 750,
  writeDeadlineMs: 30_000,
  observationEvents: 10_000,
  observationRetentionMs: 24 * 3600 * 1000,
  inflightPerWorkspace: 1,
  systemPlanRun: { deadlineMs: 180_000, modelRequests: 6, toolTasks: 20, invalidPlans: 3 },
} as const;

export type ConfirmationPolicy = "per_plan" | "standing";
