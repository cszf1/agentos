import { useCallback, useEffect, useState } from "react";
import type { AppDetail } from "@agentos/contracts";
import { api, describeError, newKey, type DeploymentView, type GrantView, type RuntimeView, type ServiceView } from "./api";

const HEALTH_TEXT: Record<string, string> = { ready: "运行中", recovering: "恢复中", degraded: "故障", stopped: "已停止" };
export const STAGE_TEXT: Record<string, string> = {
  validate: "校验",
  dependencies: "依赖准备",
  build: "构建",
  start: "启动检查",
  health: "启动检查",
  activate: "激活",
  cleanup: "清理",
};
const DEPLOY_STATUS: Record<string, string> = { queued: "排队", preparing: "准备中", ready: "待激活", committed: "已发布", failed: "失败", cancelled: "已取消", superseded: "已替换" };

export function healthText(h: string | null | undefined): string {
  return h ? (HEALTH_TEXT[h] ?? h) : "";
}

export function DeploymentLine(props: { d: DeploymentView }) {
  const d = props.d;
  return (
    <div className={`deploy deploy-${d.status}`} role="status">
      <strong>{DEPLOY_STATUS[d.status] ?? d.status}</strong>
      {d.stage && <span className="muted small"> · {STAGE_TEXT[d.stage] ?? d.stage}</span>}
      {d.status === "committed" && d.cleanupState !== "complete" && <span className="muted small"> · 清理旧实例</span>}
      {d.error && (
        <div className="small">
          {d.error.stage ? `${STAGE_TEXT[d.error.stage] ?? d.error.stage}：` : ""}
          {d.error.code} {d.error.message}
        </div>
      )}
    </div>
  );
}

/** Runtime state of a code app: health, generation, diagnostics and start/stop/restart (spec §19.3). */
export function RuntimePanel(props: { detail: AppDetail; tick: number; onChanged: () => void }) {
  const { detail } = props;
  const [rt, setRt] = useState<RuntimeView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    api.runtime(detail.appId).then(setRt).catch((e) => setErr(describeError(e)));
  }, [detail.appId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load, props.tick, detail.appEpoch]);
  const act = async (action: "start" | "stop" | "restart") => {
    setErr(null);
    try {
      await api.runtimeControl(detail.appId, action, { expectedAppEpoch: detail.appEpoch }, newKey());
      load();
      props.onChanged();
    } catch (e) {
      setErr(describeError(e));
    }
  };
  if (!rt) return err ? <div className="banner error">{err}</div> : null;
  return (
    <div className="runtime-panel" aria-label="运行状态">
      <h3>运行状态</h3>
      <div>
        <span className={`dot ${rt.health === "ready" ? "ok" : rt.health === "recovering" ? "warn" : "bad"}`} /> {healthText(rt.health)}
        <span className="muted small"> · 实例代次 {rt.generation}{rt.restartCount > 0 ? ` · 近期重启 ${rt.restartCount}` : ""}</span>
      </div>
      {rt.lastError && rt.health !== "ready" && <div className="banner error small">{rt.lastError.code}：{rt.lastError.message}</div>}
      <div className="actions">
        {rt.enabled ? (
          <>
            <button onClick={() => void act("restart")}>重启</button>
            <button onClick={() => void act("stop")}>停止</button>
          </>
        ) : (
          <button className="primary" onClick={() => void act("start")}>启动</button>
        )}
      </div>
      {err && <div className="banner error small">{err}</div>}
      <details>
        <summary className="small">诊断</summary>
        <div className="muted small">
          {rt.instance ? `实例 ${rt.instance.id.slice(0, 8)} · ${rt.instance.observedState} · 内存上限 ${Math.round(rt.instance.limits.memoryBytes / 2 ** 20)} MiB · CPU ${rt.instance.limits.cpus} · 进程 ${rt.instance.limits.pids}` : "没有运行中的实例"}
        </div>
        <ol className="diag">
          {rt.diagnostics.map((d, i) => (
            <li key={i} className={d.level === "error" ? "err" : ""}>{d.text}</li>
          ))}
        </ol>
      </details>
    </div>
  );
}

/** Imports of the selected app and their connections; the user alone grants and revokes (spec §17.1). */
export function ServicesPanel(props: { detail: AppDetail; tick: number; onChanged: () => void }) {
  const { detail } = props;
  const [imports, setImports] = useState<{ alias: string; description?: string; grant: GrantView | null }[]>([]);
  const [catalog, setCatalog] = useState<ServiceView[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    Promise.all([api.imports(detail.appId), api.services()])
      .then(([i, c]) => {
        setImports(i.items);
        setCatalog(c.items.filter((x) => x.appId !== detail.appId));
      })
      .catch((e) => setErr(describeError(e)));
  }, [detail.appId]);
  useEffect(load, [load, props.tick, detail.appEpoch]);
  if (imports.length === 0) return null;
  const connect = async (alias: string, svc: ServiceView) => {
    setErr(null);
    try {
      await api.createGrant(
        { sourceAppId: detail.appId, sourceRevisionId: detail.activeRevisionId!, alias, targetAppId: svc.appId, targetRevisionId: svc.revisionId, exportName: svc.exportName, contractHash: svc.contractHash },
        newKey(),
      );
      load();
      props.onChanged();
    } catch (e) {
      setErr(describeError(e));
    }
  };
  const revoke = async (g: GrantView) => {
    setErr(null);
    try {
      await api.revokeGrant(g.grantId, newKey());
      load();
      props.onChanged();
    } catch (e) {
      setErr(describeError(e));
    }
  };
  return (
    <div className="services-panel" aria-label="服务连接">
      <h3>服务连接</h3>
      {imports.map((imp) => {
        const g = imp.grant;
        const live = g && g.state === "active";
        return (
          <div key={imp.alias} className="service">
            <div>
              <strong>{imp.alias}</strong> <span className="muted small">{imp.description}</span>
            </div>
            {live ? (
              <div className="small">
                已连接：{catalog.find((c) => c.appId === g.targetAppId)?.appTitle ?? g.targetAppId.slice(0, 8)} · {g.exportName}
                <button className="link" onClick={() => void revoke(g)}>断开</button>
              </div>
            ) : (
              <div className="small">
                {g && g.state === "inactive" ? <span className="warn-text">服务待重新连接：{g.reason}</span> : g && g.state === "revoked" ? <span className="muted">已断开</span> : <span className="muted">未连接</span>}
                {catalog.map((svc) => (
                  <button key={`${svc.appId}:${svc.exportName}`} onClick={() => {
                    if (window.confirm(`允许“${detail.bundle?.manifest.title}”只读调用“${svc.appTitle}”的 ${svc.exportName} 服务？\n${svc.description}`)) void connect(imp.alias, svc);
                  }}>
                    连接 {svc.appTitle} · {svc.exportName}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {err && <div className="banner error small">{err}</div>}
    </div>
  );
}
