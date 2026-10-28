import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Client, ROOT, seedFixtures, startHost, stopHost, type HostProc } from "../proc.js";
import { tmpDir } from "../helpers.js";

/**
 * v0.2 process-level recovery (spec §15, §24 V2-P/D08/A03/A05/O): real host child processes, real SQLite files, real
 * rootless Podman, SIGKILL fault points (NODE_ENV=test + AGENTOS_FAULTS=1 only). Skipped where no engine socket exists.
 */
const SOCK = `/run/user/${process.getuid!()}/podman/podman.sock`;
const HAS_PODMAN = fs.existsSync(SOCK);
const d = HAS_PODMAN ? describe : describe.skip;
const FAULT = (point: string) => ({ AGENTOS_FAULTS: "1", AGENTOS_FAULT_POINT: point });
const os = (dir: string) => path.join(dir, "os.sqlite");

function q<T = Record<string, unknown>>(dir: string, sql: string, ...params: unknown[]): T[] {
  const db = new DatabaseSync(os(dir), { readOnly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}
function exec(dir: string, sql: string, ...params: unknown[]): void {
  const db = new DatabaseSync(os(dir));
  try {
    db.prepare(sql).run(...(params as never[]));
  } finally {
    db.close();
  }
}
/** Workspace containers by store label (podman CLI, outside the host). */
function containers(dir: string): { name: string; state: string; role: string }[] {
  const store = q<{ store_uuid: string }>(dir, "SELECT store_uuid FROM meta")[0]!.store_uuid;
  const out = execFileSync("podman", ["ps", "-a", "--filter", `label=agentos.store=${store}`, "--format", "{{.Names}}\t{{.State}}\t{{.Labels.agentos.role}}"], { encoding: "utf8" });
  return out.trim().split("\n").filter(Boolean).map((l) => {
    const [name, state, role] = l.split("\t");
    return { name: name!, state: state!, role: role! };
  });
}
async function login(h: HostProc): Promise<Client> {
  const c = new Client(h);
  await c.login(h.dataDir);
  return c;
}
async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 200));
  }
}
const appRow = (dir: string, appId: string) => q<{ epoch: number; data_epoch: number; active_revision_id: string }>(dir, "SELECT epoch, data_epoch, active_revision_id FROM apps WHERE id = ?", appId)[0]!;

/** A crash during a code generation: the dying host, then a clean restart that must converge. */
async function crashDuringCodeRun(point: string, intent = "做一个待办看板应用") {
  const dir = tmpDir();
  const h = await startHost(dir, FAULT(point));
  const c = await login(h);
  const r = await c.req("POST", "/api/runs", { intent, targetAppId: null });
  expect(r.status).toBe(202);
  const code = await Promise.race([h.exit, new Promise((res) => setTimeout(() => res("alive"), 120_000))]);
  expect(code).not.toBe("alive");
  return { dir, runId: r.data.runId as string, appId: r.data.targetAppId as string };
}

