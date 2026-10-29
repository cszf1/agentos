/**
 * v0.4 cold backup and restore with conversations, policies and the scheduler (spec §23, V4-R06..R10). Real host
 * processes, real `agentos-admin backup/restore`, real os.sqlite/agent.sqlite, the formal faux model. Needs the code
 * runtime (rootless podman) like the v0.2 restore tests.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Client, ROOT, seedFixtures, startHost, stopHost } from "../proc.js";
import { tmpDir } from "../helpers.js";

const SOCK = `/run/user/${process.getuid!()}/podman/podman.sock`;
const d = fs.existsSync(SOCK) ? describe : describe.skip;

function q<T = Record<string, unknown>>(dir: string, sql: string, ...params: unknown[]): T[] {
  const db = new DatabaseSync(path.join(dir, "os.sqlite"), { readOnly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}
async function until<T>(f: () => Promise<T | null | undefined | false>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as T;
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 500));
  }
}
const admin = (dir: string, args: string[]) => spawnSync(path.join(ROOT, "bin", "agentos-admin"), args, { env: { ...process.env, AGENTOS_DATA_DIR: dir }, encoding: "utf8", timeout: 300_000 });

d("v0.4 backup / restore", () => {
  it("V4-R06/R07/R08/R09 backup records conversations, policies and epochs; restore never lets old work act again and keeps history", async () => {
    const dir = tmpDir();
    const [a] = await seedFixtures(dir, ["todo-v1.json"]);
    let h = await startHost(dir, { AGENTOS_MODEL_MODE: "faux" });
    let c = new Client(h);
    await c.login(dir);
    // an approved automatic policy and a finished task conversation
    const created = await c.req("POST", "/api/maintenance/policies", { templateId: "app-recovery", target: { kind: "app", id: a!.appId }, mode: "automatic", trigger: { kind: "manual" } });
    expect(created.status, JSON.stringify(created)).toBe(201);
    const ap = await c.req("POST", `/api/maintenance/policies/${created.data.policyId}/approve`, { version: created.data.version, policyHash: created.data.policyHash });
    expect([200, 202]).toContain(ap.status);
    const r1 = await c.req("POST", "/api/runs", { intent: "增加优先级", targetAppId: a!.appId, expectedAppEpoch: 1 });
    expect(r1.status).toBe(202);
    expect((await c.waitRun(r1.data.runId, 180_000)).status).toBe("succeeded");
    // a second task still running when the host stops (shutdown drains it to a durable state)
    const r2 = await c.req("POST", "/api/runs", { intent: "增加截止日期 [faux:slow:5000]", targetAppId: a!.appId, expectedAppEpoch: (await c.get(`/api/apps/${a!.appId}`)).data.epoch });
    expect(r2.status).toBe(202);
    await until(async () => q<{ status: string }>(dir, "SELECT status FROM runs WHERE id = ?", r2.data.runId)[0]?.status === "running");
    await stopHost(h);

    const out = path.join(tmpDir(), "bk");
    const b = admin(dir, ["backup", "--output", out]);
    expect(b.status, b.stderr).toBe(0);
    const m = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    // R06: the coordinated cold backup carries the v0.4 facts
    expect(m.v04).toBeTruthy();
    expect(m.v04.conversations.total).toBeGreaterThanOrEqual(2);
    expect(m.v04.policies.some((p: { id: string; state: string }) => p.id === created.data.policyId && p.state === "enabled")).toBe(true);
    expect(m.v04.openDeleteIntents).toBe(0);
    const backupEpochs = { s: m.v04.schedulerEpoch, e: m.v04.maintenanceEpoch };

    // R08: work after the backup on the original workspace
    h = await startHost(dir, { AGENTOS_MODEL_MODE: "faux" });
    c = new Client(h);
    await c.login(dir);
    await c.waitRun(r2.data.runId, 180_000).catch(() => undefined);
    const afterBackupRevisions = q<{ n: number }>(dir, "SELECT COUNT(*) AS n FROM revisions WHERE app_id = ?", a!.appId)[0]!.n;
    await stopHost(h);

    // restore the older backup into a new directory
    const target = tmpDir();
    const rs = admin(target, ["restore", "--backup", out]);
    expect(rs.status, rs.stderr).toBe(0);
    const meta = q<{ scheduler_epoch: number; maintenance_epoch: number }>(target, "SELECT scheduler_epoch, maintenance_epoch FROM meta WHERE id = 1")[0]!;
    // R07: new scheduler and maintenance epochs; the old policy needs a new review; nothing old dispatches
    expect(meta.scheduler_epoch).toBeGreaterThan(backupEpochs.s);
    expect(meta.maintenance_epoch).toBeGreaterThan(backupEpochs.e);
    expect(q<{ state: string }>(target, "SELECT state FROM maintenance_policies WHERE id = ?", created.data.policyId)[0]!.state).toBe("paused_needs_review");
    expect(q(target, "SELECT id FROM maintenance_jobs WHERE state IN ('queued','observing','analyzing','waiting','acting','verifying')")).toHaveLength(0);
    expect(q(target, "SELECT id FROM maintenance_effect_outbox WHERE dispatch_state IN ('pending','sent','accepted')")).toHaveLength(0);
    // the task that was running at backup time is fenced: a new execution epoch and a closed route
    const old = q<{ status: string; stop_reason: string | null }>(target, "SELECT status, stop_reason FROM runs WHERE id = ?", r2.data.runId)[0]!;
    expect(["cancel_requested", "cancelled", "failed"]).toContain(old.status);
    const routes = q<{ route_purpose: string }>(target, "SELECT route_purpose FROM agent_conversations WHERE run_id = ?", r2.data.runId);
    for (const r of routes) expect(r.route_purpose).toBe("closed");
    // R09: no object is left half-deleted; nothing is `deleting`
    expect(q(target, "SELECT id FROM artifacts WHERE gc_state IN ('deleting','marked')")).toHaveLength(0);

    const h2 = await startHost(target, { AGENTOS_MODEL_MODE: "faux" });
    const c2 = new Client(h2);
    await c2.login(target);
    // the old task ends through the normal cancel path, never as the old execution
    const fin = await until(async () => {
      const r = await c2.get(`/api/runs/${r2.data.runId}`);
      return ["cancelled", "failed", "succeeded"].includes(r.data.status) ? r.data : null;
    }, 120_000);
    expect(fin.status).not.toBe("succeeded");
    // the restored workspace is the older one (no revision made after the backup), history is intact
    expect(q<{ n: number }>(target, "SELECT COUNT(*) AS n FROM revisions WHERE app_id = ?", a!.appId)[0]!.n).toBeLessThanOrEqual(afterBackupRevisions);
    const tr = await c2.get(`/api/runs/${r1.data.runId}/transcript`);
    expect(tr.status).toBe(200);
    expect(tr.data.items.length).toBeGreaterThan(0);
    const pol = (await c2.get("/api/maintenance/policies")).data.items.find((p: { policyId: string }) => p.policyId === created.data.policyId);
    expect(pol.state).toBe("paused_needs_review");
    // a new task runs normally on the restored workspace (new execution epoch)
    const r3 = await c2.req("POST", "/api/runs", { intent: "增加备注", targetAppId: a!.appId, expectedAppEpoch: (await c2.get(`/api/apps/${a!.appId}`)).data.epoch });
    expect(r3.status, JSON.stringify(r3)).toBe(202);
    expect((await c2.waitRun(r3.data.runId, 180_000)).status).toBe("succeeded");
    await stopHost(h2);
  }, 900_000);

  it("V4-R10 a restored pair that does not match keeps agent writes closed and never clears either database", async () => {
    const dir = tmpDir();
    await seedFixtures(dir, ["todo-v1.json"]);
    const other = tmpDir();
    await seedFixtures(other, ["todo-v1.json"]);
    for (const d0 of [dir, other]) {
      const h = await startHost(d0, { AGENTOS_MODEL_MODE: "faux" });
      await stopHost(h);
    }
    const out = path.join(tmpDir(), "bk");
    expect(admin(dir, ["backup", "--output", out]).status).toBe(0);
    // swap in another workspace's agent.sqlite (and fix its listed hash so only the pairing is wrong)
    const m = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    const agentKey = Object.keys(m.files ?? {}).find((k) => /agent\.sqlite$/.test(k));
    expect(agentKey).toBeTruthy();
    fs.copyFileSync(path.join(other, "agent.sqlite"), path.join(out, agentKey!));
    m.files[agentKey!] = createHash("sha256").update(fs.readFileSync(path.join(out, agentKey!))).digest("hex");
    fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(m, null, 2));
    const target = tmpDir();
    const rs = admin(target, ["restore", "--backup", out]);
    expect(rs.status, rs.stderr).toBe(0);
    const agentHash = () => createHash("sha256").update(fs.readFileSync(path.join(target, "agent.sqlite"))).digest("hex");
    const before = agentHash();
    const h = await startHost(target, { AGENTOS_MODEL_MODE: "faux" });
    const c = new Client(h);
    await c.login(target);
    // the business side stays readable
    const st = await c.get("/api/state");
    expect(st.status).toBe(200);
    expect(st.data.apps.length).toBe(1);
    // the agent side is closed: no task can start on a mismatched pair, and nothing was "repaired" by clearing it
    const r = await c.req("POST", "/api/runs", { intent: "做一个待办应用", targetAppId: null });
    if (r.status === 202) {
      const fin = await c.waitRun(r.data.runId, 60_000).catch(() => ({ status: "timeout" }));
      expect(fin.status).not.toBe("succeeded");
    } else {
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    await stopHost(h);
    expect(agentHash()).toBe(before);
    expect(q(target, "SELECT id FROM apps")).toHaveLength(1);
  }, 300_000);
});
