import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HOST_VERSION, RUNNER_ABI_VERSION, catalogHash, type RuntimeCatalog, type RuntimeLock } from "@agentos/contracts";
import { ArtifactStore, MIGRATIONS, RUNTIME_POLICY, type RuntimeDriver } from "@agentos/core";
import { TOOLSET_VERSION } from "@agentos/agent-pi";
import { expandHome, type HostConfig } from "./config.js";
import { backup as backupDatabases, restore as restoreDatabases } from "./admin.js";
import { createDriver, loadCatalog } from "./runtime-setup.js";

/**
 * v0.2 cold backup and restore (spec §21). The recoverable set: the paired databases, the runtime catalog, every
 * referenced artifact, the OCI images those versions need (exported through the engine), and a manifest with integrity
 * hashes. A set missing an image or artifact is refused, never marked complete.
 */
import { brokerRestore, quiesceForBackup, type V03BackupFacts } from "./backup-v3.js";
import { applyV04Restore, settleGcBeforeBackup, v04Facts, type V04BackupFacts } from "./backup-v4.js";

export interface ManifestV2 {
  format: 2;
  complete: boolean;
  storeUUID: string;
  productVersion: string;
  schemaVersion: number;
  clientEpoch: number;
  abiVersion: number;
  policyVersion: number;
  toolsetVersion: number;
  sourceCommit: string;
  piDurableVersion: string;
  catalogHash: string;
  createdAt: string;
  files: Record<string, string>;
  artifacts: { id: string; files: Record<string, string> }[];
  images: { name: string; id: string; platform: string; recipeHash: string; file: string; sha256: string }[];
  /** v0.3 (spec §23.1): provider catalog/policy hash, resources, broker checkpoint, audit export, managed snapshot. */
  v03?: V03BackupFacts;
  /** v0.4 (spec §23.3): bindings summary, scheduler/maintenance epochs, approved policy hashes, open jobs/intents/pins, unknown effects. */
  v04?: V04BackupFacts;
}

const sha256File = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");

function fsyncPath(p: string): void {
  try {
    const fd = fs.openSync(p, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* directories on some filesystems */
  }
}

export function sourceCommit(platformRoot: string): string {
  for (const f of [path.join(platformRoot, "SOURCE_COMMIT")]) if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim().slice(0, 64);
  try {
    const head = fs.readFileSync(path.join(platformRoot, ".git", "HEAD"), "utf8").trim();
    if (head.startsWith("ref: ")) return fs.readFileSync(path.join(platformRoot, ".git", head.slice(5)), "utf8").trim();
    return head;
  } catch {
    return process.env.AGENTOS_SOURCE_COMMIT ?? "unknown";
  }
}

interface DbFacts {
  storeUUID: string;
  codeApps: number;
  artifacts: { id: string; lock: string }[];
}

function dbFacts(osFile: string): DbFacts {
  const db = new DatabaseSync(osFile, { readOnly: true });
  try {
    const meta = db.prepare("SELECT store_uuid FROM meta WHERE id = 1").get() as { store_uuid: string };
    const hasV2 = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'artifacts'").get();
    if (!hasV2) return { storeUUID: meta.store_uuid, codeApps: 0, artifacts: [] };
    const artifacts = db.prepare("SELECT DISTINCT a.id AS id, a.runtime_lock_id AS lock FROM artifacts a JOIN revision_artifacts ra ON ra.artifact_id = a.id").all() as { id: string; lock: string }[];
    const codeApps = (db.prepare("SELECT COUNT(*) AS n FROM revisions WHERE json_extract(bundle_json, '$.formatVersion') IN (2, 3)").get() as { n: number }).n;
    return { storeUUID: meta.store_uuid, codeApps, artifacts };
  } finally {
    db.close();
  }
}

const safe = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, "_");

