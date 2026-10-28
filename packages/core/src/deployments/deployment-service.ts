import { randomUUID } from "node:crypto";
import {
  AgentOsError,
  CODE_LIMITS,
  canonicalJson,
  checkMutationPlan,
  rpcValueIssue,
  utf8Bytes,
  type AnyBundle,
  type CodeBundle,
  type HandlerContext,
  LIMITS, isCodeBundle } from "@agentos/contracts";
import { iso } from "../persistence/store.js";
import { fault } from "../faults.js";
import type { RuntimeContext } from "../runtime/context.js";
import type { AppRuntimeService, InstanceRow } from "../runtime/app-runtime.js";
import type { LiveInstance } from "../runtime/instances.js";
import { RUNTIME_POLICY } from "../runtime/policy.js";
import { BuildError } from "../builds/build-service.js";
import { checkPlan } from "../records/mutations.js";
import { previewRecords, sampleInput } from "./preview.js";

export type DeploymentStatus = "queued" | "preparing" | "ready" | "committed" | "failed" | "cancelled" | "superseded";
export type DeploymentStage = "validate" | "dependencies" | "build" | "start" | "health" | "activate" | "cleanup";

export interface DeploymentRow {
  id: string;
  app_id: string;
  target_revision_id: string;
  base_revision_id: string | null;
  expected_app_epoch: number;
  origin: "agent_prepare" | "user_history";
  owner_run_id: string | null;
  request_key: string;
  request_hash: string;
  status: DeploymentStatus;
  stage: DeploymentStage | null;
  no_op: number;
  build_job_id: string | null;
  artifact_id: string | null;
  candidate_instance_id: string | null;
  last_probe_at: string | null;
  deadline_at: string;
  committed_epoch: number | null;
  committed_at: string | null;
  cleanup_state: "pending" | "complete" | "retrying";
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeploymentDto {
  deploymentId: string;
  appId: string;
  targetRevisionId: string;
  baseRevisionId: string | null;
  origin: DeploymentRow["origin"];
  status: DeploymentStatus;
  stage: DeploymentStage | null;
  noOp: boolean;
  runtime: "declarative-v1" | "isolated-code-v1" | "isolated-code-v2";
  artifactId: string | null;
  deadlineAt: string;
  committedEpoch: number | null;
  committedAt: string | null;
  cleanupState: DeploymentRow["cleanup_state"];
  error: { stage?: string; code: string; message: string; diagnostics?: unknown[] } | null;
  health: string | null;
}

export interface PrepareRequest {
  appId: string;
  revisionId: string;
  expectedAppEpoch: number;
  origin: DeploymentRow["origin"];
  ownerRunId: string | null;
  requestKey: string;
  requestHash: string;
  deadlineMs?: number;
}

const OPEN = ["queued", "preparing", "ready"];

/**
 * Prepare / Activate / Reconcile (spec §14). The database commit is the publication fact; instance health is
 * reported separately. Preparation never changes the active pointer, the data contract or real records.
 */
export class DeploymentService {
  #driving = new Map<string, Promise<void>>();
  #draining = new Set<string>();
  /** Called after a user_history deployment becomes ready so it activates without another browser request. */
  autoActivate: ((d: DeploymentRow) => Promise<void>) | null = null;

  constructor(private readonly ctx: RuntimeContext, private readonly runtime: AppRuntimeService) {}

  private now(): string {
    return iso(this.ctx.store.clock.now());
  }

  get(id: string): DeploymentRow | undefined {
    return this.ctx.store.get<DeploymentRow>("SELECT * FROM deployments WHERE id = ?", id);
  }

  require(id: string): DeploymentRow {
    const d = this.get(id);
    if (!d) throw new AgentOsError("NOT_FOUND", "deployment not found", { deploymentId: id });
    return d;
  }

  dto(d: DeploymentRow): DeploymentDto {
    const b = this.ctx.apps.revisionBundle(d.app_id, d.target_revision_id) as AnyBundle | null;
    const health = this.runtime.row(d.app_id)?.health ?? null;
    return {
      deploymentId: d.id,
      appId: d.app_id,
      targetRevisionId: d.target_revision_id,
      baseRevisionId: d.base_revision_id,
      origin: d.origin,
      status: d.status,
      stage: d.stage,
      noOp: d.no_op === 1,
      runtime: b?.manifest.runtime ?? "declarative-v1",
      artifactId: d.artifact_id,
      deadlineAt: d.deadline_at,
      committedEpoch: d.committed_epoch,
      committedAt: d.committed_at,
      cleanupState: d.cleanup_state,
      error: d.error_json ? (JSON.parse(d.error_json) as DeploymentDto["error"]) : null,
      health: b && isCodeBundle(b) ? health : null,
    };
  }

