import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AppDetail, RevisionSummary, RunView, StateView, SystemInfo } from "@agentos/contracts";
import { ApiError, NetworkError, api, describeError, newKey, setClientEpoch } from "./api";
import { AppView } from "./AppView";
import { CodeAppView } from "./SlotRenderer";
import { DeploymentLine, RuntimePanel, ServicesPanel, STAGE_TEXT, healthText } from "./Panels";
import type { DeploymentView } from "./api";
import { TaskCenter } from "./TaskCenter";
import { MaintenanceCenter } from "./MaintenanceCenter";
import { AppSystemPanel, ConfirmDialog, SystemCenter } from "./SystemCenter";

class Boundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  static getDerivedStateFromProps(p: { resetKey: string }, s: { key: string }) {
    return p.resetKey !== s.key ? { error: null, key: p.resetKey } : null;
  }
  render() {
    if (this.state.error) {
      return (
        <div className="banner error" role="alert">
          这个应用版本渲染失败：{this.state.error.message}。可以在右侧切换到其他版本。
        </div>
      );
    }
    return this.props.children;
  }
}

function Login(props: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <main className="login">
      <h1>AgentOS</h1>
      <p className="muted">输入本机数据目录里的 auth-token 登录（文件权限 0600，只有你能读）。</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.login(token);
            setToken("");
            props.onDone();
          } catch (x) {
            setErr(x instanceof ApiError && x.code === "AUTH_REQUIRED" ? "token 不正确" : describeError(x));
          }
        }}
      >
        <input type="password" autoComplete="off" placeholder="auth-token" value={token} onChange={(e) => setToken(e.target.value)} aria-label="auth-token" />
        <button className="primary" type="submit" disabled={!token}>
          登录
        </button>
      </form>
      {err && <div className="banner error">{err}</div>}
    </main>
  );
}

