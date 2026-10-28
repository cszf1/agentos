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
    };
    return map[e.code] ? `${map[e.code]}（${e.code}）` : `${e.message}（${e.code}）`;
  }
  if (e instanceof NetworkError) return "连接中断，可以点“重试”（不会重复提交）";
  return (e as Error)?.message ?? String(e);
}