d("V2-P: publication crash recovery (real processes and podman)", () => {
  it("V2-P02 container created, id not registered: the restart finds it by its persisted identity; no duplicate orphans", async () => {
    const { dir, runId, appId } = await crashDuringCodeRun("build.after_container_create");
    const job = q<{ container_name: string; container_id: string | null; status: string }>(dir, "SELECT container_name, container_id, status FROM build_jobs")[0]!;
    expect(job.container_id).toBeNull();
    expect(containers(dir).map((x) => x.name)).toContain(job.container_name);
    const h = await startHost(dir);
    const c = await login(h);
    const run = await c.waitRun(runId, 180_000);
    expect(run.status).toBe("succeeded");
    expect(containers(dir).map((x) => x.name)).not.toContain(job.container_name);
    const left = containers(dir);
    expect(left.filter((x) => x.role === "build")).toEqual([]);
    // the activated candidate keeps its creation label (preview) until it is replaced
    expect(left.filter((x) => x.state === "running")).toHaveLength(1);
    expect(appRow(dir, appId).epoch).toBe(1);
    await stopHost(h);
  });

  it("V2-P03 artifact written, not registered: the restart verifies and registers it; no half-built reference", async () => {
    const { dir, runId } = await crashDuringCodeRun("build.after_artifact_write");
    expect(q(dir, "SELECT * FROM artifacts")).toHaveLength(0);
    const onDisk = fs.readdirSync(path.join(dir, "artifacts")).filter((n) => /^[0-9a-f]{64}$/.test(n));
    expect(onDisk).toHaveLength(1);
    const h = await startHost(dir);
    const c = await login(h);
    expect((await c.waitRun(runId, 180_000)).status).toBe("succeeded");
    const arts = q<{ id: string }>(dir, "SELECT id FROM artifacts");
    expect(arts.map((a) => a.id.slice(7))).toEqual(onDisk);
    await stopHost(h);
  });

  it("V2-P04 ready but not activated: the old version stays active, the restart prepares again within its deadline", async () => {
    const { dir, runId, appId } = await crashDuringCodeRun("deploy.after_ready");
    expect(appRow(dir, appId).active_revision_id).toBeNull();
    expect(q<{ status: string }>(dir, "SELECT status FROM deployments")[0]!.status).toBe("ready");
    const h = await startHost(dir);
    const c = await login(h);
    expect((await c.waitRun(runId, 180_000)).status).toBe("succeeded");
    expect(appRow(dir, appId).epoch).toBe(1);
    expect(q<{ status: string }>(dir, "SELECT status FROM deployments WHERE status = 'committed'")).toHaveLength(1);
    await stopHost(h);
  });

  it("V2-P05 kill inside the activation transaction: pointer, contract, defaults, receipts and facts are all old", async () => {
    // a v1 app with records first, then the kanban upgrade crashes inside activation
    const dir = tmpDir();
    const [seed] = await seedFixtures(dir, ["todo-v1.json"]);
    const h0 = await startHost(dir);
    const c0 = await login(h0);
    for (const t of ["a", "b"]) await c0.req("POST", `/api/apps/${seed!.appId}/records`, { expectedAppEpoch: 1, data: { title: t } });
    await stopHost(h0);
    const before = { app: appRow(dir, seed!.appId), recs: q(dir, "SELECT * FROM records ORDER BY id"), ops: q(dir, "SELECT COUNT(*) AS n FROM operations")[0] };
    const h = await startHost(dir, FAULT("deploy.activate_before_commit"));
    const c = await login(h);
    const r = await c.req("POST", "/api/runs", { intent: "改成看板，支持批量完成", targetAppId: seed!.appId, expectedAppEpoch: 1 });
    expect(await h.exit).not.toBe(0);
    expect(appRow(dir, seed!.appId)).toEqual(before.app);
    expect(q(dir, "SELECT * FROM records ORDER BY id")).toEqual(before.recs);
    expect(q(dir, "SELECT * FROM deployments WHERE status = 'committed'")).toHaveLength(0);
    expect(q<{ applied_revision_id: string | null }>(dir, "SELECT applied_revision_id FROM runs WHERE id = ?", r.data.runId)[0]!.applied_revision_id).toBeNull();
    void before.ops;
    const h2 = await startHost(dir);
    const c2 = await login(h2);
    const fin = await c2.waitRun(r.data.runId, 180_000);
    expect(fin.status, JSON.stringify(fin.error) + h2.logs.join("").split("\n").filter((l) => /warn|error/.test(l)).slice(-8).join("\n")).toBe("succeeded");
    expect(appRow(dir, seed!.appId).epoch).toBe(2);
    await stopHost(h2);
  });

  it("V2-P06 activation committed, Pi result not recorded: the receipt replays; the epoch rises once", async () => {
    const { dir, runId, appId } = await crashDuringCodeRun("activate.after_commit");
    expect(appRow(dir, appId).epoch).toBe(1);
    const h = await startHost(dir);
    const c = await login(h);
    expect((await c.waitRun(runId, 120_000)).status).toBe("succeeded");
    expect(appRow(dir, appId).epoch).toBe(1);
    expect(q(dir, "SELECT * FROM operations WHERE operation_key LIKE ?", `%/${runId}/%/app_activate`)).toHaveLength(1);
    await until(async () => ((await c.get(`/api/apps/${appId}/runtime`)).data?.health === "ready" ? true : null));
    await stopHost(h);
  });

  it("V2-P08 user switch committed, old container not cleaned: the restart removes it without undoing the new version", async () => {
    const dir = tmpDir();
    const [a, , k] = await seedFixtures(dir, ["todo-v1.json", "v0.2/todo-kanban", "v0.2/todo-kanban-hours"]);
    void a;
    const h0 = await startHost(dir, FAULT("deploy.user_after_commit"));
    const c0 = await login(h0);
    const appId = k!.appId;
    await until(async () => ((await c0.get(`/api/apps/${appId}/runtime`)).data?.health === "ready" ? true : null));
    const revs = (await c0.get(`/api/apps/${appId}/revisions`)).data.items as { revisionId: string; title: string }[];
    const kanban = revs.find((r) => r.title === "待办看板")!;
    await c0.req("POST", `/api/apps/${appId}/deployments`, { revisionId: kanban.revisionId, expectedAppEpoch: 3 });
    expect(await h0.exit).not.toBe(0);
    expect(appRow(dir, appId).active_revision_id).toBe(kanban.revisionId);
    expect(appRow(dir, appId).epoch).toBe(4);
    // the old and the new instance containers are left behind (running, or exited once the runner sees the host gone)
    const running = containers(dir);
    expect(running.length).toBeGreaterThanOrEqual(1);
    const h = await startHost(dir);
    const c = await login(h);
    await until(async () => ((await c.get(`/api/apps/${appId}/runtime`)).data?.health === "ready" ? true : null));
    expect(appRow(dir, appId).active_revision_id).toBe(kanban.revisionId);
    expect(appRow(dir, appId).epoch).toBe(4);
    const after = containers(dir).filter((x) => x.state === "running");
    expect(after).toHaveLength(1);
    await until(() => containers(dir).every((x) => !running.some((o) => o.name === x.name)) || null);
    await stopHost(h);
  });
});

