import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openCore, RuntimeSystem, requestHash, type Core } from "@agentos/core";
import type { AppBundle } from "@agentos/contracts";
import { codeFixture } from "../fixtures-v02.js";
import { catalogService, makeDriver, sandboxDir } from "./env.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const v1 = JSON.parse(readFileSync(path.join(here, "../../fixtures/todo-v1.json"), "utf8")) as AppBundle;
const v2 = JSON.parse(readFileSync(path.join(here, "../../fixtures/todo-v2.json"), "utf8")) as AppBundle;
const APP = v1.manifest.appId;

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 60_000, stepMs = 100): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function meta(body: unknown, clientEpoch?: number) {
  const k = randomUUID();
  return { operationKey: k, requestHash: requestHash({ k, body: body as never }), ...(clientEpoch !== undefined ? { clientEpoch } : {}) };
}

/** Publish a code (or declarative) bundle without a model: agent_prepare with no owning run (test seeding path). */
export async function publish(sys: RuntimeSystem, core: Core, bundle: unknown): Promise<{ status: string; deploymentId: string; revisionId: string; error: unknown }> {
  const appId = (bundle as AppBundle).manifest.appId;
  const staged = core.store.tx(() => core.apps.stage(appId, bundle, null));
  const app = core.apps.requireApp(appId);
  const d = core.store.tx(() =>
    sys.deployments.prepareInTx({ appId, revisionId: staged.revisionId, expectedAppEpoch: app.epoch, origin: "agent_prepare", ownerRunId: null, requestKey: randomUUID(), requestHash: "t" }),
  );
  await sys.deployments.drive(d.id);
  let row = sys.deployments.require(d.id);
  if (row.status !== "ready") return { status: row.status, deploymentId: d.id, revisionId: staged.revisionId, error: row.error_json ? JSON.parse(row.error_json) : null };
  await sys.deployments.freshProbe(row);
  core.store.tx(() => sys.deployments.activateInTx(d.id, { runId: null }));
  await sys.deployments.afterCommit(d.id);
  row = sys.deployments.require(d.id);
  return { status: row.status, deploymentId: d.id, revisionId: staged.revisionId, error: null };
}

describe("M2 deployments on real podman (no model)", () => {
  const box = sandboxDir();
  let core: Core;
  let sys: RuntimeSystem;
  beforeAll(async () => {
    core = openCore(path.join(box.dir, "os.sqlite"));
    sys = new RuntimeSystem(core, { dataDir: box.dir, catalog: catalogService(), driver: makeDriver(), log: () => {}, autoReconcile: false });
    await sys.boot();
    core.apps.seedActivated(v1);
    core.apps.seedActivated(v2);
    const principal = { kind: "app" as const, appId: APP, viaUser: true };
    core.store.tx(() => core.records.create(principal, APP, 2, { title: "买牛奶", priority: "high" }));
    core.store.tx(() => core.records.create(principal, APP, 2, { title: "写周报" }));
  });
  afterAll(async () => {
    await sys.shutdown();
    core.store.close();
    box.cleanup();
  });

  it("publishes the hand-written kanban code version and serves queries and atomic commands", async () => {
    const r = await publish(sys, core, codeFixture("todo-kanban"));
    expect(r.status, JSON.stringify(r.error)).toBe("committed");
    const view = sys.runtime.view(APP);
    expect(view.health).toBe("ready");
    expect(view.generation).toBe(1);
    const app = core.apps.requireApp(APP);
    expect(app.epoch).toBe(3);
    const q = await sys.invocations.query(APP, "main", {}, 3);
    const out = q.output as { items: { id: string; title: string }[]; open: number; byPriority: { high: number } };
    expect(out.open).toBe(2);
    expect(out.byPriority.high).toBe(1);
    const ids = out.items.map((i) => i.id);
    const dataEpochBefore = core.store.get<{ e: number }>("SELECT data_epoch AS e FROM apps WHERE id = ?", APP)!.e;
    const m = meta({ ids });
    const acc = sys.submitCommand(m, APP, "completeMany", { recordIds: ids }, 3);
    expect(acc.status).toBe(202);
    const inv = await waitFor(() => {
      const row = sys.invocations.get(acc.body.invocationId);
      return row && (row.status === "succeeded" || row.status === "failed") ? row : null;
    });
    expect(inv.status, inv.error_json ?? "").toBe("succeeded");
    expect(core.store.get<{ e: number }>("SELECT data_epoch AS e FROM apps WHERE id = ?", APP)!.e).toBe(dataEpochBefore + 1);
    // Same key, same body → same invocation, nothing executed again.
    const again = sys.submitCommand(m, APP, "completeMany", { recordIds: ids }, 3);
    expect(again.replayed).toBe(true);
    expect(again.body.invocationId).toBe(acc.body.invocationId);
    expect(core.store.get<{ e: number }>("SELECT data_epoch AS e FROM apps WHERE id = ?", APP)!.e).toBe(dataEpochBefore + 1);
    const q2 = await sys.invocations.query(APP, "main", {}, 3);
    expect((q2.output as { open: number }).open).toBe(0);
  });

  it("a failing candidate (type error) leaves the active version serving", async () => {
    const bad = codeFixture("todo-kanban", (b) => {
      b.code.files["src/app.ts"] = b.code.files["src/app.ts"]!.replace("byPriority[i.priority]++;", "byPriority[i.priority] = 'x';");
    });
    const r = await publish(sys, core, bad);
    expect(r.status).toBe("failed");
    expect((r.error as { stage: string; code: string }).stage).toBe("build");
    expect((r.error as { code: string }).code).toBe("BUILD_FAILED");
    expect(core.apps.requireApp(APP).epoch).toBe(3);
    const q = await sys.invocations.query(APP, "main", {}, 3);
    expect((q.output as { total: number }).total).toBe(2);
  });

  it("restarting the same version bumps the runtime generation, not the app epoch", async () => {
    const before = sys.runtime.view(APP);
    const r = sys.control(meta({ a: "restart" }), APP, "restart", 3);
    expect(r.status).toBe(202);
    await sys.reconciler.runOnce();
    const after = await waitFor(() => {
      const v = sys.runtime.view(APP);
      return v.health === "ready" && v.generation > before.generation ? v : null;
    });
    expect(after.generation).toBe(before.generation + 1);
    expect(core.apps.requireApp(APP).epoch).toBe(3);
    await sys.invocations.query(APP, "main", {}, 3);
  });

  it("switching back to the declarative history version goes through a deployment and stops the code instance", async () => {
    const revs = core.apps.listRevisions(APP);
    const v2rev = revs.find((r) => r.runtime === "declarative-v1" && r.title === v2.manifest.title)!;
    const sw = sys.switchVersion(meta({ v2rev }), APP, v2rev.revisionId, 3);
    expect(sw.status).toBe(202);
    const d = await waitFor(() => {
      const row = sys.deployments.get(sw.body.deploymentId);
      return row && row.status === "committed" && row.cleanup_state === "complete" ? row : null;
    });
    expect(d.committed_epoch).toBe(4);
    expect(sys.runtime.view(APP).enabled).toBe(false);
    const recs = core.records.list({ kind: "app", appId: APP, viaUser: true }, APP, {});
    expect(recs.items.every((r) => r.data.done === true)).toBe(true);
    const report = await sys.reconciler.runOnce();
    expect(report.engineReachable).toBe(true);
    const left = await sys.opts.driver!.list(sys.ctx.storeUUID);
    expect(left.filter((c) => c.state === "running")).toEqual([]);
  });
});
