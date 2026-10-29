import { randomUUID } from "node:crypto";
import {
  AgentOsError,
  MAINTENANCE_TEMPLATES,
  V4_LIMITS,
  canonicalJson,
  sha256Hex,
  type MaintenanceMode,
  type MaintenanceTemplateId,
  type PolicyCreateBody,
  type PolicyState,
} from "@agentos/contracts";
import { iso, type Store } from "../persistence/store.js";

export interface PolicyRow {
  id: string;
  version: number;
  template_id: MaintenanceTemplateId;
  template_version: number;
  target_kind: "app" | "service" | "workspace" | "conversation";
  target_id: string;
  target_contract: string | null;
  trigger_json: string;
  condition_json: string;
  bounds_json: string;
  mode: MaintenanceMode;
  allowed_actions: string;
  policy_hash: string;
  approved_by: string | null;
  approved_at: string | null;
  approved_hash: string | null;
  maintenance_epoch: number;
  expires_at: string;
  state: PolicyState;
  root_sync_state: string;
  root_version: number | null;
  created_at: string;
  updated_at: string;
}

export interface PolicyView {
  policyId: string;
  version: number;
  templateId: string;
  templateVersion: number;
  target: { kind: string; id: string; contract: unknown };
  trigger: { kind: string; intervalSeconds?: number };
  bounds: Record<string, number>;
  mode: MaintenanceMode;
  allowedActions: string[];
  automaticActions: string[];
  policyHash: string;
  state: PolicyState;
  /** what the user approves: real target, capabilities, frequency, daily budget, expiry (spec §13.1, V4-U02) */
  approval: { approvedAt: string | null; approvedHash: string | null; expiresAt: string };
  rootSync: { state: string; version: number | null; local: string; root: string };
  risk: string;
  usesModel: boolean;
  createdAt: string;
}

/** Install-time caps for a target (root side): user policies may only narrow them (spec §13.3, V4-P06). */
export interface InstallCaps {
  allowed: boolean;
  /** bound name → max value */
  max: Record<string, number>;
  reason?: string;
}

/**
 * User-approved maintenance policies (spec §11.1, §13.1). A policy binds a fixed platform template and version to one
 * concrete target, a trigger, bounds, a mode, an expiry and the exact user approval. Its body is immutable; any change
 * that matters for permissions creates a new version that must be approved again; nothing renews automatically; the
 * model never creates, approves or widens a policy (only the trusted user API calls this service).
 */
export class PolicyService {
  /** set by the system layer: install caps of a service target (broker install policy). */
  installCaps: ((kind: string, id: string) => InstallCaps) | null = null;
  /** set by the maintenance root sync: queue a policy sync/revoke towards the broker (protocol 2). */
  onRootSync: ((p: PolicyRow, kind: "policy-sync" | "policy-revoke") => void) | null = null;
  /** set by the lifecycle layer: does an app target exist and is it eligible? */
  targetCheck: ((kind: string, id: string) => { ok: boolean; contract?: unknown; reason?: string }) | null = null;

  constructor(private readonly store: Store) {}

  private now(): string {
    return iso(this.store.clock.now());
  }

  get(id: string, version?: number): PolicyRow | undefined {
    return version === undefined
      ? this.store.get<PolicyRow>("SELECT * FROM maintenance_policies WHERE id = ? ORDER BY version DESC LIMIT 1", id)
      : this.store.get<PolicyRow>("SELECT * FROM maintenance_policies WHERE id = ? AND version = ?", id, version);
  }

  require(id: string, version?: number): PolicyRow {
    const p = this.get(id, version);
    if (!p) throw new AgentOsError("NOT_FOUND", "policy not found", { policyId: id });
    return p;
  }

  /** The currently enabled version of a policy (or none). */
  live(id: string): PolicyRow | undefined {
    return this.store.get<PolicyRow>("SELECT * FROM maintenance_policies WHERE id = ? AND state = 'enabled'", id);
  }

  enabled(): PolicyRow[] {
    return this.store.all<PolicyRow>("SELECT * FROM maintenance_policies WHERE state = 'enabled' ORDER BY created_at");
  }

  list(): PolicyRow[] {
    return this.store.all<PolicyRow>("SELECT * FROM maintenance_policies WHERE state NOT IN ('superseded') ORDER BY created_at DESC LIMIT 200");
  }

