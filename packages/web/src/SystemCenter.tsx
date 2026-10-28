import { useCallback, useEffect, useState } from "react";
import { ApiError, api, describeError, newKey, type SysAction, type SysBindings, type SysResource } from "./api";

/**
 * v0.3 Shell UI (spec §21.2): resource connections, the trusted confirmation dialog, the global operation center and
 * the system_plan request form. Apps cannot draw any of this: confirmation always comes from the Shell.
 */

const KIND_TEXT: Record<string, string> = {
  "import-root": "只读目录",
  "managed-root": "受管目录",
  service: "服务",
  "lab-network": "测试网络",
  "host-network": "本机网络",
  serial: "串口设备",
  telemetry: "遥测",
};
const PHASE_TEXT: Record<string, string> = {
  awaiting_confirmation: "计划已生成，等待确认（尚未执行）",
  granting: "已确认，授权同步中（尚未执行）",
  executing: "执行中",
  done: "已核实完成",
  no_effect: "确定未执行",
  unknown: "结果待确认",
  rejected: "已拒绝/已作废",
};
const QUALITY_TEXT: Record<string, string> = { fresh: "最新", stale: "已过时", gap: "有缺口，需重读", unavailable: "不可用" };

export function phaseClass(p: string): string {
  return p === "done" ? "ok" : p === "unknown" ? "warn" : p === "executing" || p === "granting" ? "info" : p === "no_effect" || p === "rejected" ? "muted" : "info";
}