export async function backupFull(config: HostConfig, output: string, driverIn?: RuntimeDriver | null): Promise<ManifestV2> {
  const out = path.resolve(expandHome(output));
  const dataDir = config.dataDir;
  const osFile = path.join(dataDir, "os.sqlite");
  if (!fs.existsSync(osFile)) throw new Error(`os.sqlite is missing in ${dataDir}`);
  // v0.4: delete intents are finished from their phases before the copy decides which artifacts it holds.
  const gcResumed = await settleGcBeforeBackup(dataDir);
  const facts = dbFacts(osFile);
  const catalog = loadCatalog(config);
  const driver = driverIn === undefined ? createDriver(config, catalog) : driverIn;
  // The host is stopped (we hold host.lock); re-inspect that no workspace container still runs.
  if (driver) {
    let list: Awaited<ReturnType<RuntimeDriver["list"]>>;
    try {
      list = await driver.list(facts.storeUUID);
    } catch (e) {
      if (facts.codeApps > 0) throw new Error(`cannot verify that no workspace container runs (engine unreachable: ${(e as Error).message})`);
      list = [];
    }
    const running = list.filter((c) => c.state === "running" || c.state === "created");
    if (running.length > 0) throw new Error(`workspace containers are still running: ${running.map((c) => c.name).join(", ")}; stop the host and wait`);
  } else if (facts.codeApps > 0) {
    throw new Error("the container engine is needed to export the images of the code versions");
  }
  // v0.3 (spec §23.2 steps 2–3): broker quiesce, facts synced into the business copy, checkpoint recorded.
  if (fs.existsSync(out) && fs.readdirSync(out).length > 0) throw new Error(`backup directory ${out} is not empty`);
  const staging = `${out}.v03-staging`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  const v04 = v04Facts(osFile, gcResumed);
  const q = await quiesceForBackup(osFile, staging);
  let v03: V03BackupFacts | null = q.facts;
  try {
  // 1. databases (verified copies with hashes; refuses a non-empty output dir).
  const dbManifest = backupDatabases(dataDir, out);
  const files: Record<string, string> = { ...dbManifest.files };
  // 2. runtime catalog.
  fs.mkdirSync(path.join(out, "runtime"), { mode: 0o700 });
  fs.copyFileSync(config.catalogFile, path.join(out, "runtime", "catalog.json"));
  files["runtime/catalog.json"] = sha256File(path.join(out, "runtime", "catalog.json"));
  // 3. referenced artifacts, verified before and after copying.
  const store = new ArtifactStore(path.join(dataDir, "artifacts"));
  const artifacts: ManifestV2["artifacts"] = [];
  const locksNeeded = new Set<string>();
  for (const a of facts.artifacts) {
    const problem = store.verify(a.id);
    if (problem !== null) throw new Error(`referenced artifact ${a.id} is not intact (${problem}); the backup would be incomplete`);
    const src = store.dirOf(a.id);
    const dst = path.join(out, "artifacts", path.basename(src));
    fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
    const hashes: Record<string, string> = {};
    for (const f of fs.readdirSync(src)) {
      fs.copyFileSync(path.join(src, f), path.join(dst, f));
      fsyncPath(path.join(dst, f));
      hashes[f] = sha256File(path.join(dst, f));
    }
    artifacts.push({ id: a.id, files: hashes });
    locksNeeded.add(a.lock);
  }
  // 4. images the referenced versions need: runtime (to run) and builder (to rebuild), exported through the engine.
  const images: ManifestV2["images"] = [];
  if (locksNeeded.size > 0) {
    fs.mkdirSync(path.join(out, "images"), { mode: 0o700 });
    for (const lockId of locksNeeded) {
      const lock = catalog.catalog.locks.find((l) => l.id === lockId);
      if (!lock) throw new Error(`lock ${lockId} is not in the catalog; the backup would be incomplete`);
      for (const [role, img] of [["runtime", lock.runtimeImage], ["builder", lock.builderImage]] as const) {
        const st = await driver!.inspectImage(img.name);
        if (!st.present || st.labels?.["agentos.recipe"] !== img.recipeHash) throw new Error(`image ${img.name} (${role}) is not available locally; run pnpm runtime:prefetch before backing up`);
        const file = `images/${safe(img.name)}.oci.tar`;
        await driver!.exportImage(img.name, path.join(out, file));
        fsyncPath(path.join(out, file));
        images.push({ name: img.name, id: st.id ?? "", platform: lock.platform, recipeHash: img.recipeHash, file, sha256: sha256File(path.join(out, file)) });
      }
    }
  }
  // v0.3 extras: audit export and managed-file snapshot (hashed like everything else).
  if (v03) {
    for (const e of fs.readdirSync(staging)) fs.cpSync(path.join(staging, e), path.join(out, e), { recursive: true });
    const add = (rel: string) => {
      const full = path.join(out, rel);
      if (fs.statSync(full).isDirectory()) for (const n of fs.readdirSync(full)) add(`${rel}/${n}`);
      else files[rel] = sha256File(full);
    };
    if (v03.auditFile) add("system");
    if (v03.managed) add("managed");
  }
  const manifest: ManifestV2 = {
    format: 2,
    complete: true,
    storeUUID: dbManifest.storeUUID,
    productVersion: HOST_VERSION,
    schemaVersion: dbManifest.schemaVersion,
    clientEpoch: dbManifest.clientEpoch,
    abiVersion: RUNNER_ABI_VERSION,
    policyVersion: RUNTIME_POLICY.version,
    toolsetVersion: TOOLSET_VERSION,
    sourceCommit: sourceCommit(config.platformRoot),
    piDurableVersion: dbManifest.piDurableVersion,
    catalogHash: catalog.hash,
    createdAt: new Date().toISOString(),
    files,
    artifacts,
    images,
    ...(v03 ? { v03 } : {}),
    ...(v04 ? { v04 } : {}),
  };
  // The v1 manifest written by the database step is replaced by the complete v2 manifest, written last.
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  fsyncPath(path.join(out, "manifest.json"));
  fsyncPath(out);
  v03 = null;
  return manifest;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    // Step 5: the quiesce ends by an explicit resume after success or failure; failure was already reported.
    await q.release().catch(() => undefined);
  }
}

