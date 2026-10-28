import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { loadConfig, expandHome } from "./config.js";
import { assertLockHeld } from "./lock.js";
import { rotateSecrets } from "./auth.js";
import { MIGRATIONS, openCore } from "@agentos/core";
import { checkStructure } from "@agentos/contracts";

/**
 * Cold backup / restore (spec §15). Run through bin/agentos-admin, which holds the same host.lock with flock,
 * so the host cannot be running. The lock file and its inode are never replaced.
 */

const RESTORE_MARKER = "restore-in-progress";
const DBS = ["os.sqlite", "agent.sqlite"] as const;
const SIDE = ["", "-wal"] as const;

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fsyncPath(p: string): void {
  const fd = fs.openSync(p, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function piVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve("@earendil-works/pi-durable/package.json", { paths: [path.join(import.meta.dirname, "..", "..", "agent-pi")] });
    return (JSON.parse(fs.readFileSync(pkg, "utf8")) as { version: string }).version;
  } catch {
    return "1.4.0";
  }
}

interface Manifest {
  format: 1;
  storeUUID: string;
  schemaVersion: number;
  clientEpoch: number;
  piDurableVersion: string;
  createdAt: string;
  files: Record<string, string>;
}

function readMeta(file: string): { store_uuid: string; schema_version: number; client_epoch: number } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT store_uuid, schema_version, client_epoch FROM meta WHERE id = 1").get() as never;
  } finally {
    db.close();
  }
}

function integrity(file: string): void {
  const db = new DatabaseSync(file);
  try {
    const r = db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;
    if (Object.values(r)[0] !== "ok") throw new Error(`${path.basename(file)} failed integrity_check`);
  } finally {
    db.close();
  }
}

export function backup(dataDir: string, output: string): Manifest {
  const out = path.resolve(expandHome(output));
  if (fs.existsSync(out) && fs.readdirSync(out).length > 0) throw new Error(`backup directory ${out} is not empty`);
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  for (const db of DBS) if (!fs.existsSync(path.join(dataDir, db))) throw new Error(`${db} is missing in ${dataDir}`);
  const files: Record<string, string> = {};
  for (const db of DBS) {
    for (const s of SIDE) {
      const name = `${db}${s}`;
      const src = path.join(dataDir, name);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(out, name));
      fsyncPath(path.join(out, name));
      files[name] = sha256File(path.join(out, name));
    }
  }
  const meta = readMeta(path.join(out, "os.sqlite"));
  const manifest: Manifest = {
    format: 1,
    storeUUID: meta.store_uuid,
    schemaVersion: meta.schema_version,
    clientEpoch: meta.client_epoch,
    piDurableVersion: piVersion(),
    createdAt: new Date().toISOString(),
    files,
  };
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  fsyncPath(path.join(out, "manifest.json"));
  fsyncPath(out);
  return manifest;
}

function verifySet(dir: string): Manifest {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
  if (manifest.format !== 1) throw new Error("unknown backup format");
  for (const db of DBS) if (!manifest.files[db]) throw new Error(`backup lacks ${db}`);
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (sha256File(path.join(dir, name)) !== hash) throw new Error(`${name} does not match the manifest hash`);
  }
  return manifest;
}

/** Spec §15 version check: this host must be able to open the set without a downgrade or a Pi format change. */
function checkVersions(manifest: Manifest): void {
  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 1 || manifest.schemaVersion > MIGRATIONS.length) {
    throw new Error(`backup os.sqlite schema ${manifest.schemaVersion} cannot be opened by this host (supports 1..${MIGRATIONS.length})`);
  }
  const pi = piVersion();
  if (manifest.piDurableVersion !== pi) {
    throw new Error(`backup was taken with pi-durable ${manifest.piDurableVersion}; this host runs ${pi}`);
  }
}

