import { randomUUID } from "node:crypto";
import {
  AgentOsError,
  V4_LIMITS,
  canonicalJson,
  isCodeBundle,
  sha256Hex,
  type AnyBundle,
  type CodeBundle,
  type ValidationIssue,
} from "@agentos/contracts";
import { iso, type Store } from "../persistence/store.js";
import type { AppService } from "../apps/app-service.js";
import type { RunService } from "../runs/run-service.js";
import { fault } from "../faults.js";

/** A structured diagnosis report (spec §19.1): hypotheses, never a repair or an authorization. */
export interface ReportBody {
  incidentId: string | null;
  summary: string;
  evidenceRefs: string[];
  hypotheses: { text: string; confidence: "low" | "medium" | "high" }[];
  recommendedTemplate: string | null;
  missingEvidence: string[];
}

export interface ProposalBody {
  appId: string;
  baseRevisionId: string;
  baseAppEpoch: number;
  candidateRevisionId: string;
  candidateCheckId: string;
  runtimeLockId: string;
  reasons: string;
  expectedBenefit: string;
  knownLimits: string;
  diff: { files: { path: string; change: "added" | "removed" | "modified"; beforeBytes: number; afterBytes: number }[]; viewChanged: boolean };
  check: Record<string, unknown>;
}

export interface ProposalRow {
  id: string;
  app_id: string;
  run_id: string;
  job_id: string | null;
  base_revision_id: string;
  base_app_epoch: number;
  candidate_revision_id: string;
  candidate_check_id: string | null;
  body_json: string;
  proposal_hash: string;
  state: "pending" | "accepted" | "publishing" | "published" | "rejected" | "stale" | "expired" | "needs_recheck";
  decided_at: string | null;
  deployment_id: string | null;
  applied_revision_id: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

const str = (v: unknown, max: number, name: string): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw new AgentOsError("INVALID_REQUEST", `${name} must be a non-empty string of at most ${max} characters`);
  return v;
};

/**
 * The capability boundary of a background candidate (spec §19.1, V4-E01): data schema, public query/command/service
 * contracts, imports, system bindings/actions, the capability set and the runtimeLock stay exactly the same; only the
 * code (and the presentation of the view) may change. Returns the violations.
 */
export function candidateBoundary(base: AnyBundle, cand: AnyBundle): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const issue = (path: string, message: string) => out.push({ path, code: "SCHEMA_INCOMPATIBLE", message } as ValidationIssue);
  if (!isCodeBundle(base) || !isCodeBundle(cand)) {
    issue("/formatVersion", "background optimisation only applies to code apps (formatVersion 2/3)");
    return out;
  }
  const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
  if (base.formatVersion !== cand.formatVersion) issue("/formatVersion", "the format version must stay the same");
  if (base.manifest.appId !== cand.manifest.appId) issue("/manifest/appId", "the app id must stay the same");
  if (!same([...base.manifest.capabilities].sort(), [...cand.manifest.capabilities].sort())) issue("/manifest/capabilities", "the capability set must stay the same");
  if (base.runtimeLockId !== cand.runtimeLockId) issue("/runtimeLockId", "the runtimeLock must stay the same (dependency changes are a new user request)");
  if (!same(base.data, cand.data)) issue("/data", "the data schema must stay the same (new fields are a new user request)");
  const decls = (b: CodeBundle) => ({
    queries: Object.fromEntries(Object.entries(b.queries).map(([k, q]) => [k, { inputSchema: q.inputSchema, outputSchema: q.outputSchema, ...(("system" in q) ? { system: (q as { system?: unknown }).system } : {}) }])),
    commands: Object.fromEntries(Object.entries(b.commands).map(([k, c]) => [k, c])),
  });
  const bd = decls(base);
  const cd = decls(cand);
  if (!same(Object.keys(bd.queries).sort(), Object.keys(cd.queries).sort()) || !same(bd.queries, cd.queries)) issue("/queries", "public query contracts must stay the same");
  if (!same(bd.commands, cd.commands)) issue("/commands", "public command contracts must stay the same");
  if (!same(base.exports, cand.exports)) issue("/exports", "service exports must stay the same");
  if (!same(base.imports, cand.imports)) issue("/imports", "service imports must stay the same");
  if (base.formatVersion === 3 && cand.formatVersion === 3 && !same(base.system, cand.system)) issue("/system", "system bindings and actions must stay the same");
  return out;
}

