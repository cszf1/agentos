import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import {
  AgentOsError,
  HOST_VERSION,
  LIMITS,
  canonicalJson,
  isAgentOsError,
  parseDto,
  sha256Hex,
  type ActivateBody,
  type AuthSessionBody,
  type RecordCreateBody,
  type RecordDeleteBody,
  type RecordPatchBody,
  type RunCreateBody,
  type StateView,
} from "@agentos/contracts";
import { fault, readSystemInfo, type AgentEngine, type Core, type RunCoordinator, type RuntimeSystem, type UserWriteMeta } from "@agentos/core";
import { COOKIE, parseCookies, type SessionAuth } from "./auth.js";
import type { HostConfig } from "./config.js";
import type { Logger } from "./log.js";

export interface ModelInfo {
  available: boolean;
  diagnostic: string | null;
  ref: { provider: string; modelId: string } | null;
  mode: "real" | "faux";
}

export interface HostStatus {
  phase: "starting" | "ready" | "stopping";
  /** False when recovery found an inconsistency: reads stay available, business writes are refused. */
  writable: boolean;
  agentState: "ready" | "blocked" | "unavailable";
  agentDiagnostic: string | null;
}

export interface HostRuntime {
  config: HostConfig;
  core: Core;
  engine: AgentEngine | null;
  coord: RunCoordinator | null;
  model: ModelInfo;
  auth: SessionAuth;
  log: Logger;
  status: HostStatus;
  /** Number of business write handlers currently executing (drained on shutdown). */
  inflight: { n: number };
  /** v0.2 code runtime (null until booted or when it failed to start). */
  sys: RuntimeSystem | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sendError(reply: FastifyReply, e: AgentOsError): FastifyReply {
  return reply.code(e.status).send({ error: e.toBody() });
}

export function buildServer(rt: HostRuntime): FastifyInstance {
  const { config, core, log } = rt;
  const app = Fastify({ logger: false, genReqId: () => randomUUID(), bodyLimit: LIMITS.maxBodyBytes, trustProxy: false, return503OnClosing: true });

  // Every request: exact Host allow-list (DNS rebinding), security headers.
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    reply.header("Cache-Control", "no-store");
    const host = req.headers.host ?? "";
    if (!config.allowedHosts.includes(host)) {
      return sendError(reply, new AgentOsError("FORBIDDEN", "host not allowed"));
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.headers.origin;
      if (origin !== undefined && !config.allowedHosts.some((h) => origin === `http://${h}`)) {
        return sendError(reply, new AgentOsError("FORBIDDEN", "cross-origin writes are not allowed"));
      }
      const site = req.headers["sec-fetch-site"];
      if (site === "cross-site" || site === "same-site") return sendError(reply, new AgentOsError("FORBIDDEN", "cross-site writes are not allowed"));
      const ct = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (ct !== "application/json") return sendError(reply, new AgentOsError("UNSUPPORTED_MEDIA_TYPE", "writes must be application/json"));
    }
  });

  // Spec §15 request log: ids, status and duration; never tokens, cookies, bodies or record contents.
  app.addHook("onResponse", async (req, reply) => {
    const params = (req.params ?? {}) as Record<string, string | undefined>;
    const fields: Record<string, unknown> = {
      requestId: req.id,
      method: req.method,
      route: req.routeOptions?.url ?? null,
      status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    };
    if (params.appId) fields.appId = params.appId;
    if (params.runId) fields.runId = params.runId;
    if (params.recordId) fields.recordId = params.recordId;
    if (params.deploymentId) fields.deploymentId = params.deploymentId;
    if (params.invocationId) fields.invocationId = params.invocationId;
    if (params.grantId) fields.grantId = params.grantId;
    if (params.queryId) fields.queryId = params.queryId;
    if (params.commandId) fields.commandId = params.commandId;
    const key = req.headers["idempotency-key"];
    if (typeof key === "string") fields.operationKey = key;
    const routine = (req.method === "GET" || req.method === "HEAD") && reply.statusCode < 400;
    if (routine) log.debug("request", fields);
    else log.info("request", fields);
  });

  app.setErrorHandler((err, req, reply) => {
    if (isAgentOsError(err)) return sendError(reply, err);
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode === 413) return sendError(reply, new AgentOsError("LIMIT_EXCEEDED", "request body too large"));
    if (e.statusCode === 400 || e.statusCode === 415) return sendError(reply, new AgentOsError("INVALID_REQUEST", "malformed request"));
    if (/SQLITE_BUSY|database is locked|disk I\/O/i.test(e.message)) {
      log.error("store unavailable", { path: req.url, error: e.message });
      return sendError(reply, new AgentOsError("STORE_UNAVAILABLE", "the local store is busy; retry"));
    }
    log.error("unhandled error", { path: req.routeOptions?.url, error: e.message });
    return reply.code(500).send({ error: { code: "INTERNAL", message: "internal error", retryable: false } });
  });

  const clientEpoch = () => core.store.meta().client_epoch;

  const requireSession = (req: FastifyRequest) => {
    const cookie = parseCookies(req.headers.cookie)[COOKIE];
    if (!rt.auth.verify(cookie, clientEpoch())) throw new AgentOsError("AUTH_REQUIRED", "sign in with the local token");
  };

  const requireReady = () => {
    if (rt.status.phase !== "ready") throw new AgentOsError("STORE_UNAVAILABLE", rt.status.phase === "stopping" ? "host is shutting down" : "host is starting");
  };

  /** Session, idempotency key, client epoch header and request hash for a business write. */
  const writeMeta = (req: FastifyRequest): UserWriteMeta => {
    requireSession(req);
    requireReady();
    if (!rt.status.writable) throw new AgentOsError("RECOVERY_BLOCKED", rt.status.agentDiagnostic ?? "workspace recovery is required; writes are paused");
    const key = String(req.headers["idempotency-key"] ?? "");
    if (!UUID.test(key)) throw new AgentOsError("INVALID_REQUEST", "Idempotency-Key must be a lowercase UUID");
    const ep = Number(req.headers["x-agentos-epoch"]);
    if (!Number.isSafeInteger(ep)) throw new AgentOsError("INVALID_REQUEST", "X-AgentOS-Epoch header is required");
    const normPath = (req.routeOptions.url ?? req.url).replace(/:(\w+)/g, (_m, p: string) => `:${p}=${String((req.params as Record<string, string>)[p])}`);
    const requestHash = sha256Hex(canonicalJson({ method: req.method, path: normPath, principal: "user:local", body: req.body ?? null }));
    return { operationKey: key, requestHash, clientEpoch: ep };
  };

  const withWrite = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    rt.inflight.n++;
    try {
      return await fn();
    } finally {
      rt.inflight.n--;
    }
  };

  const ok = (reply: FastifyReply, status: number, data: unknown) => reply.code(status).send({ data });

  const runView = (runId: string | undefined) => {
    if (!runId) return null;
    const row = core.runs.getRow(runId);
    return row ? core.runs.view(row) : null;
  };

  // ---- health & auth ----
  app.get("/health/live", async () => ({ status: "live" }));
  app.get("/health/ready", async (_req, reply) => {
    if (rt.status.phase === "ready" && rt.status.writable) return { status: "ready" };
    return reply.code(503).send({ status: rt.status.phase === "ready" ? "unavailable" : "recovering" });
  });

  app.post("/api/auth/session", async (req, reply) => {
    const body = parseDto<AuthSessionBody>("authSession", req.body);
    if (!rt.auth.checkToken(body.token)) throw new AgentOsError("AUTH_REQUIRED", "invalid token");
    const s = rt.auth.issue(clientEpoch());
    reply.header("Set-Cookie", `${COOKIE}=${s.value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${s.maxAgeSec}`);
    return ok(reply, 200, { clientEpoch: clientEpoch() });
  });

  app.delete("/api/auth/session", async (_req, reply) => {
    reply.header("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return ok(reply, 200, { signedOut: true });
  });

  // ---- reads ----
  app.get("/api/state", async (req, reply) => {
    requireSession(req);
    const view: StateView = core.store.read((): StateView => {
      const active = core.runs.activeRun();
      const last = core.runs.lastRun();
      return {
        clientEpoch: clientEpoch(),
        eventSeq: core.store.eventSeq(),
        apps: core.apps.listApps(),
        activeRun: active ? core.runs.view(active) : null,
        lastRun: last ? core.runs.view(last) : null,
        modelAvailable: rt.model.available && rt.status.agentState === "ready",
        model: rt.model.ref ? { ...rt.model.ref, mode: rt.model.mode } : null,
        agentState: rt.status.agentState,
        agentDiagnostic: rt.status.agentDiagnostic ?? rt.model.diagnostic,
        hostVersion: HOST_VERSION,
        ready: rt.status.phase === "ready" && rt.status.writable,
        runtimeReady: rt.sys?.runtimeReady ?? false,
        runtimeProblems: rt.sys ? rt.sys.environmentProblems.slice(0, 10) : ["the code runtime has not started"],
      };
      for (const a of view.apps) {
        const row = core.apps.requireApp(a.appId);
        const b = core.apps.activeBundle(row);
        a.runtime = b?.manifest.runtime;
        a.dataEpoch = row.data_epoch;
        a.health = b?.formatVersion === 2 ? (rt.sys?.runtime.row(a.appId)?.health ?? "stopped") : null;
      }
    });
    return ok(reply, 200, view);
  });

  app.get("/api/system", async (req, reply) => {
    requireSession(req);
    return ok(reply, 200, readSystemInfo());
  });

  app.get<{ Params: { appId: string } }>("/api/apps/:appId", async (req, reply) => {
    requireSession(req);
    if (!UUID.test(req.params.appId)) throw new AgentOsError("NOT_FOUND", "app not found");
    return ok(reply, 200, core.apps.getApp(req.params.appId));
  });

  app.get<{ Params: { appId: string } }>("/api/apps/:appId/revisions", async (req, reply) => {
    requireSession(req);
    if (!UUID.test(req.params.appId)) throw new AgentOsError("NOT_FOUND", "app not found");
    return ok(reply, 200, { items: core.apps.listRevisions(req.params.appId) });
  });

  app.get<{ Params: { appId: string }; Querystring: Record<string, string> }>("/api/apps/:appId/records", async (req, reply) => {
    requireSession(req);
    if (!UUID.test(req.params.appId)) throw new AgentOsError("NOT_FOUND", "app not found");
    const q = req.query;
    let filters: Record<string, unknown> | undefined;
    if (q.filters !== undefined && q.filters !== "") {
      try {
        filters = JSON.parse(q.filters) as Record<string, unknown>;
      } catch {
        throw new AgentOsError("INVALID_REQUEST", "filters must be a JSON object");
      }
    }
    const int = (v: string | undefined, name: string) => {
      if (v === undefined || v === "") return undefined;
      if (!/^\d+$/.test(v)) throw new AgentOsError("INVALID_REQUEST", `${name} must be a non-negative integer`);
      return Number(v);
    };
    const appId = req.params.appId;
    const page = core.records.list({ kind: "app", appId, viaUser: true }, appId, { q: q.q, filters, offset: int(q.offset, "offset"), limit: int(q.limit, "limit") });
    return ok(reply, 200, page);
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (req, reply) => {
    requireSession(req);
    const v = UUID.test(req.params.runId) ? runView(req.params.runId) : null;
    if (!v) throw new AgentOsError("NOT_FOUND", "run not found");
    return ok(reply, 200, v);
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId/transcript", async (req, reply) => {
    requireSession(req);
    const v = UUID.test(req.params.runId) ? runView(req.params.runId) : null;
    if (!v) throw new AgentOsError("NOT_FOUND", "run not found");
    if (["queued", "running", "cancel_requested", "blocked"].includes(v.status)) {
      return ok(reply, 200, { final: false, items: [] });
    }
    if (!rt.engine) return ok(reply, 200, { final: true, items: [] });
    const t = await rt.engine.transcript();
    // Only the entries of this run: from its input onwards (the input mentions the run id).
    const start = t.items.findLastIndex((i) => i.role === "user" && i.text.includes(v.runId));
    const items = (start >= 0 ? t.items.slice(start) : []).slice(-LIMITS.transcriptMaxItems);
    let end = items.length;
    for (let i = 1; i < items.length; i++) if (items[i]!.role === "user") { end = i; break; }
    const usage = rt.engine.usage ? await rt.engine.usage().catch(() => null) : null;
    return ok(reply, 200, { final: true, items: items.slice(0, end), sessionUsage: usage });
  });

  // ---- writes ----
  app.post<{ Params: { appId: string } }>("/api/apps/:appId/activate", async (req, reply) =>
    withWrite(() => {
      const meta = writeMeta(req);
      const body = parseDto<ActivateBody>("activate", req.body);
      const r = rt.sys
        ? rt.sys.activateDeclarativeHistory(meta, req.params.appId, body.revisionId, body.expectedAppEpoch)
        : core.user.activateHistorical(meta, req.params.appId, body.revisionId, body.expectedAppEpoch);
      log.info("app activated", { appId: req.params.appId, revisionId: body.revisionId, appEpoch: r.body.appEpoch, replayed: r.replayed });
      return ok(reply, r.status, r.body);
    }),
  );

  app.post("/api/runs", async (req, reply) =>
    withWrite(async () => {
      const meta = writeMeta(req);
      const body = parseDto<RunCreateBody>("runCreate", req.body);
      if (rt.status.agentState === "blocked") throw new AgentOsError("RECOVERY_BLOCKED", rt.status.agentDiagnostic ?? "agent recovery is blocked");
      if (!rt.engine || !rt.model.available) throw new AgentOsError("MODEL_UNAVAILABLE", rt.model.diagnostic ?? "no model is configured");
      const idle = await rt.engine.isIdle();
      const r = core.user.submitRun(meta, body, idle);
      log.info("run accepted", { runId: r.body.runId, appId: r.body.targetAppId, replayed: r.replayed });
      fault("run.after_accept");
      void rt.coord?.kick();
      return ok(reply, r.status, r.body);
    }),
  );

  app.post<{ Params: { runId: string } }>("/api/runs/:runId/cancel", async (req, reply) =>
    withWrite(() => {
      const meta = writeMeta(req);
      parseDto("empty", req.body);
      if (!UUID.test(req.params.runId)) throw new AgentOsError("NOT_FOUND", "run not found");
      const r = core.user.cancelRun(meta, req.params.runId);
      log.info("run cancel", { runId: req.params.runId, status: r.body.status });
      void rt.coord?.kick();
      return ok(reply, r.status, r.body);
    }),
  );

  app.post<{ Params: { appId: string } }>("/api/apps/:appId/records", async (req, reply) =>
    withWrite(() => {
      const meta = writeMeta(req);
      const body = parseDto<RecordCreateBody>("recordCreate", req.body);
      const r = core.user.createRecord(meta, req.params.appId, body.expectedAppEpoch, body.data);
      return ok(reply, r.status, r.body);
    }),
  );

  app.patch<{ Params: { appId: string; recordId: string } }>("/api/apps/:appId/records/:recordId", async (req, reply) =>
    withWrite(() => {
      const meta = writeMeta(req);
      const body = parseDto<RecordPatchBody>("recordPatch", req.body);
      const r = core.user.updateRecord(meta, req.params.appId, req.params.recordId, body.expectedAppEpoch, body.expectedRecordVersion, body.changes);
      return ok(reply, r.status, r.body);
    }),
  );

  app.delete<{ Params: { appId: string; recordId: string } }>("/api/apps/:appId/records/:recordId", async (req, reply) =>
    withWrite(() => {
      const meta = writeMeta(req);
      const body = parseDto<RecordDeleteBody>("recordDelete", req.body);
      const r = core.user.deleteRecord(meta, req.params.appId, req.params.recordId, body.expectedAppEpoch, body.expectedRecordVersion);
      return ok(reply, r.status, r.body);
    }),
  );

  // ---- v0.2: runtime, deployments, queries, commands, services (spec §19.1) ----
  const requireSys = (): RuntimeSystem => {
    if (!rt.sys) throw new AgentOsError("SANDBOX_UNAVAILABLE", "the code runtime is not available on this host");
    return rt.sys;
  };
  const appParam = (id: string) => {
    if (!UUID.test(id)) throw new AgentOsError("NOT_FOUND", "app not found");
    return id;
  };

  app.get("/api/runtime/catalog", async (req, reply) => {
    requireSession(req);
    const sys = requireSys();
    const locks = [];
    for (const l of sys.opts.catalog.locks()) {
      const present = async (name: string) => {
        if (!sys.ctx.driver) return false;
        try {
          return (await sys.ctx.driver.inspectImage(name)).present;
        } catch {
          return false;
        }
      };
      locks.push({
        runtimeLockId: l.id, profileId: l.profileId, platform: l.platform, sdkVersion: l.sdkVersion, abiVersion: l.abiVersion,
        modules: l.modules.map((m) => ({ name: m.name, version: m.version, license: m.license })),
        baseImage: l.baseImage, builderImage: { ...l.builderImage, present: await present(l.builderImage.name) }, runtimeImage: { ...l.runtimeImage, present: await present(l.runtimeImage.name) },
      });
    }
    return ok(reply, 200, { platform: sys.opts.catalog.platform, catalogHash: sys.opts.catalog.hash, runtimeReady: sys.runtimeReady, problems: sys.environmentProblems, locks });
  });

  app.get<{ Params: { appId: string } }>("/api/apps/:appId/runtime", async (req, reply) => {
    requireSession(req);
    return ok(reply, 200, requireSys().runtime.view(appParam(req.params.appId)));
  });

  for (const action of ["start", "stop", "restart"] as const) {
    app.post<{ Params: { appId: string } }>(`/api/apps/:appId/runtime/${action}`, async (req, reply) =>
      withWrite(() => {
        const meta = writeMeta(req);
        const body = parseDto<{ expectedAppEpoch: number }>("runtimeControl", req.body);
        const r = requireSys().control(meta, appParam(req.params.appId), action, body.expectedAppEpoch);
        log.info(`runtime ${action}`, { appId: req.params.appId, controlEpoch: r.body.controlEpoch, replayed: r.replayed });
        return ok(reply, r.status, r.body);
      }),
    );
  }

  app.post<{ Params: { appId: string } }>("/api/apps/:appId/deployments", async (req, reply) =>
    withWrite(() => {
      const meta = writeMeta(req);
      const body = parseDto<{ revisionId: string; expectedAppEpoch: number }>("deploymentCreate", req.body);
      const r = requireSys().switchVersion(meta, appParam(req.params.appId), body.revisionId, body.expectedAppEpoch);
      log.info("deployment accepted", { appId: req.params.appId, deploymentId: r.body.deploymentId, replayed: r.replayed });
      return ok(reply, r.status, r.body);
    }),
  );

  app.get<{ Params: { deploymentId: string } }>("/api/deployments/:deploymentId", async (req, reply) => {
    requireSession(req);
    const sys = requireSys();
    const d = UUID.test(req.params.deploymentId) ? sys.deployments.get(req.params.deploymentId) : undefined;
    if (!d) throw new AgentOsError("NOT_FOUND", "deployment not found");
    return ok(reply, 200, sys.deployments.dto(d));
  });

  app.post<{ Params: { appId: string; queryId: string } }>("/api/apps/:appId/queries/:queryId", async (req, reply) => {
    // Read-only: no Idempotency-Key and no receipt, but session, origin, client epoch and input are checked.
    requireSession(req);
    requireReady();
    const ep = Number(req.headers["x-agentos-epoch"]);
    if (!Number.isSafeInteger(ep)) throw new AgentOsError("INVALID_REQUEST", "X-AgentOS-Epoch header is required");
    if (ep !== clientEpoch()) throw new AgentOsError("CLIENT_EPOCH_STALE", "this page belongs to an older workspace state; reload", { clientEpoch: clientEpoch() });
    const body = parseDto<{ expectedAppEpoch: number; input: unknown }>("queryCall", req.body);
    const r = await requireSys().invocations.query(appParam(req.params.appId), req.params.queryId, body.input, body.expectedAppEpoch);
    return ok(reply, 200, r);
  });

  app.post<{ Params: { appId: string; commandId: string } }>("/api/apps/:appId/commands/:commandId", { bodyLimit: 160 * 1024 }, async (req, reply) =>
    withWrite(() => {
      const meta = writeMeta(req);
      const body = parseDto<{ expectedAppEpoch: number; input: unknown }>("commandCall", req.body);
      const r = requireSys().submitCommand(meta, appParam(req.params.appId), req.params.commandId, body.input, body.expectedAppEpoch);
      log.info("command accepted", { appId: req.params.appId, invocationId: r.body.invocationId, replayed: r.replayed });
      return ok(reply, r.status, r.body);
    }),
  );

  app.get<{ Params: { invocationId: string } }>("/api/invocations/:invocationId", async (req, reply) => {
    requireSession(req);
    const sys = requireSys();
    const inv = UUID.test(req.params.invocationId) ? sys.invocations.get(req.params.invocationId) : undefined;
    if (!inv) throw new AgentOsError("NOT_FOUND", "invocation not found");
    return ok(reply, 200, sys.invocations.dto(inv));
  });

  app.get("/api/services", async (req, reply) => {
    requireSession(req);
    return ok(reply, 200, { items: requireSys().interApp.catalog() });
  });

  app.get<{ Params: { appId: string } }>("/api/apps/:appId/imports", async (req, reply) => {
    requireSession(req);
    return ok(reply, 200, { items: requireSys().interApp.importsOf(appParam(req.params.appId)) });
  });

  app.get("/api/service-grants", async (req, reply) => {
    requireSession(req);
    return ok(reply, 200, { items: requireSys().interApp.list() });
  });

  app.post("/api/service-grants", async (req, reply) =>
    withWrite(() => {
      const meta = writeMeta(req);
      const body = parseDto<{ sourceAppId: string; sourceRevisionId: string; alias: string; targetAppId: string; targetRevisionId: string; exportName: string; contractHash: string }>("grantCreate", req.body);
      const r = requireSys().createGrant(meta, body);
      log.info("service grant created", { grantId: r.body.grantId, replayed: r.replayed });
      return ok(reply, r.status, r.body);
    }),
  );

  app.post<{ Params: { grantId: string } }>("/api/service-grants/:grantId/revoke", async (req, reply) =>
    withWrite(() => {
      const meta = writeMeta(req);
      parseDto("empty", req.body);
      if (!UUID.test(req.params.grantId)) throw new AgentOsError("NOT_FOUND", "grant not found");
      const r = requireSys().revokeGrant(meta, req.params.grantId);
      log.info("service grant revoked", { grantId: req.params.grantId, replayed: r.replayed });
      return ok(reply, r.status, r.body);
    }),
  );

  app.all("/api/*", async () => {
    throw new AgentOsError("NOT_FOUND", "no such endpoint");
  });

  // ---- static shell (same origin) ----
  if (fs.existsSync(path.join(config.webDir, "index.html"))) {
    app.register(fastifyStatic, { root: config.webDir, prefix: "/", index: ["index.html"], cacheControl: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/health/")) return reply.sendFile("index.html");
      return sendError(reply, new AgentOsError("NOT_FOUND", "not found"));
    });
  }
  return app;
}
