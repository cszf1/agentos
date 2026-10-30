// Shell behaviour model shared by the web renderer and the native Qt Shell (spec §10.3). This file is the reference the
// vector generator (scripts/slot-vectors.mjs) runs; the C++ renderer in desktop/renderer must reproduce its outputs.
// It is a data-only port of packages/web/src/SlotRenderer.tsx (render semantics, forms, commands, idempotency keys).
import { readPointer, checkSlotTree, type SlotTreeContext } from "../v2/ui.js";
import { codePoints } from "../bundle.js";
import { FORWARD_ROUTES } from "./forward-routes.js";

/** describeError() texts of packages/web/src/api.ts plus the v1.0 native error classes (spec §16.2). */
export const ERROR_TEXT: Record<string, string> = {
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
  COMPACTION_SCOPE_DENIED: "不能压缩这段对话",  NOT_FOUND_OR_FORBIDDEN: "对象不存在或你没有权限",
  SESSION_REQUIRED: "需要重新登录",
  SESSION_LOCKED: "会话已锁定，解锁后再操作",
  SESSION_STALE: "会话已过期，需要重新绑定",
  MEMBERSHIP_REVOKED: "你在这个工作区的成员权限已被撤销",
  REGISTRY_NOT_SYNCED: "成员目录尚未同步，写入已暂停",
  STORE_ALREADY_REGISTERED: "存储已被另一个写者登记",
  PLAN_STALE: "计划已经过期或状态已变化，请重新生成并确认",
  MACHINE_CAPACITY: "机器资源已满，已排队",
  PERMIT_RECONCILING: "资源许可正在核对，已排队",
  UPDATE_SIGNATURE_INVALID: "更新签名无效，已拒绝",
  RELEASE_REPLAYED: "这是一个旧版本的重放，已拒绝",
  ROLLBACK_INCOMPATIBLE: "回退与当前数据不兼容，进入兼容检查",
  MIGRATION_REQUIRED: "需要先迁移数据",
  CHECKPOINT_INCOMPLETE: "检查点不完整，业务写入已暂停",
  RESTORE_IN_PROGRESS: "正在恢复，业务写入已暂停",
  EFFECT_UNKNOWN: "结果未知，已保留已知事实，不会自动重做",
  RESOURCE_QUARANTINED: "资源已隔离",
  HARDWARE_UNSUPPORTED: "此硬件能力不可用",
  NATIVE_RENDER_UNSUPPORTED: "原生界面不支持这个版本，请切换版本",
  EVENT_GAP: "事件有缺口，正在重新读取完整状态",
  HOST_UNAVAILABLE: "工作区服务不可用，显示的是缓存内容",
  IDEMPOTENCY_REQUIRED: "写入缺少幂等键",
  FRAME_TOO_LARGE: "请求超过 4 MiB 上限",
  CLIENT_QUEUE_FULL: "请求过多，请稍后再试",
};
export const NETWORK_ERROR_TEXT = "连接中断，可以点“重试”（不会重复提交）";

export const INVOCATION_TEXT: Record<string, string> = {
  DATA_EPOCH_STALE: "数据在命令执行期间被修改，没有写入任何内容；请刷新后重试（输入已保留）",
  APP_EPOCH_STALE: "应用版本已切换，命令没有执行（输入已保留）",
  INSTANCE_STALE: "应用实例在执行中切换，没有写入任何内容",
  INVALID_MUTATION: "应用返回了不允许的修改，已整体拒绝",
  APP_TIMEOUT: "应用执行超时，已被停止，没有写入任何内容",
  INVOCATION_EXPIRED: "命令超过了最长期限，没有写入任何内容",
  RUNTIME_STOPPED: "应用已停止，请先启动",
  INSTANCE_NOT_READY: "应用正在恢复，请稍后再试",
};

export function describeError(code: string, message: string): string {
  return ERROR_TEXT[code] ? `${ERROR_TEXT[code]}（${code}）` : `${message}（${code}）`;
}

