import { randomBytes } from "node:crypto";
import { AgentOsError, capabilityDecl, isV3, paramsHash, sealGrant, type AnyBundle, type BrokerPrincipal, type CodeBundleV3 } from "@agentos/contracts";
import { BrokerError } from "@agentos/broker-client";
import { iso, type Store } from "../persistence/store.js";
import type { ResourceRow, ResourceService } from "../resources/resource-service.js";
import type { BrokerLink } from "../system/broker-link.js";
import type { AppService } from "../apps/app-service.js";

export interface GrantRow {
  id: string;
  principal_kind: "app" | "system_action" | "run";
  app_id: string | null;
  revision_id: string | null;
  action_id: string | null;
  run_id: string | null;
  binding_alias: string | null;
  capability_id: string;
  capability_version: number;
  resource_id: string;
  resource_generation: number;
  limits_json: string;
  params_hash: string | null;
  confirmation_policy: "per_plan" | "standing";
  grant_version: number;
  expires_at: string;
  sync_state: "local" | "pending" | "active" | "revoking" | "revoked" | "failed";
  sync_error: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface GrantView {
  grantId: string;
  principal: { kind: string; appId?: string | null; revisionId?: string | null; actionId?: string | null; runId?: string | null };
  bindingAlias: string | null;
  capabilityId: string;
  contractVersion: number;
  resourceId: string;
  resourceGeneration: number;
  limits: Record<string, unknown>;
  confirmationPolicy: "per_plan" | "standing";
  state: "active" | "pending" | "revoking" | "revoked" | "failed";
  /** Revocation shown as effective only after the broker durably confirmed it (spec §8.3). */
  revocationConfirmed: boolean;
  expiresAt: string;
  createdAt: string;
  syncError: string | null;
}

const DAY = 24 * 3600 * 1000;

export class ProviderGrantService {
  onChange: (() => void) | null = null;

  constructor(readonly store: Store, readonly resources: ResourceService, readonly broker: BrokerLink, readonly apps: AppService) {}

  get(id: string): GrantRow | undefined {
    return this.store.get<GrantRow>("SELECT * FROM provider_grants WHERE id = ?", id);
  }

  view(g: GrantRow): GrantView {
    const state = g.sync_state === "local" ? (g.revoked_at ? "revoked" : "active") : g.sync_state;
    return {
      grantId: g.id,
      principal: { kind: g.principal_kind, appId: g.app_id, revisionId: g.revision_id, actionId: g.action_id, runId: g.run_id },
      bindingAlias: g.binding_alias,
      capabilityId: g.capability_id,
      contractVersion: g.capability_version,
      resourceId: g.resource_id,
      resourceGeneration: g.resource_generation,
      limits: JSON.parse(g.limits_json) as Record<string, unknown>,
      confirmationPolicy: g.confirmation_policy,
      state: state as GrantView["state"],
      revocationConfirmed: g.sync_state === "revoked" || (g.sync_state === "local" && !!g.revoked_at),
      expiresAt: g.expires_at,
      createdAt: g.created_at,
      syncError: g.sync_error,
    };
  }

  list(filter: { principalKind?: string } = {}): GrantView[] {
    const rows = filter.principalKind
      ? this.store.all<GrantRow>("SELECT * FROM provider_grants WHERE principal_kind = ? ORDER BY created_at DESC LIMIT 500", filter.principalKind)
      : this.store.all<GrantRow>("SELECT * FROM provider_grants WHERE principal_kind = 'app' ORDER BY created_at DESC LIMIT 500");
    return rows.map((g) => this.view(g));
  }

  /** Default limits per capability: bounded by the installed caps; writes always carry explicit bounds. */
  /** Do these normalized parameters stay inside a grant's limits (the same rules the broker applies at admission)? */
  static paramsWithin(capabilityId: string, params: Record<string, unknown>, limits: Record<string, unknown>): boolean {
    switch (capabilityId) {
      case "file.write_text_atomic":
        return Buffer.byteLength(String(params.content ?? ""), "utf8") <= Number(limits.maxBytes ?? 0);
      case "service.ensure_state":
        return Array.isArray(limits.states) && limits.states.includes(params.state);
      case "service.set_limit": {
        const r = limits[String(params.property)] as { min: number; max: number } | undefined;
        const v = Number(params.value);
        return !!r && v >= r.min && v <= r.max;
      }
      case "network.apply_profile":
        return Array.isArray(limits.profiles) && limits.profiles.includes(params.profileId);
      case "serial.exchange":
        return Array.isArray(limits.commands) && limits.commands.includes(params.command);
      default:
        return false;
    }
  }

