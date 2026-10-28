import path from "node:path";
import { randomUUID } from "node:crypto";
import { PiAgentEngine } from "@agentos/agent-pi";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PodmanDriver, recipeContext } from "@agentos/runtime-podman";
import { RunCoordinator, RuntimeCatalogService, RuntimeSystem, SystemCapabilities, openCore, requestHash, type Clock, type Core, type RunSettings } from "@agentos/core";
import type { RuntimeCatalog } from "@agentos/contracts";

const ROOT = path.resolve(import.meta.dirname, "..");
const CATALOG = JSON.parse(readFileSync(path.join(ROOT, "runtime", "catalog", "catalog.json"), "utf8")) as RuntimeCatalog;

/** The real Podman driver when this machine has the rootless engine socket, else null (code apps unavailable). */
export function rigDriver(): PodmanDriver | null {
  const sock = process.env.AGENTOS_PODMAN_SOCKET ?? `/run/user/${process.getuid!()}/podman/podman.sock`;
  if (process.env.AGENTOS_RUNTIME === "off" || !existsSync(sock)) return null;
  return new PodmanDriver({
    socketPath: sock,
    recipe: (img) => {
      const lock = CATALOG.locks.find((l) => l.builderImage.name === img.name || l.runtimeImage.name === img.name);
      if (!lock) return null;
      const base = `${lock.baseImage.reference}@${lock.baseImage.digest}`;
      const c = recipeContext({ platformRoot: ROOT, profileId: lock.profileId, role: img.role, baseDigestRef: base, approvedSpecifiers: lock.modules.flatMap((m) => m.specifiers), lockId: lock.id, abiVersion: lock.abiVersion });
      return { entries: c.entries, recipeHash: c.recipeHash, baseDigestRef: base };
    },
  });
}
import { tmpDir } from "./helpers.js";

export interface AgentRig {
  dir: string;
  core: Core;
  engine: PiAgentEngine;
  coord: RunCoordinator;
  sys: RuntimeSystem;
  /** v0.3 system capabilities (connected to the real broker when one is installed). */
  caps: SystemCapabilities;
  close(): Promise<void>;
}

export async function startRig(opts: { dir?: string; clock?: Clock; runSettings?: Partial<RunSettings>; fauxContextWindow?: number; compaction?: { reserveTokens?: number; keepRecentTokens?: number }; systemAutoStart?: boolean; storeUuid?: string } = {}): Promise<AgentRig> {
  const dir = opts.dir ?? tmpDir();
  const core = openCore(path.join(dir, "os.sqlite"), { runSettings: opts.runSettings, ...(opts.clock ? { clock: opts.clock } : {}) });
  const engine = new PiAgentEngine({
    agentDbPath: path.join(dir, "agent.sqlite"),
    ops: core.agentOps,
    runs: core.runs,
    modelConfig: { mode: "faux", provider: "agentos-faux", modelId: "faux-builder" },
    fauxContextWindow: opts.fauxContextWindow,
    compaction: opts.compaction,
  });
  // v0.3 tests against the installed broker use the store UUID registered in the root policy.
  if (opts.storeUuid) core.store.tx(() => core.store.run("UPDATE meta SET store_uuid = ? WHERE id = 1", opts.storeUuid));
  const caps = new SystemCapabilities(core, null, { dataDir: dir, log: () => {}, autoStart: opts.systemAutoStart ?? true });
  core.runs.systemScope = (runId, ids, scopes, deadline) => caps.freezeRunScopeInTx(runId, ids, scopes, deadline);
  core.agentOps.system = caps;
  await caps.boot();
  const sys = new RuntimeSystem(core, { dataDir: dir, catalog: new RuntimeCatalogService(CATALOG, process.arch === "arm64" ? "linux/arm64" : "linux/amd64"), driver: rigDriver(), log: () => {}, autoReconcile: false });
  await sys.boot();
  core.agentOps.runtime = sys;
  caps.attachRuntime(sys);
  await engine.open();
  const meta = core.store.meta();
  const b = await engine.bind(meta.store_uuid, meta.agent_binding_state);
  if (!b.ok) throw new Error(b.reason);
  if (meta.agent_binding_state === "pending") core.store.tx(() => core.store.run("UPDATE meta SET agent_binding_state = 'bound' WHERE id = 1"));
  const coord = new RunCoordinator(core.runs, engine, undefined, 50);
  await coord.recover();
  engine.resume();
  coord.start();
  return {
    dir,
    core,
    engine,
    coord,
    sys,
    caps,
    async close() {
      coord.stop();
      await coord.drain();
      await engine.close();
      await sys.shutdown();
      await caps.shutdown();
      core.store.close();
    },
  };
}

export async function submit(rig: AgentRig, intent: string, targetAppId: string | null = null) {
  const body: { intent: string; targetAppId: string | null; expectedAppEpoch?: number } = { intent, targetAppId };
  if (targetAppId) body.expectedAppEpoch = rig.core.apps.requireApp(targetAppId).epoch;
  const r = rig.core.user.submitRun({ operationKey: randomUUID(), requestHash: requestHash({ body }) }, body, await rig.engine.isIdle());
  void rig.coord.kick();
  return r.body;
}

export async function waitRun(rig: AgentRig, runId: string, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const row = rig.core.runs.getRow(runId)!;
    if (["succeeded", "failed", "cancelled"].includes(row.status)) return row;
    if (Date.now() > until) throw new Error(`run ${runId} still ${row.status}/${row.dispatch_state}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > until) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Controllable clock for deadline/budget tests (spec §18): starts at real time, moves only when told. */
export class ManualClock implements Clock {
  #t = Date.now();
  now(): number {
    return this.#t;
  }
  advance(ms: number): void {
    this.#t += ms;
  }
}