  view(p: PolicyRow): PolicyView {
    const t = MAINTENANCE_TEMPLATES[p.template_id];
    const meta = this.store.get<{ maintenance_state: string; maintenance_root_state: string }>("SELECT maintenance_state, maintenance_root_state FROM meta WHERE id = 1")!;
    return {
      policyId: p.id,
      version: p.version,
      templateId: p.template_id,
      templateVersion: p.template_version,
      target: { kind: p.target_kind, id: p.target_id, contract: p.target_contract ? JSON.parse(p.target_contract) : null },
      trigger: JSON.parse(p.trigger_json),
      bounds: JSON.parse(p.bounds_json),
      mode: p.mode,
      allowedActions: JSON.parse(p.allowed_actions),
      automaticActions: p.mode === "automatic" ? t.automaticActions : [],
      policyHash: p.policy_hash,
      state: p.state,
      approval: { approvedAt: p.approved_at, approvedHash: p.approved_hash, expiresAt: p.expires_at },
      rootSync: { state: p.root_sync_state, version: p.root_version, local: meta.maintenance_state, root: meta.maintenance_root_state },
      risk: t.risk,
      usesModel: t.usesModel,
      createdAt: p.created_at,
    };
  }

  /** Normalize and validate a request into the exact body the user will approve. Throws 422/403 on anything outside bounds. */
  normalize(body: PolicyCreateBody): { template: (typeof MAINTENANCE_TEMPLATES)[MaintenanceTemplateId]; norm: Record<string, unknown>; caps: InstallCaps | null; contract: unknown } {
    const t = MAINTENANCE_TEMPLATES[body.templateId];
    if (!t) throw new AgentOsError("INVALID_REQUEST", `unknown maintenance template ${String(body.templateId)}`);
    if (!body.target || body.target.kind !== t.targetKind || typeof body.target.id !== "string" || body.target.id.length === 0 || body.target.id.length > 128) {
      throw new AgentOsError("INVALID_REQUEST", `template ${t.id} needs a ${t.targetKind} target`);
    }
    if (!["observe", "suggest", "automatic"].includes(body.mode)) throw new AgentOsError("INVALID_REQUEST", "mode must be observe, suggest or automatic");
    if (body.mode === "automatic" && t.automaticActions.length === 0) throw new AgentOsError("INVALID_REQUEST", `${t.id} has no automatic actions; use suggest or observe`);
    if (body.mode === "suggest" && t.usesModel === false && t.automaticActions.length === 0) throw new AgentOsError("INVALID_REQUEST", "nothing to suggest for this template");
    const trig = body.trigger ?? { kind: "interval" };
    if (!["interval", "event", "manual"].includes(trig.kind)) throw new AgentOsError("INVALID_REQUEST", "trigger must be interval, event or manual (no cron text, no callbacks)");
    let trigger: Record<string, unknown> = { kind: trig.kind };
    if (trig.kind === "interval") {
      const iv = trig.intervalSeconds ?? t.defaults.intervalSeconds ?? 3600;
      if (!Number.isInteger(iv) || iv < V4_LIMITS.minIntervalSeconds || iv > V4_LIMITS.maxIntervalSeconds) throw new AgentOsError("INVALID_REQUEST", "intervalSeconds must be an integer from 60 to 86400");
      trigger = { kind: "interval", intervalSeconds: iv };
    }
    const bounds: Record<string, number> = {};
    for (const [k, def] of Object.entries(t.defaults)) bounds[k] = def;
    for (const [k, v] of Object.entries(body.params ?? {})) {
      const range = t.bounds[k];
      if (!range) throw new AgentOsError("INVALID_REQUEST", `parameter ${k} is not part of template ${t.id}`);
      if (typeof v !== "number" || !Number.isFinite(v) || v < range[0] || v > range[1]) throw new AgentOsError("INVALID_REQUEST", `${k} must be within ${range[0]}..${range[1]}`);
      bounds[k] = v;
    }
    let caps: InstallCaps | null = null;
    if (t.targetKind === "service") {
      caps = this.installCaps?.("service", body.target.id) ?? { allowed: false, max: {}, reason: "no broker install policy is available" };
      if (!caps.allowed) throw new AgentOsError("BROKER_POLICY_DENIED", caps.reason ?? "this service is not registered for maintenance recovery in the install policy");
      // the root cap is a hard upper bound: user values above it are clamped down, never widened
      for (const [k, max] of Object.entries(caps.max)) if (bounds[k] !== undefined && bounds[k]! > max) bounds[k] = max;
    }
    let contract: unknown = null;
    if (this.targetCheck) {
      const c = this.targetCheck(t.targetKind, body.target.id);
      if (!c.ok) throw new AgentOsError("NOT_FOUND", c.reason ?? `${t.targetKind} ${body.target.id} not found`);
      contract = c.contract ?? null;
    }
    const days = body.expiresInDays ?? V4_LIMITS.policyDefaultDays;
    if (!Number.isInteger(days) || days < 1 || days > V4_LIMITS.policyMaxDays) throw new AgentOsError("INVALID_REQUEST", "expiresInDays must be 1..365");
    const norm = {
      templateId: t.id,
      templateVersion: t.version,
      target: body.target,
      targetContract: contract,
      trigger,
      condition: { template: t.id },
      bounds,
      mode: body.mode,
      allowedActions: body.mode === "observe" ? [] : t.actions,
      expiresInDays: days,
    };
    return { template: t, norm, caps, contract };
  }