  defaultLimits(capabilityId: string, r: ResourceRow, userBounds?: Record<string, unknown>): Record<string, unknown> {
    const caps = this.resources.brokerLimits.get(r.id) ?? {};
    switch (capabilityId) {
      case "file.write_text_atomic": {
        const max = Math.min(Number((caps as { maxFileBytes?: number }).maxFileBytes ?? 131072), 131072);
        const ub = userBounds?.maxBytes;
        return { maxBytes: typeof ub === "number" && ub > 0 ? Math.min(ub, max) : max };
      }
      case "service.ensure_state":
        return { states: Array.isArray(userBounds?.states) ? userBounds!.states : ["running", "stopped"] };
      case "service.set_limit": {
        const out: Record<string, unknown> = {};
        for (const p of ["CPUQuotaPerSecUSec", "MemoryMax"]) {
          const ub = userBounds?.[p] as { min?: number; max?: number } | undefined;
          const ic = (caps as Record<string, { min: number; max: number }>)[p];
          if (ub && typeof ub.min === "number" && typeof ub.max === "number") out[p] = { min: ub.min, max: ub.max };
          else if (ic) out[p] = { min: ic.min, max: ic.max };
        }
        return out;
      }
      case "network.apply_profile":
        return { profiles: Array.isArray(userBounds?.profiles) ? userBounds!.profiles : ((caps as { profiles?: string[] }).profiles ?? ["local-allow", "local-deny"]) };
      case "serial.exchange":
        return { commands: Array.isArray(userBounds?.commands) ? userBounds!.commands : ["SAMPLE", "ECHO"] };
      default:
        return {};
    }
  }

  #insert(g: Omit<GrantRow, "created_at" | "revoked_at" | "sync_error">): GrantRow {
    const now = iso(this.store.clock.now());
    this.store.run(
      "INSERT INTO provider_grants (id, principal_kind, app_id, revision_id, action_id, run_id, binding_alias, capability_id, capability_version, resource_id, resource_generation, limits_json, params_hash, confirmation_policy, grant_version, expires_at, sync_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      g.id, g.principal_kind, g.app_id, g.revision_id, g.action_id, g.run_id, g.binding_alias, g.capability_id, g.capability_version, g.resource_id, g.resource_generation, g.limits_json, g.params_hash, g.confirmation_policy, g.grant_version, g.expires_at, g.sync_state, now,
    );
    const row = this.get(g.id)!;
    if (g.sync_state === "pending") {
      const principal: BrokerPrincipal =
        g.principal_kind === "app" ? { kind: "app", appId: g.app_id!, revisionId: g.revision_id! } : g.principal_kind === "system_action" ? { kind: "system_action", actionId: g.action_id! } : { kind: "run", runId: g.run_id! };
      // Frozen request (identity is attached when sent: the broker identity of the current binding).
      const frozen = { grantId: g.id, grantVersion: g.grant_version, principal, capabilityId: g.capability_id, contractVersion: g.capability_version, resourceId: g.resource_id, resourceGeneration: g.resource_generation, limits: JSON.parse(g.limits_json), paramsHash: g.params_hash, expiresAtMs: Date.parse(g.expires_at) };
      this.store.run(
        "INSERT INTO provider_grant_outbox (id, grant_id, kind, request_hash, frozen_request, dispatch_state, created_at, updated_at) VALUES (?, ?, 'create', ?, ?, 'pending', ?, ?)",
        `go_${randomBytes(8).toString("hex")}`, g.id, paramsHash(frozen as never), JSON.stringify(frozen), now, now,
      );
    }
    return row;
  }