/** What the Shell does with a standard error (spec §16.2). Never an automatic resend with a new id. */
export interface ErrorPolicy {
  stopSubmits: boolean;
  rebind: boolean;
  lock: boolean;
  stopWrites: boolean;
  reread: boolean;
  keepInput: boolean;
  keepKey: boolean;
  degrade: "host" | "model" | "broker" | null;
  hideObject: boolean;
}
const P = (o: Partial<ErrorPolicy>): ErrorPolicy => ({ stopSubmits: false, rebind: false, lock: false, stopWrites: false, reread: false, keepInput: true, keepKey: false, degrade: null, hideObject: false, ...o });
export const ERROR_POLICY: Record<string, ErrorPolicy> = {
  NOT_FOUND_OR_FORBIDDEN: P({ hideObject: true, reread: true }),
  SESSION_REQUIRED: P({ stopSubmits: true, rebind: true }),
  SESSION_LOCKED: P({ stopSubmits: true, lock: true }),
  SESSION_STALE: P({ stopSubmits: true, rebind: true }),
  MEMBERSHIP_REVOKED: P({ stopSubmits: true, stopWrites: true, reread: true }),
  REGISTRY_NOT_SYNCED: P({ stopWrites: true }),
  WORKSPACE_FENCED: P({ stopWrites: true, reread: true }),
  STORE_ALREADY_REGISTERED: P({ stopWrites: true }),
  CLIENT_EPOCH_STALE: P({ reread: true }),
  PLAN_STALE: P({ reread: true }),
  MACHINE_CAPACITY: P({}),
  PERMIT_RECONCILING: P({}),
  UPDATE_SIGNATURE_INVALID: P({}),
  RELEASE_REPLAYED: P({}),
  ROLLBACK_INCOMPATIBLE: P({ stopWrites: true }),
  MIGRATION_REQUIRED: P({ stopWrites: true }),
  CHECKPOINT_INCOMPLETE: P({ stopWrites: true }),
  RESTORE_IN_PROGRESS: P({ stopWrites: true }),
  EFFECT_UNKNOWN: P({ keepKey: true }),
  RESOURCE_QUARANTINED: P({}),
  HARDWARE_UNSUPPORTED: P({}),
  NATIVE_RENDER_UNSUPPORTED: P({}),
  EVENT_GAP: P({ reread: true }),
  HOST_UNAVAILABLE: P({ stopWrites: true, degrade: "host", keepKey: true }),
  STORE_UNAVAILABLE: P({ stopWrites: true, degrade: "host", keepKey: true }),
  MODEL_UNAVAILABLE: P({ degrade: "model" }),
  BROKER_UNAVAILABLE: P({ degrade: "broker" }),
  APP_EPOCH_STALE: P({ reread: true }),
  RECORD_VERSION_STALE: P({ reread: true }),
  DATA_EPOCH_STALE: P({ reread: true }),
  AUTH_REQUIRED: P({ stopSubmits: true, rebind: true }),
};
export const DEFAULT_ERROR_POLICY: ErrorPolicy = P({});
export function errorPolicy(code: string): ErrorPolicy {
  return ERROR_POLICY[code] ?? DEFAULT_ERROR_POLICY;
}

// ------------------------------------------------------------------ Slot Tree runtime model
type V = unknown;
type Obj = Record<string, unknown>;
const KNOWN = new Set(["Stack", "Grid", "Tabs", "Text", "Alert", "Metric", "Table", "Kanban", "Form", "TextInput", "TextArea", "Select", "Checkbox", "Button", "BarChart", "LineChart", "SystemActionButton", "List"]);
const MAX_NODES = 256;
const MAX_DEPTH = 12;

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
const isBind = (v: unknown): v is { $bind: Obj } => v !== null && typeof v === "object" && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, "$bind");

/** A missing value is encoded as {"$missing": true} in vector JSON so that undefined and null stay distinct. */
export const MISSING = { $missing: true } as const;
export function encodeValue(v: unknown): unknown {
  if (v === undefined) return MISSING;
  return v;
}

export interface ForwardRequest {
  methodId: "workspace.forward";
  routeId: string;
  params: Record<string, string>;
  body: unknown;
  write: boolean;
  idempotencyKey: string;
}
export function forward(routeId: string, params: Record<string, string>, body: unknown, idempotencyKey: string): ForwardRequest {
  const r = FORWARD_ROUTES[routeId];
  if (!r) throw new Error(`route ${routeId} is not registered`);
  return { methodId: "workspace.forward", routeId, params, body, write: r.write, idempotencyKey };
}

export type Outcome =
  | { invocation: "succeeded"; commitCount: number }
  | { invocation: "failed"; code: string; message?: string }
  | { invocation: "running" }
  | { plan: "confirmationRequired" | "standing"; actionId: string }
  | { network: true }
  | { apiError: string; message?: string };