  /** Create a pending policy (or the next pending version of an existing one). Returns the normalized scope and hash. */
  create(body: PolicyCreateBody & { policyId?: string }): PolicyRow {
    const { template, norm, contract } = this.normalize(body);
    return this.store.tx(() => {
      const prev = body.policyId ? this.require(body.policyId) : undefined;
      const id = prev?.id ?? randomUUID();
      const version = (prev?.version ?? 0) + 1;
      const nowMs = this.store.clock.now();
      const expiresAt = iso(nowMs + (norm.expiresInDays as number) * 86_400_000);
      const hash = sha256Hex(canonicalJson({ id, version, ...norm, expiresAt }));
      // an older draft is superseded by the new request; an enabled version keeps running until this one is approved
      if (prev) this.store.run("UPDATE maintenance_policies SET state = 'superseded', updated_at = ? WHERE id = ? AND state = 'pending_approval'", this.now(), id);
      this.store.run(
        `INSERT INTO maintenance_policies (id, version, template_id, template_version, target_kind, target_id, target_contract, trigger_json, condition_json, bounds_json,
          mode, allowed_actions, policy_hash, maintenance_epoch, expires_at, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?)`,
        id, version, template.id, template.version, (norm.target as { kind: string }).kind, (norm.target as { id: string }).id, contract === null ? null : JSON.stringify(contract),
        JSON.stringify(norm.trigger), JSON.stringify(norm.condition), JSON.stringify(norm.bounds), norm.mode, JSON.stringify(norm.allowedActions), hash,
        this.#epoch(), expiresAt, iso(nowMs), iso(nowMs),
      );
      this.store.event("maintenance.policy_created", { policyId: id, version, policyHash: hash, templateId: template.id }, {});
      return this.require(id, version);
    });
  }

