import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AgentOsError, MAINTENANCE_TEMPLATES, V4_LIMITS, type MaintenanceTemplateId, type PolicyCreateBody } from "@agentos/contracts";
import type { UserWriteMeta } from "@agentos/core";
import type { HostRuntime } from "./http.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function obj(v: unknown, allowed: string[], name = "body"): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new AgentOsError("INVALID_REQUEST", `${name} must be a JSON object`);
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new AgentOsError("INVALID_REQUEST", `unknown field ${k}`);
  return v as Record<string, unknown>;
}

/**
 * v0.4 HTTP surface (spec §22.1): maintenance templates/policies/control/checks/jobs, health incidents, proposals,
 * archive/restore and compactions. Every write keeps the session, same-origin JSON, client epoch, Idempotency-Key and the
 * frozen request hash; the maintenance controller never calls these user endpoints.
 */
export function registerMaintenanceRoutes(
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
  const m = core.maintenance;
  const user = { kind: "user" as const };
  const write = <T>(cap: string, meta: UserWriteMeta, fn: () => { status: number; body: T }) => core.gateway.write(cap, { principal: user, ...meta }, fn);

  // ---------------------------------------------------------------- templates, policies

  app.get("/api/maintenance/templates", async (req, reply) => {
    h.requireSession(req);
    return h.ok(reply, 200, {
      items: Object.values(MAINTENANCE_TEMPLATES).map((t) => ({ ...t, automaticWhitelist: t.automaticActions })),
      limits: { maxEnabledPolicies: V4_LIMITS.maxEnabledPolicies, minIntervalSeconds: V4_LIMITS.minIntervalSeconds, maxIntervalSeconds: V4_LIMITS.maxIntervalSeconds, policyDefaultDays: V4_LIMITS.policyDefaultDays, policyMaxDays: V4_LIMITS.policyMaxDays },
      neverAutomatic: ["user records", "historical revisions", "native logs/receipts", "serial sends", "network changes", "service limit changes", "code publication"],
    });
  });

  app.get("/api/maintenance/policies", async (req, reply) => {
    h.requireSession(req);
    return h.ok(reply, 200, { items: m.policies.list().map((p) => m.policies.view(p)) });
  });

  app.post("/api/maintenance/policies", async (req, reply) =>
    h.withWrite(() => {
      const meta = h.writeMeta(req);
      const b = obj(req.body, ["templateId", "target", "mode", "trigger", "params", "expiresInDays", "policyId"]);
      const r = write("maintenance.policies.manage", meta, () => {
        const p = m.policies.create(b as unknown as PolicyCreateBody & { policyId?: string });
        return { status: 201, body: m.policies.view(p) };
      });
      return h.ok(reply, r.status, r.body);
    }),
  );

  app.post<{ Params: { id: string } }>("/api/maintenance/policies/:id/approve", async (req, reply) =>
    h.withWrite(() => {
      const meta = h.writeMeta(req);
      const b = obj(req.body, ["version", "policyHash"]);
      if (!Number.isSafeInteger(b.version) || typeof b.policyHash !== "string") throw new AgentOsError("INVALID_REQUEST", "version and policyHash are required");
      const r = write("maintenance.policies.manage", meta, () => {
        const p = m.policies.approve(req.params.id, b.version as number, b.policyHash as string);
        // a service policy is enabled only after the broker confirmed it (POLICY_SYNC_PENDING until then)
        return { status: p.state === "syncing" ? 202 : 200, body: m.policies.view(p) };
      });
      return h.ok(reply, r.status, r.body);
    }),
  );

  app.post<{ Params: { id: string } }>("/api/maintenance/policies/:id/pause", async (req, reply) =>
    h.withWrite(() => {
      const meta = h.writeMeta(req);
      obj(req.body ?? {}, []);
      const r = write("maintenance.policies.manage", meta, () => {
        const p = m.policies.pause(req.params.id, "user");
        const v = m.policies.view(p);
        return { status: 200, body: { ...v, local: "paused", root: p.root_sync_state === "revoking" ? "revoking (pending broker confirmation)" : p.root_sync_state } };
      });
      return h.ok(reply, r.status, r.body);
    }),
  );

  app.post("/api/maintenance/control", async (req, reply) =>
    h.withWrite(async () => {
      const meta = h.writeMeta(req);
      const b = obj(req.body, ["action"]);
      if (b.action !== "pause" && b.action !== "resume") throw new AgentOsError("INVALID_REQUEST", "action must be pause or resume");
      const r = write("maintenance.control", meta, () => {
        const st = b.action === "pause" ? m.jobs.pause() : m.jobs.resume();
        return { status: 200, body: { ...st, local: st.state, rootConfirmed: st.root === "synced" } };
      });
      if (b.action === "pause") {
        // stop new background model requests of maintenance runs at once (targeted cancel; foreground untouched)
        for (const run of core.runs.unfinished().filter((x) => x.background === 1)) core.runs.requestStop(run.id, "maintenance_paused");
        void rt.coord?.kick();
      }
      return h.ok(reply, r.status, r.body);
    }),
  );

  app.post("/api/maintenance/checks", async (req, reply) =>
    h.withWrite(() => {
      const meta = h.writeMeta(req);
      const b = obj(req.body, ["templateId", "target"]);
      const tpl = MAINTENANCE_TEMPLATES[b.templateId as MaintenanceTemplateId];
      if (!tpl) throw new AgentOsError("INVALID_REQUEST", "unknown templateId");
      const t = obj(b.target, ["kind", "id"], "target");
      const r = write("maintenance.checks", meta, () => ({ status: 202, body: m.jobs.manualCheck(tpl.id, { kind: String(t.kind), id: String(t.id) }, meta.operationKey) }));
      return h.ok(reply, r.status, { ...r.body, note: "accepted: a one-off check; it grants no standing authorization" });
    }),
  );

  app.get<{ Querystring: Record<string, string> }>("/api/maintenance/jobs", async (req, reply) => {
    h.requireSession(req);
    const rows = m.jobs.list({ open: req.query.open === "1" || req.query.open === "true", limit: req.query.limit ? Number(req.query.limit) : undefined });
    return h.ok(reply, 200, { items: rows.map((j) => m.jobs.view(j)) });
  });

  app.get<{ Params: { id: string } }>("/api/maintenance/jobs/:id", async (req, reply) => {
    h.requireSession(req);
    return h.ok(reply, 200, m.jobs.view(m.jobs.requireJob(req.params.id)));
  });

  app.post<{ Params: { id: string } }>("/api/maintenance/jobs/:id/cancel", async (req, reply) =>
    h.withWrite(() => {
      const meta = h.writeMeta(req);
      obj(req.body ?? {}, []);
      const r = write("maintenance.jobs.manage", meta, () => ({ status: 202, body: m.jobs.view(m.jobs.cancel(req.params.id)) }));
      return h.ok(reply, r.status, r.body);
    }),
  );

  app.post<{ Params: { id: string } }>("/api/maintenance/jobs/:id/approve", async (req, reply) =>
    h.withWrite(() => {
      const meta = h.writeMeta(req);
      obj(req.body ?? {}, []);
      const r = write("maintenance.jobs.manage", meta, () => ({ status: 202, body: m.jobs.view(m.jobs.approveJob(req.params.id)) }));
      return h.ok(reply, r.status, r.body);
    }),
  );

  /** Maintenance center overview: state, budgets, circuits, root sync, metrics (spec §22.2, §24.2). */
  app.get("/api/maintenance/state", async (req, reply) => {
    h.requireSession(req);
    const circuits = core.store.all("SELECT target_kind AS targetKind, target_id AS targetId, action_family AS actionFamily, state, consecutive_failures AS consecutiveFailures, opened_at AS openedAt, reason FROM maintenance_circuits");
    return h.ok(reply, 200, {
      ...m.jobs.state(),
      clock: m.clock.state,
      lastSleep: m.clock.lastSleep,
      budgets: { limits: core.budgets.limits(), usage: core.budgets.summary() },
      circuits,
      metrics: rt.maint?.metrics() ?? null,
      lastSampleAt: m.health.lastSampleAt(),
      foreground: { slots: core.runs.foregroundSlots, queued: core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE background = 0 AND scheduling_state IN ('waiting_slot','waiting_target')")!.n },
    });
  });

  app.post("/api/maintenance/clock/recheck", async (req, reply) =>
    h.withWrite(() => {
      const meta = h.writeMeta(req);
      obj(req.body ?? {}, []);
      const r = write("maintenance.control", meta, () => ({ status: 200, body: { clock: m.clock.recheck() } }));
      return h.ok(reply, r.status, r.body);
    }),
  );

  app.post("/api/maintenance/circuits/reset", async (req, reply) =>
    h.withWrite(() => {
      const meta = h.writeMeta(req);
      const b = obj(req.body, ["targetKind", "targetId"]);
      const r = write("maintenance.control", meta, () => {
        if (b.targetKind === "app") rt.maint?.appRecovery?.resetCircuit(String(b.targetId));
        else if (b.targetKind === "service") rt.maint?.service?.resetCircuit(String(b.targetId));
        else throw new AgentOsError("INVALID_REQUEST", "targetKind must be app or service");
        return { status: 200, body: { reset: true } };
      });
      return h.ok(reply, r.status, r.body);
    }),
  );

  app.post("/api/maintenance/settings", async (req, reply) =>
    h.withWrite(() => {
      const meta = h.writeMeta(req);
      const b = obj(req.body, ["backgroundModel", "modelRequestsPer24h", "backgroundModelRequestsPer24h", "backgroundOutputTokensPer24h"]);
      const r = write("settings.budgets", meta, () => {
        if (b.backgroundModel !== undefined) m.jobs.setBackgroundModel(b.backgroundModel === true);
        const lim = core.budgets.setLimits({
          modelRequestsPer24h: b.modelRequestsPer24h as number | undefined,
          backgroundModelRequestsPer24h: b.backgroundModelRequestsPer24h as number | undefined,
          backgroundOutputTokensPer24h: b.backgroundOutputTokensPer24h as number | undefined,
        });
        return { status: 200, body: { backgroundModel: m.jobs.state().backgroundModel, limits: lim } };
      });
      return h.ok(reply, r.status, r.body);
    }),
  );

  app.get("/api/maintenance/reports", async (req, reply) => {
    h.requireSession(req);
    return h.ok(reply, 200, { items: core.proposals.reports() });
  });

  // ---------------------------------------------------------------- managed services: user intent (spec §16)

  app.post<{ Params: { id: string } }>("/api/system-resources/:id/maintenance-control", async (req, reply) =>
    h.withWrite(() => {
      const meta = h.writeMeta(req);
      const b = obj(req.body, ["intent"]);
      if (b.intent !== "stopped" && b.intent !== "running") throw new AgentOsError("INVALID_REQUEST", "intent must be stopped or running");
      const svc = rt.maint?.service;
      if (!svc) throw new AgentOsError("PROVIDER_UNAVAILABLE", "service maintenance is not available");
      const r = write("maintenance.control", meta, () => ({ status: 200, body: { controlEpoch: svc.userControl(req.params.id, b.intent as "stopped" | "running"), ...svc.controlEpoch(req.params.id) } }));
      return h.ok(reply, r.status, r.body);
    }),
  );

  // ---------------------------------------------------------------- health, notifications

  app.get<{ Querystring: Record<string, string> }>("/api/health/incidents", async (req, reply) => {
    h.requireSession(req);
    const rows = m.incidents.list({ open: req.query.open === "1" || req.query.open === "true", limit: req.query.limit ? Number(req.query.limit) : undefined });
    return h.ok(reply, 200, { items: rows.map((i) => m.incidents.view(i)) });
  });

  app.get("/api/notifications", async (req, reply) => {
    h.requireSession(req);
    return h.ok(reply, 200, { items: m.notifications.list(true) });
  });

  app.post<{ Params: { id: string } }>("/api/notifications/:id/read", async (req, reply) =>
    h.withWrite(() => {
      const meta = h.writeMeta(req);
      obj(req.body ?? {}, []);
      const r = write("maintenance.control", meta, () => {
        m.notifications.markRead(req.params.id);
        return { status: 200, body: { read: true } };
      });
      return h.ok(reply, r.status, r.body);
    }),
  );

  // ---------------------------------------------------------------- proposals

  app.get("/api/proposals", async (req, reply) => {
    h.requireSession(req);
    return h.ok(reply, 200, { items: core.proposals.list() });
  });

  app.post<{ Params: { id: string } }>("/api/proposals/:id/accept", async (req, reply) =>
    h.withWrite(() => {
      const meta = h.writeMeta(req);
      const b = obj(req.body, ["proposalHash", "expectedAppEpoch"]);
      if (typeof b.proposalHash !== "string" || !Number.isSafeInteger(b.expectedAppEpoch)) throw new AgentOsError("INVALID_REQUEST", "proposalHash and expectedAppEpoch are required");
      if (!UUID.test(req.params.id)) throw new AgentOsError("NOT_FOUND", "proposal not found");
      let r: ReturnType<typeof write>;
      try {
        r = write("proposals.decide", meta, () => {
        const p = core.proposals.acceptInTx(req.params.id, b.proposalHash as string, b.expectedAppEpoch as number, `proposal:${req.params.id}`, meta.requestHash);
        if (p.job_id) m.jobs.finish(p.job_id, "succeeded", `candidate accepted by the user; publication runs as deployment ${p.deployment_id}`, "none");
        return { status: 202, body: core.proposals.view(p) };
        });
      } catch (e) {
        core.proposals.applyRefusalMark(req.params.id, e);
        throw e;
      }
      return h.ok(reply, r.status, r.body);
    }),
  );

  app.post<{ Params: { id: string } }>("/api/proposals/:id/reject", async (req, reply) =>
    h.withWrite(() => {
      const meta = h.writeMeta(req);
      obj(req.body ?? {}, []);
      if (!UUID.test(req.params.id)) throw new AgentOsError("NOT_FOUND", "proposal not found");
      const r = write("proposals.decide", meta, () => {
        const p = core.proposals.rejectInTx(req.params.id);
        if (p.job_id) m.jobs.finish(p.job_id, "no_change", "candidate rejected by the user", "none");
        return { status: 200, body: core.proposals.view(p) };
      });
      return h.ok(reply, r.status, r.body);
    }),
  );

  // ---------------------------------------------------------------- archive / restore (spec §18)

  app.get<{ Params: { appId: string } }>("/api/apps/:appId/lifecycle", async (req, reply) => {
    h.requireSession(req);
    return h.ok(reply, 200, core.lifecycle.view(req.params.appId));
  });

  app.post<{ Params: { appId: string } }>("/api/apps/:appId/archive", async (req, reply) =>
    h.withWrite(() => {
      const meta = h.writeMeta(req);
      obj(req.body ?? {}, ["expectedAppEpoch"]);
      if (!UUID.test(req.params.appId)) throw new AgentOsError("NOT_FOUND", "app not found");
      const r = write("apps.lifecycle", meta, () => {
        const row = core.lifecycle.archive(req.params.appId, "user");
        return { status: row.state === "archived" ? 200 : 202, body: core.lifecycle.view(req.params.appId) };
      });
      return h.ok(reply, r.status, r.body);
    }),
  );

  app.post<{ Params: { appId: string } }>("/api/apps/:appId/restore", async (req, reply) =>
    h.withWrite(() => {
      const meta = h.writeMeta(req);
      obj(req.body ?? {}, []);
      if (!UUID.test(req.params.appId)) throw new AgentOsError("NOT_FOUND", "app not found");
      const r = write("apps.lifecycle", meta, () => {
        core.lifecycle.restore(req.params.appId);
        return { status: 200, body: { ...core.lifecycle.view(req.params.appId), note: "provider connections must be granted again; old grants are never revived" } };
      });
      void rt.sys?.reconciler.runOnce().catch(() => undefined);
      return h.ok(reply, r.status, r.body);
    }),
  );

  // ---------------------------------------------------------------- compactions (spec §20)

  app.get<{ Params: { id: string } }>("/api/conversations/:id/compactions", async (req, reply) => {
    h.requireSession(req);
    return h.ok(reply, 200, { items: core.compactions.list(req.params.id).map((j) => core.compactions.view(j)) });
  });

  app.post<{ Params: { id: string } }>("/api/conversations/:id/compactions", async (req, reply) =>
    h.withWrite(async () => {
      const meta = h.writeMeta(req);
      const b = obj(req.body ?? {}, ["allowProviderContent", "instructions"]);
      const prior = core.store.get<{ response_json: string }>("SELECT response_json FROM operations WHERE principal = 'user:local' AND operation_key = ?", meta.operationKey);
      if (prior) return h.ok(reply, 202, write("conversations.compact", meta, () => ({ status: 202, body: null })).body);
      const job = await core.compactions.request(req.params.id, { allowProviderContent: b.allowProviderContent === true, instructions: typeof b.instructions === "string" ? b.instructions : undefined });
      const r = write("conversations.compact", meta, () => ({ status: 202, body: core.compactions.view(job) }));
      return h.ok(reply, r.status, r.body);
    }),
  );

  app.post<{ Params: { id: string } }>("/api/compactions/:id/cancel", async (req, reply) =>
    h.withWrite(async () => {
      const meta = h.writeMeta(req);
      obj(req.body ?? {}, []);
      const j = await core.compactions.cancel(req.params.id);
      const r = write("conversations.compact", meta, () => ({ status: 200, body: core.compactions.view(j) }));
      return h.ok(reply, r.status, r.body);
    }),
  );
}