  /**
   * POST /api/provider-grants: the user connects an app's binding alias to a real resource. One grant per capability
   * the binding declares, for the app's current active revision only (spec §8.2). Inside the caller's transaction.
   */
  createAppGrantsInTx(req: { appId: string; bindingAlias: string; resourceId: string; confirmationPolicy: "per_plan" | "standing"; bounds?: Record<string, Record<string, unknown>>; expiresInDays?: number }): GrantRow[] {
    const row = this.apps.getAppRow(req.appId);
    if (!row?.active_revision_id) throw new AgentOsError("NOT_FOUND", "app has no active version");
    const app = { activeRevisionId: row.active_revision_id };
    const bundle = this.apps.revisionBundle(req.appId, app.activeRevisionId) as AnyBundle | null;
    if (!bundle || !isV3(bundle)) throw new AgentOsError("PROVIDER_GRANT_REQUIRED", "only formatVersion 3 apps can be connected to system resources (older apps get no new capability)");
    const binding = (bundle as CodeBundleV3).system.bindings.find((b) => b.alias === req.bindingAlias);
    if (!binding) throw new AgentOsError("RESOURCE_NOT_BOUND", `the app declares no binding "${req.bindingAlias}"`);
    const r = this.resources.require(req.resourceId);
    if (r.kind !== binding.resourceKind) throw new AgentOsError("RESOURCE_NOT_BOUND", `binding "${req.bindingAlias}" needs a ${binding.resourceKind}, not a ${r.kind}`);
    if (r.status !== "available" && r.status !== "quarantined") throw new AgentOsError("RESOURCE_GONE", `resource is ${r.status}`);
    const live = this.store.all<GrantRow>("SELECT * FROM provider_grants WHERE principal_kind = 'app' AND app_id = ? AND revision_id = ? AND binding_alias = ? AND revoked_at IS NULL AND sync_state NOT IN ('revoked','failed')", req.appId, app.activeRevisionId, req.bindingAlias);
    if (live.length > 0) throw new AgentOsError("REQUEST_CONFLICT", "this binding is already connected; revoke it first", { grantIds: live.map((g) => g.id) });
    const expires = iso(this.store.clock.now() + Math.min(Math.max(req.expiresInDays ?? 30, 1), 365) * DAY);
    const out: GrantRow[] = [];
    for (const c of binding.capabilities) {
      const d = capabilityDecl(c.capabilityId);
      if (!d || !d.resourceKinds.includes(r.kind)) throw new AgentOsError("CAPABILITY_VERSION_UNSUPPORTED", `${c.capabilityId} is not available for ${r.kind}`);
      let policy = req.confirmationPolicy;
      if (d.mode === "read") policy = "standing";
      else if (policy === "standing" && d.standingAllowed === "never") policy = "per_plan";
      else if (policy === "standing" && d.standingAllowed === "with-explicit-bounds" && !req.bounds?.[c.capabilityId]) {
        throw new AgentOsError("INVALID_REQUEST", `a standing grant for ${c.capabilityId} needs explicit parameter bounds`, { capabilityId: c.capabilityId });
      }
      const limits = this.defaultLimits(c.capabilityId, r, req.bounds?.[c.capabilityId]);
      this.#checkLimitsAgainstInstall(c.capabilityId, r, limits);
      out.push(
        this.#insert({
          id: `pg_${randomBytes(10).toString("hex")}`,
          principal_kind: "app", app_id: req.appId, revision_id: app.activeRevisionId, action_id: null, run_id: null, binding_alias: req.bindingAlias,
          capability_id: c.capabilityId, capability_version: c.contractVersion, resource_id: r.id, resource_generation: r.generation, limits_json: JSON.stringify(limits),
          params_hash: null, confirmation_policy: policy, grant_version: 1, expires_at: expires,
          sync_state: r.execution_class === "broker" ? "pending" : "local",
        }),
      );
    }
    this.store.event("provider_grant.created", { appId: req.appId, bindingAlias: req.bindingAlias, resourceId: r.id, grants: out.map((g) => g.id) }, { appId: req.appId });
    return out;
  }

  /** Early host-side check (G01 is enforced again by the broker from its root policy). */
  #checkLimitsAgainstInstall(cap: string, r: ResourceRow, limits: Record<string, unknown>): void {
    const caps = this.resources.brokerLimits.get(r.id) as Record<string, unknown> | undefined;
    if (!caps) return;
    if (cap === "service.set_limit") {
      for (const [k, v] of Object.entries(limits)) {
        const ic = caps[k] as { min: number; max: number } | undefined;
        const b = v as { min: number; max: number };
        if (!ic || b.min < ic.min || b.max > ic.max || b.min > b.max) throw new AgentOsError("BROKER_POLICY_DENIED", `${k} bounds ${b.min}..${b.max} exceed the installed ${ic?.min}..${ic?.max}`);
      }
    }
    if (cap === "file.write_text_atomic" && Number(limits.maxBytes) > Number(caps.maxFileBytes ?? 0)) throw new AgentOsError("BROKER_POLICY_DENIED", "maxBytes exceeds the installed limit");
  }

  /** One-time execution grant for a confirmed plan (spec §8.4). */
  createActionGrantInTx(action: { id: string; capability_id: string; resource_id: string; resource_generation: number; params: Record<string, unknown> }, ttlMs: number): GrantRow {
    const r = this.resources.require(action.resource_id);
    const limits = this.defaultLimits(action.capability_id, r);
    return this.#insert({
      id: `pg_${randomBytes(10).toString("hex")}`,
      principal_kind: "system_action", app_id: null, revision_id: null, action_id: action.id, run_id: null, binding_alias: null,
      capability_id: action.capability_id, capability_version: 1, resource_id: r.id, resource_generation: action.resource_generation, limits_json: JSON.stringify(limits),
      params_hash: paramsHash(action.params), confirmation_policy: "per_plan", grant_version: 1, expires_at: iso(this.store.clock.now() + ttlMs), sync_state: "pending",
    });
  }

  /** Run-scoped read grants for broker-backed reads inside a system_plan run (spec §8.4). */
  createRunReadGrantInTx(runId: string, r: ResourceRow, capabilityId: string, expiresAtMs: number): GrantRow {
    return this.#insert({
      id: `pg_${randomBytes(10).toString("hex")}`,
      principal_kind: "run", app_id: null, revision_id: null, action_id: null, run_id: runId, binding_alias: null,
      capability_id: capabilityId, capability_version: 1, resource_id: r.id, resource_generation: r.generation, limits_json: "{}",
      params_hash: null, confirmation_policy: "standing", grant_version: 1, expires_at: iso(expiresAtMs), sync_state: r.execution_class === "broker" ? "pending" : "local",
    });
  }

  /** Revocation: the host blocks new admissions first, then the broker confirms (spec §8.3). */
  revokeInTx(grantId: string, reason: string): GrantRow {
    const g = this.get(grantId);
    if (!g) throw new AgentOsError("NOT_FOUND", "grant not found");
    if (g.revoked_at || g.sync_state === "revoked" || g.sync_state === "revoking") return g;
    const now = iso(this.store.clock.now());
    if (g.sync_state === "local") {
      this.store.run("UPDATE provider_grants SET revoked_at = ? WHERE id = ?", now, g.id);
    } else {
      this.store.run("UPDATE provider_grants SET sync_state = 'revoking', revoked_at = ? WHERE id = ?", now, g.id);
      this.store.run(
        "INSERT INTO provider_grant_outbox (id, grant_id, kind, request_hash, frozen_request, dispatch_state, created_at, updated_at) VALUES (?, ?, 'revoke', ?, ?, 'pending', ?, ?) ON CONFLICT(grant_id, kind) DO NOTHING",
        `go_${randomBytes(8).toString("hex")}`, g.id, paramsHash({ grantId: g.id, grantVersion: g.grant_version } as never), JSON.stringify({ grantId: g.id, grantVersion: g.grant_version }), now, now,
      );
    }
    this.store.event("provider_grant.revoked", { grantId, reason }, { appId: g.app_id });
    return this.get(g.id)!;
  }

  /** Revoke the whole connection a grant belongs to (all capabilities of that binding). */
  revokeConnectionInTx(grantId: string, reason: string): GrantRow[] {
    const g = this.get(grantId);
    if (!g) throw new AgentOsError("NOT_FOUND", "grant not found");
    const sib = g.principal_kind === "app"
      ? this.store.all<GrantRow>("SELECT * FROM provider_grants WHERE principal_kind = 'app' AND app_id = ? AND revision_id = ? AND binding_alias = ? AND resource_id = ? AND revoked_at IS NULL", g.app_id, g.revision_id, g.binding_alias, g.resource_id)
      : [g];
    return sib.map((x) => this.revokeInTx(x.id, reason));
  }

  /** Version switches void provider grants; switching back never revives them (spec §8.3, V3-G08). */
  invalidateAppInTx(appId: string, reason: string): GrantRow[] {
    return this.store.all<GrantRow>("SELECT * FROM provider_grants WHERE principal_kind = 'app' AND app_id = ? AND revoked_at IS NULL", appId).map((g) => this.revokeInTx(g.id, reason));
  }

  /** True when every provider grant of the app is revoked and the broker confirmed it. */
  revocationsConfirmed(appId: string): boolean {
    return !this.store.get("SELECT 1 FROM provider_grants WHERE principal_kind = 'app' AND app_id = ? AND (revoked_at IS NULL OR sync_state = 'revoking')", appId);
  }

  /** The active grant an app call may use, with the precise error otherwise. */
  requireAppGrant(appId: string, revisionId: string, alias: string, capabilityId: string): GrantRow {
    const rows = this.store.all<GrantRow>(
      "SELECT * FROM provider_grants WHERE principal_kind = 'app' AND app_id = ? AND revision_id = ? AND binding_alias = ? AND capability_id = ? ORDER BY created_at DESC",
      appId, revisionId, alias, capabilityId,
    );
    const g = rows[0];
    if (!g) throw new AgentOsError("PROVIDER_GRANT_REQUIRED", `binding "${alias}" is not connected for ${capabilityId}`, { bindingAlias: alias, capabilityId });
    this.requireUsable(g);
    return g;
  }

  requireUsable(g: GrantRow): void {
    if (g.sync_state === "revoking") throw new AgentOsError("GRANT_REVOKING", "the grant is being revoked; revocation is not yet confirmed", { grantId: g.id });
    if (g.revoked_at || g.sync_state === "revoked") throw new AgentOsError("GRANT_REVOKED", "the grant was revoked", { grantId: g.id });
    if (g.sync_state === "pending") throw new AgentOsError("GRANT_PENDING", "the grant is not yet confirmed by the broker", { grantId: g.id });
    if (g.sync_state === "failed") throw new AgentOsError("BROKER_POLICY_DENIED", g.sync_error ?? "the broker refused the grant", { grantId: g.id });
    if (Date.parse(g.expires_at) <= this.store.clock.now()) throw new AgentOsError("GRANT_REVOKED", "the grant expired", { grantId: g.id });
    const r = this.resources.require(g.resource_id);
    if (r.generation !== g.resource_generation) throw new AgentOsError("RESOURCE_GENERATION_STALE", "the resource changed since this grant was made; connect it again", { resourceId: r.id });
  }

  /** Deliver pending grant syncs/revocations (idempotent; same frozen body on every retry). */
  async pump(): Promise<void> {
    const rows = this.store.all<{ id: string; grant_id: string; kind: "create" | "revoke"; frozen_request: string; attempts: number }>(
      "SELECT id, grant_id, kind, frozen_request, attempts FROM provider_grant_outbox WHERE dispatch_state IN ('pending','sent') ORDER BY created_at LIMIT 32",
    );
    if (rows.length === 0) return;
    await this.broker.ensure();
    let identity;
    try {
      identity = this.broker.requireWritable();
    } catch {
      return;
    }
    for (const o of rows) {
      const frozen = JSON.parse(o.frozen_request) as Record<string, unknown>;
      const now = () => iso(this.store.clock.now());
      this.store.tx(() => this.store.run("UPDATE provider_grant_outbox SET dispatch_state = 'sent', attempts = attempts + 1, updated_at = ? WHERE id = ?", now(), o.id));
      try {
        if (o.kind === "create") {
          const res = await this.broker.client.grantSync(sealGrant({ identity, ...(frozen as Record<string, unknown>) } as never));
          this.store.tx(() => {
            this.store.run("UPDATE provider_grant_outbox SET dispatch_state = 'confirmed', broker_result = ?, updated_at = ? WHERE id = ?", JSON.stringify(res), now(), o.id);
            // A grant revoked meanwhile stays revoking (its revoke row follows).
            this.store.run("UPDATE provider_grants SET sync_state = CASE WHEN sync_state = 'pending' THEN ? ELSE sync_state END WHERE id = ?", res.state === "revoked" ? "revoked" : "active", o.grant_id);
          });
        } else {
          const res = await this.broker.client.grantRevoke(identity, String(frozen.grantId), Number(frozen.grantVersion));
          this.store.tx(() => {
            this.store.run("UPDATE provider_grant_outbox SET dispatch_state = 'confirmed', broker_result = ?, updated_at = ? WHERE id = ?", JSON.stringify(res), now(), o.id);
            this.store.run("UPDATE provider_grants SET sync_state = 'revoked' WHERE id = ?", o.grant_id);
          });
        }
      } catch (e) {
        const be = e as BrokerError;
        const final = ["BROKER_POLICY_DENIED", "RESOURCE_NOT_BOUND", "CAPABILITY_VERSION_UNSUPPORTED", "RESOURCE_GENERATION_STALE", "OPERATION_CONFLICT", "INVALID_SYSTEM_PLAN", "PLAN_HASH_MISMATCH"].includes(be.code);
        this.store.tx(() => {
          this.store.run("UPDATE provider_grant_outbox SET dispatch_state = ?, broker_result = ?, updated_at = ? WHERE id = ?", final ? "failed" : "pending", JSON.stringify({ code: be.code, message: be.message }), now(), o.id);
          if (final && o.kind === "create") this.store.run("UPDATE provider_grants SET sync_state = 'failed', sync_error = ? WHERE id = ? AND sync_state = 'pending'", `${be.code}: ${be.message}`, o.grant_id);
        });
        if (!final) break; // broker unreachable: keep order, retry later
      }
    }
    this.onChange?.();
  }
}