/** Verify a v2 set completely (hashes of every file, artifact and image archive). */
export function verifyFull(dir: string): ManifestV2 {
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as ManifestV2;
  if (m.format !== 2) throw new Error("not a v0.2 backup");
  if (!m.complete) throw new Error("the backup is marked incomplete and cannot be restored offline");
  for (const [name, hash] of Object.entries(m.files)) if (sha256File(path.join(dir, name)) !== hash) throw new Error(`${name} does not match the manifest`);
  for (const a of m.artifacts) {
    for (const [f, h] of Object.entries(a.files)) if (sha256File(path.join(dir, "artifacts", a.id.replace(/^sha256:/, ""), f)) !== h) throw new Error(`artifact ${a.id} file ${f} is corrupt`);
    if (ArtifactStore.idOf(fs.readFileSync(path.join(dir, "artifacts", a.id.replace(/^sha256:/, ""), "manifest.json"))) !== a.id) throw new Error(`artifact ${a.id} manifest hash mismatch`);
  }
  for (const i of m.images) if (sha256File(path.join(dir, i.file)) !== i.sha256) throw new Error(`image archive ${i.file} is corrupt`);
  if (m.schemaVersion > MIGRATIONS.length || m.schemaVersion < 1) throw new Error(`backup os.sqlite schema ${m.schemaVersion} cannot be opened by this host (supports 1..${MIGRATIONS.length})`);
  return m;
}

/** The backup's runtime locks must still mean the same thing in this host's catalog (lock ids never change). */
function checkCatalogCompat(backupCatalog: RuntimeCatalog, current: RuntimeCatalog, needed: Set<string>): void {
  for (const id of needed) {
    const a = backupCatalog.locks.find((l) => l.id === id);
    const b = current.locks.find((l) => l.id === id && l.platform === a?.platform);
    if (!a || !b || JSON.stringify(a as RuntimeLock) !== JSON.stringify(b)) throw new Error(`runtime lock ${id} differs between the backup and this host`);
  }
}

/**
 * Restore (spec §21): the v0.1 restore-in-progress protocol for the databases, plus image import (retryable) and the
 * artifact/catalog set. The workspace only opens once everything verified; an interrupted restore blocks startup.
 */
