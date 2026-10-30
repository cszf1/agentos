import { userDomain } from "@agentos/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AgentOsError, isV3, parseDto, type CodeBundleV3 } from "@agentos/contracts";
import type { SystemCapabilities, UserWriteMeta } from "@agentos/core";
import type { HostRuntime } from "./http.js";
import { historyAll } from "./backup-v3.js";

/**
 * v0.3 HTTP endpoints (spec §21.1). Every write keeps local auth, same origin, JSON, client epoch, the idempotency
 * receipt and the error envelope. A 202 only means "accepted"; outcomes are read from the action DTO.
 */
export function registerSystemRoutes(
  app: FastifyInstance,
  rt: HostRuntime,
  h: {
    requireSession: (req: FastifyRequest) => void;
    writeMeta: (req: FastifyRequest) => UserWriteMeta;
    withWrite: <T>(fn: () => T | Promise<T>) => Promise<T>;
    ok: (reply: FastifyReply, status: number, data: unknown) => FastifyReply;
  },
): void {
  const { core } = rt;
  const caps = (): SystemCapabilities => {
    if (!rt.caps) throw new AgentOsError("PROVIDER_UNAVAILABLE", "system capabilities are not available on this host");
    return rt.caps;
  };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const ACTION = /^sa_[0-9a-f]{24}$/;
  const GRANT = /^pg_[0-9a-f]{20}$/;
  const RES = /^res_[a-z0-9_]{4,64}$/;
  const principal = { kind: "user" as const };

  /**
   * Async writes (provider calls happen outside SQLite): an existing receipt replays without redoing anything;
   * otherwise do the work, then record the receipt. Final domain errors are stored as receipts too.
   */
  const asyncWrite = async <T>(cap: string, meta: UserWriteMeta, work: () => Promise<{ status: number; body: T }>) => {
    const prior = core.store.get<{ request_hash: string }>("SELECT request_hash FROM operations WHERE principal = ? AND operation_key = ?", userDomain(), meta.operationKey);
    if (prior) return core.gateway.write(cap, { principal, ...meta }, () => {
      throw new AgentOsError("INTERNAL" as never, "unreachable: receipt exists");
    });
    // Admission before any side effect: a stale client epoch (or a denied principal) must not run `work()`.
    core.gateway.admit(cap, { principal, ...meta });
    let out: { status: number; body: T };
    try {
      out = await work();
    } catch (e) {
      if (e instanceof AgentOsError) {
        try {
          core.gateway.write(cap, { principal, ...meta }, () => {
            throw e;
          });
        } catch {
          /* rethrown below */
        }
      }
      throw e;
    }
    return core.gateway.write(cap, { principal, ...meta }, () => out);
  };

  // ---- catalog, resources ----
  app.get("/api/providers", async (req, reply) => {
    h.requireSession(req);
    return h.ok(reply, 200, { catalogVersion: 1, items: caps().providerCatalog(), broker: caps().broker.status });
  });

  app.get("/api/system-resources", async (req, reply) => {
    h.requireSession(req);
    const c = caps();
    const items = c.resources.list().map((r) => {
      const v0 = c.resources.view(r);
      // The telemetry resource is only as available as its collector (no BTF/tracepoints → unavailable, with the reason).
      const tel = (c.state() as { providers?: Record<string, unknown> }).providers?.telemetry as { available?: boolean; reason?: string } | undefined;
      const v = r.kind === "telemetry" && tel && !tel.available ? { ...v0, status: "unavailable" as const, statusReason: tel.reason ?? "collector unavailable" } : v0;
      const grants = core.store.all<{ app_id: string; binding_alias: string; sync_state: string }>("SELECT DISTINCT app_id, binding_alias, sync_state FROM provider_grants WHERE principal_kind = 'app' AND resource_id = ? AND revoked_at IS NULL", r.id);
      const last = core.store.get<{ observed_at: string; quality: string; capability_id: string; summary_json: string }>("SELECT observed_at, quality, capability_id, summary_json FROM resource_observations WHERE resource_id = ? ORDER BY observed_at DESC LIMIT 1", r.id);
      return { ...v, connectedApps: grants, lastObservation: last ? { observedAt: last.observed_at, quality: last.quality, capabilityId: last.capability_id, summary: JSON.parse(last.summary_json) } : null };
    });
    return h.ok(reply, 200, { items, broker: c.broker.status });
  });

  app.post("/api/system-resources/import-roots", async (req, reply) =>
    h.withWrite(async () => {
      const meta = h.writeMeta(req);
      const body = parseDto<{ path: string; displayName?: string }>("importRootCreate", req.body);
      const r = await asyncWrite("system.resources.manage", meta, async () => {
        const row = await caps().resources.registerImportRoot(body.path, body.displayName);
        caps().startWatcher();
        return { status: 201, body: caps().resources.view(row) };
      });
      return h.ok(reply, r.status, r.body);
    }),
  );

  // Snapshot read of a resource for the Shell (user scope; recorded as an observation with its time).
  app.post<{ Params: { resourceId: string } }>("/api/system-resources/:resourceId/read", async (req, reply) => {
    h.requireSession(req);
    if (!RES.test(req.params.resourceId)) throw new AgentOsError("NOT_FOUND", "resource not found");
    const b = req.body as { capabilityId?: unknown; params?: unknown } | null;
    if (!b || typeof b.capabilityId !== "string") throw new AgentOsError("INVALID_REQUEST", "capabilityId is required");
    return h.ok(reply, 200, await caps().userRead(req.params.resourceId, b.capabilityId, b.params ?? {}));
  });

  // ---- provider grants ----
  app.get("/api/provider-grants", async (req, reply) => {
    h.requireSession(req);
    return h.ok(reply, 200, { items: caps().grants.list() });
  });

  // The app's declared bindings and their connection state (for the connect page and the app banner).
  app.get<{ Params: { appId: string } }>("/api/apps/:appId/system-bindings", async (req, reply) => {
    h.requireSession(req);
    if (!UUID.test(req.params.appId)) throw new AgentOsError("NOT_FOUND", "app not found");
    const row = core.apps.requireApp(req.params.appId);
    const b = row.active_revision_id ? core.apps.revisionBundle(row.id, row.active_revision_id) : null;
    if (!b || !isV3(b)) return h.ok(reply, 200, { items: [], actions: [] });
    const v3 = b as CodeBundleV3;
    const items = v3.system.bindings.map((bd) => {
      const gs = caps().grants.list().filter((g) => g.principal.appId === row.id && g.principal.revisionId === row.active_revision_id && g.bindingAlias === bd.alias && g.state !== "revoked");
      return { ...bd, grants: gs, connected: gs.length > 0 && gs.every((g) => g.state === "active") };
    });
    return h.ok(reply, 200, { items, actions: Object.entries(v3.system.actions).map(([id, a]) => ({ handlerId: id, ...a })) });
  });

  app.post("/api/provider-grants", async (req, reply) =>
    h.withWrite(async () => {
      const meta = h.writeMeta(req);
      const body = parseDto<{ appId: string; bindingAlias: string; resourceId: string; confirmationPolicy: "per_plan" | "standing"; expiresInDays?: number; bounds?: Record<string, Record<string, unknown>> }>("providerGrantCreate", req.body);
      const r = core.gateway.write("system.grants.manage", { principal, ...meta }, () => ({ status: 202, body: { items: caps().grants.createAppGrantsInTx(body).map((g) => caps().grants.view(g)) } }));
      caps().actions.kick();
      return h.ok(reply, r.status, r.body);
    }),
  );

  app.post<{ Params: { grantId: string } }>("/api/provider-grants/:grantId/revoke", async (req, reply) =>
    h.withWrite(async () => {
      const meta = h.writeMeta(req);
      parseDto("empty", req.body);
      if (!GRANT.test(req.params.grantId)) throw new AgentOsError("NOT_FOUND", "grant not found");
      // Host blocks new admissions in this transaction; the broker confirms asynchronously (state "revoking").
      const r = core.gateway.write("system.grants.manage", { principal, ...meta }, () => ({ status: 202, body: { items: caps().grants.revokeConnectionInTx(req.params.grantId, "user revoked").map((g) => caps().grants.view(g)) } }));
      caps().actions.kick();
      return h.ok(reply, r.status, r.body);
    }),
  );

  // ---- system actions ----
  app.post<{ Params: { appId: string; handlerId: string } }>("/api/apps/:appId/system-actions/:handlerId", { bodyLimit: 160 * 1024 }, async (req, reply) =>
    h.withWrite(async () => {
      const meta = h.writeMeta(req);
      if (!UUID.test(req.params.appId)) throw new AgentOsError("NOT_FOUND", "app not found");
      const body = parseDto<{ expectedAppEpoch: number; input: unknown }>("systemActionPlan", req.body);
      const r = await asyncWrite("system.actions.plan", meta, async () => {
        const a = await caps().planFromApp(req.params.appId, req.params.handlerId, body.input, body.expectedAppEpoch);
        return { status: 201, body: caps().actions.view(a) };
      });
      return h.ok(reply, r.status, r.body);
    }),
  );

  app.get<{ Params: { actionId: string } }>("/api/system-actions/:actionId", async (req, reply) => {
    h.requireSession(req);
    if (!ACTION.test(req.params.actionId)) throw new AgentOsError("NOT_FOUND", "system action not found");
    return h.ok(reply, 200, caps().actions.view(caps().actions.require(req.params.actionId)));
  });

  app.post<{ Params: { actionId: string } }>("/api/system-actions/:actionId/confirm", async (req, reply) =>
    h.withWrite(async () => {
      const meta = h.writeMeta(req);
      if (!ACTION.test(req.params.actionId)) throw new AgentOsError("NOT_FOUND", "system action not found");
      const body = parseDto<{ planHash: string }>("systemActionConfirm", req.body);
      const r = core.gateway.write("system.actions.confirm", { principal, ...meta }, () => ({ status: 202, body: caps().actions.view(caps().actions.confirmInTx(req.params.actionId, body.planHash, meta.operationKey)) }));
      caps().actions.kick();
      return h.ok(reply, r.status, r.body);
    }),
  );

  app.post<{ Params: { actionId: string } }>("/api/system-actions/:actionId/cancel", async (req, reply) =>
    h.withWrite(async () => {
      const meta = h.writeMeta(req);
      if (!ACTION.test(req.params.actionId)) throw new AgentOsError("NOT_FOUND", "system action not found");
      const body = parseDto<{ reason?: string }>("systemActionCancel", req.body ?? {});
      const r = await asyncWrite("system.actions.manage", meta, async () => ({ status: 202, body: caps().actions.view(await caps().actions.cancel(req.params.actionId, body.reason ?? "cancelled by the user")) }));
      return h.ok(reply, r.status, r.body);
    }),
  );

  app.post<{ Params: { actionId: string } }>("/api/system-actions/:actionId/resolve", async (req, reply) =>
    h.withWrite(async () => {
      const meta = h.writeMeta(req);
      if (!ACTION.test(req.params.actionId)) throw new AgentOsError("NOT_FOUND", "system action not found");
      const body = parseDto<{ decision: "confirmed_applied" | "confirmed_not_applied" | "accept_unknown"; note: string; releaseQuarantine?: boolean }>("systemActionResolve", req.body);
      const r = await asyncWrite("system.actions.manage", meta, async () => ({ status: 200, body: caps().actions.view(await caps().actions.resolve(req.params.actionId, body.decision, body.note, body.releaseQuarantine ?? false)) }));
      return h.ok(reply, r.status, r.body);
    }),
  );

  app.post<{ Params: { actionId: string } }>("/api/system-actions/:actionId/compensations", async (req, reply) =>
    h.withWrite(async () => {
      const meta = h.writeMeta(req);
      if (!ACTION.test(req.params.actionId)) throw new AgentOsError("NOT_FOUND", "system action not found");
      parseDto("empty", req.body ?? {});
      const r = await asyncWrite("system.actions.manage", meta, async () => ({ status: 201, body: caps().actions.view(await caps().compensate(req.params.actionId)) }));
      return h.ok(reply, r.status, r.body);
    }),
  );

  // Global operation center: independent of app rendering, instance liveness and the current version (spec §21.2).
  app.get<{ Querystring: { open?: string; appId?: string } }>("/api/system-operations", async (req, reply) => {
    h.requireSession(req);
    const c = caps();
    const items = c.actions.list({ open: req.query.open === "1", appId: req.query.appId && UUID.test(req.query.appId) ? req.query.appId : undefined, limit: 200 });
    // Operations the broker knows that this (restored) workspace has no row for.
    let brokerOnly: unknown[] = [];
    try {
      const st = await c.broker.ensure();
      if (st.brokerReady && st.machineInstallId) {
        const h2 = { operations: (await historyAll(c.broker.client, st.machineInstallId)).ops };
        const known = new Set(core.store.all<{ operation_id: string }>("SELECT operation_id FROM system_actions WHERE operation_id IS NOT NULL").map((x) => x.operation_id));
        brokerOnly = h2.operations.filter((o) => !known.has(o.operationId)).map((o) => ({ ...o, source: "broker-only" }));
      }
    } catch {
      /* broker unavailable: local view only, marked in state */
    }
    return h.ok(reply, 200, { items, brokerOnly, broker: c.broker.status });
  });

  app.get<{ Querystring: { sinceSeq?: string; limit?: string } }>("/api/observations", async (req, reply) => {
    h.requireSession(req);
    const since = Number(req.query.sinceSeq ?? 0);
    const limit = Number(req.query.limit ?? 200);
    if (!Number.isSafeInteger(since) || since < 0 || !Number.isSafeInteger(limit)) throw new AgentOsError("INVALID_REQUEST", "sinceSeq/limit must be integers");
    return h.ok(reply, 200, { ...caps().observations.events(since, limit), telemetry: { ...caps().observations.telemetry } });
  });
}