d("V2-D08 / A03: command and prepare interruption (real processes)", () => {
  it("V2-D08 crash before the commit re-executes within budget; crash after the commit only replays; records commit once", async () => {
    for (const point of ["invocation.before_commit", "invocation.after_commit"]) {
      const dir = tmpDir();
      const [, k] = await seedFixtures(dir, ["todo-v1.json", "v0.2/todo-kanban"]);
      const appId = k!.appId;
      const h = await startHost(dir, FAULT(point));
      const c = await login(h);
      await until(async () => ((await c.get(`/api/apps/${appId}/runtime`)).data?.health === "ready" ? true : null));
      const key = "0b6c8b4e-2a4f-4b5e-9c1d-3e2f1a0b9c8d";
      const r = await c.req("POST", `/api/apps/${appId}/commands/add`, { expectedAppEpoch: 2, input: { title: "只写一次" } }, key);
      expect(r.status).toBe(202);
      expect(await h.exit).not.toBe(0);
      const h2 = await startHost(dir);
      const c2 = await login(h2);
      const inv = await until(async () => {
        const g = await c2.get(`/api/invocations/${r.data.invocationId}`);
        return g.data && (g.data.status === "succeeded" || g.data.status === "failed") ? g.data : null;
      });
      expect(inv.status).toBe("succeeded");
      expect(inv.attempt).toBe(point === "invocation.before_commit" ? 2 : 1);
      expect(q(dir, "SELECT * FROM records WHERE app_id = ? AND data_json LIKE ?", appId, "%只写一次%")).toHaveLength(1);
      // the same key + body replays the acceptance; nothing executes again
      const again = await c2.req("POST", `/api/apps/${appId}/commands/add`, { expectedAppEpoch: 2, input: { title: "只写一次" } }, key);
      expect(again.data.invocationId).toBe(r.data.invocationId);
      expect(q(dir, "SELECT * FROM records WHERE app_id = ? AND data_json LIKE ?", appId, "%只写一次%")).toHaveLength(1);
      await stopHost(h2);
    }
  });

  it("V2-A03 app_prepare replay finds the original deployment; a finished one is not restarted by its old receipt", async () => {
    const { dir, runId } = await crashDuringCodeRun("tool.app_prepare.after_accept");
    expect(q(dir, "SELECT * FROM deployments")).toHaveLength(1);
    const h = await startHost(dir);
    const c = await login(h);
    expect((await c.waitRun(runId, 180_000)).status).toBe("succeeded");
    const deps = q<{ id: string; status: string }>(dir, "SELECT id, status FROM deployments");
    expect(deps).toHaveLength(1);
    expect(deps[0]!.status).toBe("committed");
    await stopHost(h);
    // restart again: the committed deployment stays committed; nothing re-prepares
    const h2 = await startHost(dir);
    await new Promise((r) => setTimeout(r, 2000));
    expect(q<{ status: string; updated_at: string }>(dir, "SELECT status FROM deployments")).toEqual([{ status: "committed" }]);
    expect(q(dir, "SELECT * FROM build_jobs")).toHaveLength(1);
    await stopHost(h2);
  });

  it("V2-A05 a non-idle old root refuses the tool set upgrade; nothing is cleared or mis-bound", async () => {
    const dir = tmpDir();
    const h = await startHost(dir);
    const c = await login(h);
    const done = await c.waitRun((await c.req("POST", "/api/runs", { intent: "做一个待办应用", targetAppId: null })).data.runId);
    await c.req("POST", `/api/apps/${done.targetAppId}/records`, { expectedAppEpoch: 1, data: { title: "保留" } });
    const slow = await c.req("POST", "/api/runs", { intent: "增加优先级 [faux:slow:20000]", targetAppId: done.targetAppId, expectedAppEpoch: 1 });
    await until(async () => q<{ dispatch_state: string }>(dir, "SELECT dispatch_state FROM runs WHERE id = ?", slow.data.runId)[0]?.dispatch_state === "submitted");
    h.proc.kill("SIGKILL");
    await h.exit;
    // simulate a workspace that was written by the v0.1 tool set
    exec(dir, "UPDATE meta SET agent_toolset_version = 1");
    const before = q(dir, "SELECT * FROM records");
    const migBefore = q(dir, "SELECT * FROM agent_toolset_migrations");
    const h2 = await startHost(dir);
    const c2 = await login(h2);
    const st = (await c2.get("/api/state")).data;
    expect(st.agentState).toBe("blocked");
    expect(st.agentDiagnostic).toMatch(/upgrade v1→v2 refused/);
    expect(q(dir, "SELECT * FROM records")).toEqual(before);
    expect(q<{ v: number }>(dir, "SELECT agent_toolset_version AS v FROM meta")[0]!.v).toBe(1);
    expect(q(dir, "SELECT * FROM agent_toolset_migrations")).toEqual(migBefore);
    expect(fs.statSync(path.join(dir, "agent.sqlite")).size).toBeGreaterThan(0);
    // apps keep working while generation is blocked
    const page = await c2.get(`/api/apps/${done.targetAppId}/records`);
    expect(page.data.total).toBe(1);
    await stopHost(h2);
  });
});

