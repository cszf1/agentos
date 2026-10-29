/**
 * V4-O02 real maintenance with the model offline (box, real podman): a code app's container is killed until its
 * restart budget is spent (degraded); the approved automatic app-recovery policy converges it again through the one
 * runtime controller, and an online cache GC completes, all while no model is configured. No model request is made,
 * records are untouched, and the maintenance facts are recorded.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { Client, startHost, stopHost, type HostProc } from "../proc.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-v4-o02-"));
let host: HostProc | null = null;
afterAll(async () => {
  if (host) await stopHost(host).catch(() => undefined);
});
const podman = (...a: string[]) => execFileSync("podman", a, { encoding: "utf8" }).trim();
function q<T>(sql: string, ...a: unknown[]): T[] {
  const db = new DatabaseSync(path.join(dir, "os.sqlite"), { readOnly: true });
  try {
    return db.prepare(sql).all(...(a as never[])) as T[];
  } finally {
    db.close();
  }
}
async function until<T>(f: () => Promise<T> | T, ok: (v: T) => boolean, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  let last: T | undefined;
  for (;;) {
    last = await f();
    if (ok(last)) return last;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}; last ${JSON.stringify(last).slice(0, 600)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
type Rt = { health: string; generation: number; restart_count: number; container_id: string | null };
const rt = (appId: string) =>
  q<Rt>("SELECT ar.health, ar.generation, ar.restart_count, ri.container_id FROM app_runtime ar LEFT JOIN runtime_instances ri ON ri.id = ar.active_instance_id WHERE ar.app_id = ?", appId)[0]!;

describe("V4-O02 real recovery and online GC with the model offline", () => {
  it("a degraded code app is converged by the automatic policy and GC completes, with no model", async () => {
    host = await startHost(dir, { AGENTOS_MODEL_MODE: "faux" });
    let c = new Client(host);
    await c.login(dir);
    const r = await c.req("POST", "/api/runs", { intent: "做一个看板应用", targetAppId: null });
    const appId = r.data.targetAppId as string;
    expect((await c.waitRun(r.data.runId, 240_000)).status).toBe("succeeded");
    await until(() => rt(appId), (x) => x.health === "ready" && !!x.container_id, 120_000, "kanban ready");
    const app = (await c.get(`/api/apps/${appId}`)).data;
    expect((await c.req("POST", `/api/apps/${appId}/commands/add`, { expectedAppEpoch: app.appEpoch, input: { title: "离线前" } })).status).toBeLessThan(300);
    await stopHost(host);

    // restart with no model at all
    host = await startHost(dir, { AGENTOS_MODEL_MODE: "real", AGENTOS_MODEL_PROVIDER: "", AGENTOS_MODEL_ID: "" });
    c = new Client(host);
    await c.login(dir);
    expect((await c.get("/api/state")).data.modelAvailable).toBe(false);
    const attemptsBefore = q<{ n: number }>("SELECT COUNT(*) AS n FROM model_attempts")[0]?.n ?? 0;
    const recordsBefore = q("SELECT app_id, id, version, data_json FROM records ORDER BY app_id, id");
    await until(() => rt(appId), (x) => x.health === "ready" && !!x.container_id, 120_000, "kanban ready after restart");

    // the user approves an automatic recovery policy for this app (exact version + hash)
    const p = await c.req("POST", "/api/maintenance/policies", { templateId: "app-recovery", target: { kind: "app", id: appId }, mode: "automatic", trigger: { kind: "event" }, params: { observeSeconds: 60 } });
    expect(p.status, JSON.stringify(p)).toBe(201);
    const ap = await c.req("POST", `/api/maintenance/policies/${p.data.policyId}/approve`, { version: p.data.version, policyHash: p.data.policyHash });
    expect(ap.status, JSON.stringify(ap)).toBe(200);
    expect(ap.data.state).toBe("enabled");

    // kill the container until the restart budget is spent (the controller's own restarts first)
    const genStart = rt(appId).generation;
    for (let i = 0; i < 6 && rt(appId).health !== "degraded"; i++) {
      const cur = await until(() => rt(appId), (x) => !!x.container_id || x.health === "degraded", 60_000, "a running container");
      if (cur.health === "degraded") break;
      try {
        podman("kill", cur.container_id!);
      } catch {
        /* already gone */
      }
      await until(() => rt(appId), (x) => x.container_id !== cur.container_id || x.health === "degraded", 60_000, "the controller to notice");
    }
    await until(() => rt(appId), (x) => x.health === "degraded", 120_000, "degraded");

    // incident → automatic app-recovery job → converge → verified ready over the observation window
    const job = await until(
      async () => ((await c.get("/api/maintenance/jobs?limit=50")).data.items as { jobId: string; templateId: string; state: string; target: { id: string } }[]).find((j) => j.templateId === "app-recovery" && j.target.id === appId),
      (j) => !!j && ["succeeded", "failed_no_effect", "failed_partial", "needs_attention", "cancelled"].includes(j.state),
      300_000,
      "the recovery job to finish",
    );
    expect(job!.state).toBe("succeeded");
    const after = rt(appId);
    expect(after.health).toBe("ready");
    expect(after.generation).toBeGreaterThan(genStart);
    const q1 = await c.req("POST", `/api/apps/${appId}/queries/main`, { expectedAppEpoch: (await c.get(`/api/apps/${appId}`)).data.appEpoch, input: {} });
    expect(q1.status).toBe(200);

    // online GC with the model offline
    const gc = await c.req("POST", "/api/maintenance/checks", { templateId: "cache-gc", target: { kind: "workspace", id: "workspace" } });
    expect(gc.status, JSON.stringify(gc)).toBe(202);
    const gj = await until(async () => (await c.get(`/api/maintenance/jobs/${gc.data.jobId}`)).data, (j) => ["succeeded", "no_change", "failed_no_effect", "needs_attention"].includes(j.state), 180_000, "GC");
    expect(["succeeded", "no_change"]).toContain(gj.state);

    // no model request was made, the records are untouched, the facts are recorded
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM model_attempts")[0]?.n ?? 0).toBe(attemptsBefore);
    expect(q("SELECT app_id, id, version, data_json FROM records ORDER BY app_id, id")).toEqual(recordsBefore);
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM maintenance_steps WHERE job_id = ?", job!.jobId)[0]!.n).toBeGreaterThan(0);
    console.log(`O02 recovery job ${job!.jobId} ${job!.state}; generation ${genStart} -> ${after.generation}; gc ${gj.state}`);
  }, 900_000);
});