/** Restore a whole workspace set. Re-running after an interruption completes the same restore. */
export function restore(dataDir: string, backupDir: string, opts: { failAfterFirstReplace?: boolean } = {}): { storeUUID: string; clientEpoch: number; preRestoreBackup: string } {
  const src = path.resolve(expandHome(backupDir));
  const manifest = verifySet(src);
  checkVersions(manifest);
  const markerFile = path.join(dataDir, RESTORE_MARKER);
  let marker: { backup: string; preRestore: string; clientEpoch: number } | undefined;
  if (fs.existsSync(markerFile)) {
    marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
    if (marker!.backup !== src) throw new Error(`an interrupted restore from ${marker!.backup} must be finished first`);
  } else {
    // 1. save the current set first
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const pre = path.join(dataDir, "backups", `pre-restore-${stamp}`);
    let currentEpoch = 0;
    if (fs.existsSync(path.join(dataDir, "os.sqlite"))) {
      backup(dataDir, pre);
      currentEpoch = readMeta(path.join(pre, "os.sqlite")).client_epoch;
    }
    marker = { backup: src, preRestore: pre, clientEpoch: Math.max(currentEpoch, manifest.clientEpoch) + 1 };
    // 2. write and flush the restore marker before touching any database file
    fs.writeFileSync(markerFile, JSON.stringify(marker), { mode: 0o600 });
    fsyncPath(markerFile);
    fsyncPath(dataDir);
  }
  // 3. verify the complete set in a staging directory
  const staging = path.join(dataDir, ".restore-staging");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { mode: 0o700 });
  for (const name of Object.keys(manifest.files)) fs.copyFileSync(path.join(src, name), path.join(staging, name));
  for (const name of Object.keys(manifest.files)) if (sha256File(path.join(staging, name)) !== manifest.files[name]) throw new Error(`staged ${name} is corrupt`);
  // 4. replace both databases and their WAL; drop stale sidecars
  let n = 0;
  for (const db of DBS) {
    for (const s of ["-wal", "-shm", "-journal"]) fs.rmSync(path.join(dataDir, `${db}${s}`), { force: true });
    for (const s of SIDE) {
      const name = `${db}${s}`;
      if (!manifest.files[name]) continue;
      fs.copyFileSync(path.join(staging, name), path.join(dataDir, `${name}.restoring`));
      fsyncPath(path.join(dataDir, `${name}.restoring`));
      fs.renameSync(path.join(dataDir, `${name}.restoring`), path.join(dataDir, name));
    }
    n++;
    if (opts.failAfterFirstReplace && n === 1) {
      fsyncPath(dataDir);
      process.kill(process.pid, "SIGKILL");
    }
  }
  fsyncPath(dataDir);
  // 5. new client epoch (old pages are refused), rotate the local token, integrity and version checks
  const db = new DatabaseSync(path.join(dataDir, "os.sqlite"));
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.prepare("UPDATE meta SET client_epoch = ? WHERE id = 1").run(marker!.clientEpoch);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  rotateSecrets(dataDir);
  integrity(path.join(dataDir, "os.sqlite"));
  integrity(path.join(dataDir, "agent.sqlite"));
  const after = readMeta(path.join(dataDir, "os.sqlite"));
  if (after.store_uuid !== manifest.storeUUID) throw new Error("restored store_uuid does not match the manifest");
  if (after.schema_version !== manifest.schemaVersion) throw new Error("restored os.sqlite schema does not match the manifest");
  fs.rmSync(staging, { recursive: true, force: true });
  // 6. remove and flush the marker
  fs.rmSync(markerFile);
  fsyncPath(dataDir);
  return { storeUUID: after.store_uuid, clientEpoch: after.client_epoch, preRestoreBackup: marker!.preRestore };
}

/**
 * Spec §17 M2: internal test entry that seeds hand-written fixtures (in order) into a stopped test workspace.
 * Refused unless NODE_ENV=test; production has no fixture import over HTTP or CLI.
 */
export function seedFixtures(dataDir: string, files: string[]): { appId: string; revisionId: string; appEpoch: number }[] {
  const core = openCore(path.join(dataDir, "os.sqlite"));
  try {
    return files.map((f) => {
      const raw = JSON.parse(fs.readFileSync(path.resolve(f), "utf8")) as unknown;
      const s = checkStructure(raw);
      if (!s.ok) throw new Error(`${f} is not a valid AppBundle: ${JSON.stringify(s.issues.slice(0, 3))}`);
      const r = core.apps.seedActivated(s.bundle);
      return { appId: r.appId, revisionId: r.revisionId, appEpoch: r.appEpoch };
    });
  } finally {
    core.store.close();
  }
}

function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === name && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  });
  return out;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function adminMain(): void {
  const cmd = process.argv[2];
  const config = loadConfig();
  const lockFile = path.join(config.dataDir, "host.lock");
  try {
    assertLockHeld(lockFile);
    if (cmd === "backup") {
      const out = arg("--output");
      if (!out) throw new Error("usage: pnpm backup -- --output <dir>");
      const m = backup(config.dataDir, out);
      process.stdout.write(`${JSON.stringify({ ok: true, output: path.resolve(expandHome(out)), storeUUID: m.storeUUID, files: Object.keys(m.files) })}\n`);
    } else if (cmd === "restore") {
      const b = arg("--backup");
      if (!b) throw new Error("usage: pnpm restore -- --backup <dir>");
      const r = restore(config.dataDir, b, { failAfterFirstReplace: config.testMode && process.env.AGENTOS_FAULT_POINT === "restore.after_first_replace" && process.env.AGENTOS_FAULTS === "1" });
      process.stdout.write(`${JSON.stringify({ ok: true, ...r, note: "workspace restored to the backup time; sign in again with the new auth-token" })}\n`);
    } else if (cmd === "seed") {
      if (!config.testMode) throw new Error("seed is a test-only entry (NODE_ENV=test)");
      const files = args("--fixture");
      if (files.length === 0) throw new Error("usage: agentos-admin seed --fixture <bundle.json> [--fixture <bundle.json> ...]");
      fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
      process.stdout.write(`${JSON.stringify({ ok: true, seeded: seedFixtures(config.dataDir, files) })}\n`);
    } else {
      throw new Error("usage: agentos-admin backup --output <dir> | restore --backup <dir>");
    }
  } catch (e) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: (e as Error).message })}\n`);
    process.exit(1);
  }
}
