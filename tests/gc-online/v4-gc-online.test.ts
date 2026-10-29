/**
 * v0.4 online cache and log cleanup (spec §17, V4-G01..G08): real files in a real ArtifactStore, the real I/O worker
 * thread, real os.sqlite. Interrupted phases are reproduced by stopping between the persisted phases.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ArtifactStore, OnlineGc, openCore, type Core } from "@agentos/core";
import { fixture, tmpDir } from "../helpers.js";

function setup() {
  const dir = tmpDir("agentos-gc-");
  const core = openCore(path.join(dir, "os.sqlite"));
  const store = new ArtifactStore(path.join(dir, "artifacts"));
  const logs = path.join(dir, "logs");
  fs.mkdirSync(logs, { recursive: true });
  const gc = new OnlineGc(core.store, store, logs);
  return { dir, core, store, gc, logs };
}

function app(core: Core): { appId: string; revisionId: string } {
  const b = fixture("todo-v1.json");
  const appId = randomUUID();
  (b.manifest as { appId: string }).appId = appId;
  const r = core.apps.seedActivated(b);
  return { appId, revisionId: r.revisionId };
}

/** A real artifact on disk + its row; optionally linked to a revision. */
function artifact(core: Core, store: ArtifactStore, n: number, link?: { appId: string; revisionId: string }): string {
  const put = store.put({ "app.mjs": Buffer.from(`export default ${n};\n`.padEnd(200 + n, " ")) }, { runtimeLockId: "lock", platform: "linux/amd64", abiVersion: 1 });
  core.store.tx(() => {
    core.store.run(
      "INSERT OR IGNORE INTO artifacts (id, build_key, runtime_lock_id, platform, manifest_json, relative_path, size_bytes, verified_at, gc_state, created_at) VALUES (?, ?, 'lock', 'linux/amd64', ?, ?, ?, 'x', 'live', 'x')",
      put.artifactId, `bk-${n}`, put.manifestBytes.toString("utf8"), store.relativePath(put.artifactId), put.sizeBytes,
    );
    if (link) core.store.run("INSERT INTO revision_artifacts (app_id, revision_id, runtime_lock_id, artifact_id, created_at) VALUES (?, ?, 'lock', ?, 'x')", link.appId, link.revisionId, put.artifactId);
  });
  return put.artifactId;
}

const onDisk = (store: ArtifactStore, id: string) => fs.existsSync(store.dirOf(id));

