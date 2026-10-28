import fs from "node:fs";
import path from "node:path";
import { HOST_VERSION, checkStructure } from "@agentos/contracts";
import { RunCoordinator, openCore, type Core } from "@agentos/core";
import { PiAgentEngine, modelConfigFromEnv } from "@agentos/agent-pi";
import { loadConfig } from "./config.js";
import { createLogger, type Logger } from "./log.js";
import { assertLocalFs, assertLockHeld } from "./lock.js";
import { SessionAuth, ensureSecrets } from "./auth.js";
import { buildServer, type HostRuntime } from "./http.js";

export const RESTORE_MARKER = "restore-in-progress";

function fail(log: Logger | null, msg: string, fields?: Record<string, unknown>): never {
  if (log) log.error(msg, fields);
  else process.stderr.write(`${msg}\n`);
  process.exit(1);
}

export async function main(): Promise<void> {
  // 1. configuration and the data directory lock
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(config.dataDir, 0o700);
  const lockFile = path.join(config.dataDir, "host.lock");
  try {
    assertLocalFs(config.dataDir);
    assertLockHeld(lockFile);
  } catch (e) {
    fail(null, (e as Error).message);
  }
  const log = createLogger(path.join(config.dataDir, "logs"), config.logLevel);
  log.info("agentos host starting", { version: HOST_VERSION, pid: process.pid, dataDir: config.dataDir, port: config.port });

  // 3. refuse a half-finished restore before any database opens
  if (fs.existsSync(path.join(config.dataDir, RESTORE_MARKER))) {
    fail(log, "a restore is in progress or was interrupted; finish it with `pnpm restore` before starting the host");
  }
  let core: Core;
  try {
    core = openCore(path.join(config.dataDir, "os.sqlite"), {
      runSettings: config.testMode && process.env.AGENTOS_TEST_RUN_DEADLINE_MS ? { deadlineMs: Number(process.env.AGENTOS_TEST_RUN_DEADLINE_MS) } : {},
    });
  } catch (e) {
    fail(log, "os.sqlite could not be opened or migrated; not deleting anything", { error: (e as Error).message });
  }
  core.store.onSlowTransaction = (info) => log.warn("slow transaction", info);
  ensureSecrets(config.dataDir);
  const auth = new SessionAuth(config.dataDir, config.sessionTtlMs);

  const modelConfig = modelConfigFromEnv(process.env);
  const rt: HostRuntime = {
    config,
    core,
    engine: null,
    coord: null,
    model: { available: false, diagnostic: null, ref: null, mode: modelConfig?.mode ?? "real" },
    auth,
    log,
    status: { phase: "starting", writable: true, agentState: "unavailable", agentDiagnostic: null },
    inflight: { n: 0 },
  };

  // reserve the port early; business endpoints answer 503 until ready
  const server = buildServer(rt);
  await server.listen({ host: config.host, port: config.port });
  log.info("listening", { host: config.host, port: config.port });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    rt.status.phase = "stopping";
    rt.coord?.stop();
    const closing = rt.engine?.close().catch((e) => log.warn("harness close failed", { error: (e as Error).message }));
    const until = Date.now() + 12_000;
    while (rt.inflight.n > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    await rt.coord?.drain();
    await closing;
    await server.close().catch(() => undefined);
    core.store.close();
    log.info("stopped");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // 4. trusted services and Pi tools; open agent.sqlite without scheduling; pair the two stores
  const engine = new PiAgentEngine({
    agentDbPath: path.join(config.dataDir, "agent.sqlite"),
    ops: core.agentOps,
    runs: core.runs,
    modelConfig,
    fauxContextWindow: config.testMode && process.env.AGENTOS_TEST_FAUX_CONTEXT ? Number(process.env.AGENTOS_TEST_FAUX_CONTEXT) : undefined,
    onFailure: (error) => {
      log.error("agent storage failed; exiting for a clean restart", { error: (error as Error)?.message });
      rt.status.phase = "stopping";
      process.exit(1);
    },
    log: (msg, f) => log.warn(msg, f),
    toolLog: (msg, f) => log.info(msg, f),
  });
  try {
    await engine.open();
  } catch (e) {
    fail(log, "agent.sqlite could not be opened", { error: (e as Error).message });
  }
  rt.engine = engine;
  rt.model = { available: engine.modelAvailable, diagnostic: engine.modelDiagnostic, ref: engine.modelRef, mode: modelConfig?.mode ?? "real" };
  const meta = core.store.meta();
  const bind = await engine.bind(meta.store_uuid, meta.agent_binding_state);
  if (!bind.ok) {
    rt.status.agentState = "blocked";
    rt.status.agentDiagnostic = bind.reason;
    rt.status.writable = false;
    rt.status.phase = "ready";
    log.error("workspace pairing failed; scheduling is blocked", { reason: bind.reason });
    return;
  }
  if (meta.agent_binding_state === "pending") {
    core.store.tx(() => core.store.run("UPDATE meta SET agent_binding_state = 'bound' WHERE id = 1"));
    log.info("workspace paired with agent store", { how: bind.bound });
  }

  // 5. bind and reconcile the active run before anything can be scheduled
  const coord = new RunCoordinator(core.runs, engine, { info: log.info, warn: log.warn, error: log.error });
  rt.coord = coord;
  await coord.recover();
  if (coord.recoveryBlocked) {
    rt.status.agentState = "blocked";
    rt.status.agentDiagnostic = coord.recoveryBlocked;
    rt.status.writable = false;
    rt.status.phase = "ready";
    return;
  }

  // 6. resume Pi scheduling and the coordinator
  engine.resume();
  coord.start();
  rt.status.agentState = engine.modelAvailable ? "ready" : "unavailable";

  // 7. every active bundle must be renderable by this host
  for (const a of core.apps.listApps()) {
    const b = core.apps.getApp(a.appId).bundle;
    if (b && !checkStructure(b).ok) log.error("active bundle not accepted by this renderer", { appId: a.appId });
  }
  if (!fs.existsSync(path.join(config.webDir, "index.html"))) log.warn("web shell build not found", { webDir: config.webDir });
  rt.status.phase = "ready";
  log.info("ready", { modelAvailable: rt.model.available, model: rt.model.ref });
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