export interface ClickResult {
  kind: "none" | "error" | "confirm" | "request";
  notice?: { kind: string; text: string };
  confirmText?: string;
  request?: ForwardRequest;
}

export class SlotSession {
  sources: Record<string, unknown> = {};
  forms: Record<string, Record<string, unknown>> = {};
  selections: Record<string, string[]> = {};
  pages: Record<string, number> = {};
  tabs: Record<string, number> = {};
  busy = false;
  disabled = false;
  staleInput = false;
  notice: { kind: string; text: string } | null = null;
  pendingKey: { sig: string; key: string } | null = null;
  private keyN = 0;
  private inflight: { kind: "command" | "system"; p: Obj; spec: Obj } | null = null;
  private pendingConfirm: { p: Obj; item: unknown } | null = null;
  openedPlans: string[] = [];
  reloads = 0;
  view: Obj;
  constructor(public bundle: Obj, public app: { appId: string; appEpoch: number; revisionId: string }) {
    this.view = bundle.view as Obj;
  }
  newKey(): string {
    return `k${++this.keyN}`;
  }
  context(): SlotTreeContext {
    const b = this.bundle;
    const v3 = b.formatVersion === 3;
    return { queries: b.queries as Record<string, { inputSchema: unknown }>, commands: b.commands as Record<string, unknown>, systemActions: v3 ? ((b.system as Obj).actions as Record<string, unknown>) : undefined, viewKind: v3 ? "slot-tree-v2" : "slot-tree-v1" };
  }
  validate() {
    return checkSlotTree(this.view, this.context()).issues;
  }
  /** One request per data source, in declaration order. */
  queryRequests(): ForwardRequest[] {
    return Object.entries(this.view.dataSources as Record<string, Obj>).map(([name, ds]) =>
      forward("apps.queries.post", { appId: this.app.appId, queryId: ds.queryId as string }, { expectedAppEpoch: this.app.appEpoch, input: ds.input ?? {} }, `q:${name}`),
    );
  }
  /** A query answer is applied only when it belongs to the current revision and epoch (late answers are dropped). */
  applyQuery(source: string, r: { output: unknown; revisionId: string; appEpoch: number }): boolean {
    if (r.revisionId !== this.app.revisionId || r.appEpoch !== this.app.appEpoch) return false;
    this.sources[source] = r.output;
    return true;
  }