d("V2-O: operations (real processes)", () => {
  it("V2-O07 host.lock, SIGTERM stops workspace containers; the next boot revokes old instances; health is per app", async () => {
    const dir = tmpDir();
    const [, k] = await seedFixtures(dir, ["todo-v1.json", "v0.2/todo-kanban"]);
    const h = await startHost(dir);
    const c = await login(h);
    await until(async () => ((await c.get(`/api/apps/${k!.appId}/runtime`)).data?.health === "ready" ? true : null));
    const second = spawnSync(path.join(ROOT, "bin", "agentos-host"), [], { env: { ...process.env, NODE_ENV: "test", AGENTOS_DATA_DIR: dir, AGENTOS_PORT: "4999" }, timeout: 15_000 });
    expect(second.status).not.toBe(0);
    expect(containers(dir).filter((x) => x.state === "running")).toHaveLength(1);
    const t0 = Date.now();
    expect(await stopHost(h)).toBe(0);
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(containers(dir)).toEqual([]);
    const boot1 = q<{ host_boot_id: string }>(dir, "SELECT host_boot_id FROM meta")[0]!.host_boot_id;
    const h2 = await startHost(dir);
    const c2 = await login(h2);
    expect((await c2.get("/api/state")).data.runtimeReady).toBe(true);
    await until(async () => ((await c2.get(`/api/apps/${k!.appId}/runtime`)).data?.health === "ready" ? true : null));
    const boot2 = q<{ host_boot_id: string }>(dir, "SELECT host_boot_id FROM meta")[0]!.host_boot_id;
    expect(boot2).not.toBe(boot1);
    expect(q(dir, "SELECT * FROM runtime_instances WHERE host_boot_id = ? AND desired_state <> 'removed'", boot1)).toEqual([]);
    expect((await fetch(`http://127.0.0.1:${h2.port}/health/ready`)).status).toBe(200);
    await stopHost(h2);
  });

  it("V2-O02/O04 complete cold backup with artifacts, catalog and images; an interrupted restore blocks start until rerun", async () => {
    const dir = tmpDir();
    const [, k] = await seedFixtures(dir, ["todo-v1.json", "v0.2/todo-kanban-hours"]);
    const h = await startHost(dir);
    const c = await login(h);
    await until(async () => ((await c.get(`/api/apps/${k!.appId}/runtime`)).data?.health === "ready" ? true : null));
    await c.req("POST", `/api/apps/${k!.appId}/commands/add`, { expectedAppEpoch: 2, input: { title: "备份前", estimate_minutes: 15 } });
    await until(() => q(dir, "SELECT * FROM records").length === 1);
    await stopHost(h);
    const out = path.join(tmpDir(), "bk");
    const b = spawnSync(path.join(ROOT, "bin", "agentos-admin"), ["backup", "--output", out], { env: { ...process.env, AGENTOS_DATA_DIR: dir }, encoding: "utf8", timeout: 300_000 });
    expect(b.status, b.stderr).toBe(0);
    const m = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    expect(m.format).toBe(2);
    expect(m.complete).toBe(true);
    expect(m.artifacts).toHaveLength(1);
    expect(m.images.map((i: { name: string }) => i.name).sort()).toEqual(expect.arrayContaining([expect.stringMatching(/agentos-runtime-core-v1/), expect.stringMatching(/agentos-builder-core-v1/)]));
    for (const key of ["storeUUID", "productVersion", "schemaVersion", "abiVersion", "policyVersion", "sourceCommit", "piDurableVersion", "catalogHash"]) expect(m[key]).toBeTruthy();
    // a damaged copy is refused before anything is touched
    const target = tmpDir();
    const bad = path.join(tmpDir(), "bad");
    fs.cpSync(out, bad, { recursive: true });
    fs.appendFileSync(path.join(bad, m.images[0].file), "x");
    const rb = spawnSync(path.join(ROOT, "bin", "agentos-admin"), ["restore", "--backup", bad], { env: { ...process.env, AGENTOS_DATA_DIR: target }, encoding: "utf8" });
    expect(rb.status).not.toBe(0);
    expect(rb.stderr).toMatch(/corrupt/);
    // interrupted restore (after the first database replace) blocks the host; rerunning finishes it
    const r1 = spawnSync(path.join(ROOT, "bin", "agentos-admin"), ["restore", "--backup", out], { env: { ...process.env, NODE_ENV: "test", AGENTOS_DATA_DIR: target, ...FAULT("restore.after_first_replace") }, encoding: "utf8", timeout: 300_000 });
    expect(r1.status).not.toBe(0);
    const blocked = spawnSync(path.join(ROOT, "bin", "agentos-host"), [], { env: { ...process.env, NODE_ENV: "test", AGENTOS_DATA_DIR: target, AGENTOS_PORT: "4998" }, encoding: "utf8", timeout: 20_000 });
    expect(blocked.status).not.toBe(0);
    expect(blocked.stdout + blocked.stderr).toMatch(/restore is in progress/);
    const r2 = spawnSync(path.join(ROOT, "bin", "agentos-admin"), ["restore", "--backup", out], { env: { ...process.env, AGENTOS_DATA_DIR: target }, encoding: "utf8", timeout: 300_000 });
    expect(r2.status, r2.stderr).toBe(0);
    const h2 = await startHost(target);
    const c2 = await login(h2);
    await until(async () => ((await c2.get(`/api/apps/${k!.appId}/runtime`)).data?.health === "ready" ? true : null));
    const qr = await c2.req("POST", `/api/apps/${k!.appId}/queries/main`, { expectedAppEpoch: 2, input: {} });
    expect(qr.data.output.remainingMinutes).toBe(15);
    await stopHost(h2);
  });
});

