import { useCallback, useEffect, useState } from "react";
import { type SysResource, api, describeError, newKey, type MaintJob, type MaintPolicy, type MaintState } from "./api";

/**
 * v0.4 maintenance center (spec §22.2): enabled scope, recent checks, actual changes, cooldown / circuit breaker,
 * budgets and a prominent pause. "Paused locally" and "confirmed by the system executor" are shown separately; a
 * diagnosis, a validated candidate, a publication and a reconciled external action are different outcomes.
 */
const JOB_TEXT: Record<string, string> = {
  queued: "排队",
  deferred: "延后",
  observing: "观察中",
  ready: "待执行",
  running: "执行中",
  verifying: "核对健康中",
  reconciling: "核对结果中",
  diagnosing: "诊断中",
  awaiting_approval: "等待你的决定",
  succeeded: "完成",
  no_change: "无需变更",
  failed_no_effect: "未执行（无效果）",
  cancelled: "已取消",
  expired: "已过期",
  indeterminate: "结果未知（需核对）",
  needs_attention: "需要处理",
};
const CERT_TEXT: Record<string, string> = { none: "没有实际变更", confirmed: "已确认变更", partial: "部分变更", unknown: "变更未知" };
const TPL_TEXT: Record<string, string> = {
  "app-recovery": "应用故障恢复",
  "service-ensure-running": "服务保持运行",
  "cache-gc": "构建缓存清理",
  "log-cleanup": "诊断日志整理",
  "app-archive": "应用归档",
  "session-compaction": "会话压缩",
  "app-diagnose": "应用诊断",
  "app-optimize": "优化候选",
};