  // ------------------------------------------------------------ resolve / render
  resolve(v: unknown, item: unknown, inItem: boolean): unknown {
    if (!isBind(v)) return v;
    const b = v.$bind as Obj;
    switch (b.from) {
      case "query":
        return readPointer(this.sources[b.source as string], b.pointer as string);
      case "form":
        return readPointer(this.forms[b.formId as string] ?? {}, b.pointer as string);
      case "selection":
        return this.selections[b.selectionId as string] ?? [];
      case "item":
        return inItem ? readPointer(item, b.pointer as string) : undefined;
      default:
        return undefined;
    }
  }
  visible(node: Obj, item: unknown, inItem: boolean): boolean {
    const w = node.visibleWhen as { value: unknown; op: string; equals?: unknown } | undefined;
    if (!w) return true;
    const v = this.resolve(w.value, item, inItem);
    if (w.op === "exists") return v !== undefined && v !== null;
    return v === w.equals;
  }
  render(): Obj[] {
    const out: Obj[] = [];
    const counter = { n: 0 };
    // Toolbar, then main, then aside: the order the web page mounts them in (one shared node budget).
    for (const slot of ["toolbar", "main", "aside"]) {
      const node = (this.view.slots as Obj)[slot] as Obj | undefined;
      if (node) out.push(this.node(node, `/view/slots/${slot}`, null, 1, counter, undefined, false) ?? { path: `/view/slots/${slot}`, type: node.type, visible: false });
    }
    return out;
  }
  private node(node: Obj, path: string, formId: string | null, depth: number, counter: { n: number }, item: unknown, inItem: boolean): Obj | null {
    counter.n++;
    if (counter.n > MAX_NODES || depth > MAX_DEPTH) return { path, type: "error", text: "界面超过节点或层级上限" };
    if (!KNOWN.has(node.type as string)) return { path, type: "error", text: `未知组件 ${asText(node.type)}` };
    if (!this.visible(node, item, inItem)) return { path, type: node.type, visible: false };
    const p = (node.props ?? {}) as Obj;
    const kids = (fid: string | null = formId) => ((node.children ?? []) as Obj[]).map((c, i) => this.node(c, `${path}/children/${i}`, fid, depth + 1, counter, item, inItem) ?? { path: `${path}/children/${i}`, type: c.type, visible: false });
    const base: Obj = { path, type: node.type, visible: true };
    const r = (v: unknown) => this.resolve(v, item, inItem);
    switch (node.type) {
      case "Stack":
        return { ...base, direction: p.direction === "horizontal" ? "horizontal" : "vertical", gap: (p.gap as string) ?? "md", children: kids() };
      case "Grid":
        return { ...base, columns: Number(p.columns) || 1, gap: (p.gap as string) ?? "md", children: kids() };
      case "Tabs": {
        const labels = (p.labels as string[]) ?? [];
        const active = this.tabs[path] ?? 0;
        const children = (node.children ?? []) as Obj[];
        const child = children[active];
        return { ...base, labels, active, children: child ? [this.node(child, `${path}/children/${active}`, formId, depth + 1, counter, item, inItem) ?? { path: `${path}/children/${active}`, type: child.type, visible: false }] : [] };
      }
      case "Text":
        return { ...base, text: asText(r(p.text)), variant: (p.variant as string) ?? "body" };
      case "Alert":
        return { ...base, status: p.status, text: asText(r(p.text)) };
      case "Metric":
        return { ...base, label: asText(p.label), value: asText(r(p.value)), unit: typeof p.unit === "string" ? p.unit : null };
      case "Table":
        return { ...base, ...this.table(p, path, item, inItem) };
      case "Kanban":
        return { ...base, ...this.kanban(p, item, inItem) };
      case "Form":
        return { ...base, formId: p.formId, title: typeof p.title === "string" ? p.title : null, children: kids(p.formId as string) };
      case "TextInput":
      case "TextArea":
      case "Select":
      case "Checkbox": {
        if (!formId) return { path, type: node.type, visible: false };
        const name = p.name as string;
        const v = this.forms[formId]?.[name];
        const label = asText(p.label);
        if (node.type === "Checkbox") return { ...base, formId, name, label, checked: v === true };
        if (node.type === "Select") return { ...base, formId, name, label, value: typeof v === "string" ? v : "", allowDefault: !p.required, options: ((p.options as Obj[]) ?? []).map((o) => ({ value: o.value, label: o.label })) };
        if (node.type === "TextArea") return { ...base, formId, name, label, value: typeof v === "string" ? v : "", maxLength: (p.maxLength as number) ?? 4096 };
        const integer = p.mode === "integer";
        return { ...base, formId, name, label, value: v === undefined || v === null ? "" : String(v), mode: integer ? "integer" : "text", maxLength: integer ? 16 : ((p.maxLength as number) ?? 4096), placeholder: asText(p.placeholder) };
      }
      case "Button":
        return { ...base, label: asText(p.label), command: p.command, variant: (p.variant as string) ?? "secondary", disabled: this.busy || this.disabled || this.staleInput, confirm: typeof p.confirm === "string" ? p.confirm : null };
      case "SystemActionButton":
        return { ...base, label: asText(p.label), action: p.action, variant: (p.variant as string) ?? "secondary", disabled: this.busy || this.disabled || this.staleInput };
      case "BarChart":
      case "LineChart":
        return { ...base, ...this.chart(p, item, inItem) };
      case "List":
        return { ...base, ...this.list(node, p, path, formId, depth, item, inItem) };
      default:
        return null;
    }
  }
  private rowId(it: unknown, p: Obj, i: number): string {
    const v = readPointer(it, (p.rowId as string) ?? "/id");
    return typeof v === "string" ? v : String(i);
  }
  private table(p: Obj, path: string, item: unknown, inItem: boolean): Obj {
    const items = this.resolve(p.items, item, inItem);
    const list = Array.isArray(items) ? items : [];
    const size = (p.pageSize as number) ?? 20;
    const pages = Math.max(1, Math.ceil(list.length / size));
    const page = Math.max(0, Math.min(this.pages[path] ?? 0, pages - 1));
    const shown = list.slice(page * size, page * size + size);
    const cols = (p.columns as { pointer: string; label: string }[]) ?? [];
    const sel = p.selectionId as string | undefined;
    return {
      columns: cols.map((c) => c.label),
      selectionId: sel ?? null,
      page,
      pages,
      total: list.length,
      emptyText: shown.length === 0 ? asText(p.emptyText) || "没有数据" : null,
      rows: shown.map((it, i) => {
        const id = this.rowId(it, p, page * size + i);
        return { id, selected: sel ? (this.selections[sel] ?? []).includes(id) : false, cells: cols.map((c) => asText(readPointer(it, c.pointer))) };
      }),
    };
  }
  private kanban(p: Obj, item: unknown, inItem: boolean): Obj {
    const items = this.resolve(p.items, item, inItem);
    const list = Array.isArray(items) ? items.slice(0, 1000) : [];
    const groups = (p.groups as { value: unknown; label: string }[]) ?? [];
    const fields = (p.cardFields as { pointer: string; label: string }[]) ?? [];
    const sel = p.selectionId as string | undefined;
    return {
      selectionId: sel ?? null,
      columns: groups.map((g) => {
        const col = list.map((it, i) => ({ it, i })).filter(({ it }) => readPointer(it, p.groupPointer as string) === g.value);
        return {
          label: g.label,
          count: col.length,
          cards: col.map(({ it, i }) => {
            const id = this.rowId(it, p, i);
            return { id, selected: sel ? (this.selections[sel] ?? []).includes(id) : false, title: asText(readPointer(it, p.cardTitlePointer as string)), fields: fields.map((f) => `${f.label}：${asText(readPointer(it, f.pointer))}`) };
          }),
        };
      }),
    };
  }
  private chart(p: Obj, item: unknown, inItem: boolean): Obj {
    const data = this.resolve(p.data, item, inItem);
    const rows = Array.isArray(data) ? data.slice(0, 500) : [];
    const series = ((p.series as { pointer: string; label: string }[]) ?? []).slice(0, 8);
    const xs = rows.map((r) => asText(readPointer(r, p.xPointer as string)));
    const values = series.map((s) => rows.map((r) => {
      const n = readPointer(r, s.pointer);
      return typeof n === "number" && Number.isFinite(n) ? n : 0;
    }));
    const max = Math.max(1, ...values.flat());
    return { title: typeof p.title === "string" ? p.title : null, xs, series: series.map((s, i) => ({ label: s.label, values: values[i] })), max, truncatedRows: Array.isArray(data) ? Math.max(0, data.length - 500) : 0 };
  }
  private list(node: Obj, p: Obj, path: string, formId: string | null, depth: number, _item: unknown, _inItem: boolean): Obj {
    const data = this.resolve(p.items, _item, _inItem);
    const max = Math.min(100, typeof p.maxItems === "number" ? p.maxItems : 50);
    const items = Array.isArray(data) ? data.slice(0, max) : [];
    const base: Obj = { direction: p.direction === "horizontal" ? "horizontal" : "vertical", gap: (p.gap as string) ?? "md", templateNodes: countNodes((node.children ?? []) as Obj[]) };
    if (items.length === 0) return { ...base, emptyText: asText(p.emptyText) || "暂无数据", items: [], more: null };
    const seen = new Set<string>();
    return {
      ...base,
      emptyText: null,
      items: items.map((it, i) => {
        let key = asText(readPointer(it, (p.rowId as string) ?? "/id"));
        if (key === "" || seen.has(key)) key = `#${i}`;
        seen.add(key);
        const counter = { n: 0 };
        return { key, children: ((node.children ?? []) as Obj[]).map((c, j) => this.node(c, `${path}/items/${i}/children/${j}`, formId, depth + 1, counter, it, true) ?? { path: `${path}/items/${i}/children/${j}`, type: c.type, visible: false }) };
      }),
      more: Array.isArray(data) && data.length > max ? `仅显示前 ${max} 项（共 ${data.length} 项）` : null,
    };
  }

