import { WEB_ERROR_TEXT, NETWORK_ERROR_TEXT } from "@agentos/contracts/view";
import type {
  ActivateBody,
  AppDetail,
  ErrorBody,
  RecordEnvelope,
  RecordPage,
  RevisionSummary,
  RunView,
  StateView,
  SystemInfo,
} from "@agentos/contracts";

export interface InvocationView {
  invocationId: string;
  status: "accepted" | "executing" | "succeeded" | "failed";
  result: unknown;
  commit: { created: Record<string, string>; updated: string[]; deleted: string[]; dataEpoch: number } | null;
  error: { code: string; message: string } | null;
}
export interface RuntimeView {
  appId: string;
  runtime: string | null;
  revisionId: string | null;
  enabled: boolean;
  generation: number;
  controlEpoch: number;
  health: "stopped" | "recovering" | "ready" | "degraded" | null;
  restartCount: number;
  lastError: { code: string; message: string; at?: string } | null;
  instance: { id: string; observedState: string; lastProbeAt: string | null; limits: { memoryBytes: number; cpus: number; pids: number } } | null;
  diagnostics: { level: string; text: string; at: string }[];
}
export interface DeploymentView {
  deploymentId: string;
  appId: string;
  targetRevisionId: string;
  status: "queued" | "preparing" | "ready" | "committed" | "failed" | "cancelled" | "superseded";
  stage: string | null;
  runtime: string;
  cleanupState: string;
  error: { stage?: string; code: string; message: string; diagnostics?: unknown[] } | null;
  health: string | null;
}
export interface ServiceView {
  appId: string;
  appTitle: string;
  revisionId: string;
  exportName: string;
  description: string;
  contractHash: string;
  contractVersion: number;
}
export interface GrantView {
  grantId: string;
  sourceAppId: string;
  sourceRevisionId: string;
  alias: string;
  targetAppId: string;
  targetRevisionId: string;
  exportName: string;
  contractHash: string;
  createdAt: string;
  revokedAt: string | null;
  state: "active" | "inactive" | "revoked";
  reason: string | null;
}

// ---- v0.3 system DTOs (spec §21.1)
export interface SysResource {
  resourceId: string;
  kind: string;
  displayName: string;
  generation: number;
  status: string;
  source: string;
  executionClass: string;
  identity: Record<string, unknown> | null;
  limits: Record<string, unknown> | null;
  quarantineOperationId: string | null;
  connectedApps?: { app_id: string; binding_alias: string; sync_state: string }[];
  lastObservation?: { observedAt: string; quality: string; capabilityId: string; summary: unknown } | null;
}
export interface SysGrant {
  grantId: string;
  principal: { kind: string; appId?: string | null; revisionId?: string | null };
  bindingAlias: string | null;
  capabilityId: string;
  resourceId: string;
  resourceGeneration: number;
  limits: Record<string, unknown>;
  confirmationPolicy: string;
  state: string;
  revocationConfirmed: boolean;
  expiresAt: string;
  syncError: string | null;
}
export interface SysPreview {
  title: string;
  target: string;
  resourceKind: string;
  change: { label: string; from: string | null; to: string }[];
  preconditions: string[];
  reversible: string;
  autoRetry: string;
  risks: string[];
  irreversible: boolean;
}
export interface SysAction {
  actionId: string;
  origin: string;
  appId: string | null;
  runId: string | null;
  handlerId: string | null;
  capabilityId: string;
  resourceId: string;
  planHash: string;
  preview: SysPreview;
  confirmationRequired: boolean;
  confirmationPolicy: string;
  state: string;
  phase: "awaiting_confirmation" | "granting" | "executing" | "done" | "no_effect" | "unknown" | "rejected";
  operationId: string | null;
  expiresAt: string;
  completionKind: string | null;
  effectCertainty: string | null;
  evidenceKind: string | null;
  result: unknown;
  evidence: unknown;
  error: { code: string; message: string } | null;
  resolution: unknown;
  compensationAvailable: boolean;
  retryAdvice: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface SysBindings {
  items: { alias: string; resourceKind: string; description: string; capabilities: { capabilityId: string }[]; grants: SysGrant[]; connected: boolean }[];
  actions: { handlerId: string; description?: string; bindingAlias: string; capabilityId: string }[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorBody,
  ) {
    super(body.message);
  }
  get code(): string {
    return this.body.code;
  }
}

export class NetworkError extends Error {}

let clientEpoch = 0;
export function setClientEpoch(e: number): void {
  clientEpoch = e;
}

async function call<T>(method: string, url: string, body?: unknown, key?: string): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    if (key) headers["Idempotency-Key"] = key;
    headers["X-AgentOS-Epoch"] = String(clientEpoch);
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}), credentials: "same-origin" });
  } catch (e) {
    throw new NetworkError((e as Error).message || "network error");
  }
  let json: { data?: T; error?: ErrorBody } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    /* empty body */
  }
  if (!res.ok || json.error) {
    throw new ApiError(res.status, json.error ?? { code: "INTERNAL", message: `HTTP ${res.status}`, retryable: false });
  }
  return json.data as T;
}

