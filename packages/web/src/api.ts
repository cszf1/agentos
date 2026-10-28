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
  transcript: (runId: string) => call<{ final: boolean; items: { kind: string; role: string; text: string; toolName?: string; isError?: boolean }[] }>("GET", `/api/runs/${runId}/transcript`),
};

export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    const map: Record<string, string> = {
      AUTH_REQUIRED: "需要重新登录",
      RUN_BUSY: "已有生成任务在运行，请等待它结束",
      APP_EPOCH_STALE: "应用版本已经切换，请刷新后再提交（你的输入已保留）",
      RECORD_VERSION_STALE: "这条记录刚被修改过，请刷新后再试（你的输入已保留）",
      CLIENT_EPOCH_STALE: "工作区已恢复到其他状态，请刷新页面",
      ALREADY_APPLIED: "该任务已经发布了新版本，请通过版本切换撤回",
      MODEL_UNAVAILABLE: "模型不可用，无法创建或修改应用",
      RECOVERY_BLOCKED: "工作区需要恢复，写入已暂停",
      STORE_UNAVAILABLE: "本地存储暂不可用，请稍后重试",
      SANDBOX_UNAVAILABLE: "代码应用运行环境不可用",
      RUNTIME_STOPPED: "应用已停止，请先启动",
      INSTANCE_NOT_READY: "应用正在启动或恢复，请稍后再试",
      APP_TIMEOUT: "应用执行超时，已被停止",
      APP_BUSY: "应用正忙，请稍后再试",
      DEPLOYMENT_BUSY: "另一个版本切换正在进行",
      DEPLOYMENT_REQUIRED: "代码版本需要通过发布流程切换",
      DATA_EPOCH_STALE: "数据已变化，请刷新后重试（输入已保留）",
      GRANT_REQUIRED: "服务未连接",
      GRANT_REVOKED: "服务已断开",
      SERVICE_UNAVAILABLE: "服务暂不可用",
      PROVIDER_UNAVAILABLE: "系统能力暂不可用",
      PROVIDER_GRANT_REQUIRED: "需要先连接资源",
      GRANT_PENDING: "授权尚未同步完成",
      GRANT_REVOKING: "授权撤销待确认",
      BROKER_UNAVAILABLE: "系统执行服务不可用，系统写入已暂停",
      BROKER_IDENTITY_MISMATCH: "系统执行服务身份不匹配，系统写入已关闭",
      WORKSPACE_FENCED: "工作区已恢复为新代次，旧计划不能执行",
      PLAN_EXPIRED: "计划已过期，请重新生成",
      PLAN_HASH_MISMATCH: "计划内容已变化，请重新确认",
      RESOURCE_GENERATION_STALE: "资源已变化，请重新连接或重新生成计划",
      RESOURCE_BUSY: "资源正忙或已被隔离",
      SYSTEM_ACTION_PENDING: "有系统操作尚未结算，暂不能切换版本",
      BROKER_POLICY_DENIED: "超出安装策略允许的范围",
      INVALID_SYSTEM_PLAN: "计划不合法",
      MIXED_EFFECTS_FORBIDDEN: "一个系统动作只能有一个效果",
      COMPENSATION_CONFLICT: "当前状态已变化，不能补偿",
      OBSERVATION_EXPIRED: "观察已过期，请重新读取",
      OBSERVATION_GAP: "观察有缺口，请重新读取",
    };
    return map[e.code] ? `${map[e.code]}（${e.code}）` : `${e.message}（${e.code}）`;
  }
  if (e instanceof NetworkError) return "连接中断，可以点“重试”（不会重复提交）";
  return (e as Error)?.message ?? String(e);
}
