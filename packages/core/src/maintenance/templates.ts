import { V4_LIMITS, canonicalJson, sha256Hex } from "@agentos/contracts";
import type { Store } from "../persistence/store.js";
import type { RunService } from "../runs/run-service.js";
import type { OnlineGc } from "../builds/online-gc.js";
import type { IncidentStore } from "../health/incidents.js";
import type { JobContext, TemplateHandler } from "./jobs.js";

/** Strip anything that looks like a secret and bound the size (spec §12.2, §24.2, V4-U06). */
export function scrub(v: unknown, max = 4000): unknown {
  const text = JSON.stringify(v ?? null)
    .replace(/(authorization|cookie|token|secret|api[_-]?key|password)("?\s*[:=]\s*)"[^"]*"/gi, '$1$2"[redacted]"')
    .replace(/\b(authorization|cookie|token|secret|api[_-]?key|password|passwd)(\s*[:=]\s*)(bearer\s+)?[^\s",;\\]+/gi, "$1$2[redacted]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
  return text.length > max ? { truncated: true, head: text.slice(0, max) } : JSON.parse(text);
}

/**
 * Frozen evidence for a model analysis (spec §12.2, §24.1): fixed-length structured snapshots only — the incident, its
 * recent samples and the runtime's last error summary. Never user records, file contents, serial frames, other runs'
 * transcripts or credentials; at most 64 KiB. Each item has an id the report must cite.
 */
export function buildEvidence(store: Store, incidents: IncidentStore, job: { id: string; target_kind: string; target_id: string; incident_id: string | null }): { evidence: { id: string; kind: string; data: unknown }[]; evidenceIds: string[] } {
  const out: { id: string; kind: string; data: unknown }[] = [];
  const inc = job.incident_id ? incidents.get(job.incident_id) : null;
  if (inc) out.push({ id: `incident:${inc.id}`, kind: "incident", data: scrub({ condition: inc.condition_key, state: inc.state, severity: inc.severity, quality: inc.quality, firstSeenAt: inc.first_seen_at, lastSeenAt: inc.last_seen_at, evidence: inc.evidence_json ? JSON.parse(inc.evidence_json) : null }) });
  const samples = store.all<{ seq: number; condition_key: string; value: string; quality: string; observed_at: string }>(
    "SELECT seq, condition_key, value, quality, observed_at FROM health_samples WHERE target_kind = ? AND target_id = ? ORDER BY seq DESC LIMIT 20", job.target_kind, job.target_id,
  );
  if (samples.length) out.push({ id: `samples:${job.target_kind}:${job.target_id}`, kind: "health_samples", data: samples });
  if (job.target_kind === "app") {
    const ar = store.get<{ health: string; restart_count: number; last_error_json: string | null; generation: number }>("SELECT health, restart_count, last_error_json, generation FROM app_runtime WHERE app_id = ?", job.target_id);
    if (ar) out.push({ id: `runtime:${job.target_id}`, kind: "runtime_state", data: scrub({ health: ar.health, restartCount: ar.restart_count, generation: ar.generation, lastError: ar.last_error_json ? JSON.parse(ar.last_error_json) : null }, 8000) });
    const app = store.get<{ active_revision_id: string | null; epoch: number }>("SELECT active_revision_id, epoch FROM apps WHERE id = ?", job.target_id);
    if (app) out.push({ id: `app:${job.target_id}`, kind: "app_version", data: { activeRevisionId: app.active_revision_id, appEpoch: app.epoch } });
  }
  let evidence = out;
  while (Buffer.byteLength(canonicalJson(evidence)) > V4_LIMITS.diagnosisEvidenceBytes && evidence.length > 1) evidence = evidence.slice(0, -1);
  return { evidence, evidenceIds: evidence.map((e) => e.id) };
}

export function diagnoseHandler(store: Store, runs: RunService, incidents: IncidentStore): TemplateHandler {
  return {
    async observe(ctx: JobContext) {
      const inc = ctx.job.incident_id ? incidents.get(ctx.job.incident_id) : store.get<{ id: string }>("SELECT id FROM health_incidents WHERE target_kind = ? AND target_id = ? AND state IN ('open','investigating','needs_attention') ORDER BY last_seen_at DESC LIMIT 1", ctx.job.target_kind, ctx.job.target_id);
      if (!inc) return { needed: false, reason: "no open incident to diagnose" };
      return { needed: true, reason: "an incident needs a diagnosis", incidentId: (inc as { id: string }).id };
    },
    async analyze(ctx) {
      const job = { ...ctx.job, incident_id: ctx.job.incident_id ?? (store.get<{ incident_id: string | null }>("SELECT incident_id FROM maintenance_jobs WHERE id = ?", ctx.job.id)?.incident_id ?? null) };
      const scope = buildEvidence(store, incidents, job);
      const runId = runs.acceptBackground({
        mode: "maintenance_diagnose", jobId: ctx.job.id, incidentId: job.incident_id, appId: ctx.job.target_kind === "app" ? ctx.job.target_id : null,
        intent: "诊断该 incident：只依据冻结证据给出假设与缺失证据，提交一份结构化报告。", scope: { ...scope, evidenceHash: sha256Hex(canonicalJson(scope.evidence)) },
      });
      return { runId };
    },
    async act() {
      return { certainty: "none", reason: "analysis only", completed: 0 };
    },
  };
}

export function optimizeHandler(store: Store, runs: RunService, incidents: IncidentStore): TemplateHandler {
  return {
    async observe(ctx: JobContext) {
      const app = store.get<{ active_revision_id: string | null }>("SELECT active_revision_id FROM apps WHERE id = ?", ctx.job.target_id);
      if (!app?.active_revision_id) return { needed: false, reason: "the app has no active version" };
      const b = store.get<{ bundle_json: string }>("SELECT bundle_json FROM revisions WHERE app_id = ? AND id = ?", ctx.job.target_id, app.active_revision_id);
      const fv = b ? (JSON.parse(b.bundle_json) as { formatVersion: number }).formatVersion : 0;
      if (fv !== 2 && fv !== 3) return { needed: false, reason: "only code apps have optimisation candidates" };
      const pending = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM proposals WHERE app_id = ? AND state IN ('pending','needs_recheck')", ctx.job.target_id)!.n;
      if (pending >= V4_LIMITS.proposalsPerApp) return { needed: false, reason: "proposals of this app already wait for a decision" };
      return { needed: true, reason: "optimisation requested" };
    },
    async analyze(ctx) {
      const scope = buildEvidence(store, incidents, ctx.job);
      const runId = runs.acceptBackground({
        mode: "maintenance_refactor", jobId: ctx.job.id, incidentId: ctx.job.incident_id, appId: ctx.job.target_id,
        intent: "在不改变数据 schema、公开 query/command/service 契约、system 绑定、能力集合与 runtimeLock 的前提下，减少重复计算或修复已确定的异常；生成一个候选并通过平台检查后提交 proposal。",
        scope,
      });
      return { runId };
    },
    async act() {
      return { certainty: "none", reason: "candidate only; the user decides", completed: 0 };
    },
  };
}

/** `cache-gc` (spec §17): pressure re-read, then one bounded online collection with per-object intents. */
export function cacheGcHandler(gc: OnlineGc, store: Store): TemplateHandler {
  return {
    async observe(ctx) {
      const u = gc.usage();
      const pct = u.budget > 0 ? u.bytes / u.budget : 0;
      const trig = (ctx.bounds.triggerPercent ?? 80) / 100;
      const p = await gc.plan();
      const reclaimable = p.artifacts.length + p.staging.length;
      const ev = { bytes: u.bytes, budget: u.budget, percent: Math.round(pct * 100), reclaimable, protectedBytes: p.protectedBytes, reportedOnly: p.reportedOnly.length };
      if (reclaimable === 0) return { needed: false, reason: "no_reclaimable_space: nothing unreferenced to remove (history is never deleted)", evidence: ev };
      const manual = ctx.job.trigger_key.includes("/manual/");
      if (!manual && pct < trig && !ctx.job.incident_id) return { needed: false, reason: `cache at ${ev.percent}% of its budget; below the trigger`, evidence: ev };
      return { needed: true, reason: `${reclaimable} unreferenced object(s) can be removed`, evidence: ev, targetVersion: String(u.bytes), suggestion: { action: "gc.delete_unreferenced", objects: reclaimable } };
    },
    async act(ctx) {
      const u = gc.usage();
      const target = Math.floor(u.budget * ((ctx.bounds.targetPercent ?? 60) / 100));
      const manual = ctx.job.trigger_key.includes("/manual/");
      let report: Awaited<ReturnType<OnlineGc["collect"]>> | null = null;
      const out = await ctx.step("collect", "gc.delete_unreferenced", "io-worker", { kind: "cache", targetBytes: manual ? 0 : target }, async () => {
        report = await gc.collect({ jobId: ctx.job.id, stepId: "collect", targetBytes: manual ? undefined : target, cancelled: () => ctx.cancelled() });
        return { state: report.objects > 0 ? "succeeded" : report.unknown > 0 ? "unknown" : "no_change", result: report as unknown as Record<string, unknown> };
      }, async () => {
        // restart: the per-object intents were already resumed by OnlineGc.recover(); report only what really happened
        const done = store.get<{ n: number; b: number | null }>("SELECT COUNT(*) AS n, SUM(unlinked_bytes) AS b FROM gc_delete_intents WHERE job_id = ? AND phase = 'recorded'", ctx.job.id)!;
        const unknown = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM gc_delete_intents WHERE job_id = ? AND phase = 'unknown'", ctx.job.id)!.n;
        return { state: unknown > 0 ? "unknown" : done.n > 0 ? "succeeded" : "no_change", result: { objects: done.n, bytesUnlinked: done.b ?? 0, unknown, resumedAfterRestart: true } };
      });
      const r = (out.result ?? {}) as { objects?: number; bytesUnlinked?: number; unknown?: number; noReclaimable?: boolean };
      ctx.evidence({ gc: out.result });
      if (out.state === "unknown" || (r.unknown ?? 0) > 0) return { certainty: "unknown", reason: `${r.objects ?? 0} object(s) removed; ${r.unknown} stopped with an unknown identity or I/O result`, completed: r.objects ?? 0 };
      return { certainty: (r.objects ?? 0) > 0 ? "confirmed" : "none", reason: r.noReclaimable ? "no_reclaimable_space" : `${r.objects ?? 0} object(s), ${r.bytesUnlinked ?? 0} bytes unlinked`, completed: r.objects ?? 0 };
    },
  };
}

/** `log-cleanup` (spec §17.4): closed rotated host logs only. */
export function logCleanupHandler(gc: OnlineGc): TemplateHandler {
  return {
    async observe() {
      return { needed: true, reason: "check closed rotated logs against retention" };
    },
    async act(ctx) {
      const out = await ctx.step("logs", "logs.delete_closed", "io-worker", { retentionDays: ctx.bounds.retentionDays ?? 7, retentionMiB: ctx.bounds.retentionMiB ?? 100 }, async () => {
        const r = await gc.cleanLogs({ retentionMs: (ctx.bounds.retentionDays ?? 7) * 86_400_000, retentionBytes: (ctx.bounds.retentionMiB ?? 100) * 1024 * 1024, jobId: ctx.job.id, stepId: "logs", cancelled: () => ctx.cancelled() });
        return { state: r.removed > 0 ? "succeeded" : r.unknown > 0 ? "unknown" : "no_change", result: r };
      });
      const r = (out.result ?? {}) as { removed?: number; bytes?: number; unknown?: number };
      if ((r.unknown ?? 0) > 0) return { certainty: "unknown", reason: `${r.removed ?? 0} closed log(s) removed; ${r.unknown} unknown`, completed: r.removed ?? 0 };
      return { certainty: (r.removed ?? 0) > 0 ? "confirmed" : "none", reason: `${r.removed ?? 0} closed log file(s), ${r.bytes ?? 0} bytes`, completed: r.removed ?? 0 };
    },
  };
}
