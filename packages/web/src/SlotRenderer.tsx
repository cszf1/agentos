import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppDetail, CodeBundle, SlotNode } from "@agentos/contracts";
import { ApiError, NetworkError, api, describeError, newKey } from "./api";

/**
 * Trusted Slot Tree renderer (spec §9). The tree is data: a fixed component set, bindings that read JSON Pointers
 * over own properties, no expressions, no HTML, no URLs. Everything shown is a text node.
 */
const RESERVED = new Set(["__proto__", "prototype", "constructor"]);
const POINTER = /^(\/[A-Za-z0-9_-]{1,64}){0,8}$/;
const KNOWN = new Set(["Stack", "Grid", "Tabs", "Text", "Alert", "Metric", "Table", "Kanban", "Form", "TextInput", "TextArea", "Select", "Checkbox", "Button", "BarChart", "LineChart", "SystemActionButton"]);
const MAX_NODES = 256;
const MAX_DEPTH = 12;

export function readPointer(root: unknown, ptr: string): unknown {
  if (!POINTER.test(ptr)) return undefined;
  if (ptr === "") return root;
  let cur: unknown = root;
  for (const seg of ptr.slice(1).split("/")) {
    if (RESERVED.has(seg)) return undefined;
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]{0,5})$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
    } else if (cur !== null && typeof cur === "object") {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    } else return undefined;
  }
  return cur;
}

type Bind = { $bind: { from: "query"; source: string; pointer: string } | { from: "form"; formId: string; pointer: string } | { from: "selection"; selectionId: string } | { from: "item"; pointer: string } };
const isBind = (v: unknown): v is Bind => v !== null && typeof v === "object" && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, "$bind");

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

interface SourceState {
  data: unknown;
  error: string | null;
  loading: boolean;
  dataEpoch: number | null;
}

type FormValues = Record<string, unknown>;

interface Ctx {
  /** v0.3: ask the Shell to plan a system action; the confirmation UI is the Shell's, never the app's. */
  runSystemAction: (p: Record<string, unknown>) => void;
  sources: Record<string, SourceState>;
  forms: Record<string, FormValues>;
  setField: (formId: string, name: string, value: unknown) => void;
  selections: Record<string, string[]>;
  toggle: (selectionId: string, id: string, on: boolean) => void;
  runCommand: (btn: Record<string, unknown>) => void;
  busy: boolean;
  disabled: boolean;
}

function resolve(ctx: Ctx, v: unknown): unknown {
  if (!isBind(v)) return v;
  const b = v.$bind;
  switch (b.from) {
    case "query":
      return readPointer(ctx.sources[b.source]?.data, b.pointer);
    case "form":
      return readPointer(ctx.forms[b.formId] ?? {}, b.pointer);
    case "selection":
      return ctx.selections[b.selectionId] ?? [];
    default:
      return undefined;
  }
}

function visible(ctx: Ctx, node: SlotNode): boolean {
  const w = node.visibleWhen as { value: unknown; op: "exists" | "eq"; equals?: unknown } | undefined;
  if (!w) return true;
  const v = resolve(ctx, w.value);
  if (w.op === "exists") return v !== undefined && v !== null;
  return v === w.equals;
}

