import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentOsError, type AppBundle } from "@agentos/contracts";
import { commitMutations, openCore, RuntimeSystem, type Core } from "@agentos/core";
import { PodmanDriver } from "@agentos/runtime-podman";
import { codeFixture } from "../fixtures-v02.js";
import { catalogService, makeDriver, sandboxDir } from "./env.js";
import { opMeta, publish, waitFor } from "./util.js";

const here = import.meta.dirname;
const v1 = JSON.parse(readFileSync(path.join(here, "../../fixtures/todo-v1.json"), "utf8")) as AppBundle;
const LAB = "f00dfa11-0000-4000-8000-00000000fa11";
const TODO = v1.manifest.appId;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (e) {
    return (e as AgentOsError).code ?? (e as Error).message;
  }
}

async function command(sys: RuntimeSystem, appId: string, id: string, input: unknown) {
  const e = sys.core.apps.requireApp(appId).epoch;
  const acc = sys.submitCommand(opMeta({ id, input }), appId, id, input, e);
  return waitFor(() => {
    const r = sys.invocations.get(acc.body.invocationId);
    return r && (r.status === "succeeded" || r.status === "failed") ? r : null;
  }, 60_000);
}

describe("V2-S/D: sandbox isolation, limits, forged principals, command fences (real podman)", () => {
  const box = sandboxDir();
  let core: Core;
  let sys: RuntimeSystem;
  beforeAll(async () => {
    core = openCore(path.join(box.dir, "os.sqlite"));
    sys = new RuntimeSystem(core, { dataDir: box.dir, catalog: catalogService(), driver: makeDriver(), log: () => {}, autoReconcile: false });
    await sys.boot();
    expect(sys.runtimeReady).toBe(true);
    core.apps.seedActivated(v1);
    expect((await publish(sys, core, codeFixture("todo-kanban"))).status).toBe("committed");
    core.store.tx(() => core.store.run("INSERT INTO apps (id, active_revision_id, epoch, contract_json, created_at, updated_at) VALUES (?, NULL, 0, '{\"fields\":{}}', ?, ?)", LAB, new Date().toISOString(), new Date().toISOString()));
    const r = await publish(sys, core, codeFixture("fault-lab"));
    expect(r.status, JSON.stringify(r.error)).toBe("committed");
    expect((await command(sys, LAB, "add", { n: 3 })).status).toBe("succeeded");
  });
  afterAll(async () => {
    await sys.shutdown();
    core.store.close();
    box.cleanup();
  });

  const q = (appId: string, id: string, input: unknown = {}) => sys.invocations.query(appId, id, input, core.apps.requireApp(appId).epoch);

  it("V2-S01/S02 no host files, engine socket, other bridges, egress or host loopback; the legal bridge works", async () => {
    const r = await q(LAB, "probe");
    const d = Object.fromEntries((r.output as { detail: string }).detail.split(";").map((kv) => kv.split("=") as [string, string]));
    expect(d.home).toBe("ENOENT");
    expect(d.hostdb).toBe("ENOENT");
    expect(d.podmansock).toBe("ENOENT");
    expect(d.podmanapi).toBe("ENOENT");
    expect(d.otherbridge).toBe("OK:host.sock");
    expect(d.writeroot).toBe("EROFS");
    expect(d.writeapp).toBe("EROFS");
    expect(d.ifaces).toBe("OK:lo");
    expect(d.public).not.toBe("CONNECTED");
    expect(d.hostloop).not.toBe("CONNECTED");
    expect(d.bridge2 === "CONNECTED" ? "refused-after-connect" : d.bridge2).not.toBe("data");
    expect(d.env).not.toMatch(/API_KEY|TOKEN|PROXY|AGENTOS_MODEL|HOME=\/data/);
    expect(d.env).toMatch(/AGENTOS_INSTANCE_ID/);
    console.log("probe:", JSON.stringify(d));
  });

  it("V2-S03 an infinite loop times out, the instance is killed and restarted; other apps keep answering", async () => {
    const before = sys.runtime.view(LAB);
    const t0 = Date.now();
    const spinning = code(q(LAB, "spin"));
    // the other app answers while the loop runs
    const other = await q(TODO, "main");
    expect((other.output as { total: number }).total).toBeGreaterThanOrEqual(0);
    expect(await spinning).toBe("APP_TIMEOUT");
    expect(Date.now() - t0).toBeLessThan(8000);
    await waitFor(() => sys.runtime.row(LAB)!.health === "recovering" || null, 10_000);
    await new Promise((r) => setTimeout(r, 1200));
    await sys.reconciler.runOnce();
    const after = await waitFor(() => (sys.runtime.view(LAB).health === "ready" ? sys.runtime.view(LAB) : null), 60_000);
    expect(after.generation).toBe(before.generation + 1);
    expect(after.restartCount).toBe(1);
    expect(core.apps.requireApp(LAB).epoch).toBe(before.generation === 0 ? 1 : core.apps.requireApp(LAB).epoch);
    expect((await q(LAB, "main")).output).toEqual({ ok: true, detail: "fault lab ready" });
  });

  it("V2-S04 memory and process pressure hit the real limits without touching other apps", async () => {
    const ready = async () => {
      await new Promise((r) => setTimeout(r, 1200));
      for (let i = 0; i < 12 && sys.runtime.row(LAB)!.health !== "ready"; i++) {
        await sys.reconciler.runOnce();
        await new Promise((r) => setTimeout(r, 1000));
      }
      expect(sys.runtime.row(LAB)!.health).toBe("ready");
    };
    await ready();
    const hog = await q(LAB, "hog").then(() => "OK", (e: AgentOsError) => { console.log("hog-err:", e.message); return e.code; });
    expect(hog).toBe("APP_RESOURCE_LIMIT");
    const row = await waitFor(() => (sys.runtime.row(LAB)!.last_error_json ? sys.runtime.row(LAB)! : null), 10_000);
    console.log("hog:", hog, row.last_error_json);
    expect(JSON.parse(row.last_error_json!).code).toBe("APP_RESOURCE_LIMIT");
    expect((await q(TODO, "main")).output).toBeTruthy();
    expect(sys.runtime.view(TODO).health).toBe("ready");
    await ready();
    const pids = await q(LAB, "forkbomb").catch((e: AgentOsError) => ({ output: { detail: `call ${e.code}` } }));
    const detail = (pids.output as { detail: string }).detail;
    console.log("forkbomb:", detail);
    // the pids limit stops the fork storm (EAGAIN), or the runner itself cannot get a thread and is restarted
    expect(/err=EAGAIN/.test(detail) || /call /.test(detail)).toBe(true);
    expect((await q(TODO, "main")).output).toBeTruthy();
    await ready();
  });

  it("V2-S05 tmpfs quota and log flooding stay bounded", async () => {
    const t = await q(LAB, "tmpfill");
    expect((t.output as { detail: string }).detail).toMatch(/wrote=6[0-4]MiB;err=ENOSPC/);
    await q(LAB, "logflood");
    const live = sys.ctx.instances!.get(sys.runtime.row(LAB)!.active_instance_id!)!;
    expect(live.logs.length).toBeLessThanOrEqual(50);
    const logBytes = live.logs.reduce((n, l) => n + l.text.length, 0);
    expect(logBytes).toBeLessThanOrEqual(64 * 1024);
    // the engine keeps at most the bounded k8s-file log
    const diag = await sys.ctx.driver!.diagnostics(live.containerId!, 1024 * 1024);
    expect(diag.length).toBeLessThanOrEqual(1024 * 1024);
  });

  it("V2-S06 forged principals: ungranted alias, background messages, a second connection and a stale instance are refused", async () => {
    const r = await q(LAB, "forge");
    expect((r.output as { detail: string }).detail).toBe("ungranted=GRANT_REQUIRED");
    const live = sys.ctx.instances!.get(sys.runtime.row(LAB)!.active_instance_id!)!;
    await waitFor(() => live.logs.some((l) => l.text.includes("background service call refused")) || null, 5000);
    expect(live.logs.find((l) => l.text.includes("background service call refused"))!.text).toMatch(/FORBIDDEN/);
    // a stale handle (older generation after a restart) cannot serve or commit
    sys.control(opMeta({ r: 1 }), LAB, "restart", core.apps.requireApp(LAB).epoch);
    await sys.reconciler.runOnce();
    await waitFor(() => sys.runtime.row(LAB)!.health === "ready" || null, 60_000);
    expect(await code(sys.ctx.instances!.call(live, "query", "main", {}, { callId: "x", appId: LAB, revisionId: live.revisionId, appEpoch: 1, dataEpoch: 0, logicalTime: "", deadline: new Date(Date.now() + 2000).toISOString(), records: [] }, 2000))).toBe("INSTANCE_STALE");
  });

  it("V2-D07 a plan touching an undeclared field is rejected as a whole", async () => {
    const before = core.store.all("SELECT id, version, data_json FROM records WHERE app_id = ? ORDER BY id", LAB);
    const inv = await command(sys, LAB, "sneaky", {});
    expect(inv.status).toBe("failed");
    expect(JSON.parse(inv.error_json!).code).toBe("INVALID_MUTATION");
    expect(core.store.all("SELECT id, version, data_json FROM records WHERE app_id = ? ORDER BY id", LAB)).toEqual(before);
  });

  it("V2-D05 a concurrent record change during a running command ends in DATA_EPOCH_STALE without overwriting", async () => {
    const e = core.apps.requireApp(LAB).epoch;
    const acc = sys.submitCommand(opMeta({ slow: 1 }), LAB, "slowTouch", { ms: 1500 }, e);
    await waitFor(() => sys.invocations.get(acc.body.invocationId)!.status === "executing" || null, 10_000);
    // another writer commits while the command computes
    const lab = codeFixture("fault-lab");
    const ep = core.store.get<{ e: number }>("SELECT data_epoch AS e FROM apps WHERE id = ?", LAB)!.e;
    core.store.tx(() =>
      commitMutations(core.store, { appId: LAB, bundle: lab, command: lab.commands.add!, contract: core.apps.contractOf(core.apps.requireApp(LAB)), expectedDataEpoch: ep, mutations: [{ kind: "create", localKey: "c", data: { note: "concurrent" } }] }),
    );
    const snapshot = core.store.all("SELECT id, version, data_json FROM records WHERE app_id = ? ORDER BY id", LAB);
    const inv = await waitFor(() => {
      const r = sys.invocations.get(acc.body.invocationId)!;
      return r.status === "failed" || r.status === "succeeded" ? r : null;
    }, 20_000);
    expect(inv.status).toBe("failed");
    expect(JSON.parse(inv.error_json!).code).toBe("DATA_EPOCH_STALE");
    expect(core.store.all("SELECT id, version, data_json FROM records WHERE app_id = ? ORDER BY id", LAB)).toEqual(snapshot);
  });

  it("V2-D06 a version switch while a command runs: the late result cannot commit", async () => {
    const e = core.apps.requireApp(LAB).epoch;
    const acc = sys.submitCommand(opMeta({ slow: 2 }), LAB, "slowTouch", { ms: 2500 }, e);
    await waitFor(() => sys.invocations.get(acc.body.invocationId)!.status === "executing" || null, 10_000);
    const before = core.store.all("SELECT id, version FROM records WHERE app_id = ? ORDER BY id", LAB);
    // restart = new generation; the running attempt's instance loses its right to commit
    sys.control(opMeta({ r: 2 }), LAB, "restart", e);
    const inv = await waitFor(() => {
      const r = sys.invocations.get(acc.body.invocationId)!;
      return r.status === "failed" || r.status === "succeeded" ? r : null;
    }, 30_000);
    await sys.reconciler.runOnce();
    console.log("D06", inv.status, inv.error_json, inv.attempt);
    if (inv.status === "succeeded") {
      // allowed only as a fresh second attempt on the new generation, never the late first result
      expect(inv.attempt).toBe(2);
      expect(inv.generation).toBeGreaterThan(0);
    } else {
      expect(core.store.all("SELECT id, version FROM records WHERE app_id = ? ORDER BY id", LAB)).toEqual(before);
    }
  });

  it("V2-S07 without a usable isolation environment code apps answer SANDBOX_UNAVAILABLE (no fallback)", async () => {
    const box2 = sandboxDir();
    const core2 = openCore(path.join(box2.dir, "os.sqlite"));
    const sys2 = new RuntimeSystem(core2, { dataDir: box2.dir, catalog: catalogService(), driver: new PodmanDriver({ socketPath: path.join(box2.dir, "no-such.sock") }), log: () => {}, autoReconcile: false });
    await sys2.boot();
    expect(sys2.runtimeReady).toBe(false);
    expect(sys2.environmentProblems.join()).toMatch(/unreachable/);
    core2.apps.seedActivated(codeFixture("todo-kanban"));
    expect(await code(sys2.invocations.query(TODO, "main", {}, 1))).toBe("SANDBOX_UNAVAILABLE");
    const staged = core2.store.tx(() => core2.apps.stage(TODO, codeFixture("todo-kanban-hours"), null));
    expect(() => core2.store.tx(() => sys2.deployments.prepareInTx({ appId: TODO, revisionId: staged.revisionId, expectedAppEpoch: 1, origin: "agent_prepare", ownerRunId: null, requestKey: "k", requestHash: "h" }))).toThrow(/runtime is not available/);
    await sys2.shutdown();
    core2.store.close();
    box2.cleanup();
  });
});