function fileDiff(base: CodeBundle, cand: CodeBundle): ProposalBody["diff"] {
  const files: ProposalBody["diff"]["files"] = [];
  const names = new Set([...Object.keys(base.code.files), ...Object.keys(cand.code.files)]);
  for (const n of [...names].sort()) {
    const a = base.code.files[n];
    const b = cand.code.files[n];
    if (a === b) continue;
    files.push({ path: n, change: a === undefined ? "added" : b === undefined ? "removed" : "modified", beforeBytes: a ? Buffer.byteLength(a) : 0, afterBytes: b ? Buffer.byteLength(b) : 0 });
  }
  return { files, viewChanged: canonicalJson(base.view) !== canonicalJson(cand.view) };
}

/**
 * Diagnosis reports and optimisation proposals (spec §19). A background run can only submit an immutable report or a
 * proposal bound to one app, its base revision and epoch, and a passed platform check. Accepting is the user's: it
 * creates a formal `proposal_accept` deployment that goes through Prepare and the normal activation transaction; a
 * stale base, a changed catalog, a revoked authorization or an expiry never publishes and never reuses the old consent.
 */
export class ProposalService {
  /** host runtime: is this runtimeLock still in the approved catalog? */
  lockApproved: ((lockId: string) => boolean) | null = null;
  /** host runtime: create + drive the formal deployment for an accepted proposal (in the caller's tx; returns its id) */
  startDeploymentInTx: ((p: ProposalRow, requestKey: string, requestHash: string) => string) | null = null;
  /** release the candidate pin */
  releasePin: ((ownerKind: string, ownerId: string) => void) | null = null;

  constructor(
    private readonly store: Store,
    private readonly apps: AppService,
    private readonly runs: RunService,
  ) {}

  private now(): string {
    return iso(this.store.clock.now());
  }

  // ------------------------------------------------------------------ reports