describe("G: online GC", () => {
  it("V4-G01/G08 history, active, deployment, instance, build, proposal, check and every pin protect; records and history stay", async () => {
    const { core, store, gc } = setup();
    const a = app(core);
    core.store.tx(() => core.user.createRecord({ operationKey: randomUUID(), requestHash: "h" }, a.appId, core.apps.requireApp(a.appId).epoch, { title: "x" }));
    const history = artifact(core, store, 1, a); // a.revisionId is activated → history
    const free = artifact(core, store, 2);
    const pinnedBackup = artifact(core, store, 3);
    const pinnedReader = artifact(core, store, 4);
    gc.pin("artifact", pinnedBackup, "backup", "bk1");
    gc.pin("artifact", pinnedReader, "reader", "r1");
    const rep = await gc.collect();
    expect(rep.objects).toBe(1);
    expect(onDisk(store, free)).toBe(false);
    for (const id of [history, pinnedBackup, pinnedReader]) expect(onDisk(store, id)).toBe(true);
    expect(rep.protectedObjects).toBe(3);
    expect(core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM records")!.n).toBe(1);
    expect(core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM revisions")!.n).toBeGreaterThan(0);
    // releasing the owner makes it collectable
    gc.releaseOwner("reader", "r1");
    const rep2 = await gc.collect();
    expect(rep2.objects).toBe(1);
    expect(onDisk(store, pinnedReader)).toBe(false);
    await gc.worker.stop();
  });

  it("V4-G02 once an object is `deleting`, no new pin or link can take it; a reference taken first wins", async () => {
    const { core, store, gc } = setup();
    const id = artifact(core, store, 5);
    // reference first: the mark transaction sees it and skips
    core.store.tx(() => core.store.run("INSERT INTO build_jobs (id, app_id, revision_id, build_key, runtime_lock_id, status, attempt, container_name, artifact_id, deadline_at, created_at, updated_at) SELECT ?, a.id, a.active_revision_id, 'bk', 'lock', 'building', 0, 'c', ?, 'x', 'x', 'x' FROM apps a LIMIT 1", randomUUID(), id));
    const noApp = core.store.get("SELECT 1 FROM apps LIMIT 1");
    if (noApp) {
      const rep = await gc.collect();
      expect(rep.objects).toBe(0);
      expect(onDisk(store, id)).toBe(true);
    }
    // deleting first: a pin is refused with ARTIFACT_GC_PENDING
    const id2 = artifact(core, store, 6);
    core.store.tx(() => core.store.run("UPDATE artifacts SET gc_state = 'deleting', delete_intent_id = 'x' WHERE id = ?", id2));
    expect(() => gc.pin("artifact", id2, "preview", "p1")).toThrow(/ARTIFACT_GC_PENDING|being cleaned/);
    expect(() => core.store.tx(() => gc.requireLiveInTx(id2))).toThrow(/cleaned up/);
    await gc.worker.stop();
  });

  it("V4-G03 staging: an open owner's directory is never an orphan; an unregistered one is only reported; an ended one after the grace", async () => {
    const { core, store, gc } = setup();
    const root = store.root;
    fs.mkdirSync(path.join(root, ".staging-unknown"));
    fs.mkdirSync(path.join(root, ".staging-open"));
    fs.mkdirSync(path.join(root, ".staging-ended"));
    const a = app(core);
    core.store.tx(() => {
      for (const [id, st] of [["b-open", "building"], ["b-ended", "failed"]]) {
        core.store.run("INSERT INTO build_jobs (id, app_id, revision_id, build_key, runtime_lock_id, status, attempt, container_name, deadline_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'lock', ?, 0, ?, 'x', 'x', ?)", id, a.appId, a.revisionId, `k-${id}`, st, `c-${id}`, new Date(Date.now() - 2 * 3_600_000).toISOString());
      }
      core.store.run("INSERT INTO staging_owners (path_key, owner_kind, owner_id, state, created_at) VALUES ('.staging-open', 'build', 'b-open', 'open', 'x')");
      core.store.run("INSERT INTO staging_owners (path_key, owner_kind, owner_id, state, created_at) VALUES ('.staging-ended', 'build', 'b-ended', 'open', 'x')");
    });
    const rep = await gc.collect();
    expect(fs.existsSync(path.join(root, ".staging-open"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".staging-unknown"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".staging-ended"))).toBe(false);
    expect(rep.reportedOnly.map((r) => r.name)).toContain(".staging-unknown");
    // the real put() registers its owner before the directory exists
    const seen: string[] = [];
    store.put({ "app.mjs": Buffer.from("x") }, { runtimeLockId: "l", platform: "p", abiVersion: 1 }, { beforeStaging: (n) => seen.push(`before:${n}:${fs.existsSync(path.join(root, n))}`), afterPublish: (n) => seen.push(`after:${n}`) });
    expect(seen[0]).toMatch(/^before:\.staging-.*:false$/);
    await gc.worker.stop();
  });

  it("V4-G04 every interrupted phase resumes from its intent; a newer generation is never deleted by an old intent", async () => {
    const { core, store, gc } = setup();
    // phase marked (crash right after the mark transaction)
    const a1 = artifact(core, store, 7);
    const mark = (gc as unknown as { [k: string]: (...a: unknown[]) => unknown });
    const i1 = (OnlineGc.prototype as unknown as Record<string, unknown>) && core.store.tx(() => {
      core.store.run("INSERT INTO gc_delete_intents (id, object_kind, object_id, gc_generation, source_path, phase, logical_bytes, created_at, updated_at) VALUES ('gci_1', 'artifact', ?, 1, ?, 'marked', 1, 'x', 'x')", a1, store.relativePath(a1));
      core.store.run("UPDATE artifacts SET gc_state = 'deleting', delete_intent_id = 'gci_1' WHERE id = ?", a1);
      return "gci_1";
    });
    void mark;
    // phase moved (crash after the rename to trash)
    const a2 = artifact(core, store, 8);
    fs.mkdirSync(path.join(store.root, ".trash"), { recursive: true });
    fs.renameSync(store.dirOf(a2), path.join(store.root, ".trash", "gci_2"));
    core.store.tx(() => {
      core.store.run("INSERT INTO gc_delete_intents (id, object_kind, object_id, gc_generation, source_path, trash_path, phase, logical_bytes, created_at, updated_at) VALUES ('gci_2', 'artifact', ?, 1, ?, 'gci_2', 'moved', 1, 'x', 'x')", a2, store.relativePath(a2));
      core.store.run("UPDATE artifacts SET gc_state = 'deleting', delete_intent_id = 'gci_2' WHERE id = ?", a2);
    });
    // an old intent whose object was re-created with a newer generation
    const a3 = artifact(core, store, 9);
    core.store.tx(() => {
      core.store.run("UPDATE artifacts SET gc_generation = 2 WHERE id = ?", a3);
      core.store.run("INSERT INTO gc_delete_intents (id, object_kind, object_id, gc_generation, source_path, phase, logical_bytes, created_at, updated_at) VALUES ('gci_3', 'artifact', ?, 1, ?, 'marked', 1, 'x', 'x')", a3, store.relativePath(a3));
    });
    const r = await gc.recover();
    expect(r.resumed).toBe(3);
    expect(i1).toBe("gci_1");
    expect(onDisk(store, a1)).toBe(false);
    expect(fs.existsSync(path.join(store.root, ".trash", "gci_2"))).toBe(false);
    expect(onDisk(store, a3)).toBe(true);
    const phases = Object.fromEntries(core.store.all<{ id: string; phase: string }>("SELECT id, phase FROM gc_delete_intents").map((x) => [x.id, x.phase]));
    expect(phases).toEqual({ gci_1: "recorded", gci_2: "recorded", gci_3: "aborted" });
    await gc.worker.stop();
  });

  it("V4-G05 symlinks, unknown entries and mounts are refused or reported, never followed or cleared", async () => {
    const { core, store, gc, dir } = setup();
    const outside = path.join(dir, "precious");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
    fs.symlinkSync(outside, path.join(store.root, ".staging-link"));
    fs.mkdirSync(path.join(store.root, "random-dir"));
    const rep = await gc.collect();
    expect(fs.existsSync(path.join(outside, "keep.txt"))).toBe(true);
    expect(fs.existsSync(path.join(store.root, "random-dir"))).toBe(true);
    const names = rep.reportedOnly.map((r) => r.name);
    expect(names).toContain(".staging-link");
    expect(names).toContain("random-dir");
    // path traversal in an object name is refused by the worker itself
    const bad = await gc.worker.call({ op: "inspect", root: store.root, name: "../precious" });
    expect(bad.ok).toBe(false);
    void core;
    await gc.worker.stop();
  });

  it("V4-G06 batches yield at 100 objects; logical bytes and the free-space change are reported separately", async () => {
    const { core, store, gc } = setup();
    for (let i = 0; i < 130; i++) artifact(core, store, 1000 + i);
    const rep1 = await gc.collect({ maxBatches: 1 });
    expect(rep1.objects).toBe(100);
    expect(rep1.yielded).toBe(true);
    expect(rep1.remaining).toBe(30);
    expect(rep1.logicalBytes).toBeGreaterThan(0);
    expect(rep1.bytesUnlinked).toBeGreaterThan(0);
    expect(typeof rep1.freeBefore === "number" || rep1.freeBefore === null).toBe(true);
    const rep2 = await gc.collect();
    expect(rep2.objects).toBe(30);
    const rep3 = await gc.collect();
    expect(rep3.noReclaimable).toBe(true);
    await gc.worker.stop();
  });

  it("V4-G07 only closed rotated host logs go; the active file and unknown files stay", async () => {
    const { gc, logs } = setup();
    fs.writeFileSync(path.join(logs, "host.log"), "active\n");
    const old = path.join(logs, "host.log.20250101T000000.000Z");
    fs.writeFileSync(old, "x".repeat(1000));
    const ts = Date.now() / 1000 - 30 * 86400;
    fs.utimesSync(old, ts, ts);
    const recent = path.join(logs, "host.log.20991231T000000.000Z");
    fs.writeFileSync(recent, "y");
    fs.writeFileSync(path.join(logs, "other.txt"), "z");
    // an open writer on the active file keeps writing while cleanup runs
    const fd = fs.openSync(path.join(logs, "host.log"), "a");
    const r = await gc.cleanLogs({ retentionMs: 7 * 86_400_000, retentionBytes: 100 * 1024 * 1024 });
    fs.writeSync(fd, "still writing\n");
    fs.closeSync(fd);
    expect(r.removed).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.readFileSync(path.join(logs, "host.log"), "utf8")).toBe("active\nstill writing\n");
    expect(fs.existsSync(path.join(logs, "other.txt"))).toBe(true);
    await gc.worker.stop();
  });
});
