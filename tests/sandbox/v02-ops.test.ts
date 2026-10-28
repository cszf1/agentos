import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentOsError, AppBundle } from "@agentos/contracts";
import { ArtifactStore, BuildService, openCore, RuntimeSystem, type Core, type RuntimeDriver } from "@agentos/core";
import { codeFixture } from "../fixtures-v02.js";
import { catalogService, makeDriver, sandboxDir } from "./env.js";
import { opMeta, publish, waitFor } from "./util.js";

/**
 * V2-P01/P07/P11/P12, V2-O05/O06 and (opt-in, AGENTOS_OFFLINE_TEST=1) V2-B04 against real rootless Podman.
 * V2-P09/P10 are in v02-agent.test.ts (they need a run), the process-level P/O items in tests/recovery.
 */
const v1 = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../fixtures/todo-v1.json"), "utf8")) as AppBundle;
const TODO = v1.manifest.appId;
const LAB = "f00dfa11-0000-4000-8000-00000000fa11";

function placeholder(core: Core, appId: string) {
  const now = new Date().toISOString();
  core.store.tx(() => core.store.run("INSERT INTO apps (id, active_revision_id, epoch, contract_json, created_at, updated_at) VALUES (?, NULL, 0, '{\"fields\":{}}', ?, ?)", appId, now, now));
}
const podman = (...a: string[]) => execFileSync("podman", a, { encoding: "utf8" }).trim();