const STATUS_TEXT: Record<string, string> = {
  queued: "排队中",
  running: "生成中",
  cancel_requested: "正在取消",
  blocked: "已阻塞",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const TOOL_TEXT: Record<string, string> = {
  app_get: "读取应用",
  app_stage: "暂存候选版本",
  app_validate: "校验",
  app_activate: "激活",
  app_prepare: "准备发布",
  app_prepare_status: "查询准备状态",
  runtime_catalog: "读取运行时目录",
  service_catalog: "读取服务目录",
  system_info: "读取系统信息",
  app_list: "列出应用",
};

function RunPanel(props: { run: RunView; onCancel: () => void; onRetry: () => void; canRetry: boolean; cancelError: string | null; onOpenAction?: (id: string) => void }) {
  const r = props.run;
  const active = ["queued", "running", "cancel_requested", "blocked"].includes(r.status);
  const [transcript, setTranscript] = useState<{ role: string; text: string; toolName?: string; isError?: boolean }[] | null>(null);
  useEffect(() => {
    setTranscript(null);
    if (!active) api.transcript(r.runId).then((t) => setTranscript(t.items)).catch(() => setTranscript(null));
  }, [r.runId, active]);
  const noChange = r.status === "succeeded" && r.appliedRevisionId !== null && r.progress.lastTool === "app_activate" && r.mode === "modify" && r.warning === null;
  return (
    <div className={`run run-${r.status}`} aria-live="polite">
      <div className="run-head">
        <strong>{STATUS_TEXT[r.status] ?? r.status}</strong>
        <span className="muted">
          {r.runMode === "system_plan" ? "系统计划" : r.mode === "create" ? "新建应用" : "修改应用"} · 模型请求 {r.modelRequestCount} · 工具 {r.progress.toolTasks}
          {r.progress.lastTool ? ` · ${TOOL_TEXT[r.progress.lastTool] ?? r.progress.lastTool}` : ""}
        </span>
      </div>
      <div className="run-intent">“{r.intent}”</div>
      {r.deployment && (
        <div className="small">
          发布：{r.deployment.stage ? STAGE_TEXT[r.deployment.stage] ?? r.deployment.stage : r.deployment.status}
          {r.deployment.error ? ` · ${r.deployment.error.code} ${r.deployment.error.message}` : ""}
        </div>
      )}
      {r.runMode === "system_plan" && r.preparedActionId && (
        <div className="banner info">
          计划已生成，尚未执行。<button onClick={() => props.onOpenAction?.(r.preparedActionId!)}>查看并确认</button>
        </div>
      )}
      {r.appliedRevisionId && <div className="banner ok">已发布版本 {r.appliedRevisionId.slice(7, 19)}{noChange ? "" : ""}</div>}
      {r.warning && <div className="banner warn">已发布，但生成收尾有问题：{r.warning}</div>}
      {r.error && (
        <div className="banner error">
          {r.error.code}：{r.error.message}
        </div>
      )}
      {r.lastValidation && r.lastValidation.issues.length > 0 && r.status !== "succeeded" && (
        <details>
          <summary>最近一次校验问题（{r.lastValidation.issues.length}）</summary>
          <ul className="issues">
            {r.lastValidation.issues.map((i, n) => (
              <li key={n}>
                <code>{i.path}</code> {i.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      {props.cancelError && <div className="banner error">{props.cancelError}</div>}
      <div className="actions">
        {active && r.status !== "cancel_requested" && <button onClick={props.onCancel}>取消生成</button>}
        {(r.status === "failed" || r.status === "cancelled") && props.canRetry && (
          <button className="primary" onClick={props.onRetry}>
            重试
          </button>
        )}
      </div>
      {transcript && transcript.length > 0 && (
        <details className="transcript">
          <summary>过程摘要</summary>
          <ol>
            {transcript
              .filter((i) => i.role !== "user")
              .map((i, n) => (
                <li key={n} className={i.isError ? "err" : ""}>
                  <span className="muted">{i.toolName ? `${i.toolName}` : i.role}</span> {i.text.slice(0, 300)}
                </li>
              ))}
          </ol>
        </details>
      )}
    </div>
  );
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [state, setState] = useState<StateView | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AppDetail | null>(null);
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [intent, setIntent] = useState("");
  const [mode, setMode] = useState<"create" | "modify">("create");
  const [submitKey, setSubmitKey] = useState(newKey());
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [watchedRun, setWatchedRun] = useState<RunView | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [epochStale, setEpochStale] = useState(false);
  const [deploying, setDeploying] = useState<DeploymentView | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  const [center, setCenter] = useState<"tasks" | "maint" | null>(null);
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const lastIntent = useRef<{ intent: string; targetAppId: string | null } | null>(null);

  const handle = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.code === "AUTH_REQUIRED") setAuthed(false);
    else if (e instanceof ApiError && e.code === "CLIENT_EPOCH_STALE") setEpochStale(true);
    else setBanner(describeError(e));
  }, []);

  const loadState = useCallback(async () => {
    try {
      const s = await api.state();
      setClientEpoch(s.clientEpoch);
      setState(s);
      setAuthed(true);
      setBanner(null);
      const run = s.activeRun ?? s.lastRun;
      setWatchedRun((cur) => (run && (!cur || cur.runId === run.runId || s.activeRun) ? run : cur));
      return s;
    } catch (e) {
      if (e instanceof ApiError && e.code === "AUTH_REQUIRED") setAuthed(false);
      else if (e instanceof NetworkError) setBanner("与宿主的连接中断，正在重试…");
      else handle(e);
      return null;
    }
  }, [handle]);

  // Only the newest load for the currently selected app may update the view (responses can arrive out of order).
  const loadSeq = useRef(0);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const loadApp = useCallback(
    async (appId: string | null) => {
      const my = ++loadSeq.current;
      if (!appId) {
        setDetail(null);
        setRevisions([]);
        return;
      }
      // Never act on another app's detail while this one loads.
      setDetail((cur) => (cur && cur.appId !== appId ? null : cur));
      try {
        const [d, r] = await Promise.all([api.app(appId), api.revisions(appId)]);
        if (my !== loadSeq.current || selectedRef.current !== appId) return;
        setDetail(d);
        setRevisions(r.items);
      } catch (e) {
        handle(e);
      }
    },
    [handle],
  );

  // Full snapshot on load, on focus, and on a timer (1 s while a run is active, 10 s otherwise).
  useEffect(() => {
    void loadState();
    const onFocus = () => {
      void loadState();
      setRefreshToken((n) => n + 1);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadState]);

  const activeRun = state?.activeRun ?? null;
  useEffect(() => {
    if (!authed) return;
    const t = setInterval(() => void loadState(), activeRun ? 1000 : 10_000);
    return () => clearInterval(t);
  }, [authed, activeRun, loadState]);

  useEffect(() => {
    if (authed) api.system().then(setSystem).catch(() => undefined);
  }, [authed]);

  // Follow the selected app; when a run publishes or the epoch moves, reload it from the server.
  const selectedSummary = state?.apps.find((a) => a.appId === selected) ?? null;
  useEffect(() => {
    if (state && selected === null && state.apps.length > 0) setSelected(state.apps[0]!.appId);
  }, [state, selected]);
  useEffect(() => {
    void loadApp(selected);
  }, [selected, selectedSummary?.appEpoch, selectedSummary?.activeRevisionId, loadApp]);

  // When a create run publishes, jump to the new app.
  const prevRun = useRef<RunView | null>(null);
  useEffect(() => {
    const p = prevRun.current;
    // A system_plan run that prepared its plan opens the Shell confirmation (the plan is not executed yet).
    if (watchedRun && p && p.runId === watchedRun.runId && !p.preparedActionId && watchedRun.preparedActionId) setConfirmAction(watchedRun.preparedActionId);
    if (watchedRun && p && p.runId === watchedRun.runId && !p.appliedRevisionId && watchedRun.appliedRevisionId) {
      setSelected(watchedRun.targetAppId);
      void loadApp(watchedRun.targetAppId);
    }
    prevRun.current = watchedRun;
  }, [watchedRun, loadApp]);

  useEffect(() => {
    if (!selected) setMode("create");
  }, [selected]);

  const submitRun = async (override?: { intent: string; targetAppId: string | null }) => {
    if (!state) return;
    setSubmitError(null);
    const target = override ? override.targetAppId : mode === "modify" ? selected : null;
    const text = override ? override.intent : intent;
    const body: { intent: string; targetAppId: string | null; expectedAppEpoch?: number } = { intent: text, targetAppId: target };
    if (target) {
      const a = state.apps.find((x) => x.appId === target);
      if (a) body.expectedAppEpoch = a.appEpoch;
      else {
        const d = await api.app(target);
        body.expectedAppEpoch = d.appEpoch;
      }
    }
    const key = override ? newKey() : submitKey;
    try {
      await api.submitRun(body, key);
      lastIntent.current = { intent: text, targetAppId: target };
      setIntent("");
      setSubmitKey(newKey());
      await loadState();
    } catch (e) {
      if (!(e instanceof NetworkError)) setSubmitKey(newKey());
      setSubmitError(describeError(e));
      if (e instanceof ApiError && e.code === "AUTH_REQUIRED") setAuthed(false);
    }
  };

  const cancel = async () => {
    if (!watchedRun) return;
    setCancelError(null);
    try {
      const r = await api.cancelRun(watchedRun.runId, newKey());
      setWatchedRun(r);
      await loadState();
    } catch (e) {
      setCancelError(describeError(e));
    }
  };

  const retry = () => {
    if (!watchedRun) return;
    const target = watchedRun.mode === "modify" ? watchedRun.targetAppId : watchedRun.targetAppId;
    // A failed create keeps its placeholder appId: retry against the same target with a fresh run.
    void submitRun({ intent: watchedRun.intent, targetAppId: target });
  };

  // Both declarative and code history versions switch through the asynchronous deployment API (spec §19.1).
  const switchTo = async (rev: RevisionSummary) => {
    if (!detail) return;
    try {
      let d = await api.deploy(detail.appId, { revisionId: rev.revisionId, expectedAppEpoch: detail.appEpoch }, newKey());
      setDeploying(d);
      const until = Date.now() + 240_000;
      while (!["committed", "failed", "cancelled", "superseded"].includes(d.status) && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 500));
        d = await api.deployment(d.deploymentId);
        setDeploying(d);
      }
      await loadState();
      await loadApp(detail.appId);
      setRefreshToken((n) => n + 1);
      if (d.status === "committed") setTimeout(() => setDeploying((cur) => (cur?.deploymentId === d.deploymentId ? null : cur)), 4000);
    } catch (e) {
      handle(e);
      void loadApp(detail.appId);
    }
  };

  if (authed === false) return <Login onDone={() => void loadState()} />;
  if (authed === null || !state) return <main className="loading">AgentOS 正在连接…</main>;

  const modelOk = state.modelAvailable;
  const runActive = activeRun !== null;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          AgentOS <span className="muted">v{state.hostVersion}</span>
        </div>
        <button
          className={`nav-create ${selected === null ? "active" : ""}`}
          onClick={() => {
            setSelected(null);
            setMode("create");
          }}
        >
          ＋ 创建应用
        </button>
        <button className={`nav-create ${showSystem ? "active" : ""}`} onClick={() => setShowSystem((v) => !v)}>
          ⚙ 系统与操作中心
        </button>
        <button className={`nav-create ${center === "tasks" ? "active" : ""}`} onClick={() => setCenter((v) => (v === "tasks" ? null : "tasks"))}>
          ☰ 任务中心{(state.runs?.length ?? 0) > 0 ? `（${state.runs!.length}）` : ""}
        </button>
        <button className={`nav-create ${center === "maint" ? "active" : ""}`} onClick={() => setCenter((v) => (v === "maint" ? null : "maint"))}>
          ⛑ 维护中心
        </button>
        <nav aria-label="应用">
          {state.apps.map((a) => (
            <button key={a.appId} className={`nav-app ${a.appId === selected ? "active" : ""}`} onClick={() => setSelected(a.appId)}>
              {a.title}
              <span className="muted small app-meta">
                {a.runtime === "isolated-code-v1" || a.runtime === "isolated-code-v2" ? `代码${a.runtime === "isolated-code-v2" ? "+系统" : ""} · ${healthText(a.health)}` : "声明式"}
              </span>
            </button>
          ))}
          {state.apps.length === 0 && <p className="muted small">还没有应用</p>}
        </nav>
        <div className="status-box">
          <div>
            <span className={`dot ${state.ready ? "ok" : "bad"}`} /> 宿主 {state.ready ? "就绪" : "恢复中"}
          </div>
          <div title={(state.runtimeProblems ?? []).join("\n")}>
            <span className={`dot ${state.runtimeReady ? "ok" : "bad"}`} /> 代码运行环境 {state.runtimeReady ? "就绪" : "不可用"}
          </div>
          <div title={String((state.system as { broker?: { diagnostic?: string } } | undefined)?.broker?.diagnostic ?? "")}>
            <span className={`dot ${state.brokerReady ? "ok" : "bad"}`} /> 系统执行服务 {state.brokerReady ? "就绪" : "不可用（系统写入暂停）"}
          </div>
          <div>
            <span className={`dot ${state.telemetryAvailable ? "ok" : "bad"}`} /> 遥测 {state.telemetryAvailable ? "可用" : "不可用"}
          </div>
          <div>
            <span className={`dot ${modelOk ? "ok" : "bad"}`} /> 模型 {modelOk ? `${state.model?.provider}/${state.model?.modelId}${state.model?.mode === "faux" ? "（模拟）" : ""}` : "不可用"}
          </div>
          {system && (
            <div className="muted small">
              {system.platform}/{system.arch} · {system.hostname} · 内存 {Math.round(system.memory.freeBytes / 2 ** 20)}/{Math.round(system.memory.totalBytes / 2 ** 20)} MiB · 运行 {Math.round(system.uptimeSeconds / 3600)} h
            </div>
          )}
          <button
            className="link small"
            onClick={async () => {
              await api.logout().catch(() => undefined);
              setAuthed(false);
            }}
          >
            退出登录
          </button>
        </div>
      </aside>

      <main className="main">
        {epochStale && (
          <div className="banner error">
            工作区已从备份恢复或已变化，这个页面已过期。<button onClick={() => location.reload()}>刷新页面</button>
          </div>
        )}
        {banner && <div className="banner error">{banner}</div>}
        {state.agentState === "blocked" && <div className="banner error">生成功能已阻塞：{state.agentDiagnostic}。已有应用仍可查看。</div>}
        {confirmAction && <ConfirmDialog actionId={confirmAction} onClose={() => setConfirmAction(null)} />}
        {center === "tasks" && <TaskCenter runs={state.runs ?? []} slots={state.foregroundSlots ?? 2} apps={state.apps} onChanged={() => void loadState()} />}
        {center === "maint" && <MaintenanceCenter />}
        {showSystem && (
          <SystemCenter tick={refreshToken} brokerReady={!!state.brokerReady} models={modelOk} runActive={runActive} onRunStarted={() => void loadState()} onOpenAction={setConfirmAction} />
        )}

        <section className="request" aria-label="需求">
          <div className="request-target">
            {selected && detail?.bundle ? (
              <div className="segmented" role="radiogroup">
                <button className={mode === "modify" ? "active" : ""} onClick={() => setMode("modify")}>
                  修改“{detail.bundle.manifest.title}”
                </button>
                <button className={mode === "create" ? "active" : ""} onClick={() => setMode("create")}>
                  新建应用
                </button>
              </div>
            ) : (
              <strong>新建应用</strong>
            )}
          </div>
          <textarea
            rows={2}
            maxLength={8000}
            placeholder={mode === "modify" ? "例如：增加优先级和优先级筛选" : "例如：做一个待办应用"}
            value={intent}
            disabled={!modelOk || runActive}
            onChange={(e) => setIntent(e.target.value)}
            aria-label="需求描述"
          />
          <div className="actions">
            <button className="primary" disabled={!modelOk || runActive || intent.trim() === ""} onClick={() => void submitRun()}>
              {mode === "modify" ? "修改应用" : "生成应用"}
            </button>
            {!modelOk && <span className="muted small">模型不可用：只能使用已生成的应用。{state.agentDiagnostic ?? ""}</span>}
            {runActive && <span className="muted small">生成进行中，可以继续编辑记录；版本切换需等待结束。</span>}
          </div>
          {submitError && <div className="banner error">{submitError}</div>}
          {watchedRun && <RunPanel run={watchedRun} onCancel={() => void cancel()} onRetry={retry} canRetry={modelOk && !runActive && watchedRun.runMode !== "system_plan"} cancelError={cancelError} onOpenAction={setConfirmAction} />}
        </section>

        <div className="workspace">
          <div className="app-area">
            {selected && detail?.bundle ? (
              <Boundary resetKey={`${detail.appId}:${detail.activeRevisionId}`}>
                {detail.bundle.formatVersion === 2 || detail.bundle.formatVersion === 3 ? (
                  <CodeAppView
                    onSystemPlan={setConfirmAction}
                    detail={detail}
                    dataEpoch={selectedSummary?.dataEpoch ?? null}
                    refreshToken={refreshToken}
                    disabled={!state.runtimeReady}
                    onChanged={() => void loadState().then(() => loadApp(detail.appId))}
                  />
                ) : (
                  <AppView detail={detail} refreshToken={refreshToken} onChanged={() => void loadState().then(() => loadApp(detail.appId))} />
                )}
              </Boundary>
            ) : (
              <div className="placeholder muted">{selected ? "加载中…" : "描述你想要的应用，AgentOS 会生成它。"}</div>
            )}
          </div>
          {selected && detail && (
            <aside className="versions" aria-label="版本">
              {detail.bundle?.formatVersion === 3 && <AppSystemPanel appId={detail.appId} tick={refreshToken} onOpenAction={setConfirmAction} />}
              {(detail.bundle?.formatVersion === 2 || detail.bundle?.formatVersion === 3) && (
                <Boundary resetKey={`rt:${detail.appId}`}>
                  <RuntimePanel detail={detail} tick={refreshToken} onChanged={() => void loadState()} />
                  <ServicesPanel detail={detail} tick={refreshToken} onChanged={() => setRefreshToken((n) => n + 1)} />
                </Boundary>
              )}
              <h3>版本</h3>
              {deploying && deploying.appId === detail.appId && <DeploymentLine d={deploying} />}
              <p className="muted small">切换版本只换界面和规则，记录保留。删除的记录不会因切换恢复。</p>
              <ol>
                {revisions.map((r, n) => (
                  <li key={r.revisionId} className={r.isActive ? "active" : ""}>
                    <div>
                      <strong>v{n + 1}</strong> {r.title} <span className="muted small">{r.runtime === "isolated-code-v2" ? "代码+系统" : r.runtime === "isolated-code-v1" ? "代码" : "声明式"}</span>
                    </div>
                    <div className="muted small">
                      {new Date(r.firstActivatedAt).toLocaleString()} · {r.revisionId.slice(7, 15)}
                    </div>
                    {r.isActive ? (
                      <span className="badge">当前</span>
                    ) : (
                      <button disabled={runActive || (deploying !== null && !["committed", "failed", "cancelled", "superseded"].includes(deploying.status))} onClick={() => void switchTo(r)} title={runActive ? "生成进行中，稍后再切换" : ""}>
                        切换到此版本
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            </aside>
          )}
        </div>
      </main>
    </div>
  );
}
