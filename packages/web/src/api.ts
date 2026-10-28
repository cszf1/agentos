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
    };
    return map[e.code] ? `${map[e.code]}（${e.code}）` : `${e.message}（${e.code}）`;
  }
  if (e instanceof NetworkError) return "连接中断，可以点“重试”（不会重复提交）";
  return (e as Error)?.message ?? String(e);
}
