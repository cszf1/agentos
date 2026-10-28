import path from "node:path";
import { randomUUID } from "node:crypto";
import { PiAgentEngine } from "@agentos/agent-pi";
import { RunCoordinator, openCore, requestHash, type Clock, type Core, type RunSettings } from "@agentos/core";
import { tmpDir } from "./helpers.js";

export interface AgentRig {
  dir: string;
  core: Core;
  engine: PiAgentEngine;
  coord: RunCoordinator;
  close(): Promise<void>;
}

export async function startRig(opts: { dir?: string; clock?: Clock; runSettings?: Partial<RunSettings>; fauxContextWindow?: number; compaction?: { reserveTokens?: number; keepRecentTokens?: number } } = {}): Promise<AgentRig> {
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
    async close() {
      coord.stop();
      await coord.drain();
      await engine.close();
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