const V01 = process.env.AGENTOS_V01_ROOT;
(HAS_PODMAN && V01 && fs.existsSync(path.join(V01, "bin", "agentos-host")) ? describe : describe.skip)("V2-O01 real v0.1 workspace copy (v0.1 build at AGENTOS_V01_ROOT)", () => {
  it("V2-O01 upgrade a copy made by the real v0.1 host: records, revisions, hashes, receipts and the pair stay; generation continues", async () => {
    const src = tmpDir();
    const port = 4600 + Math.floor(Math.random() * 100);
    const { spawn } = await import("node:child_process");
    const old = spawn(path.join(V01!, "bin", "agentos-host"), [], { env: { ...process.env, NODE_ENV: "test", AGENTOS_DATA_DIR: src, AGENTOS_PORT: String(port), AGENTOS_HOST: "127.0.0.1", AGENTOS_MODEL_MODE: "faux" }, stdio: "ignore" });
    const oldH = { port, dataDir: src } as HostProc;
    await until(async () => (await fetch(`http://127.0.0.1:${port}/health/ready`).then((r) => r.status === 200).catch(() => false)) || null, 30_000);
    const c = new Client(oldH);
    await c.login(src);
    const run1 = await c.waitRun((await c.req("POST", "/api/runs", { intent: "做一个待办应用", targetAppId: null })).data.runId);
    const appId = run1.targetAppId as string;
    for (const t of ["旧数据一", "旧数据二"]) await c.req("POST", `/api/apps/${appId}/records`, { expectedAppEpoch: 1, data: { title: t } });
    await c.waitRun((await c.req("POST", "/api/runs", { intent: "增加优先级和优先级筛选", targetAppId: appId, expectedAppEpoch: 1 })).data.runId);
    old.kill("SIGTERM");
    await new Promise((r) => old.on("exit", r));
    const copy = tmpDir();
    fs.cpSync(src, copy, { recursive: true });
    fs.rmSync(path.join(copy, "host.lock"), { force: true });
    const snap = (dir: string) => ({
      revisions: q(dir, "SELECT app_id, id, bundle_json, first_activated_at FROM revisions ORDER BY id"),
      records: q(dir, "SELECT id, app_id, version, data_json FROM records ORDER BY id"),
      receipts: q(dir, "SELECT principal, operation_key, request_hash, status_code, result_json FROM operations ORDER BY principal, operation_key"),
      store: q(dir, "SELECT store_uuid FROM meta")[0],
    });
    const before = snap(copy);
    expect(q<{ v: number }>(copy, "SELECT MAX(version) AS v FROM schema_migrations")[0]!.v).toBe(1);
    const h = await startHost(copy);
    const c2 = await login(h);
    const st = (await c2.get("/api/state")).data;
    expect(st.agentState).not.toBe("blocked");
    const after = snap(copy);
    expect(after.revisions).toEqual(before.revisions);
    expect(after.records).toEqual(before.records);
    for (const r of before.receipts as object[]) expect(after.receipts).toContainEqual(r);
    expect(after.store).toEqual(before.store);
    // data_epoch starts at 0 for migrated apps (spec §13: >= 0); later writes bump it
    expect(q<{ data_epoch: number }>(copy, "SELECT data_epoch FROM apps WHERE id = ?", appId)[0]!.data_epoch).toBe(0);
    // the original copy is untouched
    expect(q<{ v: number }>(src, "SELECT MAX(version) AS v FROM schema_migrations")[0]!.v).toBe(1);
    // generation continues on the upgraded workspace: a code version, data kept
    const app = (await c2.get(`/api/apps/${appId}`)).data;
    const up = await c2.waitRun((await c2.req("POST", "/api/runs", { intent: "改成看板，支持批量完成", targetAppId: appId, expectedAppEpoch: app.appEpoch })).data.runId, 180_000);
    const tr = up.status === "succeeded" ? null : (await c2.get(`/api/runs/${up.runId}/transcript`)).data;
    expect(up.status, JSON.stringify(up.error) + JSON.stringify(tr?.items?.map((i: { toolName?: string; text?: string }) => [i.toolName, String(i.text ?? "").slice(0, 300)]))).toBe("succeeded");
    expect(q(copy, "SELECT id FROM records WHERE app_id = ?", appId)).toHaveLength(2);
    await stopHost(h);
  });
});