  #epoch(): number {
    return this.store.get<{ e: number }>("SELECT maintenance_epoch AS e FROM meta WHERE id = 1")!.e;
  }

  /**
   * User approval of an exact version and hash (spec §13.1, V4-P05). Enables the policy only after the target and the
   * install caps are re-checked; a service policy goes through `syncing` until the broker confirmed (POLICY_SYNC_PENDING).
   */
  approve(id: string, version: number, policyHash: string): PolicyRow {
    return this.store.tx(() => {
      const p = this.require(id, version);
      if (p.policy_hash !== policyHash) throw new AgentOsError("POLICY_VERSION_STALE", "the approved hash does not match this policy version", { policyHash: p.policy_hash });
      const newest = this.require(id);
      if (newest.version !== version) throw new AgentOsError("POLICY_VERSION_STALE", "a newer version of this policy exists", { version: newest.version });
      if (Date.parse(p.expires_at) <= this.store.clock.now()) throw new AgentOsError("POLICY_VERSION_STALE", "this policy version expired; create a new one");
      if (p.state === "enabled" || p.state === "syncing") return p;
      if (!["pending_approval", "paused"].includes(p.state)) throw new AgentOsError("POLICY_VERSION_STALE", `policy is ${p.state}`);
      const n = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM maintenance_policies WHERE state IN ('enabled','syncing') AND id <> ?", id)!.n;
      if (n >= V4_LIMITS.maxEnabledPolicies) throw new AgentOsError("LIMIT_EXCEEDED", `at most ${V4_LIMITS.maxEnabledPolicies} policies can be enabled`);
      if (this.targetCheck) {
        const c = this.targetCheck(p.target_kind, p.target_id);
        if (!c.ok) throw new AgentOsError("POLICY_VERSION_STALE", c.reason ?? "the target changed; create a new version");
        if (p.target_contract !== null && canonicalJson(c.contract ?? null) !== canonicalJson(JSON.parse(p.target_contract))) throw new AgentOsError("POLICY_VERSION_STALE", "the target's contract changed since the policy was drafted; create a new version");
      }
      if (p.target_kind === "service") {
        const caps = this.installCaps?.("service", p.target_id);
        if (!caps?.allowed) throw new AgentOsError("BROKER_POLICY_DENIED", caps?.reason ?? "service not allowed by the install policy");
        const b = JSON.parse(p.bounds_json) as Record<string, number>;
        for (const [k, max] of Object.entries(caps.max)) if (b[k] !== undefined && b[k]! > max) throw new AgentOsError("BROKER_POLICY_DENIED", `${k}=${b[k]} exceeds the install cap ${max}`);
      }
      // retire the previously enabled version of the same policy id
      this.store.run("UPDATE maintenance_policies SET state = 'superseded', updated_at = ? WHERE id = ? AND version <> ? AND state IN ('enabled','syncing','paused','paused_needs_review','pending_approval')", this.now(), id, version);
      if (p.approved_at === null) {
        this.store.run("UPDATE maintenance_policies SET approved_by = 'user', approved_at = ?, approved_hash = ? WHERE id = ? AND version = ?", this.now(), policyHash, id, version);
      }
      const needsRoot = p.target_kind === "service" && p.mode === "automatic";
      this.store.run(
        "UPDATE maintenance_policies SET state = ?, root_sync_state = ?, updated_at = ? WHERE id = ? AND version = ?",
        needsRoot ? "syncing" : "enabled", needsRoot ? "pending" : "none", this.now(), id, version,
      );
      this.store.event("maintenance.policy_approved", { policyId: id, version, policyHash }, {});
      const row = this.require(id, version);
      if (needsRoot) this.onRootSync?.(row, "policy-sync");
      return row;
    });
  }

  /** Broker confirmed the sync of exactly this version. */
  rootSynced(id: string, version: number, rootVersion: number): void {
    this.store.tx(() => {
      this.store.run(
        "UPDATE maintenance_policies SET state = CASE state WHEN 'syncing' THEN 'enabled' ELSE state END, root_sync_state = CASE root_sync_state WHEN 'pending' THEN 'synced' WHEN 'revoking' THEN 'revoked' ELSE root_sync_state END, root_version = ?, updated_at = ? WHERE id = ? AND version = ?",
        rootVersion, this.now(), id, version,
      );
    });
  }

  /** Pause new admissions of this policy at once (local), then the broker side (spec §13.2). */
  pause(id: string, reason = "user"): PolicyRow {
    return this.store.tx(() => {
      const p = this.require(id);
      if (!["enabled", "syncing", "pending_approval", "paused_needs_review"].includes(p.state)) return p;
      const root = p.root_sync_state === "synced" || p.root_sync_state === "pending" ? "revoking" : p.root_sync_state;
      this.store.run("UPDATE maintenance_policies SET state = 'paused', root_sync_state = ?, updated_at = ? WHERE id = ? AND version = ?", root, this.now(), id, p.version);
      // queued/deferred jobs of this policy never take a new effect
      this.store.run("UPDATE maintenance_jobs SET wait_reason = 'policy paused', updated_at = ? WHERE policy_id = ? AND state IN ('queued','deferred','awaiting_approval','ready')", this.now(), id);
      this.store.event("maintenance.policy_paused", { policyId: id, version: p.version, reason }, {});
      const row = this.require(id);
      if (root === "revoking") this.onRootSync?.(row, "policy-revoke");
      return row;
    });
  }

  /** Inside a tx: pause every policy of a target (user stop / archive, spec §8.3, §13.2). */
  pauseTargetInTx(kind: string, id: string, reason: string): number {
    const rows = this.store.all<PolicyRow>("SELECT * FROM maintenance_policies WHERE target_kind = ? AND target_id = ? AND state IN ('enabled','syncing')", kind, id);
    for (const p of rows) this.pause(p.id, reason);
    return rows.length;
  }

  /** Restore (spec §23.4): every policy needs review; nothing restored runs on its old approval. */
  invalidateAllInTx(): void {
    this.store.run("UPDATE maintenance_policies SET state = 'paused_needs_review', updated_at = ? WHERE state IN ('enabled','syncing','paused','pending_approval')", this.now());
  }

  /** Expiry sweep: no automatic renewal (spec §13.1). */
  expireDue(): number {
    return this.store.tx(() => {
      const due = this.store.all<PolicyRow>("SELECT * FROM maintenance_policies WHERE state IN ('enabled','syncing','paused','pending_approval') AND expires_at <= ?", this.now());
      for (const p of due) {
        this.store.run("UPDATE maintenance_policies SET state = 'expired', updated_at = ? WHERE id = ? AND version = ?", this.now(), p.id, p.version);
        this.store.event("maintenance.policy_expired", { policyId: p.id, version: p.version }, {});
        if (p.root_sync_state === "synced") this.onRootSync?.({ ...p, state: "expired" }, "policy-revoke");
      }
      return due.length;
    });
  }
}