  /**
   * Inside the caller's write transaction (after identity and receipt checks): register a deployment or return the
   * one this request key already created. Mutual exclusion per app and per workspace (spec §13).
   */
  prepareInTx(req: PrepareRequest): DeploymentRow {
    const s = this.ctx.store;
    const prior = s.get<DeploymentRow>("SELECT * FROM deployments WHERE origin = ? AND request_key = ?", req.origin, req.requestKey);
    if (prior) {
      if (prior.request_hash !== req.requestHash) throw new AgentOsError("REQUEST_CONFLICT", "this request key was used for a different deployment");
      return prior;
    }
    const app = this.ctx.apps.requireApp(req.appId);
    if (app.epoch !== req.expectedAppEpoch) throw new AgentOsError("APP_EPOCH_STALE", "the app changed since this request was prepared", { appEpoch: app.epoch });
    const rev = this.ctx.apps.getRevisionRow(req.appId, req.revisionId);
    if (!rev) throw new AgentOsError("NOT_FOUND", "revision not found", { revisionId: req.revisionId });
    if (req.origin === "user_history") {
      if (rev.first_activated_at === null) throw new AgentOsError("NOT_FOUND", "only previously activated revisions can be switched to", { revisionId: req.revisionId });
      const run = s.get("SELECT 1 FROM runs WHERE status IN ('queued','running','cancel_requested','blocked')");
      if (run) throw new AgentOsError("DEPLOYMENT_BUSY", "a generation run is active; wait for it or cancel it first");
    }
    const open = s.get<DeploymentRow>(`SELECT * FROM deployments WHERE status IN (${OPEN.map(() => "?").join(",")})`, ...OPEN);
    if (open) {
      if (req.origin === "agent_prepare" && open.owner_run_id === req.ownerRunId && open.origin === "agent_prepare") {
        // A run replacing its own candidate: the earlier one loses eligibility first (spec §13).
        this.#terminateInTx(open, "superseded", { code: "PREPARE_FAILED", message: "replaced by a newer candidate of the same run" });
      } else {
        throw new AgentOsError("DEPLOYMENT_BUSY", "another version change is being prepared", { deploymentId: open.id });
      }
    }
    if (req.origin === "agent_prepare" && req.ownerRunId) {
      const n = s.get<{ n: number }>("SELECT COUNT(*) AS n FROM deployments WHERE owner_run_id = ? AND origin = 'agent_prepare'", req.ownerRunId)!.n;
      if (n >= LIMITS.maxCandidatesPerRun) throw new AgentOsError("LIMIT_EXCEEDED", `a run may prepare at most ${LIMITS.maxCandidatesPerRun} candidates`);
    }
    const bundle = JSON.parse(rev.bundle_json) as AnyBundle;
    const noOp = app.active_revision_id === req.revisionId;
    if (isCodeBundle(bundle) && !noOp) {
      const ar = this.runtime.row(req.appId);
      const enabledHere = ar?.enabled === 1 && this.runtime.activeCodeBundle(req.appId) !== null;
      if (!enabledHere && this.runtime.enabledCodeApps() >= RUNTIME_POLICY.maxEnabledCodeApps) {
        throw new AgentOsError("APP_RESOURCE_LIMIT", `at most ${RUNTIME_POLICY.maxEnabledCodeApps} code apps can run at once; stop one first`);
      }
      if (!this.runtime.engineReachable || !this.ctx.driver) throw new AgentOsError("SANDBOX_UNAVAILABLE", "the code runtime is not available on this host");
    }
    const id = randomUUID();
    const now = this.now();
    const deadline = Math.min(req.deadlineMs ?? Number.POSITIVE_INFINITY, s.clock.now() + RUNTIME_POLICY.prepareTimeoutMs);
    s.run(
      `INSERT INTO deployments (id, app_id, target_revision_id, base_revision_id, expected_app_epoch, origin, owner_run_id, request_key, request_hash, status, stage, no_op,
        build_job_id, artifact_id, candidate_instance_id, last_probe_at, deadline_at, committed_epoch, committed_at, cleanup_state, error_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, NULL, NULL, NULL, NULL, ?, NULL, NULL, 'pending', NULL, ?, ?)`,
      id, req.appId, req.revisionId, app.active_revision_id, req.expectedAppEpoch, req.origin, req.ownerRunId, req.requestKey, req.requestHash, noOp ? 1 : 0, iso(deadline), now, now,
    );
    s.event("deployment.queued", { deploymentId: id, revisionId: req.revisionId, origin: req.origin, noOp }, { appId: req.appId, runId: req.ownerRunId });
    return this.require(id);
  }

