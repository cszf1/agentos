import { randomUUID } from "node:crypto";
import {
  AgentOsError,
  CODE_LIMITS,
  canonicalJson,
  importMatchesExport,
  rpcValueIssue,
  serviceContractHash,
  utf8Bytes,
  type AnyBundle,
  type CodeBundle,
  type Frame,
  type HandlerContext,
  type RpcSchema, isCodeBundle } from "@agentos/contracts";
import { iso } from "../persistence/store.js";
import type { RuntimeContext } from "../runtime/context.js";
import type { AppRuntimeService } from "../runtime/app-runtime.js";
import type { LiveInstance } from "../runtime/instances.js";
import { RUNTIME_POLICY } from "../runtime/policy.js";
import type { InvocationService } from "../invocations/invocation-service.js";

export interface GrantRow {
  id: string;
  source_app_id: string;
  source_revision_id: string;
  alias: string;
  target_app_id: string;
  target_revision_id: string;
  export_name: string;
  contract_hash: string;
  created_at: string;
  revoked_at: string | null;
}

export interface ServiceEntry {
  appId: string;
  appTitle: string;
  revisionId: string;
  exportName: string;
  queryId: string;
  contractVersion: number;
  description: string;
  contractHash: string;
  inputSchema: RpcSchema;
  outputSchema: RpcSchema;
}

export interface GrantDto {
  grantId: string;
  sourceAppId: string;
  sourceRevisionId: string;
  alias: string;
  targetAppId: string;
  targetRevisionId: string;
  exportName: string;
  contractHash: string;
  createdAt: string;
  revokedAt: string | null;
  /** active: both sides are on the granted revisions; inactive: a side changed version ("needs reconnecting"). */
  state: "active" | "inactive" | "revoked";
  reason: string | null;
}

/**
 * User-authorized read-only services between apps (spec §17). Grants bind exact source/target revisions and the
 * contract hash; only the local user creates or revokes them. One hop, no self calls, no commands or previews.
 */
export class InterAppService {
  constructor(private readonly ctx: RuntimeContext, private readonly runtime: AppRuntimeService, private readonly invocations: InvocationService) {}

  private now(): string {
    return iso(this.ctx.store.clock.now());
  }

  /** Exports of every app's active code revision (names, descriptions, schemas; never data). */
  catalog(): ServiceEntry[] {
    const s = this.ctx.store;
    return s.read(() => {
      const out: ServiceEntry[] = [];
      for (const a of s.all<{ id: string; active_revision_id: string }>("SELECT id, active_revision_id FROM apps WHERE active_revision_id IS NOT NULL ORDER BY created_at")) {
        const b = this.ctx.apps.revisionBundle(a.id, a.active_revision_id) as AnyBundle;
        if (!isCodeBundle(b)) continue;
        for (const e of b.exports) {
          const q = b.queries[e.queryId]!;
          out.push({
            appId: a.id, appTitle: b.manifest.title, revisionId: a.active_revision_id, exportName: e.exportName, queryId: e.queryId,
            contractVersion: e.contractVersion, description: e.description,
            contractHash: serviceContractHash({ exportName: e.exportName, contractVersion: e.contractVersion, inputSchema: q.inputSchema, outputSchema: q.outputSchema }),
            inputSchema: q.inputSchema, outputSchema: q.outputSchema,
          });
        }
      }
      return out;
    });
  }