export async function restoreFull(config: HostConfig, backupDir: string, opts: { failAfterFirstReplace?: boolean; failAfterImages?: boolean } = {}): Promise<{ storeUUID: string; clientEpoch: number; preRestoreBackup: string; images: number; artifacts: number }> {
  const src = path.resolve(expandHome(backupDir));
  const raw = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8")) as { format: number };
  if (raw.format === 1) {
    const r = restoreDatabases(config.dataDir, src, opts);
    return { ...r, images: 0, artifacts: 0 };
  }
  const m = verifyFull(src);
  const backupCatalog = JSON.parse(fs.readFileSync(path.join(src, "runtime", "catalog.json"), "utf8")) as RuntimeCatalog;
  if (catalogHash(backupCatalog) !== m.catalogHash) throw new Error("backup catalog does not match its manifest");
  const catalog = loadCatalog(config);
  const neededLocks = new Set(m.images.flatMap((i) => backupCatalog.locks.filter((l) => l.runtimeImage.name === i.name || l.builderImage.name === i.name).map((l) => l.id)));
  checkCatalogCompat(backupCatalog, catalog.catalog, neededLocks);
  // 1. images first (retryable; extra imported content may stay as cache).
  if (m.images.length > 0) {
    const driver = createDriver(config, catalog);
    if (!driver) throw new Error("the container engine is needed to import the backup's images");
    for (const i of m.images) {
      const cur = await driver.inspectImage(i.name);
      if (!(cur.present && cur.labels?.["agentos.recipe"] === i.recipeHash)) {
        await driver.importImage(path.join(src, i.file));
        const after = await driver.inspectImage(i.name);
        if (!after.present || after.labels?.["agentos.recipe"] !== i.recipeHash) throw new Error(`image ${i.name} did not import with recipe ${i.recipeHash}`);
      }
    }
  }
  if (opts.failAfterImages) process.kill(process.pid, "SIGKILL");
  // 2. artifacts into place before the databases that reference them (an extra artifact is harmless; a missing one is not).
  const store = new ArtifactStore(path.join(config.dataDir, "artifacts"));
  for (const a of m.artifacts) {
    if (store.verify(a.id) === null) continue;
    const dst = store.dirOf(a.id);
    fs.rmSync(dst, { recursive: true, force: true });
    const tmp = `${dst}.restoring`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    for (const f of Object.keys(a.files)) {
      fs.copyFileSync(path.join(src, "artifacts", path.basename(dst), f), path.join(tmp, f));
      fsyncPath(path.join(tmp, f));
    }
    fs.renameSync(tmp, dst);
    if (store.verify(a.id) !== null) throw new Error(`restored artifact ${a.id} failed verification`);
  }
  // v0.3 (spec §23.3 step 2): the broker fences the old incarnation before any database is replaced.
  const br = await brokerRestore(config.dataDir, src, m.v03);
  // 3. databases with the v0.1 marker protocol (pre-restore backup, staging, replace, client epoch, token rotation);
  // 4. before the marker goes: old instance bindings are revoked, the next host boot recreates active instances.
  const r = restoreDatabases(config.dataDir, src, {
    failAfterFirstReplace: opts.failAfterFirstReplace,
    beforeMarkerRemoval: () => {
      br.beforeMarkerRemoval();
      applyV04Restore(config.dataDir, `backup ${path.basename(src)}`);
      const db = new DatabaseSync(path.join(config.dataDir, "os.sqlite"));
      try {
        const hasV2 = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'runtime_instances'").get();
        if (hasV2) {
          db.exec("UPDATE runtime_instances SET desired_state = 'removed', observed_state = CASE WHEN observed_state IN ('stopped','failed','absent') THEN observed_state ELSE 'unknown' END");
          db.exec("UPDATE app_runtime SET active_instance_id = NULL, health = CASE WHEN enabled = 1 THEN 'recovering' ELSE 'stopped' END");
          db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        }
      } finally {
        db.close();
      }
    },
  });
  await br.complete();
  return { ...r, images: m.images.length, artifacts: m.artifacts.length, workspaceIncarnation: br.incarnation } as never;
}