(HAS_PODMAN && process.env.AGENTOS_OFFLINE_TEST === "1" ? describe : describe.skip)("V2-O03 offline restore (engine without network)", () => {
  it("V2-O03 restore with the engine offline and the platform images gone: images come from the backup, code versions run and roll back, old sessions fail", async () => {
    const dir = tmpDir();
    const [, k] = await seedFixtures(dir, ["todo-v1.json", "v0.2/todo-kanban-hours"]);
    const h = await startHost(dir);
    const c = await login(h);
    await until(async () => ((await c.get(`/api/apps/${k!.appId}/runtime`)).data?.health === "ready" ? true : null));
    await c.req("POST", `/api/apps/${k!.appId}/commands/add`, { expectedAppEpoch: 2, input: { title: "离线恢复", estimate_minutes: 20 } });
    await until(() => q(dir, "SELECT * FROM records").length === 1);
    await stopHost(h);
    const out = path.join(tmpDir(), "bk");
    expect(spawnSync(path.join(ROOT, "bin", "agentos-admin"), ["backup", "--output", out], { env: { ...process.env, AGENTOS_DATA_DIR: dir }, encoding: "utf8", timeout: 300_000 }).status).toBe(0);
    const m = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8")) as { images: { name: string }[] };
    const env = { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid!()}` };
    const sh = (cmd: string) => execFileSync("bash", ["-c", cmd], { env, encoding: "utf8" });
    sh("systemctl --user set-environment HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 && systemctl --user stop podman.service");
    try {
      for (const i of m.images) spawnSync("podman", ["rmi", "-f", i.name]);
      for (const i of m.images) expect(spawnSync("podman", ["image", "exists", i.name]).status).not.toBe(0);
      const target = tmpDir();
      const r = spawnSync(path.join(ROOT, "bin", "agentos-admin"), ["restore", "--backup", out], { env: { ...process.env, AGENTOS_DATA_DIR: target }, encoding: "utf8", timeout: 300_000 });
      expect(r.status, r.stderr).toBe(0);
      for (const i of m.images) expect(spawnSync("podman", ["image", "exists", i.name]).status).toBe(0);
      const h2 = await startHost(target);
      // the old session from before the restore is refused (token rotated)
      const stale = await fetch(`http://127.0.0.1:${h2.port}/api/state`, { headers: { cookie: c.cookie } });
      expect(stale.status).toBe(401);
      const c2 = await login(h2);
      await until(async () => ((await c2.get(`/api/apps/${k!.appId}/runtime`)).data?.health === "ready" ? true : null));
      const qr = await c2.req("POST", `/api/apps/${k!.appId}/queries/main`, { expectedAppEpoch: 2, input: {} });
      expect(qr.data.output.remainingMinutes).toBe(20);
      // roll back to the declarative v1 and forward to the code version again, still offline
      const revs = (await c2.get(`/api/apps/${k!.appId}/revisions`)).data.items as { revisionId: string; title: string }[];
      const v1 = revs.find((x) => x.title === "待办清单")!;
      const cur = revs.find((x) => x.title !== "待办清单")!;
      await c2.req("POST", `/api/apps/${k!.appId}/deployments`, { revisionId: v1.revisionId, expectedAppEpoch: 2 });
      await until(() => q<{ active_revision_id: string }>(target, "SELECT active_revision_id FROM apps WHERE id = ?", k!.appId)[0]!.active_revision_id === v1.revisionId);
      await c2.req("POST", `/api/apps/${k!.appId}/deployments`, { revisionId: cur.revisionId, expectedAppEpoch: 3 });
      await until(() => q<{ active_revision_id: string }>(target, "SELECT active_revision_id FROM apps WHERE id = ?", k!.appId)[0]!.active_revision_id === cur.revisionId);
      await until(async () => ((await c2.get(`/api/apps/${k!.appId}/runtime`)).data?.health === "ready" ? true : null));
      await stopHost(h2);
    } finally {
      sh("systemctl --user unset-environment HTTPS_PROXY HTTP_PROXY https_proxy http_proxy && systemctl --user stop podman.service");
    }
  });
});
