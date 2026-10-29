import { createHash, randomBytes } from "node:crypto";
import {
  AgentOsError,
  MAINTENANCE_FAMILY_ENSURE_RUNNING,
  domainHash,
  sealMaintenancePolicy,
  sealMaintenanceEnvelope,
  type BrokerIdentity,
  type MaintenanceControlBody,
  type MaintenancePolicySyncBody,
  type MaintenanceWriteEnvelope,
} from "@agentos/contracts";
import { BrokerError, type BrokerOperation } from "@agentos/broker-client";
import { iso, type Store } from "../persistence/store.js";
import { fault } from "../faults.js";
import type { SystemCapabilities } from "../system/system-capabilities.js";
import type { PolicyRow, PolicyService, InstallCaps } from "./policy-service.js";
import type { MaintenanceService, TemplateHandler, JobContext, StepRow, StepOutcome } from "./jobs.js";
import type { IncidentStore, Quality } from "../health/incidents.js";
import type { HealthMonitor } from "../health/health-monitor.js";

interface OutboxRow {
  id: string;
  kind: "policy-sync" | "policy-revoke" | "control" | "target-epoch";
  subject: string;
  version: number;
  frozen_request: string;
  request_hash: string;
  dispatch_state: "pending" | "sent" | "confirmed" | "failed";
  attempts: number;
}

const FAMILY = MAINTENANCE_FAMILY_ENSURE_RUNNING;

/**
 * Root-side half of maintenance (v0.4 spec §13.2–§13.4, §16, §21.2): protocol-2 policy sync/revoke, global pause and
 * per-target control epochs through a durable outbox with monotonic versions, and the `service-ensure-running`
 * template whose only effect is one broker maintenance operation (a system action with origin=maintenance). Local
 * state always changes first; the UI shows "pending" until the broker confirmed.
 */
export class ServiceMaintenance {
  #timer: NodeJS.Timeout | null = null;
  #busy = false;
  stopped = false;
  log: (lvl: "info" | "warn" | "error", msg: string, f?: Record<string, unknown>) => void = () => {};

  constructor(
    readonly store: Store,
    readonly sys: SystemCapabilities,
    readonly policies: PolicyService,
    readonly jobs: MaintenanceService,
    readonly incidents: IncidentStore,
  ) {
    policies.installCaps = (kind, id) => this.installCaps(kind, id);
    policies.onRootSync = (p, kind) => this.#enqueuePolicy(p, kind);
    const prevControl = jobs.onControl;
    jobs.onControl = (state, epoch) => {
      prevControl?.(state, epoch);
      this.enqueueControl(state, epoch);
    };
    jobs.register("service-ensure-running", this.handler());
  }

  private now(): string {
    return iso(this.store.clock.now());
  }

  // ------------------------------------------------------------------ install caps (root policy, spec §13.3)

  #brokerCaps: { unitKey: string; actionFamilies: string[]; perHour: number; per24h: number; cooldownSeconds: number }[] | null = null;

  installCaps(kind: string, id: string): InstallCaps {
    if (kind !== "service") return { allowed: false, max: {}, reason: "only services have install caps" };
    const r = this.sys.resources.get(id);
    if (!r || r.kind !== "service") return { allowed: false, max: {}, reason: "service resource not registered" };
    if (r.execution_class !== "broker") return { allowed: false, max: {}, reason: "only broker-managed units can be kept running" };
    const caps = this.#brokerCaps?.find((c) => c.unitKey === r.catalog_key && c.actionFamilies.includes(FAMILY));
    if (!caps) return { allowed: false, max: {}, reason: this.#brokerCaps === null ? "the broker's maintenance caps are not known yet (broker protocol 2 not reachable)" : "this unit is not registered for maintenance recovery in the root install policy" };
    return { allowed: true, max: { perHour: caps.perHour, per24h: caps.per24h }, reason: undefined };
  }

  /** Read the broker's install caps and confirm the global control state (startup step 2). */
  async refreshFromBroker(): Promise<void> {
    await this.sys.broker.ensure();
    if (!this.sys.broker.client.maintenanceCapable) {
      this.#brokerCaps = null;
      return;
    }
    const s = await this.sys.broker.client.maintenanceState(this.sys.broker.requireWritable());
    this.#brokerCaps = s.installCaps;
    const st = this.jobs.state();
    if (s.state === st.state && s.maintenanceEpoch === st.epoch) this.jobs.rootConfirmed(st.epoch);
    else this.enqueueControl(st.state, st.epoch);
  }

  // ------------------------------------------------------------------ durable root sync outbox

  #identity(): BrokerIdentity | null {
    try {
      return this.sys.broker.identity();
    } catch {
      return null;
    }
  }