/** One logical write: the same key is reused when the user retries after a network failure. */
export function newKey(): string {
  return crypto.randomUUID();
}

export const api = {
  login: (token: string) => call<{ clientEpoch: number }>("POST", "/api/auth/session", { token }),
  logout: () => call<unknown>("DELETE", "/api/auth/session", {}),
  state: () => call<StateView>("GET", "/api/state"),
  system: () => call<SystemInfo>("GET", "/api/system"),
  app: (appId: string) => call<AppDetail>("GET", `/api/apps/${appId}`),
  revisions: (appId: string) => call<{ items: RevisionSummary[] }>("GET", `/api/apps/${appId}/revisions`),
  activate: (appId: string, body: ActivateBody, key: string) => call<{ appEpoch: number; changed: boolean }>("POST", `/api/apps/${appId}/activate`, body, key),
  records: (appId: string, p: { q?: string; filters?: Record<string, unknown>; offset: number; limit: number }) => {
    const qs = new URLSearchParams();
    if (p.q) qs.set("q", p.q);
    if (p.filters && Object.keys(p.filters).length > 0) qs.set("filters", JSON.stringify(p.filters));
    qs.set("offset", String(p.offset));
    qs.set("limit", String(p.limit));
    return call<RecordPage>("GET", `/api/apps/${appId}/records?${qs.toString()}`);
  },
  createRecord: (appId: string, body: { expectedAppEpoch: number; data: Record<string, unknown> }, key: string) =>
    call<RecordEnvelope>("POST", `/api/apps/${appId}/records`, body, key),
  updateRecord: (appId: string, id: string, body: { expectedAppEpoch: number; expectedRecordVersion: number; changes: Record<string, unknown> }, key: string) =>
    call<RecordEnvelope>("PATCH", `/api/apps/${appId}/records/${id}`, body, key),
  deleteRecord: (appId: string, id: string, body: { expectedAppEpoch: number; expectedRecordVersion: number }, key: string) =>
    call<{ deleted: true }>("DELETE", `/api/apps/${appId}/records/${id}`, body, key),
  submitRun: (body: { intent: string; targetAppId: string | null; expectedAppEpoch?: number }, key: string) =>
    call<{ runId: string; targetAppId: string; status: string }>("POST", "/api/runs", body, key),
  run: (runId: string) => call<RunView>("GET", `/api/runs/${runId}`),
  cancelRun: (runId: string, key: string) => call<RunView>("POST", `/api/runs/${runId}/cancel`, {}, key),
  // v0.2
  query: (appId: string, queryId: string, body: { expectedAppEpoch: number; input: unknown }) =>
    call<{ output: unknown; revisionId: string; appEpoch: number; dataEpoch: number; runtimeGeneration: number }>("POST", `/api/apps/${appId}/queries/${queryId}`, body),
  command: (appId: string, commandId: string, body: { expectedAppEpoch: number; input: unknown }, key: string) =>
    call<{ invocationId: string; status: string }>("POST", `/api/apps/${appId}/commands/${commandId}`, body, key),
  invocation: (id: string) => call<InvocationView>("GET", `/api/invocations/${id}`),
  runtime: (appId: string) => call<RuntimeView>("GET", `/api/apps/${appId}/runtime`),
  runtimeControl: (appId: string, action: "start" | "stop" | "restart", body: { expectedAppEpoch: number }, key: string) =>
    call<{ controlEpoch: number }>("POST", `/api/apps/${appId}/runtime/${action}`, body, key),
  deploy: (appId: string, body: { revisionId: string; expectedAppEpoch: number }, key: string) => call<DeploymentView>("POST", `/api/apps/${appId}/deployments`, body, key),
  deployment: (id: string) => call<DeploymentView>("GET", `/api/deployments/${id}`),
  services: () => call<{ items: ServiceView[] }>("GET", "/api/services"),
  imports: (appId: string) => call<{ items: { alias: string; description?: string; grant: GrantView | null }[] }>("GET", `/api/apps/${appId}/imports`),
  grants: () => call<{ items: GrantView[] }>("GET", "/api/service-grants"),
  createGrant: (body: Omit<GrantView, "grantId" | "createdAt" | "revokedAt" | "state" | "reason">, key: string) => call<GrantView>("POST", "/api/service-grants", body, key),
  revokeGrant: (grantId: string, key: string) => call<GrantView>("POST", `/api/service-grants/${grantId}/revoke`, {}, key),
  // v0.3
  providers: () => call<{ items: { capabilityId: string; mode: string; resourceKinds: string[]; available: boolean; standingAllowed: string }[] }>("GET", "/api/providers"),
  sysResources: () => call<{ items: SysResource[]; broker: Record<string, unknown> }>("GET", "/api/system-resources"),
  registerImportRoot: (body: { path: string; displayName?: string }, key: string) => call<SysResource>("POST", "/api/system-resources/import-roots", body, key),
  readResource: (resourceId: string, capabilityId: string, params: unknown = {}) =>
    call<{ observedAt: string; quality: string; data: unknown; resourceVersion: string | null; observationId: string }>("POST", `/api/system-resources/${resourceId}/read`, { capabilityId, params }),
  providerGrants: () => call<{ items: SysGrant[] }>("GET", "/api/provider-grants"),
  createProviderGrant: (body: { appId: string; bindingAlias: string; resourceId: string; confirmationPolicy: "per_plan" | "standing"; bounds?: Record<string, Record<string, unknown>> }, key: string) =>
    call<{ items: SysGrant[] }>("POST", "/api/provider-grants", body, key),
  revokeProviderGrant: (grantId: string, key: string) => call<{ items: SysGrant[] }>("POST", `/api/provider-grants/${grantId}/revoke`, {}, key),
  systemBindings: (appId: string) => call<SysBindings>("GET", `/api/apps/${appId}/system-bindings`),
  planSystemAction: (appId: string, handlerId: string, body: { expectedAppEpoch: number; input: unknown }, key: string) => call<SysAction>("POST", `/api/apps/${appId}/system-actions/${handlerId}`, body, key),
  systemAction: (id: string) => call<SysAction>("GET", `/api/system-actions/${id}`),
  confirmSystemAction: (id: string, planHash: string, key: string) => call<SysAction>("POST", `/api/system-actions/${id}/confirm`, { planHash }, key),
  cancelSystemAction: (id: string, key: string) => call<SysAction>("POST", `/api/system-actions/${id}/cancel`, { reason: "用户取消" }, key),
  resolveSystemAction: (id: string, body: { decision: string; note: string; releaseQuarantine?: boolean }, key: string) => call<SysAction>("POST", `/api/system-actions/${id}/resolve`, body, key),
  compensateSystemAction: (id: string, key: string) => call<SysAction>("POST", `/api/system-actions/${id}/compensations`, {}, key),
  systemOperations: (open = false) => call<{ items: SysAction[]; brokerOnly: { operationId: string; state: string; capabilityId: string; effectCertainty: string | null }[]; broker: Record<string, unknown> }>("GET", `/api/system-operations${open ? "?open=1" : ""}`),
  observations: (sinceSeq = 0) => call<{ events: unknown[]; cursors: { source: string; quality: string; drop_count: number; last_refresh_at: string | null }[]; lastSeq: number; requiresFullReread: boolean; telemetry: Record<string, unknown> }>("GET", `/api/observations?sinceSeq=${sinceSeq}`),
  submitSystemPlan: (body: { intent: string; targetAppId: null; mode: "system_plan"; resourceIds: string[]; capabilityScopes: string[] }, key: string) =>
    call<{ runId: string; status: string }>("POST", "/api/runs", body, key),
  // v0.4 task center / maintenance center (spec §22)
  runs: (limit = 30) => call<{ items: RunView[]; foregroundSlots: number }>("GET", `/api/runs?limit=${limit}`),
  maintState: () => call<MaintState>("GET", "/api/maintenance/state"),
  maintPolicies: () => call<{ items: MaintPolicy[] }>("GET", "/api/maintenance/policies"),
  maintTemplates: () => call<{ items: { id: string; title: string; targetKind: string; risk: string; usesModel: boolean; defaults: Record<string, number>; bounds: Record<string, [number, number]> }[] }>("GET", "/api/maintenance/templates"),
  maintJobs: (open = false) => call<{ items: MaintJob[] }>("GET", `/api/maintenance/jobs?limit=30${open ? "&open=1" : ""}`),
  maintControl: (action: "pause" | "resume", key: string) => call<MaintState>("POST", "/api/maintenance/control", { action }, key),
  maintPolicyApprove: (id: string, version: number, policyHash: string, key: string) => call<MaintPolicy>("POST", `/api/maintenance/policies/${id}/approve`, { version, policyHash }, key),
  maintPolicyPause: (id: string, key: string) => call<MaintPolicy>("POST", `/api/maintenance/policies/${id}/pause`, {}, key),
  maintCheck: (templateId: string, target: { kind: string; id: string }, key: string) => call<{ jobId: string }>("POST", "/api/maintenance/checks", { templateId, target }, key),
  maintCancelJob: (id: string, key: string) => call<MaintJob>("POST", `/api/maintenance/jobs/${id}/cancel`, {}, key),
  maintResetCircuit: (body: { targetKind: string; targetId: string }, key: string) => call<unknown>("POST", "/api/maintenance/circuits/reset", body, key),
  incidents: () => call<{ items: { incidentId: string; target: { kind: string; id: string }; condition: string; state: string; evidenceCount: number; quality: string; circuit?: string | null; lastSeenAt: string; jobId: string | null }[] }>("GET", "/api/health/incidents?open=1"),
  notifications: () => call<{ items: { id: string; kind: string; severity: string; title: string; detail: string | null; count: number; state: string; updatedAt: string }[] }>("GET", "/api/notifications"),
  readNotification: (id: string, key: string) => call<unknown>("POST", `/api/notifications/${id}/read`, {}, key),
  transcript: (runId: string) => call<{ final: boolean; items: { kind: string; role: string; text: string; toolName?: string; isError?: boolean }[] }>("GET", `/api/runs/${runId}/transcript`),
  proposals: () => call<{ items: ProposalView[] }>("GET", "/api/proposals"),
  acceptProposal: (id: string, proposalHash: string, expectedAppEpoch: number, key: string) =>
    call<ProposalView>("POST", `/api/proposals/${id}/accept`, { proposalHash, expectedAppEpoch }, key),
  rejectProposal: (id: string, key: string) => call<ProposalView>("POST", `/api/proposals/${id}/reject`, {}, key),
  lifecycle: (appId: string) => call<LifecycleView | null>("GET", `/api/apps/${appId}/lifecycle`),
  archiveApp: (appId: string, expectedAppEpoch: number, key: string) => call<LifecycleView>("POST", `/api/apps/${appId}/archive`, { expectedAppEpoch }, key),
  restoreApp: (appId: string, key: string) => call<LifecycleView>("POST", `/api/apps/${appId}/restore`, {}, key),
  compactConversation: (conversationId: string, key: string) => call<{ compactionId: string; state: string }>("POST", `/api/conversations/${conversationId}/compactions`, {}, key),
};

