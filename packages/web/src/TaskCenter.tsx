import { useState } from "react";
import type { AppSummary, RunView } from "@agentos/contracts";
import { api, describeError, newKey } from "./api";

/**
 * v0.4 task center (spec §22.2): the foreground slots, the queue, each task's target, permissions, progress and budget,
 * and an independent cancel per task. Waiting for another task's build is shown as such, never as a model failure;
 * internal ids (conversation, execution epoch, protocol) stay in the details.
 */
const SCHED_TEXT: Record<string, string> = {
  waiting_slot: "排队：等待空闲任务槽",
  waiting_target: "排队：同一应用正有其他任务",
  waiting_build: "等待其他任务完成构建",
  waiting_model: "等待模型并发额度",
  dispatching: "正在启动",
  active: "执行中",
  draining: "正在收尾",
  done: "已结束",
};
const ROLE_TEXT: Record<string, string> = { build: "构建", system_plan: "系统计划", maintenance_diagnose: "诊断（后台）", maintenance_refactor: "优化候选（后台）" };

export function schedText(r: RunView): string {
  if (r.status === "cancel_requested") return "正在取消";
  return SCHED_TEXT[r.schedulingState ?? ""] ?? r.status;
}

function Budget(props: { r: RunView }) {
  const b = props.r.budget;
  if (!b) return null;
  const pct = (n: number, d: number) => (d > 0 ? Math.min(100, Math.round((n / d) * 100)) : 0);
  return (
    <div className="budget small" aria-label="本任务预算">
      <span title="模型请求">请求 {b.modelRequests}/{b.maxModelRequests}</span>
      <meter min={0} max={100} value={pct(b.modelRequests, b.maxModelRequests)} />
      <span title="输出 token（预留或已结算）">输出 {b.outputTokensReservedOrUsed}/{b.maxOutputTokens * b.maxModelRequests}</span>
      {b.usageUnknownAttempts > 0 && <span className="warn-text"> · {b.usageUnknownAttempts} 次用量未知（按上限记账）</span>}
    </div>
  );
}

function TaskRow(props: { r: RunView; apps: AppSummary[]; onCancelled: () => void }) {
  const { r } = props;
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const target = r.targetAppId ? (props.apps.find((a) => a.appId === r.targetAppId)?.title ?? "（新应用）") : "无目标应用";
  const cancellable = ["queued", "running", "blocked"].includes(r.status);
  const cancel = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.cancelRun(r.runId, newKey());
      props.onCancelled();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={`task ${r.background ? "bg" : "fg"}`} data-run-id={r.runId} data-sched={r.schedulingState ?? ""}>
      <div className="task-head">
        <strong>{r.intent.slice(0, 80) || "（无描述）"}</strong>
        <span className="muted small">
          {ROLE_TEXT[r.runMode ?? "build"] ?? r.runMode} · {target}
        </span>
      </div>
      <div className="task-state">
        <span className={`pill ${r.schedulingState === "active" ? "ok" : r.schedulingState?.startsWith("waiting") ? "info" : ""}`}>{schedText(r)}</span>
        {r.queuePosition != null && <span className="muted small"> 第 {r.queuePosition} 位</span>}
        {r.waitReason && r.schedulingState !== "active" && <span className="muted small"> · {waitText(r.waitReason)}</span>}
        <span className="muted small"> · 工具 {r.progress.toolTasks} · 阶段尝试 {r.progress.stageAttempts}{r.progress.lastTool ? ` · 最近 ${r.progress.lastTool}` : ""}</span>
      </div>
      <Budget r={r} />
      <div className="task-actions">
        {cancellable && (
          <button className="danger small" disabled={busy} onClick={() => void cancel()} aria-label={`取消任务 ${r.intent.slice(0, 20)}`}>
            取消此任务
          </button>
        )}
        <button className="link small" onClick={() => setOpen((v) => !v)}>{open ? "收起详情" : "详情"}</button>
      </div>
      {err && <div className="banner error small">{err}</div>}
      {open && (
        <dl className="task-detail small">
          <dt>权限</dt>
          <dd>{(r.permissions ?? []).join("、") || "—"}</dd>
          <dt>截止</dt>
          <dd>{r.deadlineAt ?? (r.queueDeadlineAt ? `排队截止 ${r.queueDeadlineAt}` : "—")}</dd>
          <dt>诊断</dt>
          <dd className="mono">run {r.runId} · 会话 {r.conversationId ?? "—"} · 执行代次 {r.executionEpoch ?? "—"}</dd>
        </dl>
      )}
    </li>
  );
}

function waitText(reason: string): string {
  if (/build/i.test(reason)) return "等待其他任务完成构建";
  if (/slot/i.test(reason)) return "等待空闲任务槽";
  if (/target|same app|busy/i.test(reason)) return "同一应用正被其他任务修改";
  if (/model/i.test(reason)) return "等待模型额度";
  return reason;
}

export function TaskCenter(props: { runs: RunView[]; slots: number; apps: AppSummary[]; onChanged: () => void }) {
  const fg = props.runs.filter((r) => !r.background);
  const running = fg.filter((r) => r.schedulingState && !["waiting_slot", "waiting_target", "done"].includes(r.schedulingState));
  const queued = fg.filter((r) => r.schedulingState === "waiting_slot" || r.schedulingState === "waiting_target").sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
  const bg = props.runs.filter((r) => r.background);
  const slots = Array.from({ length: props.slots }, (_, i) => running[i] ?? null);
  return (
    <section className="task-center" aria-label="任务中心">
      <h3>任务中心</h3>
      <div className="slots" role="list" aria-label="前台任务槽">
        {slots.map((r, i) => (
          <div key={i} role="listitem" className={`slot ${r ? "busy" : "free"}`} data-slot={i + 1}>
            <div className="muted small">任务槽 {i + 1}</div>
            {r ? <ul className="tasks"><TaskRow r={r} apps={props.apps} onCancelled={props.onChanged} /></ul> : <div className="muted">空闲</div>}
          </div>
        ))}
      </div>
      {running.length > props.slots && <p className="muted small">另有 {running.length - props.slots} 个任务正在收尾</p>}
      <h4>排队中（{queued.length}）</h4>
      {queued.length === 0 ? <p className="muted small">没有排队的任务</p> : <ul className="tasks" aria-label="排队任务">{queued.map((r) => <TaskRow key={r.runId} r={r} apps={props.apps} onCancelled={props.onChanged} />)}</ul>}
      {bg.length > 0 && (
        <>
          <h4>后台分析（{bg.length}）</h4>
          <ul className="tasks" aria-label="后台任务">{bg.map((r) => <TaskRow key={r.runId} r={r} apps={props.apps} onCancelled={props.onChanged} />)}</ul>
        </>
      )}
    </section>
  );
}