  // ------------------------------------------------------------ interaction
  /** Find a node by render path; list item paths (…/items/N/children/…) resolve to the template plus that item. */
  findNode(path: string): { node: Obj; item: unknown; inItem: boolean; formId: string | null } | null {
    const m = /^\/view\/slots\/(main|toolbar|aside)(.*)$/.exec(path);
    if (!m) return null;
    let node = (this.view.slots as Obj)[m[1]!] as Obj | undefined;
    let item: unknown = undefined;
    let inItem = false;
    let formId: string | null = null;
    const segs = m[2]!.split("/").filter((s) => s !== "");
    for (let i = 0; node && i < segs.length; i += 2) {
      if (node.type === "Form") formId = (node.props as Obj).formId as string;
      const kind = segs[i];
      const n = Number(segs[i + 1]);
      if (kind === "children") node = ((node.children ?? []) as Obj[])[n];
      else if (kind === "items" && node.type === "List") {
        const p = (node.props ?? {}) as Obj;
        const data = this.resolve(p.items, item, inItem);
        const max = Math.min(100, typeof p.maxItems === "number" ? p.maxItems : 50);
        if (!Array.isArray(data) || n >= Math.min(max, data.length)) return null;
        item = data[n];
        inItem = true;
        i += 2;
        if (segs[i] !== "children") return null;
        node = ((node.children ?? []) as Obj[])[Number(segs[i + 1])];
      } else return null;
    }
    if (node && node.type === "Form") formId = (node.props as Obj).formId as string;
    return node ? { node, item, inItem, formId } : null;
  }
  private inputNode(formId: string, name: string): Obj | null {
    let found: Obj | null = null;
    const walk = (n: Obj, fid: string | null) => {
      const p = (n.props ?? {}) as Obj;
      const id = n.type === "Form" ? (p.formId as string) : fid;
      if (id === formId && p.name === name && ["TextInput", "TextArea", "Select", "Checkbox"].includes(n.type as string)) found = n;
      for (const c of (n.children ?? []) as Obj[]) walk(c, id);
    };
    for (const slot of Object.values(this.view.slots as Obj)) if (slot) walk(slot as Obj, null);
    return found;
  }
  setField(formId: string, name: string, value: unknown) {
    this.forms = { ...this.forms, [formId]: { ...(this.forms[formId] ?? {}), [name]: value } };
  }
  /** Typed text into a TextInput/TextArea, with the web renderer's integer-mode conversion. */
  typeText(formId: string, name: string, raw: string) {
    const n = this.inputNode(formId, name);
    if (!n) throw new Error(`no input ${formId}.${name}`);
    const p = (n.props ?? {}) as Obj;
    if (n.type === "TextInput" && p.mode === "integer") {
      if (raw.trim() === "") return this.setField(formId, name, undefined);
      const v = Number(raw);
      return this.setField(formId, name, Number.isSafeInteger(v) ? v : raw);
    }
    this.setField(formId, name, raw);
  }
  choose(formId: string, name: string, value: string) {
    this.setField(formId, name, value === "" ? undefined : value);
  }
  check(formId: string, name: string, on: boolean) {
    this.setField(formId, name, on);
  }
  toggle(sid: string, id: string, on: boolean) {
    const cur = new Set(this.selections[sid] ?? []);
    if (on) cur.add(id);
    else cur.delete(id);
    this.selections = { ...this.selections, [sid]: [...cur] };
  }
  setPage(path: string, page: number) {
    this.pages[path] = page;
  }
  setTab(path: string, i: number) {
    this.tabs[path] = i;
  }
  validateForm(formId: string, values: Record<string, unknown>): string | null {
    const walk = (n: Obj, inForm: boolean): string | null => {
      const p = (n.props ?? {}) as Obj;
      const here = n.type === "Form" ? p.formId === formId : inForm;
      if (here && (n.type === "TextInput" || n.type === "TextArea" || n.type === "Select")) {
        const v = values[p.name as string];
        const label = asText(p.label);
        if (p.required && (v === undefined || v === "")) return `${label}不能为空`;
        if (n.type === "TextInput" && p.mode === "integer" && v !== undefined && (typeof v !== "number" || !Number.isSafeInteger(v))) return `${label}必须是整数`;
        if (typeof v === "number" && typeof p.minimum === "number" && v < p.minimum) return `${label}不能小于 ${p.minimum}`;
        if (typeof v === "number" && typeof p.maximum === "number" && v > p.maximum) return `${label}不能大于 ${p.maximum}`;
        // Host rule: lengths are Unicode code points (the browser's maxLength counts UTF-16 units).
        if (typeof v === "string" && typeof p.maxLength === "number" && codePoints(v) > p.maxLength) return `${label}不能超过 ${p.maxLength} 个字符`;
      }
      for (const c of (n.children ?? []) as Obj[]) {
        const e = walk(c, here);
        if (e) return e;
      }
      return null;
    };
    for (const slot of Object.values(this.view.slots as Obj)) {
      const e = slot ? walk(slot as Obj, false) : null;
      if (e) return e;
    }
    return null;
  }
  private assemble(p: Obj, item: unknown, requireSelection: boolean): { input: Obj } | { error: string } {
    const spec = (p.input ?? {}) as { form?: string; selection?: { selectionId: string; as: string }; item?: { pointer: string; as: string }; constant?: Obj };
    const input: Obj = { ...(spec.constant ?? {}) };
    if (spec.item) {
      const v = readPointer(item, spec.item.pointer);
      if (v === undefined) return { error: "该项缺少所需字段" };
      input[spec.item.as] = v;
    }
    if (spec.form) {
      const err = this.validateForm(spec.form, this.forms[spec.form] ?? {});
      if (err) return { error: err };
      for (const [k, v] of Object.entries(this.forms[spec.form] ?? {})) if (v !== undefined && v !== "") input[k] = v;
    }
    if (spec.selection) {
      const ids = this.selections[spec.selection.selectionId] ?? [];
      if (requireSelection && ids.length === 0) return { error: "请先选择记录" };
      input[spec.selection.as] = ids;
    }
    return { input };
  }
  click(path: string): ClickResult {
    const f = this.findNode(path);
    if (!f) throw new Error(`no node at ${path}`);
    const p = (f.node.props ?? {}) as Obj;
    if (this.busy || this.disabled || this.staleInput) return { kind: "none" };
    if (f.node.type === "Button") {
      const a = this.assemble(p, f.item, true);
      if ("error" in a) {
        this.notice = { kind: "error", text: a.error };
        return { kind: "error", notice: this.notice };
      }
      if (typeof p.confirm === "string") {
        this.pendingConfirm = { p, item: f.item };
        return { kind: "confirm", confirmText: p.confirm };
      }
      return this.sendCommand(p, a.input);
    }
    if (f.node.type === "SystemActionButton") {
      const a = this.assemble(p, f.item, false);
      if ("error" in a) {
        this.notice = { kind: "error", text: a.error };
        return { kind: "error", notice: this.notice };
      }
      const action = p.action as string;
      const sig = JSON.stringify({ action, input: a.input, appEpoch: this.app.appEpoch });
      const key = this.pendingKey?.sig === sig ? this.pendingKey.key : this.newKey();
      this.pendingKey = { sig, key };
      this.busy = true;
      this.inflight = { kind: "system", p, spec: (p.input ?? {}) as Obj };
      this.notice = { kind: "info", text: `${asText(p.label)}：正在生成计划（尚未执行）…` };
      return { kind: "request", notice: this.notice, request: forward("apps.systemactions.post", { appId: this.app.appId, handlerId: action }, { expectedAppEpoch: this.app.appEpoch, input: a.input }, key) };
    }
    throw new Error(`${String(f.node.type)} is not clickable`);
  }
  /** The trusted confirmation for Button.confirm (the Shell's own dialog, not the app's). */
  confirm(accept: boolean): ClickResult {
    const c = this.pendingConfirm;
    this.pendingConfirm = null;
    if (!c || !accept) return { kind: "none" };
    const a = this.assemble(c.p, c.item, true);
    if ("error" in a) {
      this.notice = { kind: "error", text: a.error };
      return { kind: "error", notice: this.notice };
    }
    return this.sendCommand(c.p, a.input);
  }
  private sendCommand(p: Obj, input: Obj): ClickResult {
    const command = p.command as string;
    const sig = JSON.stringify({ command, input, appEpoch: this.app.appEpoch });
    const key = this.pendingKey?.sig === sig ? this.pendingKey.key : this.newKey();
    this.pendingKey = { sig, key };
    this.busy = true;
    this.inflight = { kind: "command", p, spec: (p.input ?? {}) as Obj };
    this.notice = { kind: "info", text: `${asText(p.label)}：已提交，执行中…` };
    return { kind: "request", notice: this.notice, request: forward("apps.commands.post", { appId: this.app.appId, commandId: command }, { expectedAppEpoch: this.app.appEpoch, input }, key) };
  }
  respond(o: Outcome): { notice: { kind: string; text: string } | null; reload: boolean; openPlan: string | null } {
    const f = this.inflight;
    if (!f) throw new Error("nothing in flight");
    this.inflight = null;
    this.busy = false;
    const label = asText(f.p.label);
    const spec = f.spec as { form?: string; selection?: { selectionId: string } };
    let reload = false;
    let openPlan: string | null = null;
    if ("network" in o) {
      this.notice = { kind: "error", text: NETWORK_ERROR_TEXT };
    } else if ("apiError" in o) {
      // A definite server answer needs a fresh key next time, except when the effect is unknown (never redo under a new id).
      if (!errorPolicy(o.apiError).keepKey) this.pendingKey = null;
      this.notice = { kind: "error", text: describeError(o.apiError, o.message ?? o.apiError) };
    } else if (f.kind === "system" && "plan" in o) {
      this.pendingKey = null;
      this.notice = { kind: "info", text: o.plan === "confirmationRequired" ? `${label}：计划已生成，等待你在 AgentOS 确认框中确认（尚未执行）` : `${label}：已按持续授权提交，执行结果见操作中心` };
      openPlan = o.actionId;
      this.openedPlans.push(o.actionId);
    } else if (f.kind === "command" && "invocation" in o) {
      this.pendingKey = null;
      if (o.invocation === "succeeded") {
        this.notice = { kind: "ok", text: `${label}：完成，${o.commitCount} 条记录已原子提交` };
        if (spec.form) this.forms = { ...this.forms, [spec.form]: {} };
        if (spec.selection) this.selections = { ...this.selections, [spec.selection.selectionId]: [] };
        reload = true;
      } else if (o.invocation === "failed") {
        this.notice = { kind: "error", text: `${INVOCATION_TEXT[o.code] ?? o.message ?? "命令失败"}（${o.code}）` };
        if (o.code === "APP_EPOCH_STALE" || o.code === "DATA_EPOCH_STALE") reload = true;
      } else {
        this.notice = { kind: "info", text: "命令仍在执行，稍后刷新查看结果" };
      }
    } else throw new Error("outcome does not match the request");
    if (reload) this.reloads++;
    return { notice: this.notice, reload, openPlan };
  }
  /** A new active revision: drop sources/selections/keys; dirty input stays but cannot be submitted until confirmed. */
  switchRevision(bundle: Obj, app: { appId: string; appEpoch: number; revisionId: string }) {
    if (app.revisionId === this.app.revisionId) return;
    this.bundle = bundle;
    this.view = bundle.view as Obj;
    this.app = app;
    this.pendingKey = null;
    this.sources = {};
    this.selections = {};
    this.pages = {};
    this.tabs = {};
    const dirty = Object.values(this.forms).some((f) => Object.values(f).some((v) => v !== undefined && v !== ""));
    if (dirty) this.staleInput = true;
  }
  /** "按新版本确认": keep only inputs the new version's forms still have. */
  confirmNewVersion() {
    const names = new Map<string, Set<string>>();
    const walk = (n: Obj, fid: string | null) => {
      const p = (n.props ?? {}) as Obj;
      const id = n.type === "Form" ? (p.formId as string) : fid;
      if (id && typeof p.name === "string") names.set(id, (names.get(id) ?? new Set()).add(p.name));
      for (const c of (n.children ?? []) as Obj[]) walk(c, id);
    };
    for (const slot of Object.values(this.view.slots as Obj)) if (slot) walk(slot as Obj, null);
    this.forms = Object.fromEntries(Object.entries(this.forms).filter(([id]) => names.has(id)).map(([id, vals]) => [id, Object.fromEntries(Object.entries(vals).filter(([k]) => names.get(id)!.has(k)))]));
    this.staleInput = false;
  }
  /** Workspace switch / lock / logout: every per-scope cache goes (spec §11, V1-D12). */
  clearScope() {
    this.sources = {};
    this.forms = {};
    this.selections = {};
    this.pages = {};
    this.tabs = {};
    this.pendingKey = null;
    this.notice = null;
    this.busy = false;
    this.inflight = null;
    this.pendingConfirm = null;
    this.staleInput = false;
  }
  formsSnapshot(): Record<string, Record<string, unknown>> {
    return Object.fromEntries(Object.entries(this.forms).map(([k, f]) => [k, Object.fromEntries(Object.entries(f).map(([n, v]) => [n, encodeValue(v)]))]));
  }
}

export function countNodes(nodes: Obj[]): number {
  let n = 0;
  const walk = (x: Obj) => {
    n++;
    for (const c of (x.children ?? []) as Obj[]) walk(c);
  };
  nodes.forEach(walk);
  return n;
}