function ago(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} 秒前` : s < 3600 ? `${Math.round(s / 60)} 分钟前` : new Date(iso).toLocaleString();
}

/** Shell-owned confirmation of one immutable plan: normalized target, change, preconditions, reversibility, expiry. */
export function ConfirmDialog(props: { actionId: string; onClose: () => void }) {
  const [a, setA] = useState<SysAction | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(newKey());
  const load = useCallback(async () => {
    try {
      setA(await api.systemAction(props.actionId));
    } catch (e) {
      setErr(describeError(e));
    }
  }, [props.actionId]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 1000);
    return () => clearInterval(t);
  }, [load]);
  if (!a) return <div className="modal-backdrop"><div className="modal" role="dialog">{err ?? "加载计划…"}</div></div>;
  const left = Math.max(0, Math.round((Date.parse(a.expiresAt) - Date.now()) / 1000));
  const confirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      setA(await api.confirmSystemAction(a.actionId, a.planHash, key));
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const reject = async () => {
    setBusy(true);
    try {
      setA(await api.cancelSystemAction(a.actionId, newKey()));
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <div className="modal system-confirm" role="dialog" aria-label="AgentOS 系统动作确认">
        <div className="shell-mark">AgentOS 系统确认 · 不是应用界面</div>
        <h3>{a.preview.title}</h3>
        <dl className="preview">
          <dt>目标</dt>
          <dd>{a.preview.target}（{KIND_TEXT[a.preview.resourceKind] ?? a.preview.resourceKind}）</dd>
          {a.preview.change.map((c, i) => (
            <div key={i} className="row">
              <dt>{c.label}</dt>
              <dd>{c.from === null ? "当前值未知" : c.from} → <strong>{c.to}</strong></dd>
            </div>
          ))}
          <dt>前提条件</dt>
          <dd><ul>{a.preview.preconditions.map((p, i) => <li key={i}>{p}</li>)}</ul></dd>
          <dt>能否撤回</dt>
          <dd>{a.preview.irreversible ? <strong className="bad">不可撤回：</strong> : null}{a.preview.reversible}</dd>
          <dt>自动重试</dt>
          <dd>{a.preview.autoRetry}</dd>
          {a.preview.risks.length > 0 && (
            <>
              <dt>注意</dt>
              <dd><ul>{a.preview.risks.map((r, i) => <li key={i}>{r}</li>)}</ul></dd>
            </>
          )}
          <dt>来源</dt>
          <dd>{a.origin === "agent" ? "Pi 系统计划" : a.origin === "compensation" ? "补偿计划" : `应用动作 ${a.handlerId ?? ""}`} · 计划 {a.planHash.slice(7, 19)}</dd>
        </dl>
        <div className={`banner ${phaseClass(a.phase)}`} role="status">
          状态：{PHASE_TEXT[a.phase] ?? a.state}
          {a.phase === "done" && a.completionKind === "already_satisfied" && "（目标状态已满足，未做改动）"}
          {a.error && a.phase !== "done" && ` · ${a.error.code}：${a.error.message}`}
        </div>
        {a.phase === "unknown" && <div className="banner warn">{a.retryAdvice}</div>}
        {err && <div className="banner error">{err}</div>}
        <div className="actions">
          {a.confirmationRequired ? (
            <>
              <button className="primary" disabled={busy || left === 0} onClick={() => void confirm()}>确认执行这一计划</button>
              <button disabled={busy} onClick={() => void reject()}>拒绝</button>
              <span className="muted small">{left > 0 ? `确认期限还剩 ${left} 秒` : "已过期，需要重新生成"}</span>
            </>
          ) : null}
          <button onClick={props.onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

/** One line of the operation center. */
function ActionRow(props: { a: SysAction; onOpen: (id: string) => void; onChanged: () => void }) {
  const { a } = props;
  const [err, setErr] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState("");
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      props.onChanged();
    } catch (e) {
      setErr(describeError(e));
    }
  };
  return (
    <li className="op-row">
      <div>
        <span className={`dot ${a.phase === "done" ? "ok" : a.phase === "unknown" ? "warn" : a.phase === "executing" ? "warn" : "bad"}`} />
        <strong>{a.preview.title}</strong>
      </div>
      <div className="muted small">
        {PHASE_TEXT[a.phase] ?? a.state} · {a.capabilityId} · {ago(a.updatedAt)}
        {a.effectCertainty && ` · 效果：${a.effectCertainty === "verified" ? "已核实" : a.effectCertainty === "none" ? "无" : "未知"}`}
        {a.evidenceKind && ` · 证据：${a.evidenceKind}`}
      </div>
      {a.error && <div className="small bad">{a.error.code}：{a.error.message}</div>}
      {a.resolution != null && <div className="small">处置：{JSON.stringify(a.resolution).slice(0, 160)}</div>}
      <div className="actions">
        <button onClick={() => props.onOpen(a.actionId)}>详情</button>
        {(a.phase === "awaiting_confirmation" || a.phase === "granting" || a.state === "ready") && <button onClick={() => void act(() => api.cancelSystemAction(a.actionId, newKey()))}>取消</button>}
        {a.compensationAvailable && <button onClick={() => void act(async () => props.onOpen((await api.compensateSystemAction(a.actionId, newKey())).actionId))}>生成补偿计划</button>}
        {a.phase === "unknown" && a.resolution == null && <button onClick={() => setResolving(true)}>核对并处置</button>}
      </div>
      {resolving && (
        <div className="resolve">
          <p className="small">请先查看资源当前状态。处置会附带一次新的观察，不会改写原始结果。</p>
          <input placeholder="说明你看到的现状" value={note} onChange={(e) => setNote(e.target.value)} aria-label="处置说明" />
          <button disabled={!note} onClick={() => void act(() => api.resolveSystemAction(a.actionId, { decision: "confirmed_applied", note, releaseQuarantine: true }, newKey()))}>确认已生效</button>
          <button disabled={!note} onClick={() => void act(() => api.resolveSystemAction(a.actionId, { decision: "confirmed_not_applied", note, releaseQuarantine: true }, newKey()))}>确认未生效</button>
          <button disabled={!note} onClick={() => void act(() => api.resolveSystemAction(a.actionId, { decision: "accept_unknown", note, releaseQuarantine: false }, newKey()))}>接受未知</button>
        </div>
      )}
      {err && <div className="banner error">{err}</div>}
    </li>
  );
}

export function SystemCenter(props: { tick: number; brokerReady: boolean; models: boolean; runActive: boolean; onRunStarted: () => void; onOpenAction: (id: string) => void }) {
  const [tab, setTab] = useState<"resources" | "operations" | "plan">("operations");
  const [resources, setResources] = useState<SysResource[]>([]);
  const [ops, setOps] = useState<SysAction[]>([]);
  const [brokerOnly, setBrokerOnly] = useState<{ operationId: string; state: string; capabilityId: string; effectCertainty: string | null }[]>([]);
  const [obs, setObs] = useState<{ cursors: { source: string; quality: string; drop_count: number; last_refresh_at: string | null }[]; telemetry: Record<string, unknown> } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [snap, setSnap] = useState<Record<string, { at: string; quality: string; text: string }>>({});
  const [intent, setIntent] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [planKey, setPlanKey] = useState(newKey());

  const load = useCallback(async () => {
    try {
      const [r, o, ob] = await Promise.all([api.sysResources(), api.systemOperations(), api.observations(0)]);
      setResources(r.items);
      setOps(o.items);
      setBrokerOnly(o.brokerOnly);
      setObs({ cursors: ob.cursors, telemetry: ob.telemetry });
      setErr(null);
    } catch (e) {
      setErr(describeError(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, props.tick]);
  useEffect(() => {
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [load]);

  const read = async (r: SysResource) => {
    const cap = r.kind === "service" ? "service.describe" : r.kind === "import-root" || r.kind === "managed-root" ? "file.list" : r.kind === "lab-network" ? "network.policy_status" : r.kind === "serial" ? "serial.status" : r.kind === "telemetry" ? "telemetry.summary" : "network.snapshot";
    try {
      const v = await api.readResource(r.resourceId, cap);
      setSnap((s) => ({ ...s, [r.resourceId]: { at: v.observedAt, quality: v.quality, text: JSON.stringify(v.data).slice(0, 600) } }));
    } catch (e) {
      setSnap((s) => ({ ...s, [r.resourceId]: { at: new Date().toISOString(), quality: "unavailable", text: describeError(e) } }));
    }
  };

  const WRITE_CAPS: Record<string, string[]> = {
    "managed-root": ["file.write_text_atomic"],
    service: ["service.ensure_state", "service.set_limit"],
    "lab-network": ["network.apply_profile"],
    serial: ["serial.exchange"],
  };
  const capChoices = [...new Set(chosen.flatMap((id) => WRITE_CAPS[resources.find((r) => r.resourceId === id)?.kind ?? ""] ?? []))];

  const startPlan = async () => {
    try {
      await api.submitSystemPlan({ intent, targetAppId: null, mode: "system_plan", resourceIds: chosen, capabilityScopes: scopes.filter((s) => capChoices.includes(s)) }, planKey);
      setIntent("");
      setPlanKey(newKey());
      props.onRunStarted();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "INVALID_REQUEST")) setPlanKey(newKey());
      setErr(describeError(e));
    }
  };

  const open = ops.filter((a) => !["done", "no_effect", "rejected"].includes(a.phase));
  return (
    <section className="system-center" aria-label="系统">
      <div className="tabs">
        <div role="tablist">
          <button role="tab" className={tab === "operations" ? "active" : ""} onClick={() => setTab("operations")}>操作中心{open.length > 0 ? `（${open.length}）` : ""}</button>
          <button role="tab" className={tab === "resources" ? "active" : ""} onClick={() => setTab("resources")}>资源</button>
          <button role="tab" className={tab === "plan" ? "active" : ""} onClick={() => setTab("plan")}>系统计划</button>
        </div>
      </div>
      {!props.brokerReady && <div className="banner warn">系统执行服务不可用：可以查看状态和历史，系统写入已暂停。</div>}
      {err && <div className="banner error">{err}</div>}
      {tab === "operations" && (
        <div>
          <ul className="ops">{ops.map((a) => <ActionRow key={a.actionId} a={a} onOpen={props.onOpenAction} onChanged={() => void load()} />)}</ul>
          {ops.length === 0 && <p className="muted small">还没有系统操作。</p>}
          {brokerOnly.length > 0 && (
            <>
              <h4>仅存在于执行日志中的操作</h4>
              <p className="muted small">工作区恢复后本地没有这些记录，执行服务仍保留其事实，不会重放。</p>
              <ul className="ops">{brokerOnly.map((o) => <li key={o.operationId} className="op-row small">{o.capabilityId} · {o.state} · 效果 {o.effectCertainty ?? "—"} · {o.operationId.slice(0, 14)}</li>)}</ul>
            </>
          )}
          {obs && (
            <div className="muted small">
              观察源：{obs.cursors.map((c) => `${c.source} ${QUALITY_TEXT[c.quality] ?? c.quality}${c.drop_count ? `（丢失 ${c.drop_count}）` : ""}`).join(" · ") || "—"}
              {" · "}遥测 {obs.telemetry.available ? "可用" : `不可用（${String(obs.telemetry.reason ?? "")}）`}
              {obs.telemetry.gap ? " · 有缺口" : ""}
            </div>
          )}
        </div>
      )}
      {tab === "resources" && (
        <div>
          <ul className="resources">
            {resources.map((r) => (
              <li key={r.resourceId} className="res-row">
                <div>
                  <strong>{r.displayName}</strong> <span className="muted small">{KIND_TEXT[r.kind] ?? r.kind} · {r.source === "user-registered" ? "你登记的" : r.source === "installed-catalog" ? "安装目录登记" : "平台"} · 代次 {r.generation}</span>
                </div>
                <div className="small">
                  <span className={`dot ${r.status === "available" ? "ok" : r.status === "quarantined" ? "warn" : "bad"}`} />
                  {r.status === "available" ? "可用" : r.status === "quarantined" ? "已隔离（有结果未知的操作）" : r.status === "suspended" ? "已暂停：目录被移动或替换，需重新登记" : r.status}
                  {r.lastObservation && ` · 观察于 ${ago(r.lastObservation.observedAt)}（${QUALITY_TEXT[r.lastObservation.quality] ?? r.lastObservation.quality}）`}
                </div>
                {r.identity && <div className="muted small">身份：{Object.entries(r.identity).filter(([k]) => k !== "catalogKey").map(([k, v]) => `${k}=${String(v)}`).join(" ")}</div>}
                {r.limits && Object.keys(r.limits).length > 0 && <div className="muted small">安装上限：{JSON.stringify(r.limits)}</div>}
                {(r.connectedApps ?? []).length > 0 && <div className="muted small">已连接：{r.connectedApps!.map((c) => `${c.binding_alias}(${c.sync_state})`).join("、")}</div>}
                <button className="small" onClick={() => void read(r)}>读取当前状态</button>
                {snap[r.resourceId] && <pre className="snap">{QUALITY_TEXT[snap[r.resourceId]!.quality] ?? snap[r.resourceId]!.quality} · {ago(snap[r.resourceId]!.at)}{"\n"}{snap[r.resourceId]!.text}</pre>}
              </li>
            ))}
          </ul>
          <div className="register">
            <input placeholder="/home/你/文档（只读登记）" value={path} onChange={(e) => setPath(e.target.value)} aria-label="目录路径" />
            <button disabled={!path} onClick={async () => {
              try {
                await api.registerImportRoot({ path }, newKey());
                setPath("");
                void load();
              } catch (e) {
                setErr(describeError(e));
              }
            }}>登记只读目录</button>
          </div>
        </div>
      )}
      {tab === "plan" && (
        <div className="plan-form">
          <p className="small">选择资源与允许提议的动作，AgentOS 会读取当前状态并生成<strong>一个</strong>计划。计划不会自动执行，需要你在确认框中确认。</p>
          <fieldset>
            <legend>资源</legend>
            {resources.filter((r) => r.kind !== "telemetry").map((r) => (
              <label key={r.resourceId} className="small">
                <input type="checkbox" checked={chosen.includes(r.resourceId)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, r.resourceId] : c.filter((x) => x !== r.resourceId)))} /> {r.displayName}
              </label>
            ))}
          </fieldset>
          {capChoices.length > 0 && (
            <fieldset>
              <legend>允许提议的动作</legend>
              {capChoices.map((c) => (
                <label key={c} className="small">
                  <input type="checkbox" checked={scopes.includes(c)} onChange={(e) => setScopes((s) => (e.target.checked ? [...s, c] : s.filter((x) => x !== c)))} /> {c}
                </label>
              ))}
            </fieldset>
          )}
          <textarea rows={2} placeholder="例如：将演示服务 CPU 上限设为 50%" value={intent} onChange={(e) => setIntent(e.target.value)} aria-label="系统计划需求" />
          <button className="primary" disabled={!props.models || props.runActive || !intent.trim() || chosen.length === 0} onClick={() => void startPlan()}>生成系统计划</button>
          {props.runActive && <span className="muted small">已有任务在运行</span>}
        </div>
      )}
    </section>
  );
}

/** Bindings of a formatVersion 3 app and their connections (shown beside the app). */
export function AppSystemPanel(props: { appId: string; tick: number; onOpenAction: (id: string) => void }) {
  const [b, setB] = useState<SysBindings | null>(null);
  const [resources, setResources] = useState<SysResource[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [policy, setPolicy] = useState<Record<string, "per_plan" | "standing">>({});
  const [ops, setOps] = useState<SysAction[]>([]);
  const load = useCallback(async () => {
    try {
      const [x, r, o] = await Promise.all([api.systemBindings(props.appId), api.sysResources(), api.systemOperations()]);
      setB(x);
      setResources(r.items);
      setOps(o.items.filter((a) => a.appId === props.appId).slice(0, 5));
    } catch (e) {
      setErr(describeError(e));
    }
  }, [props.appId]);
  useEffect(() => {
    void load();
  }, [load, props.tick]);
  // Grant sync and revocation are asynchronous (pending → active, revoking → revoked): keep the state current.
  useEffect(() => {
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [load]);
  if (!b || b.items.length === 0) return null;
  return (
    <div className="app-system">
      <h3>系统资源</h3>
      {err && <div className="banner error">{err}</div>}
      {b.items.map((it) => (
        <div key={it.alias} className="binding">
          <div><strong>{it.alias}</strong> <span className="muted small">{KIND_TEXT[it.resourceKind] ?? it.resourceKind} · {it.capabilities.map((c) => c.capabilityId).join(", ")}</span></div>
          <div className="muted small">{it.description}</div>
          {it.grants.length > 0 ? (
            <div className="small">
              {it.connected ? "已连接" : it.grants.some((g) => g.state === "revoking") ? "撤销待确认" : it.grants.some((g) => g.state === "pending") ? "授权同步中" : "授权异常"}
              {" · "}{resources.find((r) => r.resourceId === it.grants[0]!.resourceId)?.displayName}
              {" · "}{it.grants.some((g) => g.confirmationPolicy === "standing") ? "持续授权" : "每次确认"}
              <button className="link small" onClick={async () => {
                try {
                  await api.revokeProviderGrant(it.grants[0]!.grantId, newKey());
                  void load();
                } catch (e) {
                  setErr(describeError(e));
                }
              }}>撤销</button>
            </div>
          ) : (
            <div className="small">
              <span className="bad">需要连接资源</span>
              <select value={pick[it.alias] ?? ""} onChange={(e) => setPick((p) => ({ ...p, [it.alias]: e.target.value }))} aria-label={`为 ${it.alias} 选择资源`}>
                <option value="">选择…</option>
                {resources.filter((r) => r.kind === it.resourceKind).map((r) => <option key={r.resourceId} value={r.resourceId}>{r.displayName}</option>)}
              </select>
              <select value={policy[it.alias] ?? "per_plan"} onChange={(e) => setPolicy((p) => ({ ...p, [it.alias]: e.target.value as "per_plan" | "standing" }))} aria-label="确认方式">
                <option value="per_plan">每次确认</option>
                <option value="standing">持续授权</option>
              </select>
              <button disabled={!pick[it.alias]} onClick={async () => {
                try {
                  await api.createProviderGrant({ appId: props.appId, bindingAlias: it.alias, resourceId: pick[it.alias]!, confirmationPolicy: policy[it.alias] ?? "per_plan" }, newKey());
                  void load();
                } catch (e) {
                  setErr(describeError(e));
                }
              }}>连接</button>
            </div>
          )}
        </div>
      ))}
      {ops.length > 0 && (
        <>
          <h4>最近系统动作</h4>
          <ul className="ops">{ops.map((a) => <li key={a.actionId} className="small"><button className="link" onClick={() => props.onOpenAction(a.actionId)}>{a.preview.title}</button> · {PHASE_TEXT[a.phase]}</li>)}</ul>
        </>
      )}
    </div>
  );
}
