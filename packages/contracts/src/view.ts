import type { AppBundle, Field, FieldValue } from "./bundle.js";

// Shared, data-only view rules. This entry must not import Node APIs or schema validators.
export const RESERVED_KEYS: ReadonlySet<string> = new Set(["constructor", "prototype", "__proto__"]);
export const POINTER_PATTERN = "^(/[A-Za-z0-9_-]{1,64}){0,8}$";
const POINTER_RE = new RegExp(POINTER_PATTERN);

export const UI_LIMITS = {
  maxNodes: 256,
  maxDepth: 12,
  maxChildren: 64,
  maxSeries: 8,
  maxPointsPerSeries: 500,
  minRefreshSeconds: 5,
  maxRefreshSeconds: 3600,
  maxDataSources: 8,
} as const;

export const SLOT_COMPONENT_TYPES = ["Stack", "Grid", "Tabs", "Text", "Alert", "Metric", "Table", "Kanban", "Form", "TextInput", "TextArea", "Select", "Checkbox", "Button", "BarChart", "LineChart", "SystemActionButton", "List"] as const;

/** Shared display messages; these are UI text, not authorization or retry policy. */
export const WEB_ERROR_TEXT: Readonly<Record<string, string>> = Object.freeze({
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
  RUN_QUEUE_FULL: "任务队列已满，请等一个任务结束后再提交",
  TARGET_BUSY: "这个目标正忙，请稍后再试",
  TARGET_CHANGED: "排队期间应用已经变化，请按当前版本重新提交",
  RUN_IDENTITY_MISMATCH: "任务身份不匹配，这次调用被拒绝",
  EXECUTION_EPOCH_STALE: "这次执行已经失效（取消、撤销或恢复之后）",
  MODEL_BUDGET_EXCEEDED: "模型额度已用完",
  MAINTENANCE_DISABLED: "自动维护未启用",
  POLICY_VERSION_STALE: "维护策略已经更新，请按新版本重新确认",
  POLICY_SYNC_PENDING: "维护策略还在等待系统执行端确认",
  CLOCK_UNCERTAIN: "系统时钟发生跳变，自动维护已停止",
  CIRCUIT_OPEN: "自动恢复已熔断，需要你确认后才能继续",
  ARTIFACT_GC_PENDING: "构建缓存正在清理，请稍后再试",
  PROPOSAL_STALE: "候选已经过期或基线变了，请重新查看",
  APP_ARCHIVED: "应用已归档",
  COMPACTION_SCOPE_DENIED: "不能压缩这段对话",
});
export const NETWORK_ERROR_TEXT = "连接中断，可以点“重试”（不会重复提交）";
export const INVOCATION_TEXT: Readonly<Record<string, string>> = Object.freeze({
  DATA_EPOCH_STALE: "数据在命令执行期间被修改，没有写入任何内容；请刷新后重试（输入已保留）",
  APP_EPOCH_STALE: "应用版本已切换，命令没有执行（输入已保留）",
  INSTANCE_STALE: "应用实例在执行中切换，没有写入任何内容",
  INVALID_MUTATION: "应用返回了不允许的修改，已整体拒绝",
  APP_TIMEOUT: "应用执行超时，已被停止，没有写入任何内容",
  INVOCATION_EXPIRED: "命令超过了最长期限，没有写入任何内容",
  RUNTIME_STOPPED: "应用已停止，请先启动",
  INSTANCE_NOT_READY: "应用正在恢复，请稍后再试",
});

export function defaultRecordDraft(bundle: AppBundle): Record<string, FieldValue> {
  const d: Record<string, FieldValue> = {};
  for (const k of bundle.view.formFields) {
    const f = bundle.data.fields[k]!;
    if (f.default !== undefined) d[k] = f.default;
    else if (f.type === "boolean") d[k] = false;
    else if (f.type === "string") d[k] = "";
    else if (f.type === "enum") d[k] = f.values[0]!;
  }
  return d;
}

export function displayRecordValue(f: Field, v: FieldValue | undefined): string {
  if (v === undefined) return "";
  if (f.type === "boolean") return v ? "✓" : "—";
  return String(v);
}

/** Only fields offered by the current form enter an edit draft. */
export function editRecordDraft(bundle: AppBundle, data: Record<string, FieldValue | undefined>): Record<string, FieldValue> {
  const draft: Record<string, FieldValue> = {};
  for (const k of bundle.view.formFields) if (data[k] !== undefined) draft[k] = data[k]!;
  return draft;
}

/** Retain entered values for fields still offered after a version switch. */
export function rebaseRecordDraft(bundle: AppBundle, mode: "create" | "edit", draft: Record<string, FieldValue | undefined>): Record<string, FieldValue> {
  const fresh = mode === "create" ? defaultRecordDraft(bundle) : {};
  return Object.assign(fresh, editRecordDraft(bundle, draft));
}

export function asText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

/** Read a restricted JSON Pointer over own properties only (no prototype access, no evaluation). */
export function readPointer(root: unknown, ptr: string): unknown {
  if (!POINTER_RE.test(ptr)) return undefined;
  if (ptr === "") return root;
  let cur: unknown = root;
  for (const seg of ptr.slice(1).split("/")) {
    if (RESERVED_KEYS.has(seg)) return undefined;
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]{0,5})$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
    } else if (cur !== null && typeof cur === "object") {
      if (!Object.hasOwn(cur, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    } else return undefined;
  }
  return cur;
}