describe("V2-P/O runtime operations (real podman)", () => {
  const box = sandboxDir();
  const claims = fs.mkdtempSync(path.join(os.tmpdir(), "aos-claims-"));
  let core: Core;
  let sys: RuntimeSystem;
  const mk = (driver: RuntimeDriver | null = makeDriver()) => new RuntimeSystem(core, { dataDir: box.dir, catalog: catalogService(), driver, log: () => {}, autoReconcile: false, imageClaimsDir: claims });
  beforeAll(async () => {
    core = openCore(path.join(box.dir, "os.sqlite"));
    sys = mk();
    await sys.boot();
    core.apps.seedActivated(v1);
    const user = { kind: "app" as const, appId: TODO, viaUser: true };
    for (const title of ["真实记录甲", "真实记录乙"]) core.store.tx(() => core.records.create(user, TODO, 1, { title }));
  });
  afterAll(async () => {
    await sys.shutdown();
    core.store.close();
    box.cleanup();
    fs.rmSync(claims, { recursive: true, force: true });
  });

  it("V2-P01 a candidate is checked only with platform fixtures: no real records, no services, no committed mutation", async () => {
    const host = sys.ctx.instances!;
    const orig = host.call.bind(host);
    const seen: { kind: string; snapshot: string }[] = [];
    host.call = (async (...args: Parameters<typeof orig>) => {
      if (sys.runtime.row(TODO)?.active_instance_id !== args[0].id) seen.push({ kind: args[1], snapshot: JSON.stringify(args[4]) });
      return orig(...args);
    }) as typeof host.call;
    // activation may backfill defaults of new fields; what must not happen is a fixture mutation reaching real records
    const shape = () => core.store.all("SELECT id, json_extract(data_json, '$.title') AS title, json_extract(data_json, '$.done') AS done FROM records WHERE app_id = ? ORDER BY id", TODO);
    const before = core.store.all("SELECT id FROM records WHERE app_id = ? ORDER BY id", TODO);
    const beforeShape = shape();
    try {
      expect((await publish(sys, core, codeFixture("todo-kanban"))).status).toBe("committed");
    } finally {
      host.call = orig;
    }
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.some((s) => s.kind === "query")).toBe(true);
    for (const s of seen) {
      expect(s.snapshot).not.toContain("真实记录");
      for (const r of before as { id: string }[]) expect(s.snapshot).not.toContain(r.id);
    }
    expect(shape()).toEqual(beforeShape);
  });

  it("V2-P07 the published candidate crashes right after commit: still published, recovering then ready", async () => {
    await waitFor(() => sys.runtime.row(TODO)!.health === "ready" || null, 60_000);
    const rev = core.apps.requireApp(TODO).active_revision_id;
    const inst = core.store.get<{ container_id: string }>("SELECT i.container_id FROM runtime_instances i JOIN app_runtime a ON a.active_instance_id = i.id WHERE a.app_id = ?", TODO)!;
    podman("kill", inst.container_id);
    await waitFor(() => (["recovering", "degraded"].includes(sys.runtime.row(TODO)!.health) ? true : null), 20_000);
    expect(core.apps.requireApp(TODO).active_revision_id).toBe(rev);
    expect(core.store.get<{ status: string }>("SELECT status FROM deployments ORDER BY created_at DESC LIMIT 1")!.status).toBe("committed");
    for (let i = 0; i < 20 && sys.runtime.row(TODO)!.health !== "ready"; i++) {
      await sys.reconciler.runOnce();
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(sys.runtime.row(TODO)!.health).toBe("ready");
  });

  it("V2-P11 engine unreachable: nothing is reassigned or deleted; afterwards it inspects; foreign objects are left alone", async () => {
    const real = sys.ctx.driver!;
    const foreign = `agentos-foreign-${randomUUID().slice(0, 8)}`;
    const lock = catalogService().locks().find((l) => l.id === "core-v1@1")!;
    podman("create", "--name", foreign, "--label", "agentos.store=00000000-0000-4000-8000-000000000000", "--label", "agentos.role=app", "--network", "none", lock.runtimeImage.name, "true");
    const before = core.store.all("SELECT id, desired_state, observed_state FROM runtime_instances ORDER BY id");
    const down = new Proxy(real, { get: (t, p) => (typeof (t as never)[p] === "function" ? async () => Promise.reject(new Error("connect ENOENT podman.sock")) : (t as never)[p]) }) as RuntimeDriver;
    (sys.ctx as { driver: RuntimeDriver | null }).driver = down;
    try {
      await sys.reconciler.runOnce();
      expect(sys.runtime.engineReachable).toBe(false);
      expect(core.store.all("SELECT id, desired_state, observed_state FROM runtime_instances ORDER BY id")).toEqual(before);
    } finally {
      (sys.ctx as { driver: RuntimeDriver | null }).driver = real;
    }
    await sys.reconciler.runOnce();
    expect(sys.runtime.engineReachable).toBe(true);
    expect(podman("ps", "-a", "--filter", `name=${foreign}`, "--format", "{{.Names}}")).toBe(foreign);
    podman("rm", "-f", foreign);
    expect((await sys.invocations.query(TODO, "main", {}, core.apps.requireApp(TODO).epoch)).output).toBeTruthy();
  });

  it("V2-P12 the restart budget survives a host restart; a user stop is never reversed by the reconciler", async () => {
    placeholder(core, LAB);
    expect((await publish(sys, core, codeFixture("fault-lab"))).status).toBe("committed");
    for (let i = 0; i < 3; i++) {
      await waitFor(() => (sys.runtime.row(LAB)!.health === "ready" ? true : null), 30_000).catch(() => undefined);
      const id = core.store.get<{ container_id: string }>("SELECT i.container_id FROM runtime_instances i JOIN app_runtime a ON a.active_instance_id = i.id WHERE a.app_id = ?", LAB)?.container_id;
      if (id) podman("kill", id);
      await new Promise((r) => setTimeout(r, 1500));
      for (let k = 0; k < 8 && !["ready", "degraded"].includes(sys.runtime.row(LAB)!.health); k++) {
        await sys.reconciler.runOnce();
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    expect(sys.runtime.row(LAB)!.health).toBe("degraded");
    const count = sys.runtime.row(LAB)!.restart_count;
    // "restart the host": a new RuntimeSystem on the same database
    await sys.shutdown();
    sys = mk();
    await sys.boot();
    await sys.reconciler.runOnce();
    expect(sys.runtime.row(LAB)!.health).toBe("degraded");
    expect(sys.runtime.row(LAB)!.restart_count).toBe(count);
    // explicit restart clears the budget; then a user stop holds through reconciles
    sys.control(opMeta({ s: 1 }), LAB, "restart", core.apps.requireApp(LAB).epoch);
    for (let k = 0; k < 10 && sys.runtime.row(LAB)!.health !== "ready"; k++) {
      await sys.reconciler.runOnce();
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(sys.runtime.row(LAB)!.health).toBe("ready");
    sys.control(opMeta({ s: 2 }), LAB, "stop", core.apps.requireApp(LAB).epoch);
    for (let k = 0; k < 3; k++) await sys.reconciler.runOnce();
    expect(sys.runtime.row(LAB)!.enabled).toBe(0);
    expect(sys.runtime.row(LAB)!.health).toBe("stopped");
    expect(sys.runtime.row(LAB)!.active_instance_id).toBeNull();
  });

  it("V2-O05 cache GC keeps history, open deployments and claims of other workspaces; removes only this workspace's garbage", async () => {
    const staged = core.store.tx(() => core.apps.stage(TODO, codeFixture("todo-kanban-hours", (b) => (b.manifest.description = "gc probe")), null));
    const art = await sys.builds.ensureArtifact(TODO, staged.revisionId, Date.now() + 120_000);
    const history = core.store.all<{ artifact_id: string }>("SELECT ra.artifact_id FROM revision_artifacts ra JOIN revisions r ON r.app_id = ra.app_id AND r.id = ra.revision_id WHERE r.first_activated_at IS NOT NULL").map((r) => r.artifact_id);
    // a stray platform image no catalog names, claimed by another workspace on this engine
    const stray = `localhost/agentos-runtime-core-v1:gcprobe${randomUUID().slice(0, 6)}`;
    podman("tag", catalogService().locks()[0]!.runtimeImage.name, stray);
    fs.writeFileSync(path.join(claims, "11111111-2222-4333-8444-555555555555.json"), JSON.stringify({ images: [stray] }));
    try {
      const plan = await sys.gc.plan();
      expect(plan.artifacts.map((a) => a.id)).toContain(art.artifactId);
      for (const h of history) expect(plan.artifacts.map((a) => a.id)).not.toContain(h);
      expect(plan.images).not.toContain(stray);
      fs.rmSync(path.join(claims, "11111111-2222-4333-8444-555555555555.json"));
      expect((await sys.gc.plan()).images).toContain(stray);
      await sys.gc.run({ includeImages: false });
      expect(sys.artifacts.verify(art.artifactId)).not.toBeNull();
      for (const h of history) expect(sys.artifacts.verify(h)).toBeNull();
      expect(() => podman("image", "exists", stray)).not.toThrow();
    } finally {
      podman("untag", stray);
    }
    expect((await sys.invocations.query(TODO, "main", {}, core.apps.requireApp(TODO).epoch)).output).toBeTruthy();
  });

  it("V2-O06 quota and disk pressure refuse new work explicitly; running apps keep answering", async () => {
    // instance quota: 4 enabled code apps
    const ids = ["7c2e9a10-4b6d-4f3a-8e21-9d0c1b2a3f45", "5a1d2f4e-7c3b-4e8a-9f10-2b3c4d5e6f70", "1bc0ffee-0000-4000-8000-0000000001bc"];
    sys.control(opMeta({ s: 3 }), LAB, "start", core.apps.requireApp(LAB).epoch);
    placeholder(core, ids[0]!);
    expect((await publish(sys, core, codeFixture("csv-import"))).status).toBe("committed");
    placeholder(core, ids[1]!);
    expect((await publish(sys, core, codeFixture("work-overview"))).status).toBe("committed");
    placeholder(core, ids[2]!);
    const fifth = await publish(sys, core, codeFixture("ipc-probe")).catch((e: AgentOsError) => ({ status: e.code }));
    expect(fifth.status).toBe("APP_RESOURCE_LIMIT");
    expect((await sys.invocations.query(TODO, "main", {}, core.apps.requireApp(TODO).epoch)).output).toBeTruthy();
    // disk pressure: a build is refused before it starts; nothing queues
    const tight = new BuildService({
      store: core.store, artifacts: new ArtifactStore(path.join(box.dir, "artifacts")), driver: sys.ctx.driver, catalog: sys.opts.catalog,
      storeUUID: () => sys.ctx.storeUUID, bootId: () => sys.bootId, workDir: path.join(box.dir, "work3"), minFreeBytes: Number.MAX_SAFE_INTEGER,
    });
    const staged = core.store.tx(() => core.apps.stage(TODO, codeFixture("todo-kanban-hours", (b) => (b.manifest.description = "disk probe")), null));
    const err = await tight.ensureArtifact(TODO, staged.revisionId, Date.now() + 60_000).catch((e: AgentOsError) => e);
    expect((err as AgentOsError).code).toBe("APP_RESOURCE_LIMIT");
    expect(core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM build_jobs WHERE status IN ('queued','building')")!.n).toBe(0);
    expect((await sys.invocations.query(TODO, "main", {}, core.apps.requireApp(TODO).epoch)).output).toBeTruthy();
  });

  it.runIf(process.env.AGENTOS_OFFLINE_TEST === "1")("V2-B04 offline: cached images build and roll back; an uncached image fails explicitly, never another version", async () => {
    const env = { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid!()}` };
    const sh = (cmd: string) => execFileSync("bash", ["-c", cmd], { env, encoding: "utf8" });
    sh("systemctl --user set-environment HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 && systemctl --user stop podman.service");
    try {
      // a new revision builds from the cached builder image without any network
      const r = await publish(sys, core, codeFixture("todo-kanban-hours", (b) => (b.manifest.description = `offline ${Date.now()}`)));
      expect(r.status, JSON.stringify(r.error)).toBe("committed");
      // roll back to an earlier code version offline
      const kanban = core.store.get<{ id: string }>("SELECT id FROM revisions WHERE app_id = ? AND bundle_json LIKE '%\"待办看板\"%' AND first_activated_at IS NOT NULL ORDER BY created_at LIMIT 1", TODO)!;
      const sw = sys.switchVersion(opMeta({ off: 1 }), TODO, kanban.id, core.apps.requireApp(TODO).epoch);
      await waitFor(() => (sys.deployments.get(sw.body.deploymentId)!.status === "committed" ? true : null), 120_000);
      // an image that is not cached cannot be fetched: explicit failure, no substitution
      const err = await sys.ctx.driver!.ensureImage({ name: "localhost/agentos-runtime-core-v1:0000000000000000", recipeHash: `sha256:${"0".repeat(64)}`, role: "runtime", profileId: "core-v1" }, { allowBuild: true }).then(() => null, (e: Error) => e);
      expect(err).not.toBeNull();
      expect(podman("images", "-q", "localhost/agentos-runtime-core-v1:0000000000000000")).toBe("");
    } finally {
      sh("systemctl --user unset-environment HTTPS_PROXY HTTP_PROXY https_proxy http_proxy && systemctl --user stop podman.service");
    }
  });
});
