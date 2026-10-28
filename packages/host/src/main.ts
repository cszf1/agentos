import fs from "node:fs";
import path from "node:path";
import { HOST_VERSION, checkAnyStructure } from "@agentos/contracts";
import { RunCoordinator, RuntimeSystem, SystemCapabilities, openCore, type Core } from "@agentos/core";
import { catalogProblems, createDriver, loadCatalog } from "./runtime-setup.js";
import { PiAgentEngine, TOOLSET_VERSION, modelConfigFromEnv } from "@agentos/agent-pi";
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
    sys: null,
    caps: null,
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
    // Stop new system admissions and outbox deliveries first; accepted broker operations keep running (spec §22.2).
    rt.caps?.actions.stop();
    const closing = rt.engine?.close().catch((e) => log.warn("harness close failed", { error: (e as Error).message }));
    // Spec §20.1: total shutdown budget 30 s; a timeout is handled as a crash by the next start.
    const hardStop = setTimeout(() => {
      log.error("shutdown exceeded 30 s; exiting without a clean close");
      process.exit(1);
    }, 30_000);
    hardStop.unref();
    const until = Date.now() + 12_000;
    while (rt.inflight.n > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    await rt.coord?.drain();
    await closing;
    await rt.sys?.shutdown().catch((e) => log.warn("runtime shutdown incomplete; the next start reconciles", { error: (e as Error).message }));
    await rt.caps?.shutdown().catch(() => undefined);
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

  // 5a-0. v0.3 (spec §22.1 steps 2–3): broker read-only handshake and identity check, then reconcile grant syncs,
  // cancels, the system outbox and unverified results before anything new is admitted. A missing broker leaves the
  // Shell, data apps and version management working; system writes stay off and /api/state says why.
  let caps: SystemCapabilities | null = null;
  try {
    caps = new SystemCapabilities(core, null, { dataDir: config.dataDir, log: (lvl, m, f) => log[lvl](m, f) });
    core.runs.systemScope = (runId, resourceIds, capabilityScopes, deadlineMs) => caps!.freezeRunScopeInTx(runId, resourceIds, capabilityScopes, deadlineMs);
    core.agentOps.system = caps;
    await caps.boot();
    rt.caps = caps;
    const st = caps.state();
    if (st.brokerReady) log.info("broker ready", { machineInstallId: caps.broker.status.machineInstallId, incarnation: caps.broker.status.workspaceIncarnation });
    else log.warn("broker unavailable; system writes are off", { diagnostic: caps.broker.status.diagnostic });
  } catch (e) {
    log.error("system capabilities failed to start; system resources are unavailable", { error: (e as Error).message });
  }

  // 5a. v0.2 runtime (spec §20.1 steps 3–5): boot id, catalog, artifacts, engine check, revoke old leases,
  // reconcile containers, recover builds/deployments/commands, restart active code apps. Runtime problems
  // leave the host up: declarative apps and the Shell keep working, code calls answer 503.
  try {
    const catalog = loadCatalog(config);
    const problems = catalogProblems(config, catalog);
    const sys = new RuntimeSystem(core, { dataDir: config.dataDir, catalog, driver: problems.length === 0 ? createDriver(config, catalog) : null, log: (lvl, m, f) => log[lvl](m, f), cacheBudgetBytes: Number(process.env.AGENTOS_CACHE_BUDGET_BYTES) || undefined });
    await sys.boot();
    sys.environmentProblems.push(...problems);
    rt.sys = sys;
    core.agentOps.runtime = sys;
    caps?.attachRuntime(sys);
    if (!sys.runtimeReady) log.warn("code runtime unavailable", { problems: sys.environmentProblems });
    else log.info("code runtime ready", { bootId: sys.bootId, catalog: catalog.hash });
  } catch (e) {
    log.error("code runtime failed to start; code apps are unavailable", { error: (e as Error).message });
  }

  // 5b. agent tool set upgrade (spec §3.2): only from an idle root and with no unfinished run; recorded in both stores.
  {
    const cur = core.store.get<{ v: number }>("SELECT agent_toolset_version AS v FROM meta WHERE id = 1")!.v;
    if (cur !== TOOLSET_VERSION) {
      const busyRun = core.runs.activeRun();
      const up = busyRun ? { ok: false as const, reason: `run ${busyRun.id} from tool set v${cur} is unfinished; finish or cancel it with the previous host version first` } : await engine.upgradeToolset(TOOLSET_VERSION);
      if (!up.ok) {
        rt.status.agentState = "blocked";
        rt.status.agentDiagnostic = `agent tool set upgrade v${cur}→v${TOOLSET_VERSION} refused: ${up.reason}`;
        rt.status.phase = "ready";
        log.error("agent tool set upgrade refused; generation is blocked, apps keep working", { reason: up.reason });
        return;
      }
      core.store.tx(() => {
        core.store.run(
          "INSERT OR IGNORE INTO agent_toolset_migrations (version, description, applied_at) VALUES (?, ?, ?)",
          TOOLSET_VERSION,
          TOOLSET_VERSION === 3 ? "v0.3 tools: system_resource_list, system_read, system_plan (system_plan mode); formatVersion 3 / isolated-code-v2 / slot-tree-v2 rules" : "v0.2 tools",
          new Date().toISOString(),
        );
        core.store.run("UPDATE meta SET agent_toolset_version = ? WHERE id = 1", TOOLSET_VERSION);
      });
      log.info("agent tool set upgraded", { from: cur, to: TOOLSET_VERSION });
    }
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
    if (b && !checkAnyStructure(b).ok) log.error("active bundle not accepted by this renderer", { appId: a.appId });
  }
  if (!fs.existsSync(path.join(config.webDir, "index.html"))) log.warn("web shell build not found", { webDir: config.webDir });
  rt.status.phase = "ready";
  log.info("ready", { modelAvailable: rt.model.available, model: rt.model.ref });
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
