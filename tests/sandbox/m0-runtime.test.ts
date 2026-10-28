import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BuildService, InstanceHost, openCore, RUNTIME_POLICY, type Core } from "@agentos/core";
import { codeFixture } from "../fixtures-v02.js";
import { artifacts, catalogService, makeDriver, sandboxDir } from "./env.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const v1 = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/todo-v1.json"), "utf8"));

describe("M0/M1 real podman: build a code revision and run it", () => {
  const box = sandboxDir();
  const driver = makeDriver();
  const catalog = catalogService();
  let core: Core;
  let build: BuildService;
  let host: InstanceHost;
  const bootId = randomUUID();
  beforeAll(() => {
    core = openCore(path.join(box.dir, "os.sqlite"));
    core.apps.extraCheck = catalog.check;
    build = new BuildService({
      store: core.store, artifacts: artifacts(box.dir), driver, catalog,
      storeUUID: () => core.store.meta().store_uuid, bootId: () => bootId, workDir: path.join(box.dir, "work"),
    });
    host = new InstanceHost(driver, artifacts(box.dir), path.join(box.dir, "run"));
  });
  afterAll(async () => {
    for (const i of [...host.live.values()]) await host.destroy(i, "test end");
    core.store.close();
    box.cleanup();
  });

  it("environment is rootless cgroup v2 with cpu/memory/pids and seccomp", async () => {
    const env = await driver.checkEnvironment();
    expect(env.problems).toEqual([]);
    expect(env.rootless).toBe(true);
  });

  it("builds the kanban bundle in a no-network builder and serves main and a batch command", async () => {
    core.apps.seedActivated(v1);
    const appId = v1.manifest.appId;
    core.user; // keep
    const b = codeFixture("todo-kanban");
    const staged = core.store.tx(() => core.apps.stage(appId, b, null));
    expect(staged.issues).toEqual([]);
    const t0 = Date.now();
    const art = await build.ensureArtifact(appId, staged.revisionId, Date.now() + 120_000);
    expect(art.artifactId).toMatch(/^sha256:/);
    const again = await build.ensureArtifact(appId, staged.revisionId, Date.now() + 120_000);
    expect(again).toMatchObject({ artifactId: art.artifactId, cacheHit: true });
    const lock = catalog.requireLock("core-v1@1");
    const inst = await host.launch({
      id: randomUUID(), appId, revisionId: staged.revisionId, artifactId: art.artifactId, generation: 1, bootId,
      containerName: `agentos-t-${randomUUID().slice(0, 12)}`, role: "preview", bundle: b, lock, storeUUID: core.store.meta().store_uuid,
    });
    const ctx = (records: unknown[]) => ({
      callId: randomUUID(), appId, revisionId: staged.revisionId, appEpoch: 1, dataEpoch: 0, logicalTime: new Date().toISOString(),
      deadline: new Date(Date.now() + 3000).toISOString(), records: records as never,
    });
    const recs = [
      { id: "a", recordVersion: 1, createdAt: "", updatedAt: "", data: { title: "A", done: false, priority: "high" } },
      { id: "b", recordVersion: 2, createdAt: "", updatedAt: "", data: { title: "B", done: true, priority: "low" } },
    ];
    const out = (await host.call(inst, "query", "main", {}, ctx(recs), RUNTIME_POLICY.queryTimeoutMs)) as { open: number; byPriority: { high: number } };
    expect(out.open).toBe(1);
    expect(out.byPriority.high).toBe(1);
    const cmd = (await host.call(inst, "command", "completeMany", { recordIds: ["a", "b"] }, ctx(recs), RUNTIME_POLICY.commandTimeoutMs)) as { result: unknown; mutations: unknown[] };
    expect(cmd.result).toEqual({ completed: 1 });
    expect(cmd.mutations).toEqual([{ kind: "update", recordId: "a", expectedRecordVersion: 1, changes: { done: true } }]);
    expect(await host.probe(inst)).toBe(true);
    console.log(`build+launch+calls in ${Date.now() - t0} ms`);
  });
});
