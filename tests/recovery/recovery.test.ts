import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Client, ROOT, startHost, stopHost, waitHttp, type HostProc } from "../proc.js";
import { tmpDir } from "../helpers.js";

/**
 * Process-level recovery tests: real Linux child processes, real SQLite files, SIGKILL fault injection
 * (only active with NODE_ENV=test and AGENTOS_FAULTS=1).
 */

const FAULT = (point: string) => ({ AGENTOS_FAULTS: "1", AGENTOS_FAULT_POINT: point });

function q<T = Record<string, unknown>>(file: string, sql: string, ...params: unknown[]): T[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}

const os = (dir: string) => path.join(dir, "os.sqlite");
const agent = (dir: string) => path.join(dir, "agent.sqlite");

async function login(h: HostProc): Promise<Client> {
  const c = new Client(h);
  await c.login(h.dataDir);
  return c;
}

/** Start a host that is expected to die at a fault point; resolve with its exit. */
async function startDying(dir: string, point: string, port?: number): Promise<HostProc> {
  return startHost(dir, FAULT(point), { port, waitReady: true });
}

async function createApp(c: Client) {
  const r = await c.req("POST", "/api/runs", { intent: "做一个待办应用", targetAppId: null });
  const run = await c.waitRun(r.data.runId);
  return { appId: run.targetAppId as string, run };
}