export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    const map = WEB_ERROR_TEXT;
    return map[e.code] ? `${map[e.code]}（${e.code}）` : `${e.message}（${e.code}）`;
  }
  if (e instanceof NetworkError) return NETWORK_ERROR_TEXT;
  return (e as Error)?.message ?? String(e);
}

export interface ProposalView {
  proposalId: string;
  appId: string;
  state: string;
  proposalHash: string;
  baseAppEpoch: number;
  label: string;
  reasons: string;
  expectedBenefit?: string;
  diff?: { files?: { path: string }[] };
  expiresAt?: string;
}
export interface LifecycleView {
  appId: string;
  state: string;
  lastUsedAt: string | null;
  recoveryPaused?: boolean;
  note?: string;
}

export interface MaintState {
  state: "running" | "paused";
  epoch: number;
  root: string;
  clock?: string;
  budgets?: { limits: Record<string, number>; usage: Record<string, number> };
  circuits?: { targetKind: string; targetId: string; actionFamily: string; state: string; consecutiveFailures: number; openedAt: string | null; reason: string | null }[];
  metrics?: Record<string, unknown> | null;
  lastSampleAt?: string | null;
  foreground?: { slots: number; queued: number };
  [k: string]: unknown;
}
export interface MaintPolicy {
  policyId: string;
  version: number;
  templateId: string;
  target: { kind: string; id: string };
  trigger: { kind: string; intervalSeconds?: number };
  bounds: Record<string, number>;
  mode: string;
  state: string;
  policyHash: string;
  approval: { approvedAt: string | null; expiresAt: string | null };
  rootSync: { state: string | null; local: string; root: string };
  risk: string;
  allowedActions?: string[];
  automaticActions?: string[];
  usesModel?: boolean;
}
export interface MaintJob {
  jobId: string;
  templateId: string;
  state: string;
  target?: { kind: string; id: string };
  mode?: string;
  outcomeReason?: string | null;
  waitReason?: string | null;
  effectCertainty?: string | null;
  completedSteps?: number;
  createdAt?: string;
  updatedAt?: string;
  steps?: { stepId: string; state: string; kind?: string }[];
  [k: string]: unknown;
}