  #state(g: GrantRow): { state: GrantDto["state"]; reason: string | null } {
    if (g.revoked_at) return { state: "revoked", reason: "revoked by you" };
    const s = this.ctx.store;
    const src = s.get<{ active_revision_id: string | null }>("SELECT active_revision_id FROM apps WHERE id = ?", g.source_app_id);
    const tgt = s.get<{ active_revision_id: string | null }>("SELECT active_revision_id FROM apps WHERE id = ?", g.target_app_id);
    if (src?.active_revision_id !== g.source_revision_id) return { state: "inactive", reason: "the connecting app changed version; reconnect the service" };
    if (tgt?.active_revision_id !== g.target_revision_id) return { state: "inactive", reason: "the providing app changed version; reconnect the service" };
    return { state: "active", reason: null };
  }

  dto(g: GrantRow): GrantDto {
    const st = this.#state(g);
    return {
      grantId: g.id, sourceAppId: g.source_app_id, sourceRevisionId: g.source_revision_id, alias: g.alias, targetAppId: g.target_app_id,
      targetRevisionId: g.target_revision_id, exportName: g.export_name, contractHash: g.contract_hash, createdAt: g.created_at, revokedAt: g.revoked_at,
      state: st.state, reason: st.reason,
    };
  }

  list(): GrantDto[] {
    return this.ctx.store.read(() => this.ctx.store.all<GrantRow>("SELECT * FROM service_grants ORDER BY created_at DESC LIMIT 200").map((g) => this.dto(g)));
  }

  /** Imports of an app's active revision with their connection state (for the Shell). */
  importsOf(appId: string): { alias: string; description?: string; grant: GrantDto | null }[] {
    const s = this.ctx.store;
    return s.read(() => {
      const a = s.get<{ active_revision_id: string | null }>("SELECT active_revision_id FROM apps WHERE id = ?", appId);
      if (!a?.active_revision_id) return [];
      const b = this.ctx.apps.revisionBundle(appId, a.active_revision_id) as AnyBundle;
      if (!isCodeBundle(b)) return [];
      return b.imports.map((imp) => {
        const g = s.get<GrantRow>("SELECT * FROM service_grants WHERE source_app_id = ? AND alias = ? ORDER BY (revoked_at IS NULL) DESC, created_at DESC LIMIT 1", appId, imp.alias);
        return { alias: imp.alias, description: imp.description, grant: g ? this.dto(g) : null };
      });
    });
  }

  /** User-only (inside the gateway write tx): connect an import alias to a target export on exact revisions. */
  createGrantInTx(req: { sourceAppId: string; sourceRevisionId: string; alias: string; targetAppId: string; targetRevisionId: string; exportName: string; contractHash: string }): GrantDto {
    const s = this.ctx.store;
    if (req.sourceAppId === req.targetAppId) throw new AgentOsError("FORBIDDEN", "an app cannot call itself");
    const src = this.ctx.apps.revisionBundle(req.sourceAppId, req.sourceRevisionId) as AnyBundle | null;
    const tgt = this.ctx.apps.revisionBundle(req.targetAppId, req.targetRevisionId) as AnyBundle | null;
    if (!src || !tgt) throw new AgentOsError("NOT_FOUND", "source or target revision not found");
    if (!isCodeBundle(src) || !isCodeBundle(tgt)) throw new AgentOsError("SERVICE_CONTRACT_MISMATCH", "both apps must be code versions");
    const imp = src.imports.find((i) => i.alias === req.alias);
    if (!imp) throw new AgentOsError("NOT_FOUND", `the source revision has no import "${req.alias}"`);
    const exp = tgt.exports.find((e) => e.exportName === req.exportName);
    if (!exp) throw new AgentOsError("NOT_FOUND", `the target revision has no export "${req.exportName}"`);
    const q = tgt.queries[exp.queryId]!;
    const hash = serviceContractHash({ exportName: exp.exportName, contractVersion: exp.contractVersion, inputSchema: q.inputSchema, outputSchema: q.outputSchema });
    if (hash !== req.contractHash) throw new AgentOsError("SERVICE_CONTRACT_MISMATCH", "the service contract changed; review it again", { contractHash: hash });
    if (!importMatchesExport(imp, q)) throw new AgentOsError("SERVICE_CONTRACT_MISMATCH", "the import expects a different input/output contract than this export provides");
    for (const id of [req.sourceRevisionId, req.targetRevisionId]) {
      const r = s.get<{ first_activated_at: string | null }>("SELECT first_activated_at FROM revisions WHERE id = ?", id);
      if (!r?.first_activated_at) throw new AgentOsError("NOT_FOUND", "grants bind published revisions only");
    }
    // The live grant for this source revision and alias is replaced (the old one stays as a revoked record).
    s.run("UPDATE service_grants SET revoked_at = ? WHERE source_app_id = ? AND source_revision_id = ? AND alias = ? AND revoked_at IS NULL", this.now(), req.sourceAppId, req.sourceRevisionId, req.alias);
    const id = randomUUID();
    s.run(
      "INSERT INTO service_grants (id, source_app_id, source_revision_id, alias, target_app_id, target_revision_id, export_name, contract_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      id, req.sourceAppId, req.sourceRevisionId, req.alias, req.targetAppId, req.targetRevisionId, req.exportName, hash, this.now(),
    );
    s.event("grant.created", { grantId: id, alias: req.alias, targetAppId: req.targetAppId, exportName: req.exportName }, { appId: req.sourceAppId });
    return this.dto(s.get<GrantRow>("SELECT * FROM service_grants WHERE id = ?", id)!);
  }

  /** Idempotent revoke (one business transaction); the record stays. */
  revokeInTx(grantId: string): GrantDto {
    const s = this.ctx.store;
    const g = s.get<GrantRow>("SELECT * FROM service_grants WHERE id = ?", grantId);
    if (!g) throw new AgentOsError("NOT_FOUND", "grant not found");
    if (!g.revoked_at) {
      s.run("UPDATE service_grants SET revoked_at = ? WHERE id = ?", this.now(), grantId);
      s.event("grant.revoked", { grantId }, { appId: g.source_app_id });
    }
    return this.dto(s.get<GrantRow>("SELECT * FROM service_grants WHERE id = ?", grantId)!);
  }

  #grantFor(inst: LiveInstance, alias: string): GrantRow {
    const s = this.ctx.store;
    const live = s.get<GrantRow>("SELECT * FROM service_grants WHERE source_app_id = ? AND source_revision_id = ? AND alias = ? AND revoked_at IS NULL", inst.appId, inst.revisionId, alias);
    if (!live) {
      const revoked = s.get("SELECT 1 FROM service_grants WHERE source_app_id = ? AND source_revision_id = ? AND alias = ? AND revoked_at IS NOT NULL", inst.appId, inst.revisionId, alias);
      throw new AgentOsError(revoked ? "GRANT_REVOKED" : "GRANT_REQUIRED", revoked ? `the "${alias}" service was disconnected` : `the "${alias}" service is not connected`);
    }
    const tgt = s.get<{ active_revision_id: string | null }>("SELECT active_revision_id FROM apps WHERE id = ?", live.target_app_id);
    if (tgt?.active_revision_id !== live.target_revision_id) throw new AgentOsError("SERVICE_UNAVAILABLE", `the "${alias}" service changed version; reconnect it`);
    return live;
  }

  /**
   * A running query asks for an import (spec §17.2). The host derives the caller from the bridge the request came
   * on; the payload only names the alias and input.
   */
  async handleServiceCall(inst: LiveInstance, f: Frame): Promise<unknown> {
    const p = f.payload as { callId?: unknown; parentCallId?: unknown; alias?: unknown; input?: unknown };
    const callId = typeof p?.callId === "string" ? p.callId.slice(0, 200) : "";
    const s = this.ctx.store;
    if (inst.revoked || inst.dead) throw new AgentOsError("INSTANCE_STALE", "instance revoked");
    if (inst.currentCallId === null || p.parentCallId !== inst.currentCallId) throw new AgentOsError("FORBIDDEN", "service calls need a current host-issued call");
    if (inst.callKind === "service") throw new AgentOsError("IPC_DEPTH_EXCEEDED", "a service handler cannot call other services");
    if (inst.callKind !== "query") throw new AgentOsError("FORBIDDEN", "only queries may call services");
    const routedSelf = s.read(() => {
      try {
        const r = this.runtime.route(inst.appId, { revisionId: inst.revisionId });
        return r.inst.id === inst.id;
      } catch {
        return false;
      }
    });
    if (!routedSelf) throw new AgentOsError("FORBIDDEN", "preview or stale instances cannot call services");
    if (++inst.serviceCalls > RUNTIME_POLICY.ipc.maxCallsPerQuery) throw new AgentOsError("LIMIT_EXCEEDED", `a query may make at most ${RUNTIME_POLICY.ipc.maxCallsPerQuery} service calls`);
    const alias = typeof p.alias === "string" ? p.alias : "";
    const prep = s.read(() => {
      const grant = this.#grantFor(inst, alias);
      if (grant.target_app_id === inst.appId) throw new AgentOsError("FORBIDDEN", "an app cannot call itself");
      const srcBundle = this.ctx.apps.revisionBundle(inst.appId, inst.revisionId) as CodeBundle;
      const imp = srcBundle.imports.find((i) => i.alias === alias);
      const tgtBundle = this.ctx.apps.revisionBundle(grant.target_app_id, grant.target_revision_id) as CodeBundle;
      const exp = tgtBundle.exports.find((e) => e.exportName === grant.export_name);
      if (!imp || !exp) throw new AgentOsError("SERVICE_CONTRACT_MISMATCH", "the granted contract no longer exists");
      const q = tgtBundle.queries[exp.queryId]!;
      if (serviceContractHash({ exportName: exp.exportName, contractVersion: exp.contractVersion, inputSchema: q.inputSchema, outputSchema: q.outputSchema }) !== grant.contract_hash || !importMatchesExport(imp, q)) {
        throw new AgentOsError("SERVICE_CONTRACT_MISMATCH", "the service contract does not match the grant");
      }
      const snap = this.invocations.snapshot(grant.target_app_id);
      if (snap.revisionId !== grant.target_revision_id) throw new AgentOsError("SERVICE_UNAVAILABLE", "the providing app changed version");
      return { grant, queryId: exp.queryId, decl: q, snap };
    });
    inst.usedGrants.push(prep.grant.id);
    const inIssue = rpcValueIssue(prep.decl.inputSchema, p.input);
    if (inIssue) throw new AgentOsError("INVALID_REQUEST", `service input ${inIssue.message}`);
    const remaining = inst.callDeadline - Date.now();
    const timeout = Math.min(RUNTIME_POLICY.ipc.callTimeoutMs, remaining - 50);
    if (timeout <= 0) throw new AgentOsError("APP_TIMEOUT", "no time left in the calling query");
    let target: ReturnType<AppRuntimeService["route"]>;
    try {
      target = this.runtime.route(prep.grant.target_app_id, { revisionId: prep.grant.target_revision_id });
    } catch (e) {
      const ae = e as AgentOsError;
      throw new AgentOsError(ae.code === "RUNTIME_STOPPED" || ae.code === "INSTANCE_NOT_READY" || ae.code === "SANDBOX_UNAVAILABLE" ? "SERVICE_UNAVAILABLE" : ae.code, ae.message);
    }
    const context: HandlerContext = {
      callId: `${callId}:target`, appId: prep.grant.target_app_id, revisionId: prep.snap.revisionId, appEpoch: prep.snap.appEpoch, dataEpoch: prep.snap.dataEpoch,
      logicalTime: this.now(), deadline: iso(s.clock.now() + timeout), records: prep.snap.records,
    };
    // Immediate admission: a busy target answers APP_BUSY instead of queueing behind the caller (spec §11.3).
    const out = await this.ctx.instances!.call(target.inst, "query", prep.queryId, p.input, context, timeout, { immediate: true, asService: true });
    if (utf8Bytes(canonicalJson(out ?? null)) > RUNTIME_POLICY.ipc.maxOutputBytes) throw new AgentOsError("LIMIT_EXCEEDED", `service output exceeds ${CODE_LIMITS.maxServiceOutputBytes} bytes`);
    const outIssue = rpcValueIssue(prep.decl.outputSchema, out);
    if (outIssue) throw new AgentOsError("SERVICE_CONTRACT_MISMATCH", `the service returned output that does not match its contract at ${outIssue.path}`);
    // Re-check before delivering: not revoked, both sides still on the granted revisions.
    s.read(() => {
      const g = s.get<GrantRow>("SELECT * FROM service_grants WHERE id = ?", prep.grant.id);
      if (!g || g.revoked_at) throw new AgentOsError("GRANT_REVOKED", `the "${alias}" service was disconnected`);
      if (this.#state(g).state !== "active") throw new AgentOsError("SERVICE_UNAVAILABLE", "a connected app changed version");
      if (!this.runtime.stillActive(prep.grant.target_app_id, target.inst.id, target.generation)) throw new AgentOsError("SERVICE_UNAVAILABLE", "the providing app restarted");
    });
    return { callId, ok: true, output: out, target: { appId: prep.grant.target_app_id, revisionId: prep.snap.revisionId, dataEpoch: prep.snap.dataEpoch } };
  }
}