describe("R: crash recovery across os.sqlite and agent.sqlite", () => {
  it("R01 kill after os accepted the run, before Pi submit: restart submits exactly once", async () => {
    for (const point of ["run.after_accept", "dispatch.before_submit"]) {
      const dir = tmpDir();
      const h = await startDying(dir, point);
      const c = await login(h);
      await c.req("POST", "/api/runs", { intent: "做一个待办应用", targetAppId: null }).catch(() => undefined);
      expect(await h.exit).not.toBe(0);
      const run = q<{ id: string; status: string; dispatch_state: string }>(os(dir), "SELECT id, status, dispatch_state FROM runs")[0]!;
      expect(run.status).toBe("queued");
      expect(q(agent(dir), "SELECT id FROM submissions WHERE request_id = ?", JSON.stringify(run.id))).toHaveLength(0);
      const h2 = await startHost(dir);
      const c2 = await login(h2);
      const done = await c2.waitRun(run.id);
      expect(done.status).toBe("succeeded");
      expect(q(agent(dir), "SELECT id FROM submissions WHERE request_id = ?", JSON.stringify(run.id))).toHaveLength(1);
      await stopHost(h2);
    }
  });

  it("R02 kill after Pi submit, before submissionId is saved: same runId finds the same submission", async () => {
    const dir = tmpDir();
    const h = await startDying(dir, "dispatch.after_submit");
    const c = await login(h);
    await c.req("POST", "/api/runs", { intent: "做一个待办应用 [faux:slow:300]", targetAppId: null }).catch(() => undefined);
    await h.exit;
    const run = q<{ id: string; dispatch_state: string; pi_submission_id: number | null }>(os(dir), "SELECT * FROM runs")[0]!;
    expect(run.dispatch_state).toBe("dispatching");
    expect(run.pi_submission_id).toBeNull();
    const subs = q<{ id: number }>(agent(dir), "SELECT id FROM submissions WHERE request_id = ?", JSON.stringify(run.id));
    expect(subs).toHaveLength(1);
    const h2 = await startHost(dir);
    const done = await (await login(h2)).waitRun(run.id);
    expect(done.status).toBe("succeeded");
    expect(q<{ pi_submission_id: number }>(os(dir), "SELECT pi_submission_id FROM runs")[0]!.pi_submission_id).toBe(subs[0]!.id);
    expect(q(agent(dir), "SELECT id FROM submissions WHERE request_id = ?", JSON.stringify(run.id))).toHaveLength(1);
    await stopHost(h2);
  });

  it("R03 kill inside the activation transaction: all old state, then a clean publish", async () => {
    const dir = tmpDir();
    const h = await startDying(dir, "activate.before_commit");
    const c = await login(h);
    await c.req("POST", "/api/runs", { intent: "做一个待办应用", targetAppId: null });
    await h.exit;
    const app = q<{ id: string; epoch: number; active_revision_id: string | null; contract_json: string }>(os(dir), "SELECT * FROM apps")[0]!;
    expect(app.epoch).toBe(0);
    expect(app.active_revision_id).toBeNull();
    expect(JSON.parse(app.contract_json)).toEqual({ fields: {} });
    expect(q(os(dir), "SELECT * FROM revisions WHERE first_activated_at IS NOT NULL")).toHaveLength(0);
    expect(q(os(dir), "SELECT * FROM runs WHERE applied_revision_id IS NOT NULL")).toHaveLength(0);
    const h2 = await startHost(dir);
    const runId = q<{ id: string }>(os(dir), "SELECT id FROM runs")[0]!.id;
    const done = await (await login(h2)).waitRun(runId);
    expect(done.status).toBe("succeeded");
    expect(q<{ epoch: number }>(os(dir), "SELECT epoch FROM apps")[0]!.epoch).toBe(1);
    await stopHost(h2);
  });

  it("R04 kill after activation commit, before Pi stored the tool result: receipt replay, epoch +1 once", async () => {
    const dir = tmpDir();
    const h = await startDying(dir, "activate.after_commit");
    const c = await login(h);
    await c.req("POST", "/api/runs", { intent: "做一个待办应用", targetAppId: null });
    await h.exit;
    const run = q<{ id: string; status: string; applied_revision_id: string }>(os(dir), "SELECT * FROM runs")[0]!;
    expect(run.applied_revision_id).toMatch(/^sha256:/);
    expect(run.status).toBe("running");
    const h2 = await startHost(dir);
    const done = await (await login(h2)).waitRun(run.id);
    expect(done.status).toBe("succeeded");
    expect(done.appliedRevisionId).toBe(run.applied_revision_id);
    expect(q<{ epoch: number }>(os(dir), "SELECT epoch FROM apps")[0]!.epoch).toBe(1);
    expect(q(os(dir), "SELECT seq FROM events WHERE kind = 'app.activated'")).toHaveLength(1);
    expect(q(os(dir), "SELECT * FROM operations WHERE operation_key LIKE ?", `%/${run.id}/%/app_activate`)).toHaveLength(1);
    await stopHost(h2);
  });

  it("R05 cancel committed first, then kill: no publish and the cancel holds after restart", async () => {
    const dir = tmpDir();
    const h = await startHost(dir);
    const c = await login(h);
    const r = await c.req("POST", "/api/runs", { intent: "做一个待办应用 [faux:slow:1500]", targetAppId: null });
    for (let i = 0; i < 50 && (await c.get(`/api/runs/${r.data.runId}`)).data.dispatchState !== "submitted"; i++) await new Promise((x) => setTimeout(x, 50));
    const cancel = await c.req("POST", `/api/runs/${r.data.runId}/cancel`, {});
    expect(cancel.status).toBe(202);
    await stopHost(h, "SIGKILL");
    const h2 = await startHost(dir);
    const done = await (await login(h2)).waitRun(r.data.runId);
    expect(done.status).toBe("cancelled");
    expect(done.appliedRevisionId).toBeNull();
    expect(q(os(dir), "SELECT * FROM apps WHERE active_revision_id IS NOT NULL")).toHaveLength(0);
    await stopHost(h2);
  });

  it("R06 activation committed first, then cancel: ALREADY_APPLIED and reported published", async () => {
    const dir = tmpDir();
    const h = await startHost(dir);
    const c = await login(h);
    const r = await c.req("POST", "/api/runs", { intent: "做一个待办应用 [faux:post-write][faux:slow:400]", targetAppId: null });
    let applied = false;
    for (let i = 0; i < 200 && !applied; i++) {
      const v = await c.get(`/api/runs/${r.data.runId}`);
      applied = v.data.appliedRevisionId !== null;
      if (!applied) await new Promise((x) => setTimeout(x, 25));
    }
    const cancel = await c.req("POST", `/api/runs/${r.data.runId}/cancel`, {});
    expect(cancel.error?.code).toBe("ALREADY_APPLIED");
    const done = await c.waitRun(r.data.runId);
    expect(done.status).toBe("succeeded");
    await stopHost(h);
  });

  it("R07 SIGTERM keeps the run for recovery; a vanished client cancels nothing", async () => {
    const dir = tmpDir();
    const h = await startHost(dir);
    const c = await login(h);
    const r = await c.req("POST", "/api/runs", { intent: "做一个待办应用 [faux:slow:700]", targetAppId: null });
    await new Promise((x) => setTimeout(x, 300));
    expect(await stopHost(h, "SIGTERM")).toBe(0);
    const mid = q<{ status: string }>(os(dir), "SELECT status FROM runs")[0]!;
    expect(mid.status).not.toBe("cancelled");
    const h2 = await startHost(dir);
    const done = await (await login(h2)).waitRun(r.data.runId);
    expect(done.status).toBe("succeeded");
    await stopHost(h2);
  });

  it("R08 while an old run recovers, a new run is refused and gets no authority", async () => {
    const dir = tmpDir();
    const h = await startHost(dir);
    const c = await login(h);
    const r = await c.req("POST", "/api/runs", { intent: "做一个待办应用 [faux:slow:1200]", targetAppId: null });
    await new Promise((x) => setTimeout(x, 200));
    await stopHost(h, "SIGKILL");
    const h2 = await startHost(dir);
    const c2 = await login(h2);
    const second = await c2.req("POST", "/api/runs", { intent: "另一个", targetAppId: null });
    expect(second.error?.code).toBe("RUN_BUSY");
    expect(q(os(dir), "SELECT id FROM runs")).toHaveLength(1);
    expect((await c2.waitRun(r.data.runId)).status).toBe("succeeded");
    await stopHost(h2);
  });

  it("R09 a task that keeps crashing is parked: run blocked and visible, then cancellable", async () => {
    const dir = tmpDir();
    let h = await startHost(dir, FAULT("tool.app_get"));
    const c = await login(h);
    const r = await c.req("POST", "/api/runs", { intent: "做一个待办应用", targetAppId: null });
    await h.exit;
    let status = "";
    for (let i = 0; i < 9 && status !== "blocked"; i++) {
      h = await startHost(dir, FAULT("tool.app_get"), { waitReady: false });
      await Promise.race([h.exit, new Promise((x) => setTimeout(x, 4000))]);
      status = q<{ status: string }>(os(dir), "SELECT status FROM runs")[0]!.status;
      if (h.proc.exitCode === null && h.proc.signalCode === null && status !== "blocked") await new Promise((x) => setTimeout(x, 1000));
      status = q<{ status: string }>(os(dir), "SELECT status FROM runs")[0]!.status;
    }
    expect(status).toBe("blocked");
    await waitHttp(h);
    const c2 = await login(h);
    const view = await c2.get(`/api/runs/${r.data.runId}`);
    expect(view.data.error.code).toBe("RECOVERY_BLOCKED");
    expect((await c2.req("POST", "/api/runs", { intent: "x", targetAppId: null })).error?.code).toBe("RUN_BUSY");
    expect((await c2.req("POST", `/api/runs/${r.data.runId}/cancel`, {})).status).toBe(202);
    const done = await c2.waitRun(r.data.runId);
    expect(done.status).toBe("cancelled");
    await stopHost(h);
  }, 120_000);

  it("R11 interrupted first pairing completes; a foreign or missing agent.sqlite blocks scheduling", async () => {
    const dir = tmpDir();
    const h = await startHost(dir, FAULT("bind.after_marker"), { waitReady: false });
    await h.exit;
    expect(q<{ agent_binding_state: string }>(os(dir), "SELECT agent_binding_state FROM meta")[0]!.agent_binding_state).toBe("pending");
    const h2 = await startHost(dir);
    expect(q<{ agent_binding_state: string }>(os(dir), "SELECT agent_binding_state FROM meta")[0]!.agent_binding_state).toBe("bound");
    const c = await login(h2);
    const { appId } = await createApp(c);
    await stopHost(h2);

    // foreign agent.sqlite
    const other = tmpDir();
    const ho = await startHost(other);
    await stopHost(ho);
    for (const s of ["", "-wal", "-shm"]) {
      fs.rmSync(agent(dir) + s, { force: true });
      if (fs.existsSync(agent(other) + s)) fs.copyFileSync(agent(other) + s, agent(dir) + s);
    }
    const h3 = await startHost(dir);
    const c3 = await login(h3);
    const st = await c3.get("/api/state");
    expect(st.data.agentState).toBe("blocked");
    expect(st.data.agentDiagnostic).toContain("different workspace");
    expect((await fetch(`http://127.0.0.1:${h3.port}/health/ready`)).status).toBe(503);
    expect((await c3.req("POST", "/api/runs", { intent: "x", targetAppId: null })).error?.code).toBe("RECOVERY_BLOCKED");
    expect((await c3.get(`/api/apps/${appId}/records`)).status).toBe(200);
    await stopHost(h3);

    // missing agent.sqlite: refuse, do not silently create a replacement store
    for (const s of ["", "-wal", "-shm"]) fs.rmSync(agent(dir) + s, { force: true });
    const h4 = await startHost(dir);
    const st4 = await (await login(h4)).get("/api/state");
    expect(st4.data.agentState).toBe("blocked");
    expect(st4.data.agentDiagnostic).toContain("missing");
    await stopHost(h4);
  });
});

