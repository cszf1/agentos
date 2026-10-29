import { domainHash, type BrokerIdentity } from "../v3/broker.js";

/**
 * Broker protocol 2 (v0.4 spec §13.3): the maintenance principal. Mirrors native/crates/protocol/src/dto.rs. Protocol-1
 * DTOs, methods and hash domains are unchanged; protocol-2 methods are sent with frame `v: 2` only, and a maintenance
 * request is never re-sent as a protocol-1 user/action request.
 */
export const BROKER_PROTOCOL_V2 = 2;
export const BROKER_SUPPORTED_PROTOCOLS = [1, 2] as const;
export const MAINTENANCE_WRITE_DOMAIN = "agentos.broker.maintenance-write.v2";
export const MAINTENANCE_POLICY_DOMAIN = "agentos.broker.maintenance-policy.v2";
export const BROKER_METHODS_V2 = ["maintenance-policy-sync", "maintenance-policy-revoke", "maintenance-control", "maintenance-state", "maintenance-submit"] as const;
export type BrokerMethodV2 = (typeof BROKER_METHODS_V2)[number];
export const MAINTENANCE_FAMILY_ENSURE_RUNNING = "service.ensure_state.running";

export interface MaintenanceBounds {
  perHour: number;
  per24h: number;
  cooldownSeconds: number;
}

export interface MaintenancePolicySyncBody {
  identity: BrokerIdentity;
  policyId: string;
  policyVersion: number;
  policyHash: string;
  resourceId: string;
  resourceGeneration: number;
  actionFamily: string;
  bounds: MaintenanceBounds;
  expiresAtMs: number;
  maintenanceEpoch: number;
  requestHash: string;
}

export interface MaintenanceWriteEnvelope {
  protocolVersion: 2;
  machineInstallId: string;
  storeUuid: string;
  workspaceIncarnation: number;
  operationId: string;
  actionId: string;
  planHash: string;
  capabilityId: "service.ensure_state";
  contractVersion: 1;
  resourceId: string;
  resourceGeneration: number;
  preconditions: Record<string, unknown>;
  deadlineMs: number;
  params: { state: "running" };
  jobId: string;
  stepId: string;
  policyId: string;
  policyVersion: number;
  maintenanceEpoch: number;
  targetControlEpoch: number;
  triggerKey: string;
  requestHash: string;
}

export interface MaintenanceControlBody {
  identity: BrokerIdentity;
  state: "running" | "paused";
  maintenanceEpoch: number;
  target?: { resourceId: string; controlEpoch: number };
}

export function sealMaintenancePolicy(b: Omit<MaintenancePolicySyncBody, "requestHash">): MaintenancePolicySyncBody {
  return { ...b, requestHash: domainHash(MAINTENANCE_POLICY_DOMAIN, b) };
}

export function sealMaintenanceEnvelope(e: Omit<MaintenanceWriteEnvelope, "requestHash">): MaintenanceWriteEnvelope {
  return { ...e, requestHash: domainHash(MAINTENANCE_WRITE_DOMAIN, e) };
}

/** null when well-formed; never "downgradable": protocolVersion must be 2 and the only capability is ensure-running. */
export function checkMaintenanceEnvelope(e: MaintenanceWriteEnvelope): string | null {
  if (e.protocolVersion !== 2) return "a maintenance write is protocol 2";
  if (e.capabilityId !== "service.ensure_state" || e.params?.state !== "running" || Object.keys(e.params).length !== 1) return "a maintenance write is service.ensure_state(running) only";
  const { requestHash, ...body } = e;
  if (domainHash(MAINTENANCE_WRITE_DOMAIN, body) !== requestHash) return "requestHash does not match the maintenance envelope body";
  return null;
}

export interface BrokerMaintenanceState {
  protocolVersion: 2;
  incarnation: number;
  state: "running" | "paused";
  maintenanceEpoch: number;
  policies: { policyId: string; policyVersion: number; resourceId: string; actionFamily: string; bounds: MaintenanceBounds; expiresAtMs: number; revoked: boolean; policyHash: string; attempts: { lastHour: number; last24h: number; lastAdmittedAtMs: number | null } }[];
  targets: { resourceId: string; controlEpoch: number }[];
  installCaps: { unitKey: string; actionFamilies: string[]; perHour: number; per24h: number; cooldownSeconds: number }[];
}