export function MaintenanceCenter() {
  const [st, setSt] = useState<MaintState | null>(null);
  const [policies, setPolicies] = useState<MaintPolicy[]>([]);
  const [jobs, setJobs] = useState<MaintJob[]>([]);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [incidents, setIncidents] = useState<Awaited<ReturnType<typeof api.incidents>>["items"]>([]);
  const [notes, setNotes] = useState<Awaited<ReturnType<typeof api.notifications>>["items"]>([]);
  const [proposals, setProposals] = useState<Awaited<ReturnType<typeof api.proposals>>["items"]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, p, j, i, n, sv, rs, proposalPage] = await Promise.all([api.maintState(), api.maintPolicies(), api.maintJobs(), api.incidents(), api.notifications(), api.state(), api.sysResources().catch(() => ({ items: [] as SysResource[], broker: {} })), api.proposals()]);
      const names: Record<string, string> = {};
      for (const a of sv.apps as { appId: string; name?: string; title?: string }[]) names[`app:${a.appId}`] = a.name ?? a.title ?? a.appId;
      for (const r of rs.items) names[`${r.kind}:${r.resourceId}`] = r.displayName;
      setTargets(names);
      setSt(s);
      setPolicies(p.items);
      setJobs(j.items);
      setIncidents(i.items);
      setNotes(n.items);
      setProposals(proposalPage.items);
      setErr(null);
    } catch (e) {
      setErr(describeError(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
      await load();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!st) return <section className="maint-center" aria-label="维护中心">{err ? <div className="banner error">{err}</div> : <p className="muted">维护中心加载中…</p>}</section>;
  const paused = st.state === "paused";
  const rootOk = st.root === "synced";
  const enabled = policies.filter((p) => ["enabled", "syncing", "approved"].includes(p.state));
  const pending = policies.filter((p) => p.state === "pending_approval");
  const last = ((st.budgets?.usage as { last24h?: { requests: number; background: number; backgroundOutputTokens: number; usageUnknown: number } } | undefined)?.last24h) ?? { requests: 0, background: 0, backgroundOutputTokens: 0, usageUnknown: 0 };
  const limits = (st.budgets?.limits ?? {}) as { modelRequestsPer24h?: number; backgroundModelRequestsPer24h?: number; backgroundOutputTokensPer24h?: number };
  return (
    <section className="maint-center" aria-label="维护中心">
      <h3>维护中心</h3>
      {err && <div className="banner error">{err}</div>}
      <div className={`maint-switch ${paused ? "paused" : "running"}`}>
        <div>
          <strong>{paused ? "自动维护已暂停" : "自动维护运行中"}</strong>
          <div className="small" data-testid="maint-root">
            本地：{paused ? "已暂停" : "运行"} · 系统执行端：{rootOk ? "已确认" : "等待确认（暂停在本地已立即生效）"}
          </div>
          {st.clock === "clock_uncertain" && <div className="banner warn small">系统时钟发生跳变，自动维护已停止，请在确认时间正确后重新检查。</div>}
        </div>
        <button className={paused ? "primary" : "danger big"} disabled={busy} onClick={() => void act(() => api.maintControl(paused ? "resume" : "pause", newKey()))}>
          {paused ? "恢复自动维护" : "⏸ 暂停全部自动维护"}
        </button>
      </div>

      {pending.length > 0 && (
        <>
          <h4>等待你批准的策略（{pending.length}）</h4>
          <ul className="policy-approvals" aria-label="待批准策略">
            {pending.map((p) => (
              <li key={`${p.policyId}/${p.version}`} className="policy-card" data-policy-id={p.policyId}>
                <div><strong>{TPL_TEXT[p.templateId] ?? p.templateId}</strong> · 版本 {p.version}</div>
                <div className="small">目标：{p.target.kind === "workspace" ? "整个工作区" : (targets[`${p.target.kind}:${p.target.id}`] ?? `${p.target.kind} ${p.target.id}`)}</div>
                <div className="small">自动执行的动作：{p.mode === "automatic" && (p.automaticActions?.length ?? 0) > 0 ? p.automaticActions!.join("、") : "无（只观察或只给建议）"}</div>
                <div className="small">频率：{p.trigger.kind === "interval" ? `每 ${Math.round((p.trigger.intervalSeconds ?? 0) / 60)} 分钟检查` : p.trigger.kind === "event" ? "事件触发" : "只在手动检查时"}</div>
                <div className="small">额度：{p.bounds.perHour !== undefined ? `每小时最多 ${p.bounds.perHour} 次 · 24 小时最多 ${p.bounds.per24h} 次 · 冷却 ${Math.round((p.bounds.cooldownSeconds ?? 0) / 60)} 分钟` : "不执行变更"}{p.usesModel ? " · 使用后台模型额度" : ""}</div>
                <div className="small">期限：到 {p.approval.expiresAt ? p.approval.expiresAt.slice(0, 16).replace("T", " ") : "—"} 为止，不自动续期；参数或版本变化都需要重新批准。</div>
                <div className="small muted">策略指纹 {p.policyHash.slice(0, 19)}…</div>
                <button className="primary small" disabled={busy} onClick={() => void act(() => api.maintPolicyApprove(p.policyId, p.version, p.policyHash, newKey()))}>批准此范围</button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>已启用的范围（{enabled.length}）</h4>
      {enabled.length === 0 ? (
        <p className="muted small">没有启用的维护策略。维护只在你批准的范围内运行。</p>
      ) : (
        <table className="small">
          <thead>
            <tr><th>模板</th><th>目标</th><th>方式</th><th>次数与冷却</th><th>状态</th><th /></tr>
          </thead>
          <tbody>
            {enabled.map((p) => (
              <tr key={`${p.policyId}/${p.version}`}>
                <td>{TPL_TEXT[p.templateId] ?? p.templateId}</td>
                <td>{p.target.kind === "workspace" ? "整个工作区" : `${p.target.kind} ${p.target.id.slice(0, 12)}`}</td>
                <td>{p.mode === "automatic" ? "自动（白名单动作）" : p.mode === "suggest" ? "只给建议" : "只观察"}{p.trigger.kind === "interval" ? ` · 每 ${Math.round((p.trigger.intervalSeconds ?? 0) / 60)} 分钟` : p.trigger.kind === "event" ? " · 事件触发" : " · 手动"}</td>
                <td>{p.bounds.perHour !== undefined ? `每小时 ≤${p.bounds.perHour} · 24 小时 ≤${p.bounds.per24h} · 冷却 ${Math.round((p.bounds.cooldownSeconds ?? 0) / 60)} 分钟` : "—"}</td>
                <td>{p.state === "syncing" ? "等待系统执行端确认" : p.state === "enabled" ? "已启用" : p.state}{p.approval.expiresAt ? ` · 到期 ${p.approval.expiresAt.slice(0, 10)}` : ""}</td>
                <td><button className="small" disabled={busy} onClick={() => void act(() => api.maintPolicyPause(p.policyId, newKey()))}>暂停此策略</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4>冷却与熔断</h4>
      {(st.circuits ?? []).filter((c) => c.state !== "closed").length === 0 ? (
        <p className="muted small">没有打开的熔断。</p>
      ) : (
        <ul className="small">
          {(st.circuits ?? []).filter((c) => c.state !== "closed").map((c) => (
            <li key={`${c.targetKind}/${c.targetId}/${c.actionFamily}`} className="circuit">
              <span className="pill bad">已暂停自动恢复</span> {c.targetKind} {c.targetId.slice(0, 12)} · 连续失败 {c.consecutiveFailures} 次{c.reason ? ` · ${c.reason}` : ""}
              {(c.targetKind === "app" || c.targetKind === "service") && (
                <button className="small" disabled={busy} onClick={() => void act(() => api.maintResetCircuit({ targetKind: c.targetKind, targetId: c.targetId }, newKey()))}>我已处理，重新允许恢复</button>
              )}
            </li>
          ))}
        </ul>
      )}

      <h4>后台预算（滚动 24 小时）</h4>
      <p className="small" data-testid="maint-budget">
        全部模型请求 {last.requests}/{limits.modelRequestsPer24h ?? "—"} · 后台请求 {last.background}/{limits.backgroundModelRequestsPer24h ?? "—"} · 后台输出 {last.backgroundOutputTokens}/{limits.backgroundOutputTokensPer24h ?? "—"} token
        {last.usageUnknown > 0 ? ` · ${last.usageUnknown} 次用量未知（按上限记账）` : ""}
        {st.foreground ? ` · 前台任务槽 ${st.foreground.slots}，排队 ${st.foreground.queued}` : ""}
      </p>

      {proposals.some((pr) => pr.state === "pending" || pr.state === "needs_recheck" || pr.state === "publishing") && (
        <>
          <h4>等待你决定的优化候选</h4>
          <ul className="policy-approvals" aria-label="优化候选">
            {proposals.filter((pr) => pr.state === "pending" || pr.state === "needs_recheck" || pr.state === "publishing").map((pr) => (
              <li key={pr.proposalId} className="policy-card" data-proposal-id={pr.proposalId}>
                <div><strong>{pr.label}</strong></div>
                <div className="small">应用 {targets[`app:${pr.appId}`] ?? pr.appId.slice(0, 12)} · 基线版本代次 {pr.baseAppEpoch}</div>
                <div className="small">改动文件：{(pr.diff?.files ?? []).map((f) => f.path).join("、") || "—"}</div>
                {pr.expectedBenefit && <div className="small">预期：{pr.expectedBenefit}</div>}
                {pr.reasons && <div className="small muted">{pr.reasons}</div>}
                <div className="small muted">候选指纹 {pr.proposalHash.slice(0, 19)}…{pr.expiresAt ? ` · 到期 ${pr.expiresAt.slice(0, 16).replace("T", " ")}` : ""}</div>
                {pr.state === "pending" && (
                  <div>
                    <button className="primary small" disabled={busy} onClick={() => void act(() => api.acceptProposal(pr.proposalId, pr.proposalHash, pr.baseAppEpoch, newKey()))}>按此指纹发布</button>
                    <button className="small" disabled={busy} onClick={() => void act(() => api.rejectProposal(pr.proposalId, newKey()))}>拒绝</button>
                  </div>
                )}
                {pr.state === "publishing" && <div className="small">发布已排队，完成后才算成功。</div>}
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>最近的检查与实际变更</h4>
      {jobs.length === 0 ? (
        <p className="muted small">还没有维护记录。</p>
      ) : (
        <table className="small" aria-label="维护作业">
          <thead>
            <tr><th>时间</th><th>模板</th><th>结果</th><th>实际变更</th><th>原因</th><th /></tr>
          </thead>
          <tbody>
            {jobs.slice(0, 20).map((j) => (
              <tr key={j.jobId} data-job-id={j.jobId}>
                <td>{(j.createdAt ?? "").replace("T", " ").slice(0, 16)}</td>
                <td>{TPL_TEXT[j.templateId] ?? j.templateId}</td>
                <td>{JOB_TEXT[j.state] ?? j.state}</td>
                <td>{CERT_TEXT[j.effectCertainty ?? "none"] ?? j.effectCertainty}{j.completedSteps ? `（${j.completedSteps} 步）` : ""}</td>
                <td className="muted">{String(j.outcomeReason ?? j.waitReason ?? "").slice(0, 120)}</td>
                <td>{!["succeeded", "no_change", "failed_no_effect", "cancelled", "expired", "indeterminate", "needs_attention"].includes(j.state) && <button className="small" disabled={busy} onClick={() => void act(() => api.maintCancelJob(j.jobId, newKey()))}>停止后续步骤</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {incidents.length > 0 && (
        <>
          <h4>未解决的异常（{incidents.length}）</h4>
          <ul className="small">
            {incidents.map((i) => (
              <li key={i.incidentId}>
                {i.target.kind} {i.target.id.slice(0, 12)} · {i.condition} · {i.state === "needs_attention" ? "需要处理" : i.state} · 证据 {i.evidenceCount} 条（{i.quality === "fresh" ? "新鲜" : i.quality}）
              </li>
            ))}
          </ul>
        </>
      )}
      {notes.length > 0 && (
        <>
          <h4>通知（{notes.length}）</h4>
          <ul className="small">
            {notes.map((n) => (
              <li key={n.id} className={n.severity === "error" ? "warn-text" : ""}>
                {n.title}{n.count > 1 ? `（${n.count} 次，已合并）` : ""} <button className="link small" onClick={() => void act(() => api.readNotification(n.id, newKey()))}>标为已读</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