  #enqueue(kind: OutboxRow["kind"], subject: string, version: number, request: Record<string, unknown>): void {
    const body = JSON.stringify(request);
    const id = `rs_${randomBytes(10).toString("hex")}`;
    this.store.tx(() =>
      this.store.run(
        "INSERT INTO root_sync_outbox (id, kind, subject, version, frozen_request, request_hash, dispatch_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
        id, kind, subject, version, body, domainHash("agentos.root-sync.v1", request), this.now(), this.now(),
      ),
    );
    this.kick();
  }

  #enqueuePolicy(p: PolicyRow, kind: "policy-sync" | "policy-revoke"): void {
    const identity = this.#identity();
    if (!identity) {
      this.store.tx(() => this.store.run("UPDATE maintenance_policies SET root_sync_state = 'unavailable', updated_at = ? WHERE id = ? AND version = ?", this.now(), p.id, p.version));
      return;
    }
    if (kind === "policy-revoke") {
      this.#enqueue("policy-revoke", p.id, p.version, { identity, policyId: p.id, policyVersion: p.version });
      return;
    }
    const r = this.sys.resources.get(p.target_id);
    if (!r) return;
    const b = JSON.parse(p.bounds_json) as Record<string, number>;
    const body: MaintenancePolicySyncBody = sealMaintenancePolicy({
      identity, policyId: p.id, policyVersion: p.version, policyHash: `sha256:${p.policy_hash.replace(/^sha256:/, "")}`, resourceId: r.id, resourceGeneration: r.generation,
      actionFamily: FAMILY, bounds: { perHour: b.perHour ?? 2, per24h: b.per24h ?? 3, cooldownSeconds: b.cooldownSeconds ?? 600 },
      expiresAtMs: Date.parse(p.expires_at), maintenanceEpoch: this.jobs.state().epoch,
    });
    this.#enqueue("policy-sync", p.id, p.version, body as unknown as Record<string, unknown>);
  }

  enqueueControl(state: "running" | "paused", epoch: number): void {
    const identity = this.#identity();
    if (!identity) {
      this.jobs.rootUnavailable();
      return;
    }
    const body: MaintenanceControlBody = { identity, state, maintenanceEpoch: epoch };
    this.#enqueue("control", "workspace", epoch, body as unknown as Record<string, unknown>);
  }

  /**
   * User stop / start of a managed service through AgentOS (spec §16): the target's control epoch rises locally first,
   * its automatic-recovery policies pause, then the broker learns the new epoch; a late maintenance write loses.
   */
  userControl(serviceId: string, intent: "stopped" | "running"): number {
    const epoch = this.store.tx(() => {
      const cur = this.store.get<{ control_epoch: number }>("SELECT control_epoch FROM target_controls WHERE target_kind = 'service' AND target_id = ?", serviceId);
      const next = (cur?.control_epoch ?? 0) + 1;
      this.store.run(
        `INSERT INTO target_controls (target_kind, target_id, control_epoch, user_intent, root_state, updated_at) VALUES ('service', ?, ?, ?, 'pending', ?)
         ON CONFLICT (target_kind, target_id) DO UPDATE SET control_epoch = excluded.control_epoch, user_intent = excluded.user_intent, root_state = 'pending', updated_at = excluded.updated_at`,
        serviceId, next, intent, this.now(),
      );
      if (intent === "stopped") this.policies.pauseTargetInTx("service", serviceId, "user stopped the service");
      this.store.event("maintenance.target_control", { targetKind: "service", targetId: serviceId, controlEpoch: next, intent });
      return next;
    });
    const identity = this.#identity();
    if (identity) {
      const st = this.jobs.state();
      const body: MaintenanceControlBody = { identity, state: st.state, maintenanceEpoch: st.epoch, target: { resourceId: serviceId, controlEpoch: epoch } };
      this.#enqueue("target-epoch", serviceId, epoch, body as unknown as Record<string, unknown>);
    }
    return epoch;
  }

  controlEpoch(serviceId: string): { epoch: number; intent: string; rootState: string } {
    const r = this.store.get<{ control_epoch: number; user_intent: string; root_state: string }>("SELECT * FROM target_controls WHERE target_kind = 'service' AND target_id = ?", serviceId);
    return { epoch: r?.control_epoch ?? 0, intent: r?.user_intent ?? "none", rootState: r?.root_state ?? "none" };
  }

  start(pollMs = 2000): void {
    this.stopped = false;
    this.#timer = setInterval(() => void this.tick(), pollMs);
    this.#timer.unref?.();
    void this.refreshFromBroker().catch((e) => this.log("warn", "maintenance state from broker unavailable", { error: (e as Error).message }));
  }

  stop(): void {
    this.stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  kick(): void {
    if (!this.stopped) setImmediate(() => void this.tick());
  }

  async tick(): Promise<void> {
    if (this.#busy || this.stopped) return;
    this.#busy = true;
    try {
      await this.#deliver();
    } catch (e) {
      this.log("warn", "root sync delivery failed", { error: (e as Error).message });
    } finally {
      this.#busy = false;
    }
  }

  async #deliver(): Promise<void> {
    const rows = this.store.all<OutboxRow>("SELECT * FROM root_sync_outbox WHERE dispatch_state IN ('pending','sent') ORDER BY created_at LIMIT 32");
    if (rows.length === 0) return;
    await this.sys.broker.ensure();
    const client = this.sys.broker.client;
    if (!this.sys.broker.status.brokerReady || this.sys.broker.status.binding !== "bound") {
      this.#markUnavailable(rows);
      return;
    }
    if (!client.maintenanceCapable) {
      this.#markUnavailable(rows);
      return;
    }
    for (const o of rows) {
      if (this.stopped) return;
      const req = JSON.parse(o.frozen_request);
      this.store.tx(() => this.store.run("UPDATE root_sync_outbox SET dispatch_state = 'sent', attempts = attempts + 1, updated_at = ? WHERE id = ?", this.now(), o.id));
      try {
        let result: unknown;
        if (o.kind === "policy-sync") result = await client.maintenancePolicySync(req);
        else if (o.kind === "policy-revoke") result = await client.maintenancePolicyRevoke(req.identity, req.policyId, req.policyVersion);
        else result = await client.maintenanceControl(req);
        fault("maintenance.rootsync.after_broker");
        this.#confirmed(o, result);
      } catch (e) {
        const be = e as BrokerError;
        if (be.code === "BROKER_UNAVAILABLE") return; // retry later, same frozen request
        this.store.tx(() => {
          this.store.run("UPDATE root_sync_outbox SET dispatch_state = 'failed', broker_result = ?, updated_at = ? WHERE id = ?", JSON.stringify({ code: be.code, message: be.message }), this.now(), o.id);
          if (o.kind === "policy-sync") {
            this.store.run("UPDATE maintenance_policies SET state = 'paused', root_sync_state = 'failed', updated_at = ? WHERE id = ? AND version = ? AND state IN ('syncing','enabled')", this.now(), o.subject, o.version);
            this.store.event("maintenance.policy_sync_failed", { policyId: o.subject, version: o.version, code: be.code, message: be.message });
          }
        });
      }
    }
  }

  #markUnavailable(rows: OutboxRow[]): void {
    this.store.tx(() => {
      for (const o of rows) {
        if (o.kind === "control") this.store.run("UPDATE meta SET maintenance_root_state = 'unavailable' WHERE id = 1 AND maintenance_epoch = ? AND maintenance_root_state = 'pending'", o.version);
        if (o.kind === "target-epoch") this.store.run("UPDATE target_controls SET root_state = 'unavailable' WHERE target_kind = 'service' AND target_id = ? AND control_epoch = ? AND root_state = 'pending'", o.subject, o.version);
        if (o.kind === "policy-sync") this.store.run("UPDATE maintenance_policies SET root_sync_state = 'unavailable', updated_at = ? WHERE id = ? AND version = ? AND root_sync_state = 'pending'", this.now(), o.subject, o.version);
      }
    });
  }

  #confirmed(o: OutboxRow, result: unknown): void {
    this.store.tx(() => {
      this.store.run("UPDATE root_sync_outbox SET dispatch_state = 'confirmed', broker_result = ?, updated_at = ? WHERE id = ?", JSON.stringify(result ?? null).slice(0, 4000), this.now(), o.id);
      if (o.kind === "policy-sync") this.policies.rootSynced(o.subject, o.version, o.version);
      if (o.kind === "policy-revoke") this.store.run("UPDATE maintenance_policies SET root_sync_state = 'revoked', updated_at = ? WHERE id = ? AND version <= ? AND root_sync_state IN ('revoking','synced','pending','unavailable')", this.now(), o.subject, o.version);
      if (o.kind === "control") this.jobs.rootConfirmed(o.version);
      if (o.kind === "target-epoch") this.store.run("UPDATE target_controls SET root_state = 'synced' WHERE target_kind = 'service' AND target_id = ? AND control_epoch = ?", o.subject, o.version);
    });
  }

  // ------------------------------------------------------------------ probe (fresh state through the unprivileged reader)

  async probe(serviceId: string, jobId: string | null = null): Promise<{ state: "running" | "stopped" | "unknown"; quality: Quality; generation: number | null; identity: string | null; detail?: Record<string, unknown> }> {
    const r = this.sys.resources.get(serviceId);
    if (!r || r.kind !== "service") return { state: "unknown", quality: "unavailable", generation: null, identity: null, detail: { reason: "not registered" } };
    if (r.status === "gone" || r.status === "suspended") return { state: "unknown", quality: "unavailable", generation: r.generation, identity: r.identity_digest, detail: { reason: `resource ${r.status}` } };
    try {
      const o = await this.sys.reads.read({ kind: "maintenance", jobId }, r, "service.describe", {}, { timeoutMs: 3000 });
      const d = o.data as Record<string, unknown>;
      const active = String(d.activeState ?? "");
      const state = active === "active" ? "running" : active === "inactive" || active === "failed" ? "stopped" : "unknown";
      return { state, quality: o.quality === "fresh" ? "fresh" : "gap", generation: o.resourceGeneration, identity: r.identity_digest, detail: { activeState: active, subState: d.subState, invocationId: d.invocationId, observationId: o.observationId } };
    } catch (e) {
      return { state: "unknown", quality: "unavailable", generation: r.generation, identity: r.identity_digest, detail: { error: (e as Error).message.slice(0, 200) } };
    }
  }

  attachHealth(h: HealthMonitor): void {
    h.serviceProbe = (id) => this.probe(id);
  }

  // ------------------------------------------------------------------ the template (spec §16)

  handler(): TemplateHandler {
    const self = this;
    return {
      async observe(ctx: JobContext) {
        const sid = ctx.job.target_id;
        const pr = await self.probe(sid, ctx.job.id);
        const ctl = self.controlEpoch(sid);
        const ev = { probe: pr, controlEpoch: ctl.epoch, userIntent: ctl.intent };
        if (pr.state === "unknown") return { needed: false, reason: `state unknown (${pr.quality}): observe only, never treated as stopped`, evidence: ev, incidentId: ctx.job.incident_id };
        if (pr.state === "running") {
          if (ctx.job.incident_id) self.incidents.resolve(ctx.job.incident_id, { jobId: ctx.job.id, reason: "fresh observation: running" }, self.store.clock.now());
          return { needed: false, reason: "the unit is running (no_change)", evidence: ev, incidentId: ctx.job.incident_id };
        }
        if (ctl.intent === "stopped") return { needed: false, reason: "the user stopped this unit through AgentOS; recovery is paused", evidence: ev };
        if (ctx.policy) {
          const c = ctx.policy.target_contract ? (JSON.parse(ctx.policy.target_contract) as { generation?: number; identity?: string | null }) : {};
          if (c.generation !== undefined && pr.generation !== c.generation) return { needed: false, reason: `resource generation changed (${c.generation} → ${pr.generation}); the policy needs re-approval`, evidence: ev };
          if (c.identity && pr.identity && c.identity !== pr.identity) return { needed: false, reason: "unit identity changed since approval; the policy needs re-approval", evidence: ev };
        }
        return { needed: true, reason: "three fresh samples and a re-read show the unit stopped", evidence: ev, targetVersion: `${pr.generation}:${ctl.epoch}`, incidentId: ctx.job.incident_id, suggestion: { action: FAMILY, serviceId: sid } };
      },
      admission(ctx) {
        const circ = self.store.get<{ state: string; reason: string | null }>("SELECT state, reason FROM maintenance_circuits WHERE target_kind = 'service' AND target_id = ? AND action_family = ?", ctx.job.target_id, FAMILY);
        if (circ?.state === "open") return { ok: false, circuitOpen: true, reason: circ.reason ?? "circuit open" };
        if (!self.sys.broker.client.maintenanceCapable) return { ok: false, defer: true, reason: "broker protocol 2 unavailable" };
        if (!ctx.policy || ctx.policy.root_sync_state !== "synced") return { ok: false, defer: true, reason: "POLICY_SYNC_PENDING: the broker has not confirmed this policy" };
        const st = self.jobs.state();
        if (st.root !== "synced") return { ok: false, defer: true, reason: "POLICY_SYNC_PENDING: the broker has not confirmed the maintenance control state" };
        return { ok: true };
      },
      async act(ctx) {
        const out = await ctx.step("ensure-running", FAMILY, "broker", { serviceId: ctx.job.target_id, policyVersion: ctx.job.policy_version, targetVersion: ctx.job.target_version }, (effectKey) => self.#dispatch(ctx, effectKey), (s) => self.#reconcile(ctx, s));
        if (out.state === "unknown") return { certainty: "unknown", reason: `broker result unknown: ${JSON.stringify(out.result ?? {}).slice(0, 200)}`, completed: 0 };
        if (out.state === "failed_no_effect") {
          const code = (out.result as { code?: string } | undefined)?.code;
          if (code === "CIRCUIT_OPEN") self.#openCircuit(ctx.job.target_id, `root-side limit: ${(out.result as { message?: string }).message ?? ""}`);
          return { certainty: "none", reason: `not executed: ${JSON.stringify(out.result ?? {}).slice(0, 300)}`, completed: 0 };
        }
        return { certainty: "confirmed", reason: out.state === "no_change" ? "already running at dispatch (no_change)" : "StartUnit job finished; verifying", completed: out.state === "succeeded" ? 1 : 0 };
      },
      async verify(ctx) {
        const step = self.store.get<StepRow & { updated_at: string }>("SELECT * FROM maintenance_steps WHERE job_id = ? AND step_id = 'ensure-running'", ctx.job.id);
        if (!step || step.state !== "succeeded" && step.state !== "no_change") return { healthy: false, reason: "no successful step to verify" };
        const res = step.result_json ? (JSON.parse(step.result_json) as { invocationId?: string }) : {};
        const pr = await self.probe(ctx.job.target_id, ctx.job.id);
        ctx.evidence({ verify: pr });
        const windowMs = (ctx.bounds.observeSeconds ?? 60) * 1000;
        const since = Date.parse(step.updated_at);
        if (pr.state === "stopped") {
          self.#attemptOutcome(ctx.job.id, "failed");
          return { healthy: false, reason: "the unit stopped again inside the observation window (recovery did not hold)" };
        }
        if (pr.state === "unknown") {
          if (self.store.clock.now() - since > windowMs * 3) return { healthy: null, reason: "state stayed unknown after the effect" };
          return { healthy: null, reason: "state unknown", pending: true };
        }
        if (res.invocationId && pr.detail?.invocationId && pr.detail.invocationId !== res.invocationId) {
          self.#attemptOutcome(ctx.job.id, "failed");
          return { healthy: false, reason: "the unit restarted inside the observation window (new InvocationID)" };
        }
        if (self.store.clock.now() - since < windowMs) return { healthy: null, reason: "observation window", pending: true };
        self.#attemptOutcome(ctx.job.id, "succeeded");
        return { healthy: true, reason: `running for the ${windowMs / 1000} s observation window (ActiveState=active, same InvocationID)` };
      },
    };
  }

  #openCircuit(serviceId: string, reason: string): void {
    this.store.tx(() =>
      this.store.run(
        `INSERT INTO maintenance_circuits (target_kind, target_id, action_family, state, consecutive_failures, opened_at, reason, updated_at) VALUES ('service', ?, ?, 'open', 0, ?, ?, ?)
         ON CONFLICT (target_kind, target_id, action_family) DO UPDATE SET state = 'open', opened_at = excluded.opened_at, reason = excluded.reason, updated_at = excluded.updated_at`,
        serviceId, FAMILY, this.now(), reason, this.now(),
      ),
    );
  }

  #attemptOutcome(jobId: string, outcome: "succeeded" | "failed"): void {
    this.store.tx(() => {
      const a = this.store.get<{ id: string; target_id: string; outcome: string }>("SELECT id, target_id, outcome FROM maintenance_attempts WHERE job_id = ? AND action_family = ? ORDER BY admitted_at DESC LIMIT 1", jobId, FAMILY);
      if (!a || a.outcome !== "pending") return;
      this.store.run("UPDATE maintenance_attempts SET outcome = ?, verified_at = ? WHERE id = ?", outcome, this.now(), a.id);
      const c = this.store.get<{ consecutive_failures: number }>("SELECT consecutive_failures FROM maintenance_circuits WHERE target_kind = 'service' AND target_id = ? AND action_family = ?", a.target_id, FAMILY);
      const fails = outcome === "failed" ? (c?.consecutive_failures ?? 0) + 1 : 0;
      const open = fails >= 3;
      this.store.run(
        `INSERT INTO maintenance_circuits (target_kind, target_id, action_family, state, consecutive_failures, opened_at, reason, updated_at) VALUES ('service', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (target_kind, target_id, action_family) DO UPDATE SET state = CASE WHEN excluded.state = 'open' THEN 'open' ELSE maintenance_circuits.state END, consecutive_failures = excluded.consecutive_failures,
           opened_at = COALESCE(excluded.opened_at, maintenance_circuits.opened_at), reason = COALESCE(excluded.reason, maintenance_circuits.reason), updated_at = excluded.updated_at`,
        a.target_id, FAMILY, open ? "open" : "closed", fails, open ? this.now() : null, open ? `${fails} consecutive recoveries did not hold` : null, this.now(),
      );
    });
  }

  /** User decision to close a service circuit (the model never can). */
  resetCircuit(serviceId: string): void {
    this.store.tx(() => this.store.run("UPDATE maintenance_circuits SET state = 'closed', consecutive_failures = 0, reason = 'reset by the user', updated_at = ? WHERE target_kind = 'service' AND target_id = ?", this.now(), serviceId));
  }

  async #dispatch(ctx: JobContext, effectKey: string): Promise<StepOutcome> {
    const j = ctx.job;
    const identity = this.sys.broker.requireWritable();
    const r = this.sys.resources.get(j.target_id);
    if (!r) return { state: "failed_no_effect", result: { reason: "resource gone" } };
    const st = this.jobs.state();
    const ctl = this.controlEpoch(j.target_id);
    const opId = `mop_${createHash("sha256").update(`${identity.storeUuid}/${effectKey}`).digest("hex").slice(0, 40)}`;
    const actionId = `sa_m${createHash("sha256").update(`action/${effectKey}`).digest("hex").slice(0, 32)}`;
    const plan = {
      origin: "maintenance", jobId: j.id, stepId: "ensure-running", policyId: j.policy_id, policyVersion: j.policy_version, capabilityId: "service.ensure_state", contractVersion: 1,
      resourceId: r.id, resourceGeneration: r.generation, params: { state: "running" }, preconditions: {}, triggerKey: j.trigger_key, createdAt: this.now(),
      preview: { title: "维护：保持服务运行", summary: `按已批准策略对 ${r.display_name} 执行 ensure-running`, risk: "仅启动已停止的登记服务" },
    };
    const planHash = domainHash("agentos.system-plan.v1", plan);
    const env: MaintenanceWriteEnvelope = sealMaintenanceEnvelope({
      protocolVersion: 2, machineInstallId: identity.machineInstallId, storeUuid: identity.storeUuid, workspaceIncarnation: identity.workspaceIncarnation,
      operationId: opId, actionId, planHash, capabilityId: "service.ensure_state", contractVersion: 1, resourceId: r.id, resourceGeneration: r.generation,
      preconditions: {}, deadlineMs: Math.min(ctx.deadlineMs, Date.now() + 60_000), params: { state: "running" }, jobId: j.id, stepId: "ensure-running",
      policyId: j.policy_id!, policyVersion: j.policy_version!, maintenanceEpoch: st.epoch, targetControlEpoch: ctl.epoch, triggerKey: j.trigger_key.slice(0, 200),
    });
    // The frozen envelope, the action row and the local attempt are written before anything is sent.
    this.store.tx(() => {
      this.store.run(
        "INSERT INTO maintenance_effect_outbox (job_id, step_id, frozen_envelope, envelope_hash, dispatch_state, created_at, updated_at) VALUES (?, 'ensure-running', ?, ?, 'pending', ?, ?)",
        j.id, JSON.stringify(env), env.requestHash, this.now(), this.now(),
      );
      this.store.run(
        `INSERT INTO system_actions (id, origin, capability_id, plan_hash, plan_json, observation_refs, resource_id, resource_generation, confirmation_policy, state, operation_id,
           expires_at, approved_at, workspace_incarnation, job_id, step_id, policy_id, policy_version, created_at, updated_at)
         VALUES (?, 'maintenance', 'service.ensure_state', ?, ?, '[]', ?, ?, 'per_plan', 'dispatching', ?, ?, ?, ?, ?, 'ensure-running', ?, ?, ?, ?)`,
        actionId, planHash, JSON.stringify(plan), r.id, r.generation, opId, iso(env.deadlineMs), this.now(), identity.workspaceIncarnation, j.id, j.policy_id, j.policy_version, this.now(), this.now(),
      );
      this.store.run("UPDATE maintenance_steps SET action_id = ? WHERE job_id = ? AND step_id = 'ensure-running'", actionId, j.id);
      this.store.run(
        "INSERT INTO maintenance_attempts (id, target_kind, target_id, action_family, job_id, step_id, policy_id, policy_version, admitted_at) VALUES (?, 'service', ?, ?, ?, 'ensure-running', ?, ?, ?)",
        `ma_${randomBytes(10).toString("hex")}`, r.id, FAMILY, j.id, j.policy_id, j.policy_version, this.now(),
      );
    });
    fault("maintenance.service.before_submit");
    return this.#submitAndWait(ctx, env, actionId);
  }

  async #submitAndWait(ctx: JobContext, env: MaintenanceWriteEnvelope, actionId: string): Promise<StepOutcome> {
    const client = this.sys.broker.client;
    let op: BrokerOperation;
    try {
      this.store.tx(() => this.store.run("UPDATE maintenance_effect_outbox SET dispatch_state = 'sent', updated_at = ? WHERE job_id = ? AND step_id = 'ensure-running'", this.now(), ctx.job.id));
      op = await client.maintenanceSubmit(env);
      fault("maintenance.service.after_submit_before_record");
    } catch (e) {
      const be = e as BrokerError;
      if (be.code === "BROKER_UNAVAILABLE") return { state: "unknown", result: { code: be.code, message: be.message, operationId: env.operationId } };
      // Refused before acceptance: provably never executed (no count was reserved).
      this.store.tx(() => {
        this.store.run("UPDATE maintenance_effect_outbox SET dispatch_state = 'final', result_json = ?, updated_at = ? WHERE job_id = ? AND step_id = 'ensure-running'", JSON.stringify({ code: be.code, message: be.message }), this.now(), ctx.job.id);
        this.store.run("UPDATE system_actions SET state = 'failed_no_effect', effect_certainty = 'none', evidence_kind = 'broker_refused', error_json = ?, updated_at = ? WHERE id = ? AND state = 'dispatching'", JSON.stringify({ code: be.code, message: be.message }), this.now(), actionId);
        this.store.run("UPDATE maintenance_attempts SET outcome = 'failed' WHERE job_id = ? AND action_family = ? AND outcome = 'pending'", ctx.job.id, FAMILY);
      });
      return { state: "failed_no_effect", result: { code: be.code, message: be.message, details: be.details } };
    }
    this.store.tx(() => this.store.run("UPDATE maintenance_effect_outbox SET dispatch_state = 'accepted', updated_at = ? WHERE job_id = ? AND step_id = 'ensure-running'", this.now(), ctx.job.id));
    return this.#await(ctx, env, actionId, op);
  }

  async #await(ctx: JobContext, env: MaintenanceWriteEnvelope, actionId: string, first: BrokerOperation): Promise<StepOutcome> {
    const identity = { machineInstallId: env.machineInstallId, storeUuid: env.storeUuid, workspaceIncarnation: env.workspaceIncarnation };
    let op = first;
    const until = Date.now() + 75_000;
    while (["accepted", "running", "reconciling"].includes(op.state)) {
      if (Date.now() > until) return { state: "unknown", result: { reason: "broker still executing", operationId: env.operationId, brokerState: op.state } };
      await new Promise((r) => setTimeout(r, 300));
      try {
        op = await this.sys.broker.client.operationGet(identity, env.operationId);
      } catch (e) {
        return { state: "unknown", result: { reason: (e as Error).message, operationId: env.operationId } };
      }
    }
    this.sys.actions.applyBrokerOp(actionId, op);
    this.store.tx(() => this.store.run("UPDATE maintenance_effect_outbox SET dispatch_state = 'final', result_json = ?, updated_at = ? WHERE job_id = ? AND step_id = 'ensure-running'", JSON.stringify({ state: op.state, completionKind: op.completionKind }), this.now(), ctx.job.id));
    const result = { operationId: op.operationId, actionId, brokerState: op.state, completionKind: op.completionKind, evidenceKind: op.evidenceKind, invocationId: (op.result as { invocationId?: string } | null)?.invocationId ?? null, job: (op.result as { job?: unknown } | null)?.job ?? null, error: op.error };
    if (op.state === "succeeded") return { state: op.completionKind === "already_satisfied" ? "no_change" : "succeeded", result };
    if (op.state === "indeterminate") return { state: "unknown", result };
    return { state: "failed_no_effect", result: { ...result, code: op.error?.code, message: op.error?.message } };
  }

  /** Restart / interruption: find the original operation; never send a new one. */
  async #reconcile(ctx: JobContext, s: StepRow): Promise<StepOutcome> {
    const o = this.store.get<{ frozen_envelope: string; dispatch_state: string }>("SELECT frozen_envelope, dispatch_state FROM maintenance_effect_outbox WHERE job_id = ? AND step_id = ?", ctx.job.id, s.step_id);
    if (!o) return { state: "failed_no_effect", result: { reason: "interrupted before the envelope was frozen: nothing was sent" } };
    const env = JSON.parse(o.frozen_envelope) as MaintenanceWriteEnvelope;
    const actionId = env.actionId;
    if (o.dispatch_state === "final" && s.result_json) return { state: s.state as StepOutcome["state"], result: JSON.parse(s.result_json) };
    await this.sys.broker.ensure();
    const identity = { machineInstallId: env.machineInstallId, storeUuid: env.storeUuid, workspaceIncarnation: env.workspaceIncarnation };
    try {
      const op = await this.sys.broker.client.operationGet(identity, env.operationId);
      return this.#await(ctx, env, actionId, op);
    } catch (e) {
      const be = e as BrokerError;
      if (be.code === "NOT_FOUND") {
        if (o.dispatch_state === "pending") {
          // never sent: the same frozen envelope (same operationId) may be delivered now; the broker dedups.
          return this.#submitAndWait(ctx, env, actionId);
        }
        // sent but unknown to this incarnation: re-deliver the same envelope; a refusal is a proof of no effect.
        return this.#submitAndWait(ctx, env, actionId);
      }
      if (be.code === "WORKSPACE_FENCED") {
        this.store.tx(() => this.store.run("UPDATE maintenance_effect_outbox SET dispatch_state = 'fenced', updated_at = ? WHERE job_id = ? AND step_id = ?", this.now(), ctx.job.id, s.step_id));
        return { state: "unknown", result: { reason: "workspace fenced (restore); the broker history keeps the fact" } };
      }
      return { state: "unknown", result: { reason: be.message } };
    }
  }

  view(): Record<string, unknown> {
    const out = this.store.all("SELECT kind, subject, version, dispatch_state AS state, attempts, broker_result AS result, updated_at AS updatedAt FROM root_sync_outbox ORDER BY created_at DESC LIMIT 20");
    return { protocol2: this.sys.broker.client.maintenanceCapable, installCaps: this.#brokerCaps, outbox: out, targets: this.store.all("SELECT * FROM target_controls") };
  }
}

export function requirePolicyTarget(policies: PolicyService, id: string): PolicyRow {
  const p = policies.get(id);
  if (!p) throw new AgentOsError("NOT_FOUND", "policy not found");
  return p;
}