function Chart(props: { kind: "BarChart" | "LineChart"; p: Record<string, unknown>; ctx: Ctx }) {
  const data = resolve(props.ctx, props.p.data);
  const rows = Array.isArray(data) ? data.slice(0, 500) : [];
  const series = ((props.p.series as { pointer: string; label: string }[]) ?? []).slice(0, 8);
  const xs = rows.map((r) => asText(readPointer(r, props.p.xPointer as string)));
  const values = series.map((s) => rows.map((r) => {
    const n = readPointer(r, s.pointer);
    return typeof n === "number" && Number.isFinite(n) ? n : 0;
  }));
  const max = Math.max(1, ...values.flat());
  const W = 520;
  const H = 180;
  const pad = 28;
  const colors = ["#3b6fd8", "#d8833b", "#3ba86b", "#a83b8f", "#8f8f3b", "#3b9fa8", "#a83b3b", "#6b6b6b"];
  const bw = rows.length > 0 ? (W - pad * 2) / rows.length : 0;
  return (
    <figure className="chart">
      {typeof props.p.title === "string" && <figcaption>{props.p.title}</figcaption>}
      <svg viewBox={`0 0 ${W} ${H + 24}`} role="img" aria-label={asText(props.p.title) || props.kind}>
        <line x1={pad} y1={H} x2={W - pad} y2={H} stroke="#999" />
        {props.kind === "BarChart"
          ? values.map((vals, si) =>
              vals.map((v, i) => {
                const h = (v / max) * (H - 10);
                const w = bw / Math.max(1, series.length) - 4;
                return <rect key={`${si}-${i}`} x={pad + i * bw + si * (w + 4) + 2} y={H - h} width={Math.max(1, w)} height={h} fill={colors[si]}><title>{`${series[si]!.label} ${xs[i]}: ${v}`}</title></rect>;
              }),
            )
          : values.map((vals, si) => (
              <polyline key={si} fill="none" stroke={colors[si]} strokeWidth={2} points={vals.map((v, i) => `${pad + i * bw + bw / 2},${H - (v / max) * (H - 10)}`).join(" ")} />
            ))}
        {xs.map((x, i) => (rows.length <= 24 ? <text key={i} x={pad + i * bw + bw / 2} y={H + 16} fontSize="11" textAnchor="middle">{x}</text> : null))}
        <text x={2} y={12} fontSize="10">{String(max)}</text>
      </svg>
      <div className="legend">
        {series.map((s, i) => (
          <span key={i}><i style={{ background: colors[i] }} /> {s.label}</span>
        ))}
      </div>
    </figure>
  );
}

function rowId(item: unknown, p: Record<string, unknown>, i: number): string {
  const v = readPointer(item, (p.rowId as string) ?? "/id");
  return typeof v === "string" ? v : String(i);
}