describe("O: operations", () => {
  it("O01 a second host on the same data dir exits before opening the databases", async () => {
    const dir = tmpDir();
    const h = await startHost(dir);
    const second = spawnSync(path.join(ROOT, "bin", "agentos-host"), [], { env: { ...process.env, AGENTOS_DATA_DIR: dir, AGENTOS_PORT: String(h.port + 1) }, timeout: 15_000 });
    expect(second.status).toBe(75);
    await stopHost(h);
  });

  it("O03 cold backup/restore keeps the pair; old sessions and epochs are refused", async () => {
    const dir = tmpDir();
    let h = await startHost(dir);
    let c = await login(h);
    const { appId } = await createApp(c);
    const app = await c.get(`/api/apps/${appId}`);
    await c.req("POST", `/api/apps/${appId}/records`, { expectedAppEpoch: app.data.appEpoch, data: { title: "备份前" } });
    const running = spawnSync(path.join(ROOT, "bin", "agentos-admin"), ["backup", "--output", path.join(tmpDir(), "b")], { env: { ...process.env, AGENTOS_DATA_DIR: dir } });
    expect(running.status).toBe(75); // host holds the lock
    await stopHost(h);
    const backupDir = path.join(tmpDir(), "backup1");
    const b = spawnSync(path.join(ROOT, "bin", "agentos-admin"), ["backup", "--output", backupDir], { env: { ...process.env, AGENTOS_DATA_DIR: dir }, encoding: "utf8" });
    expect(b.status, b.stderr).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, "manifest.json"), "utf8"));
    expect(Object.keys(manifest.files)).toEqual(expect.arrayContaining(["os.sqlite", "agent.sqlite"]));
    h = await startHost(dir);
    c = await login(h);
    const oldCookie = c.cookie;
    await c.req("POST", `/api/apps/${appId}/records`, { expectedAppEpoch: app.data.appEpoch, data: { title: "备份后" } });
    await stopHost(h);
    const r = spawnSync(path.join(ROOT, "bin", "agentos-admin"), ["restore", "--backup", backupDir], { env: { ...process.env, AGENTOS_DATA_DIR: dir }, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    h = await startHost(dir);
    const stale = new Client(h);
    stale.cookie = oldCookie;
    expect((await stale.get("/api/state")).status).toBe(401);
    const fresh = await login(h);
    expect(fresh.epoch).toBeGreaterThan(c.epoch);
    const titles = (await fresh.get(`/api/apps/${appId}/records`)).data.items.map((i: { data: { title: string } }) => i.data.title);
    expect(titles).toEqual(["备份前"]);
    const oldEpochWrite = await fresh.req("POST", `/api/apps/${appId}/records`, { expectedAppEpoch: app.data.appEpoch, data: { title: "x" } }, undefined, { "x-agentos-epoch": String(c.epoch) });
    expect(oldEpochWrite.error?.code).toBe("CLIENT_EPOCH_STALE");
    expect((await fresh.get("/api/state")).data.agentState).toBe("ready");
    const again = await fresh.req("POST", "/api/runs", { intent: "增加优先级", targetAppId: appId, expectedAppEpoch: app.data.appEpoch });
    expect((await fresh.waitRun(again.data.runId)).status).toBe("succeeded");
    await stopHost(h);
  });

  it("O04 a broken os.sqlite stops startup without deleting anything or leaking the token", async () => {
    const dir = tmpDir();
    const h = await startHost(dir);
    await stopHost(h);
    const token = fs.readFileSync(path.join(dir, "auth-token"), "utf8").trim();
    for (const s of ["-wal", "-shm"]) fs.rmSync(os(dir) + s, { force: true });
    fs.writeFileSync(os(dir), Buffer.alloc(8192, 7));
    const h2 = await startHost(dir, {}, { waitReady: false });
    const code = await h2.exit;
    expect(code).not.toBe(0);
    expect(fs.readFileSync(os(dir)).equals(Buffer.alloc(8192, 7))).toBe(true);
    const logs = h2.logs.join("") + fs.readFileSync(path.join(dir, "logs", "host.log"), "utf8");
    expect(logs).not.toContain(token);
    expect(logs).toContain("not deleting anything");
  });

  it("O05 a restore that died after replacing one database blocks the host until finished", async () => {
    const dir = tmpDir();
    let h = await startHost(dir);
    const c = await login(h);
    await createApp(c);
    await stopHost(h);
    const backupDir = path.join(tmpDir(), "bk");
    expect(spawnSync(path.join(ROOT, "bin", "agentos-admin"), ["backup", "--output", backupDir], { env: { ...process.env, AGENTOS_DATA_DIR: dir } }).status).toBe(0);
    const killed = spawnSync(path.join(ROOT, "bin", "agentos-admin"), ["restore", "--backup", backupDir], {
      env: { ...process.env, AGENTOS_DATA_DIR: dir, NODE_ENV: "test", ...FAULT("restore.after_first_replace") },
    });
    expect(killed.status).not.toBe(0);
    expect(fs.existsSync(path.join(dir, "restore-in-progress"))).toBe(true);
    const blocked = await startHost(dir, {}, { waitReady: false });
    expect(await blocked.exit).toBe(1);
    expect(blocked.logs.join("")).toContain("restore is in progress");
    const fin = spawnSync(path.join(ROOT, "bin", "agentos-admin"), ["restore", "--backup", backupDir], { env: { ...process.env, AGENTOS_DATA_DIR: dir }, encoding: "utf8" });
    expect(fin.status, fin.stderr).toBe(0);
    h = await startHost(dir);
    expect((await (await login(h)).get("/api/state")).data.apps).toHaveLength(1);
    await stopHost(h);
  });
});