  submitReportInTx(runId: string, raw: unknown): { reportId: string } {
    const run = this.runs.requireRun(runId);
    if (run.mode !== "maintenance_diagnose") throw new AgentOsError("FORBIDDEN", "only a diagnosis run submits reports");
    if (run.report_id) throw new AgentOsError("LIMIT_EXCEEDED", "this run already submitted its report");
    const r = (raw ?? {}) as Record<string, unknown>;
    const allowed = new Set(["summary", "evidenceRefs", "hypotheses", "recommendedTemplate", "missingEvidence"]);
    for (const k of Object.keys(r)) if (!allowed.has(k)) throw new AgentOsError("INVALID_REQUEST", `unknown report field ${k}`);
    const frozen = this.runs.frozen(run);
    const body: ReportBody = {
      incidentId: frozen.maintenance?.incidentId ?? null,
      summary: str(r.summary, 2000, "summary"),
      evidenceRefs: Array.isArray(r.evidenceRefs) ? r.evidenceRefs.slice(0, 32).map((x, i) => str(x, 200, `evidenceRefs[${i}]`)) : [],
      hypotheses: Array.isArray(r.hypotheses)
        ? r.hypotheses.slice(0, 8).map((h, i) => {
            const o = (h ?? {}) as Record<string, unknown>;
            const c = String(o.confidence ?? "low");
            if (!["low", "medium", "high"].includes(c)) throw new AgentOsError("INVALID_REQUEST", `hypotheses[${i}].confidence must be low, medium or high`);
            return { text: str(o.text, 1000, `hypotheses[${i}].text`), confidence: c as "low" };
          })
        : [],
      recommendedTemplate: typeof r.recommendedTemplate === "string" ? str(r.recommendedTemplate, 64, "recommendedTemplate") : null,
      missingEvidence: Array.isArray(r.missingEvidence) ? r.missingEvidence.slice(0, 16).map((x, i) => str(x, 300, `missingEvidence[${i}]`)) : [],
    };
    if (body.hypotheses.length === 0) throw new AgentOsError("INVALID_REQUEST", "a report needs at least one hypothesis");
    // evidence references must be the job's own frozen evidence ids (never another task's content)
    const scope = (frozen.maintenance?.scope ?? {}) as { evidenceIds?: string[] };
    const known = new Set(scope.evidenceIds ?? []);
    for (const ref of body.evidenceRefs) if (!known.has(ref)) throw new AgentOsError("INVALID_REQUEST", `evidence ${ref} is not part of this job's frozen evidence`);
    const json = canonicalJson(body);
    const id = randomUUID();
    this.store.run("INSERT INTO maintenance_reports (id, run_id, incident_id, job_id, body_json, body_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, runId, body.incidentId, frozen.maintenance?.jobId ?? null, json, sha256Hex(json), this.now());
    this.store.run("UPDATE runs SET report_id = ? WHERE id = ?", id, runId);
    this.store.event("maintenance.report", { reportId: id, runId, jobId: frozen.maintenance?.jobId ?? null }, { runId });
    return { reportId: id };
  }

  reports(limit = 50) {
    return this.store.all<{ id: string; run_id: string; incident_id: string | null; job_id: string | null; body_json: string; body_hash: string; created_at: string }>("SELECT * FROM maintenance_reports ORDER BY created_at DESC LIMIT ?", limit).map((r) => ({
      reportId: r.id, runId: r.run_id, incidentId: r.incident_id, jobId: r.job_id, body: JSON.parse(r.body_json), bodyHash: r.body_hash, createdAt: r.created_at, kind: "diagnosis (hypothesis, not a repair)",
    }));
  }

  // ------------------------------------------------------------------ candidates

  /** Stage a candidate for the run's bound app; the boundary is enforced before anything is stored. */
  stageCandidateInTx(runId: string, bundle: unknown): { revisionId: string; valid: boolean; errors: ValidationIssue[] } {
    const run = this.runs.requireRun(runId);
    if (run.mode !== "maintenance_refactor" || !run.target_app_id) throw new AgentOsError("FORBIDDEN", "only an optimisation run stages candidates");
    const app = this.apps.requireApp(run.target_app_id);
    const frozen = this.runs.frozen(run);
    if (app.epoch !== run.expected_app_epoch || app.active_revision_id !== frozen.activeRevisionAtAccept) {
      throw new AgentOsError("PROPOSAL_STALE", "the app changed since this optimisation started; the candidate would be stale", { appEpoch: app.epoch });
    }
    const base = app.active_revision_id ? this.apps.revisionBundle(app.id, app.active_revision_id) : null;
    if (!base) throw new AgentOsError("FORBIDDEN", "the app has no active version to optimise");
    if (bundle && typeof bundle === "object") {
      const issues = candidateBoundary(base, bundle as AnyBundle);
      if (issues.length > 0) return { revisionId: "", valid: false, errors: issues };
    }
    const r = this.apps.stage(app.id, bundle, runId);
    return { revisionId: r.revisionId, valid: r.issues.length === 0, errors: r.issues };
  }

  /** Submit the proposal: a passed check of the same run and revision, the boundary again, workspace/app caps. */
  submitProposalInTx(runId: string, raw: unknown): { proposalId: string; proposalHash: string } {
    const run = this.runs.requireRun(runId);
    if (run.mode !== "maintenance_refactor" || !run.target_app_id) throw new AgentOsError("FORBIDDEN", "only an optimisation run submits proposals");
    if (run.proposal_id) throw new AgentOsError("LIMIT_EXCEEDED", "this run already submitted its proposal");
    const r = (raw ?? {}) as Record<string, unknown>;
    const revisionId = str(r.revisionId, 80, "revisionId");
    const checkId = str(r.checkId, 80, "checkId");
    const check = this.store.get<{ id: string; run_id: string; revision_id: string; state: string; result_json: string | null; baseline_hash: string | null; candidate_hash: string | null; fixture_set_version: string; runtime_lock_id: string | null }>("SELECT * FROM candidate_checks WHERE id = ?", checkId);
    if (!check || check.run_id !== runId || check.revision_id !== revisionId) throw new AgentOsError("INVALID_REQUEST", "the check does not belong to this run and revision");
    if (check.state !== "passed") throw new AgentOsError("INVALID_REQUEST", `the platform check is ${check.state}; only a passed check can be proposed`);
    const app = this.apps.requireApp(run.target_app_id);
    const frozen = this.runs.frozen(run);
    if (app.epoch !== run.expected_app_epoch || app.active_revision_id !== frozen.activeRevisionAtAccept) throw new AgentOsError("PROPOSAL_STALE", "the app changed during the optimisation");
    const base = this.apps.revisionBundle(app.id, app.active_revision_id!)!;
    const cand = this.apps.revisionBundle(app.id, revisionId);
    if (!cand) throw new AgentOsError("NOT_FOUND", "candidate revision not found");
    const issues = candidateBoundary(base, cand);
    if (issues.length > 0) throw new AgentOsError("SCHEMA_INCOMPATIBLE", "the candidate leaves the optimisation boundary", { issues });
    const pendingApp = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM proposals WHERE app_id = ? AND state IN ('pending','needs_recheck')", app.id)!.n;
    const pendingAll = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM proposals WHERE state IN ('pending','needs_recheck')")!.n;
    if (pendingApp >= V4_LIMITS.proposalsPerApp) throw new AgentOsError("LIMIT_EXCEEDED", `at most ${V4_LIMITS.proposalsPerApp} proposals per app can wait`);
    if (pendingAll >= V4_LIMITS.proposalsPerWorkspace) throw new AgentOsError("LIMIT_EXCEEDED", `at most ${V4_LIMITS.proposalsPerWorkspace} proposals can wait`);
    const body: ProposalBody = {
      appId: app.id, baseRevisionId: app.active_revision_id!, baseAppEpoch: app.epoch, candidateRevisionId: revisionId, candidateCheckId: checkId,
      runtimeLockId: (cand as CodeBundle).runtimeLockId,
      reasons: str(r.reasons, 2000, "reasons"), expectedBenefit: str(r.expectedBenefit, 1000, "expectedBenefit"), knownLimits: typeof r.knownLimits === "string" ? r.knownLimits.slice(0, 1000) : "",
      diff: fileDiff(base as CodeBundle, cand as CodeBundle),
      check: { checkId, fixtureSetVersion: check.fixture_set_version, baselineHash: check.baseline_hash, candidateHash: check.candidate_hash, result: check.result_json ? JSON.parse(check.result_json) : null },
    };
    const json = canonicalJson(body);
    const hash = `sha256:${sha256Hex(json)}`;
    const id = randomUUID();
    this.store.run(
      `INSERT INTO proposals (id, app_id, run_id, job_id, base_revision_id, base_app_epoch, candidate_revision_id, candidate_check_id, body_json, proposal_hash, state, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      id, app.id, runId, frozen.maintenance?.jobId ?? null, body.baseRevisionId, body.baseAppEpoch, revisionId, checkId, json, hash, iso(this.store.clock.now() + V4_LIMITS.proposalRetentionMs), this.now(), this.now(),
    );
    this.store.run("UPDATE runs SET proposal_id = ? WHERE id = ?", id, runId);
    this.store.event("proposal.submitted", { proposalId: id, appId: app.id, runId }, { appId: app.id, runId });
    return { proposalId: id, proposalHash: hash };
  }

  get(id: string): ProposalRow | undefined {
    return this.store.get<ProposalRow>("SELECT * FROM proposals WHERE id = ?", id);
  }

  /** Stale/expiry sweep: a changed base or an expired proposal is never published; its pin is released. */
  refresh(): void {
    this.store.tx(() => {
      for (const p of this.store.all<ProposalRow>("SELECT * FROM proposals WHERE state IN ('pending','needs_recheck')")) {
        const app = this.apps.getAppRow(p.app_id);
        if (Date.parse(p.expires_at) <= this.store.clock.now()) {
          this.store.run("UPDATE proposals SET state = 'expired', updated_at = ? WHERE id = ?", this.now(), p.id);
          this.releasePin?.("proposal", p.id);
        } else if (!app || app.epoch !== p.base_app_epoch || app.active_revision_id !== p.base_revision_id) {
          this.store.run("UPDATE proposals SET state = 'stale', updated_at = ? WHERE id = ?", this.now(), p.id);
          this.releasePin?.("proposal", p.id);
        }
      }
    });
  }

  view(p: ProposalRow) {
    const body = JSON.parse(p.body_json) as ProposalBody;
    const cand = this.apps.revisionBundle(p.app_id, p.candidate_revision_id) as CodeBundle | null;
    const base = this.apps.revisionBundle(p.app_id, p.base_revision_id) as CodeBundle | null;
    const files: Record<string, { before: string | null; after: string | null }> = {};
    if (cand && base) for (const f of body.diff.files) files[f.path] = { before: base.code.files[f.path]?.slice(0, 20_000) ?? null, after: cand.code.files[f.path]?.slice(0, 20_000) ?? null };
    return {
      proposalId: p.id, appId: p.app_id, runId: p.run_id, jobId: p.job_id, state: p.state, proposalHash: p.proposal_hash,
      baseRevisionId: p.base_revision_id, baseAppEpoch: p.base_app_epoch, candidateRevisionId: p.candidate_revision_id,
      reasons: body.reasons, expectedBenefit: body.expectedBenefit, knownLimits: body.knownLimits, diff: body.diff, sources: files, check: body.check,
      expiresAt: p.expires_at, decidedAt: p.decided_at, deploymentId: p.deployment_id, appliedRevisionId: p.applied_revision_id, createdAt: p.created_at,
      label: p.state === "published" ? "已发布" : p.state === "pending" ? "候选已验证，等待你决定" : p.state,
    };
  }

  list(): ReturnType<ProposalService["view"]>[] {
    this.refresh();
    return this.store.all<ProposalRow>("SELECT * FROM proposals ORDER BY created_at DESC LIMIT 100").map((p) => this.view(p));
  }

  /**
   * User acceptance (spec §19.3): the exact proposalHash and expectedAppEpoch. Creates a formal proposal_accept
   * deployment (Prepare again, then the usual activation CAS, system-action fences and provider-grant revocation).
   */
  acceptInTx(id: string, proposalHash: string, expectedAppEpoch: number, requestKey: string, requestHash: string): ProposalRow {
    const p = this.get(id);
    if (!p) throw new AgentOsError("NOT_FOUND", "proposal not found");
    if (p.proposal_hash !== proposalHash) throw new AgentOsError("PROPOSAL_STALE", "the proposal hash does not match; reload it", { proposalHash: p.proposal_hash });
    if (p.state === "publishing" || p.state === "published" || p.state === "accepted") return p; // the same decision (replay)
    if (p.state !== "pending") throw new AgentOsError("PROPOSAL_STALE", `the proposal is ${p.state}`);
    if (Date.parse(p.expires_at) <= this.store.clock.now()) {
      throw new AgentOsError("PROPOSAL_STALE", "the proposal expired", { mark: "expired" });
    }
    const app = this.apps.requireApp(p.app_id);
    if (app.epoch !== expectedAppEpoch || app.epoch !== p.base_app_epoch || app.active_revision_id !== p.base_revision_id) {
      throw new AgentOsError("PROPOSAL_STALE", "the app changed since this candidate was made; it was not published", { appEpoch: app.epoch, mark: "stale" });
    }
    const body = JSON.parse(p.body_json) as ProposalBody;
    if (this.lockApproved && !this.lockApproved(body.runtimeLockId)) {
      throw new AgentOsError("PROPOSAL_STALE", "the runtime catalog changed; the candidate needs a new check", { mark: "needs_recheck" });
    }
    if (!this.startDeploymentInTx) throw new AgentOsError("SANDBOX_UNAVAILABLE", "the code runtime is not available to publish the candidate");
    const depId = this.startDeploymentInTx(p, requestKey, requestHash);
    this.store.run("UPDATE proposals SET state = 'publishing', decided_at = ?, deployment_id = ?, updated_at = ? WHERE id = ?", this.now(), depId, this.now(), id);
    this.store.event("proposal.accepted", { proposalId: id, deploymentId: depId }, { appId: p.app_id });
    return this.get(id)!;
  }

  /**
   * A refused decision still records what it found (stale / expired / needs_recheck). The decision's own transaction
   * rolls back with its error, so the caller applies the mark afterwards in a transaction of its own.
   */
  applyRefusalMark(id: string, err: unknown): void {
    const mark = (err as { details?: { mark?: string } })?.details?.mark;
    if (mark !== "stale" && mark !== "expired" && mark !== "needs_recheck") return;
    this.store.tx(() => {
      const n = this.store.run("UPDATE proposals SET state = ?, updated_at = ? WHERE id = ? AND state = 'pending'", mark, this.now(), id);
      if (n.changes > 0 && mark !== "needs_recheck") this.releasePin?.("proposal", id);
      if (n.changes > 0) this.store.event(`proposal.${mark}`, { proposalId: id });
    });
  }

  rejectInTx(id: string): ProposalRow {
    const p = this.get(id);
    if (!p) throw new AgentOsError("NOT_FOUND", "proposal not found");
    if (p.state === "rejected") return p;
    if (!["pending", "needs_recheck", "stale", "expired"].includes(p.state)) throw new AgentOsError("PROPOSAL_STALE", `the proposal is ${p.state}`);
    this.store.run("UPDATE proposals SET state = 'rejected', decided_at = ?, updated_at = ? WHERE id = ?", this.now(), this.now(), id);
    this.releasePin?.("proposal", id);
    this.store.event("proposal.rejected", { proposalId: id }, { appId: p.app_id });
    return this.get(id)!;
  }

  /** Inside the activation transaction: the publication fact and the proposal's applied revision commit together. */
  onDeploymentCommittedInTx(deploymentId: string, appliedRevisionId: string): void {
    const p = this.store.get<ProposalRow>("SELECT * FROM proposals WHERE deployment_id = ?", deploymentId);
    if (!p) return;
    this.store.run("UPDATE proposals SET state = 'published', applied_revision_id = ?, updated_at = ? WHERE id = ? AND applied_revision_id IS NULL", appliedRevisionId, this.now(), p.id);
    fault("proposal.after_publish_projection");
  }

  /** A failed/cancelled formal deployment never publishes; the proposal needs a recheck (a new user decision). */
  onDeploymentEndedInTx(deploymentId: string): void {
    this.store.run("UPDATE proposals SET state = 'needs_recheck', updated_at = ? WHERE deployment_id = ? AND state = 'publishing'", this.now(), deploymentId);
  }

  /** Startup: a publishing proposal whose deployment committed while the projection was lost is completed (no 2nd activation). */
  recover(): void {
    this.store.tx(() => {
      for (const p of this.store.all<ProposalRow>("SELECT * FROM proposals WHERE state = 'publishing' AND deployment_id IS NOT NULL")) {
        const d = this.store.get<{ status: string; target_revision_id: string }>("SELECT status, target_revision_id FROM deployments WHERE id = ?", p.deployment_id);
        if (d?.status === "committed") this.onDeploymentCommittedInTx(p.deployment_id!, d.target_revision_id);
        else if (d && ["failed", "cancelled", "superseded"].includes(d.status)) this.onDeploymentEndedInTx(p.deployment_id!);
      }
    });
  }
}