function TableView(props: { p: Record<string, unknown>; ctx: Ctx }) {
  const { p, ctx } = props;
  const items = resolve(ctx, p.items);
  const list = Array.isArray(items) ? items : [];
  const size = (p.pageSize as number) ?? 20;
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(list.length / size));
  const shown = list.slice(page * size, page * size + size);
  const cols = (p.columns as { pointer: string; label: string }[]) ?? [];
  const sel = p.selectionId as string | undefined;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {sel && <th />}
            {cols.map((c, i) => (
              <th key={i}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 && (
            <tr>
              <td colSpan={cols.length + (sel ? 1 : 0)} className="muted">{asText(p.emptyText) || "没有数据"}</td>
            </tr>
          )}
          {shown.map((it, i) => {
            const id = rowId(it, p, page * size + i);
            return (
              <tr key={id}>
                {sel && (
                  <td>
                    <input type="checkbox" aria-label="选择" checked={(ctx.selections[sel] ?? []).includes(id)} onChange={(e) => ctx.toggle(sel, id, e.target.checked)} />
                  </td>
                )}
                {cols.map((c, j) => (
                  <td key={j}>{asText(readPointer(it, c.pointer))}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {pages > 1 && (
        <div className="pager">
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
          <span className="muted small">{page + 1}/{pages}</span>
          <button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>下一页</button>
        </div>
      )}
    </div>
  );
}

function KanbanView(props: { p: Record<string, unknown>; ctx: Ctx }) {
  const { p, ctx } = props;
  const items = resolve(ctx, p.items);
  const list = Array.isArray(items) ? items.slice(0, 1000) : [];
  const groups = (p.groups as { value: unknown; label: string }[]) ?? [];
  const fields = (p.cardFields as { pointer: string; label: string }[]) ?? [];
  const sel = p.selectionId as string | undefined;
  return (
    <div className="kanban" role="list">
      {groups.map((g, gi) => {
        const col = list.map((it, i) => ({ it, i })).filter(({ it }) => readPointer(it, p.groupPointer as string) === g.value);
        return (
          <section key={gi} className="kanban-col" aria-label={g.label} role="listitem">
            <h4>
              {g.label} <span className="muted small">{col.length}</span>
            </h4>
            {col.map(({ it, i }) => {
              const id = rowId(it, p, i);
              const checked = sel ? (ctx.selections[sel] ?? []).includes(id) : false;
              return (
                <label key={id} className={`card ${checked ? "picked" : ""}`}>
                  {sel && <input type="checkbox" checked={checked} onChange={(e) => ctx.toggle(sel, id, e.target.checked)} aria-label="选择" />}
                  <span className="card-title">{asText(readPointer(it, p.cardTitlePointer as string))}</span>
                  {fields.map((f, k) => (
                    <span key={k} className="muted small card-field">
                      {f.label}：{asText(readPointer(it, f.pointer))}
                    </span>
                  ))}
                </label>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

function Node(props: { node: SlotNode; ctx: Ctx; formId: string | null; depth: number; counter: { n: number } }): ReactNode {
  const { node, ctx, depth, counter } = props;
  counter.n++;
  if (counter.n > MAX_NODES || depth > MAX_DEPTH) return <div className="banner error">界面超过节点或层级上限</div>;
  if (!KNOWN.has(node.type)) return <div className="banner error">未知组件 {asText(node.type)}</div>;
  if (!visible(ctx, node)) return null;
  const p = (node.props ?? {}) as Record<string, unknown>;
  const kids = (formId: string | null = props.formId) => (node.children ?? []).map((c, i) => <Node key={i} node={c} ctx={ctx} formId={formId} depth={depth + 1} counter={counter} />);
  const gap = { sm: "6px", md: "12px", lg: "20px" }[(p.gap as string) ?? "md"] ?? "12px";
  switch (node.type) {
    case "Stack":
      return <div style={{ display: "flex", flexDirection: p.direction === "horizontal" ? "row" : "column", gap, flexWrap: "wrap" }}>{kids()}</div>;
    case "Grid":
      return <div style={{ display: "grid", gridTemplateColumns: `repeat(${Number(p.columns) || 1}, minmax(0, 1fr))`, gap }}>{kids()}</div>;
    case "Tabs":
      return <TabsView labels={(p.labels as string[]) ?? []}>{kids()}</TabsView>;
    case "Text": {
      const t = asText(resolve(ctx, p.text));
      if (p.variant === "title") return <h3>{t}</h3>;
      return <p className={p.variant === "muted" ? "muted" : ""}>{t}</p>;
    }
    case "Alert":
      return <div className={`banner ${p.status === "error" ? "error" : p.status === "warning" ? "warn" : p.status === "success" ? "ok" : "info"}`}>{asText(resolve(ctx, p.text))}</div>;
    case "Metric":
      return (
        <div className="metric">
          <div className="muted small">{asText(p.label)}</div>
          <div className="metric-value">
            {asText(resolve(ctx, p.value))}
            {typeof p.unit === "string" && <span className="muted small"> {p.unit}</span>}
          </div>
        </div>
      );
    case "Table":
      return <TableView p={p} ctx={ctx} />;
    case "Kanban":
      return <KanbanView p={p} ctx={ctx} />;
    case "Form":
      return (
        <form className="slot-form" onSubmit={(e) => e.preventDefault()} aria-label={asText(p.title) || asText(p.formId)}>
          {typeof p.title === "string" && <h4>{p.title}</h4>}
          {kids(p.formId as string)}
        </form>
      );
    case "TextInput":
    case "TextArea":
    case "Select":
    case "Checkbox": {
      const fid = props.formId;
      if (!fid) return null;
      const name = p.name as string;
      const v = ctx.forms[fid]?.[name];
      const label = asText(p.label);
      if (node.type === "Checkbox") {
        return (
          <label className="check">
            <input type="checkbox" checked={v === true} onChange={(e) => ctx.setField(fid, name, e.target.checked)} /> {label}
          </label>
        );
      }
      if (node.type === "Select") {
        const opts = (p.options as { value: string; label: string }[]) ?? [];
        return (
          <label className="field">
            <span>{label}</span>
            <select value={typeof v === "string" ? v : ""} onChange={(e) => ctx.setField(fid, name, e.target.value === "" ? undefined : e.target.value)} aria-label={label}>
              {!p.required && <option value="">（默认）</option>}
              {opts.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        );
      }
      if (node.type === "TextArea") {
        return (
          <label className="field">
            <span>{label}</span>
            <textarea rows={4} maxLength={(p.maxLength as number) ?? 4096} value={typeof v === "string" ? v : ""} onChange={(e) => ctx.setField(fid, name, e.target.value)} aria-label={label} />
          </label>
        );
      }
      const integer = p.mode === "integer";
      return (
        <label className="field">
          <span>{label}</span>
          <input
            inputMode={integer ? "numeric" : "text"}
            maxLength={integer ? 16 : ((p.maxLength as number) ?? 4096)}
            placeholder={asText(p.placeholder)}
            value={v === undefined || v === null ? "" : String(v)}
            onChange={(e) => {
              const raw = e.target.value;
              if (!integer) return ctx.setField(fid, name, raw);
              if (raw.trim() === "") return ctx.setField(fid, name, undefined);
              const n = Number(raw);
              ctx.setField(fid, name, Number.isSafeInteger(n) ? n : raw);
            }}
            aria-label={label}
          />
        </label>
      );
    }
    case "Button":
      return (
        <button type="button" className={p.variant === "primary" ? "primary" : p.variant === "danger" ? "danger" : ""} disabled={ctx.busy || ctx.disabled} onClick={() => ctx.runCommand(p)}>
          {asText(p.label)}
        </button>
      );
    case "SystemActionButton":
      return (
        <button type="button" className={`system-action ${p.variant === "danger" ? "danger" : p.variant === "primary" ? "primary" : ""}`} disabled={ctx.busy || ctx.disabled} onClick={() => ctx.runSystemAction(p)} title="系统动作：先生成计划，由 AgentOS 确认后才执行">
          ⚙ {asText(p.label)}
        </button>
      );
    case "BarChart":
    case "LineChart":
      return <Chart kind={node.type} p={p} ctx={ctx} />;
    default:
      return null;
  }
}

function TabsView(props: { labels: string[]; children: ReactNode[] }) {
  const [i, setI] = useState(0);
  return (
    <div className="tabs">
      <div role="tablist">
        {props.labels.map((l, k) => (
          <button key={k} role="tab" aria-selected={k === i} className={k === i ? "active" : ""} onClick={() => setI(k)}>{l}</button>
        ))}
      </div>
      <div role="tabpanel">{props.children[i] ?? null}</div>
    </div>
  );
}

function validateForm(bundle: CodeBundle, formId: string, values: FormValues): string | null {
  const walk = (n: SlotNode, inForm: boolean): string | null => {
    const p = (n.props ?? {}) as Record<string, unknown>;
    const here = n.type === "Form" ? p.formId === formId : inForm;
    if (here && (n.type === "TextInput" || n.type === "TextArea" || n.type === "Select")) {
      const v = values[p.name as string];
      const label = asText(p.label);
      if (p.required && (v === undefined || v === "")) return `${label}不能为空`;
      if (n.type === "TextInput" && p.mode === "integer" && v !== undefined && (typeof v !== "number" || !Number.isSafeInteger(v))) return `${label}必须是整数`;
      if (typeof v === "number" && typeof p.minimum === "number" && v < p.minimum) return `${label}不能小于 ${p.minimum}`;
      if (typeof v === "number" && typeof p.maximum === "number" && v > p.maximum) return `${label}不能大于 ${p.maximum}`;
    }
    for (const c of n.children ?? []) {
      const e = walk(c, here);
      if (e) return e;
    }
    return null;
  };
  for (const slot of Object.values(bundle.view.slots)) {
    const e = slot ? walk(slot as SlotNode, false) : null;
    if (e) return e;
  }
  return null;
}

const INVOCATION_TEXT: Record<string, string> = {
  DATA_EPOCH_STALE: "数据在命令执行期间被修改，没有写入任何内容；请刷新后重试（输入已保留）",
  APP_EPOCH_STALE: "应用版本已切换，命令没有执行（输入已保留）",
  INSTANCE_STALE: "应用实例在执行中切换，没有写入任何内容",
  INVALID_MUTATION: "应用返回了不允许的修改，已整体拒绝",
  APP_TIMEOUT: "应用执行超时，已被停止，没有写入任何内容",
  INVOCATION_EXPIRED: "命令超过了最长期限，没有写入任何内容",
  RUNTIME_STOPPED: "应用已停止，请先启动",
  INSTANCE_NOT_READY: "应用正在恢复，请稍后再试",
};

/** A code app's page: data sources, forms, selections, commands with progress and conflict handling. */
export function CodeAppView(props: { detail: AppDetail; dataEpoch: number | null; refreshToken: number; disabled: boolean; onChanged: () => void; onSystemPlan?: (actionId: string) => void }) {
  const { detail } = props;
  const bundle = detail.bundle as CodeBundle;
  const [sources, setSources] = useState<Record<string, SourceState>>({});
  const [forms, setForms] = useState<Record<string, FormValues>>({});
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);
  const seq = useRef<Record<string, number>>({});
  const inflight = useRef<Record<string, boolean>>({});
  const pendingKey = useRef<{ sig: string; key: string } | null>(null);
  const revision = detail.activeRevisionId;
  const appEpoch = detail.appEpoch;
  // Spec §9.2: a version change keeps unsent input as a local copy and disables the old submission until confirmed.
  const [staleInput, setStaleInput] = useState(false);
  const lastRevision = useRef(revision);
  useEffect(() => {
    if (lastRevision.current === revision) return;
    lastRevision.current = revision;
    pendingKey.current = null;
    seq.current = {};
    setSources({});
    setSelections({});
    const dirty = Object.values(forms).some((f) => Object.values(f).some((v) => v !== undefined && v !== ""));
    if (dirty) setStaleInput(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  const load = useCallback(async () => {
    for (const [name, ds] of Object.entries(bundle.view.dataSources)) {
      if (inflight.current[name]) continue; // at most one outstanding refresh per data source
      inflight.current[name] = true;
      const my = (seq.current[name] = (seq.current[name] ?? 0) + 1);
      setSources((s) => ({ ...s, [name]: { ...(s[name] ?? { data: null, error: null, dataEpoch: null }), loading: true } }));
      try {
        const r = await api.query(detail.appId, ds.queryId, { expectedAppEpoch: appEpoch, input: ds.input ?? {} });
        // Late answers from another revision/epoch or an older request never overwrite the current view.
        if (my !== seq.current[name] || r.revisionId !== revision || r.appEpoch !== appEpoch) continue;
        setSources((s) => ({ ...s, [name]: { data: r.output, error: null, loading: false, dataEpoch: r.dataEpoch } }));
      } catch (e) {
        if (my !== seq.current[name]) continue;
        const code = e instanceof ApiError ? e.code : "";
        const text = INVOCATION_TEXT[code] ?? describeError(e);
        setSources((s) => ({ ...s, [name]: { ...(s[name] ?? { data: null, dataEpoch: null }), loading: false, error: text } }));
        if (code === "APP_EPOCH_STALE") props.onChanged();
      } finally {
        inflight.current[name] = false;
      }
    }
  }, [bundle, detail.appId, appEpoch, revision, props]);

  // Refresh on open, after commands, on a newer data/app epoch, on focus; optional declared interval (≥5 s, paused when hidden).
  useEffect(() => {
    void load();
  }, [load, props.refreshToken, props.dataEpoch]);
  useEffect(() => {
    const sec = bundle.view.refresh?.intervalSeconds;
    if (!sec || sec < 5) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, sec * 1000);
    return () => clearInterval(t);
  }, [bundle, load]);

  const ctx: Ctx = useMemo(
    () => ({
      sources,
      forms,
      selections,
      busy,
      disabled: props.disabled || staleInput,
      setField: (formId, name, value) => setForms((f) => ({ ...f, [formId]: { ...(f[formId] ?? {}), [name]: value } })),
      toggle: (sid, id, on) => setSelections((s) => {
        const cur = new Set(s[sid] ?? []);
        if (on) cur.add(id);
        else cur.delete(id);
        return { ...s, [sid]: [...cur] };
      }),
      runCommand: (p) => void runCommand(p),
      runSystemAction: (p) => void runSystemAction(p),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sources, forms, selections, busy, props.disabled, staleInput],
  );

  /** SystemActionButton: the app's handler only produces a plan; the Shell shows the trusted preview and confirms. */
  async function runSystemAction(p: Record<string, unknown>) {
    const action = p.action as string;
    const spec = (p.input ?? {}) as { form?: string; selection?: { selectionId: string; as: string }; constant?: Record<string, unknown> };
    const input: Record<string, unknown> = { ...(spec.constant ?? {}) };
    if (spec.form) {
      const err = validateForm(bundle, spec.form, forms[spec.form] ?? {});
      if (err) return setNotice({ kind: "error", text: err });
      for (const [k, v] of Object.entries(forms[spec.form] ?? {})) if (v !== undefined && v !== "") input[k] = v;
    }
    if (spec.selection) input[spec.selection.as] = selections[spec.selection.selectionId] ?? [];
    const sig = JSON.stringify({ action, input, appEpoch });
    const key = pendingKey.current?.sig === sig ? pendingKey.current.key : newKey();
    pendingKey.current = { sig, key };
    setBusy(true);
    setNotice({ kind: "info", text: `${asText(p.label)}：正在生成计划（尚未执行）…` });
    try {
      const v = await api.planSystemAction(detail.appId, action, { expectedAppEpoch: appEpoch, input }, key);
      pendingKey.current = null;
      setNotice({ kind: "info", text: v.confirmationRequired ? `${asText(p.label)}：计划已生成，等待你在 AgentOS 确认框中确认（尚未执行）` : `${asText(p.label)}：已按持续授权提交，执行结果见操作中心` });
      props.onSystemPlan?.(v.actionId);
    } catch (e) {
      if (!(e instanceof NetworkError)) pendingKey.current = null;
      setNotice({ kind: "error", text: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function runCommand(p: Record<string, unknown>) {
    const command = p.command as string;
    const spec = (p.input ?? {}) as { form?: string; selection?: { selectionId: string; as: string }; constant?: Record<string, unknown> };
    const input: Record<string, unknown> = { ...(spec.constant ?? {}) };
    if (spec.form) {
      const err = validateForm(bundle, spec.form, forms[spec.form] ?? {});
      if (err) return setNotice({ kind: "error", text: err });
      for (const [k, v] of Object.entries(forms[spec.form] ?? {})) if (v !== undefined && v !== "") input[k] = v;
    }
    if (spec.selection) {
      const ids = selections[spec.selection.selectionId] ?? [];
      if (ids.length === 0) return setNotice({ kind: "error", text: "请先选择记录" });
      input[spec.selection.as] = ids;
    }
    if (typeof p.confirm === "string" && !window.confirm(p.confirm)) return;
    // The same logical command reuses its key after a network failure (no duplicate execution).
    const sig = JSON.stringify({ command, input, appEpoch });
    const key = pendingKey.current?.sig === sig ? pendingKey.current.key : newKey();
    pendingKey.current = { sig, key };
    setBusy(true);
    setNotice({ kind: "info", text: `${asText(p.label)}：已提交，执行中…` });
    try {
      const acc = await api.command(detail.appId, command, { expectedAppEpoch: appEpoch, input }, key);
      let inv = await api.invocation(acc.invocationId);
      const until = Date.now() + 30_000;
      while ((inv.status === "accepted" || inv.status === "executing") && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 300));
        inv = await api.invocation(acc.invocationId);
      }
      pendingKey.current = null;
      if (inv.status === "succeeded") {
        const c = inv.commit;
        const n = c ? Object.keys(c.created).length + c.updated.length + c.deleted.length : 0;
        setNotice({ kind: "ok", text: `${asText(p.label)}：完成，${n} 条记录已原子提交` });
        if (spec.form) setForms((f) => ({ ...f, [spec.form!]: {} }));
        if (spec.selection) setSelections((s) => ({ ...s, [spec.selection!.selectionId]: [] }));
        props.onChanged();
        void load();
      } else if (inv.status === "failed") {
        const code = inv.error?.code ?? "";
        setNotice({ kind: "error", text: `${INVOCATION_TEXT[code] ?? inv.error?.message ?? "命令失败"}（${code}）` });
        if (code === "APP_EPOCH_STALE" || code === "DATA_EPOCH_STALE") void load();
      } else {
        setNotice({ kind: "info", text: "命令仍在执行，稍后刷新查看结果" });
      }
    } catch (e) {
      if (!(e instanceof NetworkError)) pendingKey.current = null;
      setNotice({ kind: "error", text: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  const errors = Object.entries(sources).filter(([, s]) => s.error);
  const counter = { n: 0 };
  return (
    <section className="app-view code-app" aria-label={bundle.manifest.title}>
      <div className="app-head">
        <div>
          <h2>{bundle.manifest.title}</h2>
          {bundle.manifest.description && <p className="muted">{bundle.manifest.description}</p>}
        </div>
        {bundle.view.slots.toolbar && <div className="toolbar"><Node node={bundle.view.slots.toolbar as SlotNode} ctx={ctx} formId={null} depth={1} counter={counter} /></div>}
      </div>
      {staleInput && (
        <div className="banner warn" role="alert">
          应用已切换到新版本，你未提交的输入已保留但暂停提交。请按新表单核对后确认。
          <button onClick={() => {
            // Keep only inputs the new version's forms still have.
            const names = new Map<string, Set<string>>();
            const walk = (n: SlotNode, fid: string | null) => {
              const p = (n.props ?? {}) as Record<string, unknown>;
              const id = n.type === "Form" ? (p.formId as string) : fid;
              if (id && typeof p.name === "string") names.set(id, (names.get(id) ?? new Set()).add(p.name));
              for (const c of n.children ?? []) walk(c, id);
            };
            for (const slot of Object.values(bundle.view.slots)) if (slot) walk(slot as SlotNode, null);
            setForms((f) => Object.fromEntries(Object.entries(f).filter(([id]) => names.has(id)).map(([id, vals]) => [id, Object.fromEntries(Object.entries(vals).filter(([k]) => names.get(id)!.has(k)))])));
            setStaleInput(false);
          }}>按新版本确认</button>
        </div>
      )}
      {notice && <div className={`banner ${notice.kind === "ok" ? "ok" : notice.kind === "error" ? "error" : "info"}`} role="status">{notice.text}</div>}
      {errors.map(([n, s]) => (
        <div key={n} className="banner error" role="alert">数据加载失败：{s.error}</div>
      ))}
      <div className="slot-body">
        <div className="slot-main"><Node node={bundle.view.slots.main as SlotNode} ctx={ctx} formId={null} depth={1} counter={counter} /></div>
        {bundle.view.slots.aside && <div className="slot-aside"><Node node={bundle.view.slots.aside as SlotNode} ctx={ctx} formId={null} depth={1} counter={counter} /></div>}
      </div>
    </section>
  );
}
