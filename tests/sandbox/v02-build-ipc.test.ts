import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { AgentOsError, type AppBundle } from "@agentos/contracts";
import { ArtifactStore, BuildService, openCore, RuntimeSystem, buildKey, type Core } from "@agentos/core";
import { codeFixture } from "../fixtures-v02.js";
import { CATALOG, catalogService, makeDriver, sandboxDir } from "./env.js";
import { opMeta, publish, waitFor } from "./util.js";

const v1 = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../fixtures/todo-v1.json"), "utf8")) as AppBundle;
const TODO = v1.manifest.appId;
const OVERVIEW = "5a1d2f4e-7c3b-4e8a-9f10-2b3c4d5e6f70";
const LAB = "f00dfa11-0000-4000-8000-00000000fa11";
const PROBE = "1bc0ffee-0000-4000-8000-0000000001bc";

function placeholder(core: Core, appId: string) {
  core.store.tx(() => core.store.run("INSERT INTO apps (id, active_revision_id, epoch, contract_json, created_at, updated_at) VALUES (?, NULL, 0, '{\"fields\":{}}', ?, ?)", appId, new Date().toISOString(), new Date().toISOString()));
}
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (e) {
    return (e as AgentOsError).code ?? (e as Error).message;
  }
}

describe("V2-B builds and V2-I inter-app services (real podman)", () => {
  const box = sandboxDir();
  let core: Core;
  let sys: RuntimeSystem;
  const q = (appId: string, id: string, input: unknown = {}) => sys.invocations.query(appId, id, input, core.apps.requireApp(appId).epoch);
  beforeAll(async () => {
    core = openCore(path.join(box.dir, "os.sqlite"));
    sys = new RuntimeSystem(core, { dataDir: box.dir, catalog: catalogService(), driver: makeDriver(), log: () => {}, autoReconcile: false });
    await sys.boot();
    core.apps.seedActivated(v1);
  });
  afterAll(async () => {
    await sys.shutdown();
    core.store.close();
    box.cleanup();
  });

  it("V2-B01 both profiles build in a no-network builder; app config files and unapproved imports never reach it", async () => {
    expect((await publish(sys, core, codeFixture("todo-kanban-hours"))).status).toBe("committed");
    placeholder(core, "7c2e9a10-4b6d-4f3a-8e21-9d0c1b2a3f45");
    const csv = await publish(sys, core, codeFixture("csv-import"));
    expect(csv.status, JSON.stringify(csv.error)).toBe("committed");
    // a package.json / tsconfig / script in code.files is refused at stage (only src/**.ts)
    const withConfig = codeFixture("csv-import", (b) => {
      b.code.files["package.json"] = '{"scripts":{"postinstall":"curl evil"}}';
    });
    expect(() => core.store.tx(() => core.apps.stage("7c2e9a10-4b6d-4f3a-8e21-9d0c1b2a3f45", withConfig, null))).toThrow(/SOURCE_PATH_INVALID|schema/);
    // the builder itself refuses unapproved imports (static validation bypassed on purpose)
    core.apps.extraCheck = undefined;
    const bad = codeFixture("todo-kanban-hours", (b) => {
      b.code.files["src/app.ts"] = `import pad from "left-pad";\nvoid pad;\n${b.code.files["src/app.ts"]}`;
    });
    const r = await publish(sys, core, bad);
    core.apps.extraCheck = sys.opts.catalog.check;
    expect(r.status).toBe("failed");
    expect((r.error as { code: string }).code).toBe("DEPENDENCY_NOT_ALLOWED");
    // the build container has no network (same policy as apps)
    const driver = sys.ctx.driver!;
    const lock = CATALOG.locks.find((l) => l.id === "core-v1@1")!;
    const dir = fs.mkdtempSync(path.join(box.dir, "bn-"));
    fs.mkdirSync(path.join(dir, "b"), { mode: 0o700 });
    const { id } = await driver.create({
      name: `agentos-bnet-${randomUUID().slice(0, 8)}`, image: lock.builderImage.name, role: "build",
      labels: { "agentos.store": sys.ctx.storeUUID, "agentos.role": "build", "agentos.app": "x", "agentos.revision": "x", "agentos.instance": "x", "agentos.boot": "x" },
      readOnlyMount: { hostPath: dir, containerPath: "/src" }, bridgeDir: path.join(dir, "b"),
      command: ["node", "-e", "require('net').connect(443,'1.1.1.1').on('error',e=>{console.log(e.code);process.exit(0)}).on('connect',()=>{console.log('CONNECTED');process.exit(0)})"],
      env: {}, limits: { memoryBytes: 512 * 2 ** 20, cpus: 1, pids: 64, tmpfsBytes: 16 * 2 ** 20 },
    });
    await driver.start(id);
    await driver.wait(id, 15_000);
    const out = await driver.diagnostics(id, 1000);
    await driver.remove(id);
    expect(out.trim()).toBe("ENETUNREACH");
  });

  it("V2-B02 cache reuse, damaged artifacts are rebuilt to the same id, a different rebuild stops publication", async () => {
    const rev = core.apps.requireApp(TODO).active_revision_id!;
    const first = await sys.builds.ensureArtifact(TODO, rev, Date.now() + 120_000);
    expect(first.cacheHit).toBe(true);
    // damage the artifact: it is never counted as verified, and the fixed recipe reproduces the same bytes
    const f = path.join(sys.artifacts.dirOf(first.artifactId), "app.mjs");
    fs.chmodSync(f, 0o644);
    fs.appendFileSync(f, "\n// tampered");
    const again = await sys.builds.ensureArtifact(TODO, rev, Date.now() + 120_000);
    expect(again.artifactId).toBe(first.artifactId);
    expect(again.cacheHit).toBe(false);
    expect(sys.artifacts.verify(first.artifactId)).toBeNull();
    // a revision bound to an artifact the recipe does not reproduce → BUILD_NONDETERMINISTIC, nothing overwritten
    const other = codeFixture("todo-kanban-hours", (b) => (b.manifest.description = "nondeterminism probe"));
    const staged = core.store.tx(() => core.apps.stage(TODO, other, null));
    const fake = sys.artifacts.put({ "app.mjs": Buffer.from("export const queries = {}; export const commands = {};") }, { runtimeLockId: "core-v1@1", platform: "linux/amd64", abiVersion: 1 });
    const lock = CATALOG.locks.find((l) => l.id === "core-v1@1")!;
    core.store.tx(() => {
      core.store.run("INSERT INTO artifacts (id, build_key, runtime_lock_id, platform, manifest_json, relative_path, size_bytes, verified_at, gc_state, created_at) VALUES (?, ?, 'core-v1@1', 'linux/amd64', ?, ?, 10, NULL, 'live', ?)", fake.artifactId, buildKey(staged.revisionId, lock), fake.manifestBytes.toString(), sys.artifacts.relativePath(fake.artifactId), new Date().toISOString());
      core.store.run("INSERT INTO revision_artifacts (app_id, revision_id, runtime_lock_id, artifact_id, created_at) VALUES (?, ?, 'core-v1@1', ?, ?)", TODO, staged.revisionId, fake.artifactId, new Date().toISOString());
    });
    fs.rmSync(sys.artifacts.dirOf(fake.artifactId), { recursive: true, force: true });
    expect(await codeOf(sys.builds.ensureArtifact(TODO, staged.revisionId, Date.now() + 120_000))).toBe("BUILD_NONDETERMINISTIC");
    expect(core.store.get<{ artifact_id: string }>("SELECT artifact_id FROM revision_artifacts WHERE app_id = ? AND revision_id = ?", TODO, staged.revisionId)!.artifact_id).toBe(fake.artifactId);
  });

  it("V2-B03 build failure and timeout: candidate fails, resources are cleaned, the active version and records are untouched", async () => {
    const before = { app: core.apps.requireApp(TODO), recs: core.store.all("SELECT * FROM records WHERE app_id = ?", TODO) };
    const slowBuilds = new BuildService({
      store: core.store, artifacts: new ArtifactStore(path.join(box.dir, "artifacts")), driver: sys.ctx.driver, catalog: sys.opts.catalog,
      storeUUID: () => sys.ctx.storeUUID, bootId: () => sys.bootId, workDir: path.join(box.dir, "work2"), compileTimeoutMs: 300,
    });
    const timed = codeFixture("todo-kanban-hours", (b) => (b.manifest.description = "timeout probe"));
    const staged = core.store.tx(() => core.apps.stage(TODO, timed, null));
    const err = await slowBuilds.ensureArtifact(TODO, staged.revisionId, Date.now() + 60_000).catch((e) => e as { code: string });
    expect((err as { code: string }).code).toBe("BUILD_TIMEOUT");
    const broken = codeFixture("todo-kanban-hours", (b) => (b.code.files["src/app.ts"] += "\nconst x: number = 'no';\n"));
    const r = await publish(sys, core, broken);
    expect(r.status).toBe("failed");
    expect(JSON.stringify(r.error)).toMatch(/TS2322/);
    expect(core.apps.requireApp(TODO)).toEqual(before.app);
    expect(core.store.all("SELECT * FROM records WHERE app_id = ?", TODO)).toEqual(before.recs);
    const left = (await sys.ctx.driver!.list(sys.ctx.storeUUID)).filter((c) => c.labels["agentos.role"] === "build");
    expect(left).toEqual([]);
    expect(fs.existsSync(path.join(box.dir, "work")) ? fs.readdirSync(path.join(box.dir, "work")) : []).toEqual([]);
    expect(core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM build_jobs WHERE status IN ('queued','building')")!.n).toBe(0);
  });

  it("V2-I01 a service answers only through an exact grant (source revision, target revision, contract)", async () => {
    placeholder(core, OVERVIEW);
    expect((await publish(sys, core, codeFixture("work-overview"))).status).toBe("committed");
    let o = (await q(OVERVIEW, "main")).output as { connected: boolean; message: string };
    expect(o).toMatchObject({ connected: false, message: "待办服务未连接" });
    const svc = sys.interApp.catalog().find((s) => s.appId === TODO && s.exportName === "summary")!;
    const src = core.apps.requireApp(OVERVIEW).active_revision_id!;
    const req = { sourceAppId: OVERVIEW, sourceRevisionId: src, alias: "todo", targetAppId: TODO, targetRevisionId: svc.revisionId, exportName: "summary", contractHash: svc.contractHash };
    expect(await codeOf(Promise.resolve().then(() => sys.createGrant(opMeta({ a: 1 }), { ...req, contractHash: `sha256:${"0".repeat(64)}` })))).toBe("SERVICE_CONTRACT_MISMATCH");
    expect(await codeOf(Promise.resolve().then(() => sys.createGrant(opMeta({ a: 2 }), { ...req, targetAppId: OVERVIEW, targetRevisionId: src })))).toBe("FORBIDDEN");
    const g = sys.createGrant(opMeta({ a: 3 }), req);
    expect(g.body.state).toBe("active");
    o = (await q(OVERVIEW, "main")).output as { connected: boolean; message: string };
    expect(o.connected).toBe(true);
    // a grant is a user action only (no run or app principal can create it)
    expect(() => core.gateway.write("grants.manage", { principal: { kind: "run", runId: "r", piTaskId: "t", toolName: "x" }, operationKey: "k", requestHash: "h" }, () => ({ status: 201, body: null }))).toThrow(/may not call/);
  });

  it("V2-I02/I05 revoke stops new results at once; version changes need reconnecting; old pairs match again, revoked never revive", async () => {
    const g = sys.interApp.list().find((x) => x.state === "active")!;
    sys.revokeGrant(opMeta({ r: 1 }), g.grantId);
    expect(((await q(OVERVIEW, "main")).output as { message: string }).message).toBe("待办服务已断开");
    // reconnect, then a new todo version makes the grant inactive ("needs reconnecting")
    const svc = sys.interApp.catalog().find((s) => s.appId === TODO)!;
    const req = { sourceAppId: OVERVIEW, sourceRevisionId: core.apps.requireApp(OVERVIEW).active_revision_id!, alias: "todo", targetAppId: TODO, targetRevisionId: svc.revisionId, exportName: "summary", contractHash: svc.contractHash };
    const g2 = sys.createGrant(opMeta({ r: 2 }), req).body;
    const oldTodoRev = svc.revisionId;
    expect((await publish(sys, core, codeFixture("todo-kanban-hours", (b) => (b.manifest.description = "v-next")))).status).toBe("committed");
    expect(sys.interApp.list().find((x) => x.grantId === g2.grantId)!.state).toBe("inactive");
    expect(((await q(OVERVIEW, "main")).output as { message: string }).message).toMatch(/SERVICE_UNAVAILABLE/);
    // switching the todo app back to the granted revision makes the (unrevoked) grant match again
    const sw = sys.switchVersion(opMeta({ back: 1 }), TODO, oldTodoRev, core.apps.requireApp(TODO).epoch);
    await waitFor(() => (sys.deployments.get(sw.body.deploymentId)!.status === "committed" ? true : null), 120_000);
    await waitFor(() => sys.runtime.row(TODO)!.health === "ready" || null, 60_000);
    expect(sys.interApp.list().find((x) => x.grantId === g2.grantId)!.state).toBe("active");
    expect(((await q(OVERVIEW, "main")).output as { connected: boolean }).connected).toBe(true);
    // the revoked first grant never comes back
    expect(sys.interApp.list().find((x) => x.grantId === g.grantId)!.state).toBe("revoked");
    // in-flight revocation: the result is re-checked before delivery
    const host = sys.ctx.instances!;
    const orig = host.call.bind(host);
    host.call = (async (...args: Parameters<typeof orig>) => {
      const out = await orig(...args);
      if (args[5] !== undefined && (args[6] as { asService?: boolean } | undefined)?.asService) sys.revokeGrant(opMeta({ fly: 1 }), g2.grantId);
      return out;
    }) as typeof host.call;
    try {
      // the target answered, but the grant was revoked before delivery: no current result is returned
      expect(await codeOf(q(OVERVIEW, "main"))).toBe("GRANT_REVOKED");
    } finally {
      host.call = orig;
    }
  });

  it("V2-I03/I04 read-only one hop: nested calls, call caps, busy targets, timeouts and big outputs fail inside the parent deadline", async () => {
    // quota: at most 4 enabled code apps (todo, csv, overview, lab): stop csv to make room for the probe
    placeholder(core, LAB);
    placeholder(core, PROBE);
    sys.control(opMeta({ stop: "csv" }), "7c2e9a10-4b6d-4f3a-8e21-9d0c1b2a3f45", "stop", core.apps.requireApp("7c2e9a10-4b6d-4f3a-8e21-9d0c1b2a3f45").epoch);
    expect((await publish(sys, core, codeFixture("fault-lab"))).status).toBe("committed");
    expect((await publish(sys, core, codeFixture("ipc-probe"))).status).toBe("committed");
    const probeRev = core.apps.requireApp(PROBE).active_revision_id!;
    for (const [alias, exportName] of [["lab_slow", "slow"], ["lab_big", "big"], ["lab_nested", "nested"]]) {
      const svc = sys.interApp.catalog().find((s) => s.appId === LAB && s.exportName === exportName)!;
      sys.createGrant(opMeta({ alias }), { sourceAppId: PROBE, sourceRevisionId: probeRev, alias: alias!, targetAppId: LAB, targetRevisionId: svc.revisionId, exportName: exportName!, contractHash: svc.contractHash });
    }
    const run = async (input: unknown) => ((await q(PROBE, "main", input)).output as { detail: string }).detail;
    expect(await run({ which: "slow", ms: 5 })).toBe("OK:slept 5");
    expect(await run({ which: "nested" })).toBe("OK:nested=IPC_DEPTH_EXCEEDED");
    expect(await run({ which: "five" })).toBe("OK:slept 1,OK:slept 1,OK:slept 1,OK:slept 1,LIMIT_EXCEEDED");
    expect(await run({ which: "big" })).toBe("LIMIT_EXCEEDED");
    // busy target: immediate APP_BUSY, no waiting chain
    const busy = q(LAB, "slow", { ms: 2500 });
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    expect(await run({ which: "slow", ms: 5 })).toBe("APP_BUSY");
    expect(Date.now() - t0).toBeLessThan(1500);
    await busy;
    // target timeout: 1.5 s per call, inside the caller's 3 s
    const t1 = Date.now();
    expect(await run({ which: "slow", ms: 2500 })).toBe("APP_TIMEOUT");
    expect(Date.now() - t1).toBeLessThan(3000);
    // commands cannot reach services; no self grants; services never expose raw records
    const live = sys.ctx.instances!.get(sys.runtime.row(PROBE)!.active_instance_id!)!;
    live.callKind = "command";
    live.currentCallId = "c1";
    expect(await codeOf(sys.interApp.handleServiceCall(live, { protocolVersion: 1, messageId: "m", type: "serviceCall", payload: { callId: "x", parentCallId: "c1", alias: "lab_slow", input: { ms: 1 } } }))).toBe("FORBIDDEN");
    live.callKind = null;
    live.currentCallId = null;
  });
});