  /** Inside a tx: end a not-yet-committed deployment and withdraw its candidate's eligibility. */
  #terminateInTx(d: DeploymentRow, status: "failed" | "cancelled" | "superseded", error: { stage?: string; code: string; message: string; diagnostics?: unknown[] } | null): void {
    const s = this.ctx.store;
    s.run(
      `UPDATE deployments SET status = ?, error_json = COALESCE(?, error_json), updated_at = ? WHERE id = ? AND status IN (${OPEN.map(() => "?").join(",")})`,
      status, error ? JSON.stringify(error) : null, this.now(), d.id, ...OPEN,
    );
    if (d.candidate_instance_id) {
      s.run("UPDATE runtime_instances SET desired_state = 'removed', observed_state = CASE WHEN observed_state IN ('failed','stopped','absent') THEN observed_state ELSE 'draining' END, updated_at = ? WHERE id = ? AND role = 'preview'", this.now(), d.candidate_instance_id);
    }
    s.event(`deployment.${status}`, { deploymentId: d.id, code: error?.code ?? null }, { appId: d.app_id, runId: d.owner_run_id });
  }

  #fail(id: string, stage: DeploymentStage, code: string, message: string, diagnostics?: unknown[]): void {
    const s = this.ctx.store;
    s.tx(() => {
      const d = this.get(id);
      if (!d || !OPEN.includes(d.status)) return;
      this.#terminateInTx(d, "failed", { stage, code, message: message.slice(0, 800), ...(diagnostics ? { diagnostics: diagnostics.slice(0, 20) } : {}) });
    });
    void this.#cleanupCandidate(id);
  }

  async #cleanupCandidate(id: string): Promise<void> {
    const d = this.get(id);
    if (!d?.candidate_instance_id) return;
    const live = this.ctx.instances?.get(d.candidate_instance_id);
    if (live) await this.ctx.instances!.destroy(live, `deployment ${d.status}`);
    this.ctx.store.tx(() => this.ctx.store.run("UPDATE runtime_instances SET observed_state = 'stopped', updated_at = ? WHERE id = ? AND role = 'preview'", this.now(), d.candidate_instance_id));
  }

  /** Start (or join) background preparation. */
  drive(id: string): Promise<void> {
    const cur = this.#driving.get(id);
    if (cur) return cur;
    const p = this.#drive(id)
      .catch((e) => this.ctx.log("error", "deployment driver crashed", { deploymentId: id, error: (e as Error).message }))
      .finally(() => this.#driving.delete(id));
    this.#driving.set(id, p);
    return p;
  }

  /** Re-read the row and stop when it is no longer ours to work on (cancelled, expired, superseded). */
  #check(id: string, stage: DeploymentStage): DeploymentRow | null {
    const s = this.ctx.store;
    return s.tx(() => {
      const d = this.get(id);
      if (!d || !(d.status === "queued" || d.status === "preparing")) return null;
      if (Date.parse(d.deadline_at) <= s.clock.now()) {
        this.#terminateInTx(d, "failed", { stage, code: "PREPARE_EXPIRED", message: "preparation passed its deadline" });
        return null;
      }
      if (d.owner_run_id) {
        const run = s.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", d.owner_run_id);
        if (!run || !["queued", "running"].includes(run.status)) {
          this.#terminateInTx(d, "cancelled", { stage, code: "CANCELLED", message: "the run that asked for this preparation ended" });
          return null;
        }
      }
      s.run("UPDATE deployments SET status = 'preparing', stage = ?, updated_at = ? WHERE id = ?", stage, this.now(), id);
      return this.get(id)!;
    });
  }

  async #drive(id: string): Promise<void> {
    const s = this.ctx.store;
    let d = this.#check(id, "validate");
    if (!d) return void (await this.#cleanupCandidate(id));
    // 1. structure, semantics, compatibility against the current contract (no state change).
    let bundle: AnyBundle;
    try {
      const v = s.read(() => this.ctx.apps.validate(d!.app_id, d!.target_revision_id));
      if (!v.valid) return this.#fail(id, "validate", v.issues.some((i) => i.code === "SCHEMA_INCOMPATIBLE") ? "SCHEMA_INCOMPATIBLE" : "PREPARE_FAILED", "the revision is not valid for this app", v.issues);
      bundle = this.ctx.apps.revisionBundle(d.app_id, d.target_revision_id)!;
    } catch (e) {
      return this.#fail(id, "validate", (e as AgentOsError).code ?? "PREPARE_FAILED", (e as Error).message);
    }
    if (bundle.formatVersion === 1 || d.no_op === 1) {
      s.tx(() => s.run("UPDATE deployments SET status = 'ready', stage = NULL, updated_at = ? WHERE id = ? AND status = 'preparing'", this.now(), id));
      return this.#afterReady(id);
    }
    const code = bundle as CodeBundle;
    // 2. dependencies: the lock must be approved for this platform.
    d = this.#check(id, "dependencies");
    if (!d) return;
    try {
      this.ctx.catalog.requireLock(code.runtimeLockId);
    } catch (e) {
      return this.#fail(id, "dependencies", "DEPENDENCY_NOT_ALLOWED", (e as Error).message);
    }
    // 3. build or verified cache.
    d = this.#check(id, "build");
    if (!d) return;
    let artifactId: string;
    try {
      const r = await this.ctx.builds.ensureArtifact(d.app_id, d.target_revision_id, Date.parse(d.deadline_at), (_stage, buildJobId) => {
        if (buildJobId) s.tx(() => s.run("UPDATE deployments SET build_job_id = ?, updated_at = ? WHERE id = ?", buildJobId, this.now(), id));
      });
      artifactId = r.artifactId;
    } catch (e) {
      const be = e as BuildError | AgentOsError;
      return this.#fail(id, "build", (be as { code: string }).code ?? "BUILD_FAILED", be.message, (be as BuildError).diagnostics);
    }
    s.tx(() => s.run("UPDATE deployments SET artifact_id = ?, updated_at = ? WHERE id = ?", artifactId, this.now(), id));
    // 4. candidate container with preview identity.
    d = this.#check(id, "start");
    if (!d) return;
    const instanceId = randomUUID();
    const containerName = `agentos-p-${instanceId.slice(0, 12)}`;
    const admitted = s.tx(() => {
      if (this.runtime.containerCount() >= RUNTIME_POLICY.maxContainers) return false;
      s.run(
        "INSERT INTO runtime_instances (id, app_id, revision_id, artifact_id, deployment_id, role, generation, host_boot_id, container_name, container_id, desired_state, observed_state, lease_digest, last_probe_at, exit_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'preview', 0, ?, ?, NULL, 'running', 'starting', '', NULL, NULL, ?, ?)",
        instanceId, d!.app_id, d!.target_revision_id, artifactId, id, this.ctx.bootId, containerName, this.now(), this.now(),
      );
      s.run("UPDATE deployments SET candidate_instance_id = ?, updated_at = ? WHERE id = ?", instanceId, this.now(), id);
      return true;
    });
    if (!admitted) return this.#fail(id, "start", "APP_RESOURCE_LIMIT", "the container quota is full; stop a code app or wait for cleanup");
    fault("deploy.after_candidate_registered");
    let live: LiveInstance;
    try {
      live = await this.ctx.instances!.launch({
        id: instanceId, appId: d.app_id, revisionId: d.target_revision_id, artifactId, generation: 0, bootId: this.ctx.bootId,
        containerName, role: "preview", bundle: code, lock: this.ctx.catalog.requireLock(code.runtimeLockId), storeUUID: this.ctx.storeUUID,
      });
    } catch (e) {
      s.tx(() => s.run("UPDATE runtime_instances SET desired_state = 'removed', observed_state = 'failed', exit_reason = ?, updated_at = ? WHERE id = ?", (e as Error).message.slice(0, 300), this.now(), instanceId));
      const ae = e as AgentOsError;
      return this.#fail(id, "start", ae.code === "ABI_MISMATCH" || ae.code === "UNKNOWN_HANDLER" ? ae.code : "PREPARE_FAILED", ae.message, ae.details ? [ae.details] : undefined);
    }
    s.tx(() => s.run("UPDATE runtime_instances SET observed_state = 'ready', lease_digest = ?, last_probe_at = ?, updated_at = ? WHERE id = ?", live.leaseDigest, this.now(), this.now(), instanceId));
    // 5. health checks on platform fixtures only.
    d = this.#check(id, "health");
    if (!d) return void (await this.#cleanupCandidate(id));
    const problem = await this.#healthChecks(live, d, code);
    if (problem) return this.#fail(id, "health", problem.code, problem.message, problem.diagnostics);
    const ready = s.tx(() => {
      const cur = this.get(id);
      if (!cur || cur.status !== "preparing") return false;
      s.run("UPDATE deployments SET status = 'ready', stage = NULL, last_probe_at = ?, updated_at = ? WHERE id = ?", this.now(), this.now(), id);
      s.event("deployment.ready", { deploymentId: id }, { appId: cur.app_id, runId: cur.owner_run_id });
      return true;
    });
    if (!ready) return void (await this.#cleanupCandidate(id));
    fault("deploy.after_ready");
    await this.#afterReady(id);
  }

  async #afterReady(id: string): Promise<void> {
    const d = this.get(id);
    if (d?.status === "ready" && d.origin === "user_history" && this.autoActivate) await this.autoActivate(d);
  }

  /** Candidate checks (spec §14.1): handshake done by launch; main query with empty and default collections; command samples. */
  async #healthChecks(live: LiveInstance, d: DeploymentRow, bundle: CodeBundle): Promise<{ code: string; message: string; diagnostics?: unknown[] } | null> {
    const contract = this.ctx.apps.contractOf(this.ctx.apps.requireApp(d.app_id));
    // A candidate adds fields; its preview uses its own declared fields over the grown contract.
    const merged = { fields: { ...contract.fields } };
    for (const [k, f] of Object.entries(bundle.data.fields)) if (!merged.fields[k]) merged.fields[k] = { ...(f as object) } as never;
    const sets = [[], previewRecords(bundle, merged as never, 2)];
    const host = this.ctx.instances!;
    const context = (records: unknown[]): HandlerContext => ({
      callId: `preview-${randomUUID()}`, appId: d.app_id, revisionId: d.target_revision_id, appEpoch: d.expected_app_epoch, dataEpoch: 0,
      logicalTime: this.now(), deadline: iso(this.ctx.store.clock.now() + RUNTIME_POLICY.queryTimeoutMs), records: records as never,
    });
    const diag = () => live.logs.slice(-5).map((l) => l.text);
    for (const records of sets) {
      for (const [ds, src] of Object.entries(bundle.view.dataSources)) {
        const q = bundle.queries[src.queryId]!;
        const input = src.input ?? {};
        const inIssue = rpcValueIssue(q.inputSchema, input);
        if (inIssue) return { code: "PREPARE_FAILED", message: `data source "${ds}" input does not match query ${src.queryId}: ${inIssue.message}`, diagnostics: [inIssue] };
        let out: unknown;
        try {
          out = await host.call(live, "query", src.queryId, input, context(records), RUNTIME_POLICY.queryTimeoutMs);
        } catch (e) {
          return { code: (e as AgentOsError).code === "APP_TIMEOUT" ? "APP_TIMEOUT" : "PREPARE_FAILED", message: `query ${src.queryId} failed on ${records.length} preview records: ${(e as Error).message}`, diagnostics: diag() };
        }
        if (utf8Bytes(canonicalJson(out ?? null)) > CODE_LIMITS.maxQueryOutputBytes) return { code: "PREPARE_FAILED", message: `query ${src.queryId} output exceeds ${CODE_LIMITS.maxQueryOutputBytes} bytes` };
        const outIssue = rpcValueIssue(q.outputSchema, out);
        if (outIssue) return { code: "PREPARE_FAILED", message: `query ${src.queryId} output does not match its outputSchema at ${outIssue.path}: ${outIssue.message}`, diagnostics: [outIssue] };
      }
    }
    // Command samples on the default collection, simulated in memory (never committed).
    const records = sets[1] as ReturnType<typeof previewRecords>;
    for (const [cid, cmd] of Object.entries(bundle.commands)) {
      const input = sampleInput(cmd.inputSchema, records.map((r) => r.id));
      if (rpcValueIssue(cmd.inputSchema, input)) continue; // no generic sample for this schema
      let out: unknown;
      try {
        out = await host.call(live, "command", cid, input, context(records), RUNTIME_POLICY.commandTimeoutMs);
      } catch (e) {
        const code = (e as AgentOsError).code;
        if (code === "APP_TIMEOUT" || code === "INSTANCE_STALE" || code === "APP_RESOURCE_LIMIT") return { code: "PREPARE_FAILED", message: `command ${cid} sample failed: ${(e as Error).message}`, diagnostics: diag() };
        continue; // the handler rejected a generic sample: not a contract violation
      }
      const plan = checkMutationPlan(out);
      if (!plan.ok) return { code: "INVALID_MUTATION", message: `command ${cid} returned an invalid plan at ${plan.issue.path}: ${plan.issue.message}`, diagnostics: [plan.issue] };
      const rIssue = rpcValueIssue(cmd.outputSchema, plan.plan.result);
      if (rIssue) return { code: "PREPARE_FAILED", message: `command ${cid} result does not match its outputSchema at ${rIssue.path}: ${rIssue.message}`, diagnostics: [rIssue] };
      try {
        const byId = new Map(records.map((r) => [r.id, { version: r.recordVersion, data: r.data as Record<string, unknown> }]));
        checkPlan({ bundle, command: cmd, contract: merged as never, mutations: plan.plan.mutations }, (rid) => byId.get(rid), records.length);
      } catch (e) {
        return { code: (e as AgentOsError).code ?? "INVALID_MUTATION", message: `command ${cid} sample plan rejected: ${(e as Error).message}`, diagnostics: [(e as AgentOsError).details ?? {}] };
      }
    }
    return null;
  }

  /** Wait (bounded) until the deployment leaves queued/preparing; status reads have no side effects. */
  async waitSettled(id: string, timeoutMs: number): Promise<DeploymentRow> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const d = this.require(id);
      if (!(d.status === "queued" || d.status === "preparing") || Date.now() >= until) return d;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** Fresh liveness check right before activation (spec §14.2: outside the transaction). */
  async freshProbe(d: DeploymentRow): Promise<void> {
    if (d.no_op === 1 || !d.candidate_instance_id) return;
    const live = this.ctx.instances?.get(d.candidate_instance_id);
    if (!live || !(await this.ctx.instances!.probe(live))) return;
    this.ctx.store.tx(() => this.ctx.store.run("UPDATE deployments SET last_probe_at = ? WHERE id = ?", this.now(), d.id));
  }

  /**
   * Activation body (spec §14.2), inside the caller's write transaction after identity, receipt and (for agents)
   * run-fence checks. Throws to roll everything back.
   */
  /**
   * Persist the expiry of a ready deployment in its OWN transaction. Inside activateInTx the failed state would be
   * rolled back together with the thrown PREPARE_EXPIRED (savepoint), leaving the slot "ready" and busy.
   */
  expireIfDue(id: string): boolean {
    const s = this.ctx.store;
    return s.tx(() => {
      const d = this.get(id);
      if (!d || d.status !== "ready" || Date.parse(d.deadline_at) > s.clock.now()) return false;
      this.#terminateInTx(d, "failed", { stage: "activate", code: "PREPARE_EXPIRED", message: "the prepared candidate expired" });
      return true;
    });
  }

  activateInTx(id: string, opts: { runId: string | null }): { appId: string; revisionId: string; appEpoch: number; changed: boolean; deploymentId: string; noOp: boolean } {
    const s = this.ctx.store;
    const d = this.require(id);
    if (d.status === "committed") throw new AgentOsError("ALREADY_APPLIED", "this deployment was already published", { deploymentId: id, appEpoch: d.committed_epoch });
    if (d.status !== "ready") {
      const err = d.error_json ? (JSON.parse(d.error_json) as { code?: string; message?: string }) : null;
      throw new AgentOsError(d.status === "failed" || d.status === "cancelled" || d.status === "superseded" ? "PREPARE_FAILED" : "INSTANCE_NOT_READY", `deployment is ${d.status}${err?.message ? `: ${err.message}` : ""}`, { deploymentId: id, status: d.status, error: err });
    }
    if (opts.runId !== null && (d.origin !== "agent_prepare" || d.owner_run_id !== opts.runId)) throw new AgentOsError("FORBIDDEN", "this deployment belongs to another principal");
    if (Date.parse(d.deadline_at) <= s.clock.now()) {
      this.#terminateInTx(d, "failed", { stage: "activate", code: "PREPARE_EXPIRED", message: "the prepared candidate expired" });
      throw new AgentOsError("PREPARE_EXPIRED", "the prepared candidate expired; prepare again");
    }
    const app = this.ctx.apps.requireApp(d.app_id);
    if (app.epoch !== d.expected_app_epoch) throw new AgentOsError("APP_EPOCH_STALE", "the app changed since this deployment was prepared", { appEpoch: app.epoch });
    const bundle = this.ctx.apps.revisionBundle(d.app_id, d.target_revision_id)!;
    let candidate: InstanceRow | undefined;
    if (isCodeBundle(bundle) && d.no_op === 0) {
      candidate = d.candidate_instance_id ? s.get<InstanceRow>("SELECT * FROM runtime_instances WHERE id = ?", d.candidate_instance_id) : undefined;
      const live = candidate ? this.ctx.instances?.get(candidate.id) : undefined;
      const link = s.get<{ artifact_id: string }>("SELECT artifact_id FROM revision_artifacts WHERE app_id = ? AND revision_id = ?", d.app_id, d.target_revision_id);
      const fresh = d.last_probe_at !== null && s.clock.now() - Date.parse(d.last_probe_at) <= RUNTIME_POLICY.activateProbeMaxAgeMs;
      if (
        !candidate || !live || live.dead || live.revoked || candidate.host_boot_id !== this.ctx.bootId || candidate.revision_id !== d.target_revision_id ||
        candidate.artifact_id !== d.artifact_id || !link || link.artifact_id !== d.artifact_id || candidate.lease_digest !== live.leaseDigest || !fresh
      ) {
        throw new AgentOsError("INSTANCE_NOT_READY", "the prepared candidate is not alive and verified; prepare again", { deploymentId: id });
      }
      this.ctx.catalog.requireLock((bundle as CodeBundle).runtimeLockId);
    }
    // Data activation: compatibility, record limits, default backfill, pointer and epoch (v0.1 semantics).
    const r = this.ctx.apps.activateInTx(d.app_id, d.target_revision_id, d.expected_app_epoch, { historicalOnly: d.origin === "user_history", runId: opts.runId });
    if (r.changed) {
      const ar = this.runtime.ensureRow(d.app_id, false);
      if (ar.active_instance_id) {
        s.run("UPDATE runtime_instances SET desired_state = 'removed', observed_state = 'draining', exit_reason = 'replaced by a new version', updated_at = ? WHERE id = ?", this.now(), ar.active_instance_id);
      }
      if (isCodeBundle(bundle)) {
        const generation = ar.generation + 1;
        s.run("UPDATE runtime_instances SET role = 'active', generation = ?, observed_state = 'serving', updated_at = ? WHERE id = ?", generation, this.now(), candidate!.id);
        s.run(
          "UPDATE app_runtime SET enabled = 1, active_instance_id = ?, generation = ?, health = 'ready', control_epoch = control_epoch + 1, restart_count = 0, restart_window_started_at = NULL, next_restart_at = NULL, last_error_json = NULL, updated_at = ? WHERE app_id = ?",
          candidate!.id, generation, this.now(), d.app_id,
        );
        const live = this.ctx.instances!.get(candidate!.id)!;
        live.generation = generation;
        // The lease is re-bound to the new generation (the live handle and the row must agree).
        s.run("UPDATE runtime_instances SET lease_digest = ? WHERE id = ?", live.leaseDigest, candidate!.id);
      } else {
        s.run("UPDATE app_runtime SET enabled = 0, active_instance_id = NULL, health = 'stopped', control_epoch = control_epoch + 1, next_restart_at = NULL, updated_at = ? WHERE app_id = ?", this.now(), d.app_id);
      }
    }
    s.run("UPDATE deployments SET status = 'committed', stage = 'cleanup', committed_epoch = ?, committed_at = ?, updated_at = ? WHERE id = ?", r.appEpoch, this.now(), this.now(), id);
    s.event("deployment.committed", { deploymentId: id, revisionId: d.target_revision_id, appEpoch: r.appEpoch, changed: r.changed }, { appId: d.app_id, runId: opts.runId });
    fault("deploy.activate_before_commit");
    return { ...r, deploymentId: id, noOp: !r.changed };
  }

  /** After the activation commit: drain and remove the replaced instance, then mark cleanup complete (spec §14.3). */
  async afterCommit(id: string): Promise<void> {
    if (this.#draining.has(id)) return;
    this.#draining.add(id);
    try {
      const s = this.ctx.store;
      const d = this.get(id);
      if (!d || d.status !== "committed") return;
      const draining = s.all<InstanceRow>("SELECT * FROM runtime_instances WHERE app_id = ? AND observed_state = 'draining'", d.app_id);
      for (const row of draining) {
        const live = this.ctx.instances?.get(row.id);
        if (live) {
          const until = Date.now() + RUNTIME_POLICY.drainMs;
          while (live.busy && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
          await this.ctx.instances!.destroy(live, "drained after publication");
        } else if (this.ctx.driver) {
          await this.ctx.driver.remove(row.container_name).catch(() => undefined);
        }
        s.tx(() => s.run("UPDATE runtime_instances SET observed_state = 'stopped', updated_at = ? WHERE id = ?", this.now(), row.id));
      }
      s.tx(() => s.run("UPDATE deployments SET cleanup_state = 'complete', stage = NULL, updated_at = ? WHERE id = ?", this.now(), id));
    } catch (e) {
      this.ctx.store.tx(() => this.ctx.store.run("UPDATE deployments SET cleanup_state = 'retrying', updated_at = ? WHERE id = ?", this.now(), id));
      this.ctx.log("warn", "deployment cleanup failed; the reconciler retries", { deploymentId: id, error: (e as Error).message });
    } finally {
      this.#draining.delete(id);
    }
  }

  /** Inside a tx: cancel every open deployment of a run (cancel first wins over activation: spec §15). */
  cancelForRunInTx(runId: string): string[] {
    const s = this.ctx.store;
    const open = s.all<DeploymentRow>(`SELECT * FROM deployments WHERE owner_run_id = ? AND status IN (${OPEN.map(() => "?").join(",")})`, runId, ...OPEN);
    for (const d of open) this.#terminateInTx(d, "cancelled", { code: "CANCELLED", message: "the run was cancelled" });
    return open.map((d) => d.id);
  }

  cleanupCancelled(ids: string[]): void {
    for (const id of ids) void this.#cleanupCandidate(id);
  }

  /** Startup (spec §15): candidates of an earlier boot are gone; open deployments prepare again within their deadline. */
  recoverAfterBoot(): string[] {
    const s = this.ctx.store;
    const ids = s.tx(() => {
      const open = s.all<DeploymentRow>(`SELECT * FROM deployments WHERE status IN (${OPEN.map(() => "?").join(",")})`, ...OPEN);
      for (const d of open) {
        s.run("UPDATE deployments SET status = 'queued', stage = NULL, candidate_instance_id = NULL, last_probe_at = NULL, updated_at = ? WHERE id = ?", this.now(), d.id);
      }
      return open.map((d) => d.id);
    });
    for (const id of ids) void this.drive(id);
    // Committed deployments whose cleanup did not finish.
    for (const d of s.all<{ id: string }>("SELECT id FROM deployments WHERE status = 'committed' AND cleanup_state <> 'complete'")) void this.afterCommit(d.id);
    return ids;
  }

  /** Reconciler hook: retry cleanups. */
  async retryCleanups(): Promise<void> {
    for (const d of this.ctx.store.all<{ id: string }>("SELECT id FROM deployments WHERE status = 'committed' AND cleanup_state <> 'complete'")) await this.afterCommit(d.id);
  }
}
