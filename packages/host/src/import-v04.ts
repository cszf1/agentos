import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256Hex } from "@agentos/contracts";
import { bindLegacyPrincipal, openCore } from "@agentos/core";
import { verifyFull } from "./backup-v2.js";
import { applyV04Restore } from "./backup-v4.js";

/**
 * v1.0 import of a v0.4 coordinated cold backup into a NEW workspace data directory (spec §25, V1-M01—M08).
 *
 * The backup is never modified. Everything happens in `<target>.import-staging`; only a complete, verified,
 * migrated staging tree is renamed to `<target>` (one rename = the publish point). Any failure removes the staging
 * tree and leaves the target absent ("not imported").
 *
 * - Format/hash/pairing: the v0.2+ manifest is verified file by file; productVersion must be 0.4.x and the schema ≤ 4.
 * - One writable copy per storeUUID: an id the machine already registered is refused (STORE_ALREADY_REGISTERED);
 *   the caller (machined) passes the registered set.
 * - Content is kept: app ids, revision ids (= bundle hashes), record ids and data, activation history and operation
 *   receipts are compared before/after; nothing is re-hashed or rewritten.
 * - Legacy principal: `user:local` is bound to the new owner through `legacy_principals` only.
 * - Authority does not travel: maintenance policies → paused_needs_review, unfinished runs/jobs stopped, outboxes
 *   fenced (the v0.4 restore rules), service/provider grants revoked, physical resources quarantined, provider
 *   secrets not imported unless the owner asked (default: model_unconfigured).
 * - Files: only regular files and directories under the listed names are copied, created by the importing process
 *   (the execution UID) with 0600/0700; no owner UID is copied; links/devices are refused.
 * - Podman graphroot is never copied: images listed in the manifest are returned as `imagesToImport` so the
 *   workspace's own rootless engine imports them by digest.
 */
export interface ImportV04Options {
  backupDir: string;
  targetDataDir: string;
  workspaceId: string;
  ownerUserId: string;
  registeredStoreUUIDs: string[];
  includeSecrets?: boolean;
  /** fault injection for tests: throw after this step */
  failAfter?: "copy" | "migrate" | "facts";
}

export interface ContentFacts {
  apps: { appId: string; activeRevisionId: string | null; revisions: string[]; recordsHash: string; records: number }[];
  receipts: { count: number; hash: string };
  activations: { count: number; hash: string };
}

function lstatRegular(p: string): void {
  const st = fs.lstatSync(p);
  if (!st.isFile()) throw Object.assign(new Error(`${p} is not a regular file`), { code: "IMPORT_ENTRY_UNSUPPORTED" });
}

function safeName(rel: string): boolean {
  return rel.length > 0 && !path.isAbsolute(rel) && rel.split("/").every((c) => c !== "" && c !== "." && c !== ".." && !c.includes("\0") && !c.includes("\\"));
}

function copyFile(src: string, dst: string): void {
  lstatRegular(src);
  fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
  fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(dst, 0o600);
  const fd = fs.openSync(dst, "r");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}

export function contentFacts(osFile: string): ContentFacts {
  const db = new DatabaseSync(osFile, { readOnly: true });
  try {
    const apps = (db.prepare("SELECT id, active_revision_id FROM apps ORDER BY id").all() as { id: string; active_revision_id: string | null }[]).map((a) => {
      const revisions = (db.prepare("SELECT id FROM revisions WHERE app_id = ? ORDER BY id").all(a.id) as { id: string }[]).map((r) => r.id);
      const recs = db.prepare("SELECT id, version, data_json FROM records WHERE app_id = ? ORDER BY id").all(a.id) as { id: string; version: number; data_json: string }[];
      const recordsHash = "sha256:" + sha256Hex(canonicalJson(recs.map((r) => ({ id: r.id, version: r.version, data: JSON.parse(r.data_json) }))));
      return { appId: a.id, activeRevisionId: a.active_revision_id, revisions, recordsHash, records: recs.length };
    });
    const ops = db.prepare("SELECT principal, operation_key, request_hash, status_code, result_json FROM operations ORDER BY operation_key, principal").all();
    const hasDeploy = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'deployments'").get();
    const acts = hasDeploy ? db.prepare("SELECT id, app_id, target_revision_id, base_revision_id, origin, request_hash FROM deployments ORDER BY id").all() : [];
    return {
      apps,
      receipts: { count: ops.length, hash: "sha256:" + sha256Hex(canonicalJson(ops as never)) },
      activations: { count: acts.length, hash: "sha256:" + sha256Hex(canonicalJson(acts as never)) },
    };
  } finally {
    db.close();
  }
}

function invalidateAuthority(osFile: string, includeSecrets: boolean): Record<string, number> {
  const db = new DatabaseSync(osFile);
  const out: Record<string, number> = {};
  const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  try {
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    if (has("service_grants")) out.serviceGrants = Number(db.prepare("UPDATE service_grants SET revoked_at = ? WHERE revoked_at IS NULL").run(now).changes);
    if (has("provider_grants")) {
      const cols = (db.prepare("PRAGMA table_info(provider_grants)").all() as { name: string }[]).map((c) => c.name);
      if (cols.includes("revoked_at")) out.providerGrants = Number(db.prepare("UPDATE provider_grants SET revoked_at = ? WHERE revoked_at IS NULL").run(now).changes);
      else if (cols.includes("state")) out.providerGrants = Number(db.prepare("UPDATE provider_grants SET state = 'revoked' WHERE state <> 'revoked'").run().changes);
    }
    if (has("system_resources")) out.resources = Number(db.prepare("UPDATE system_resources SET status = 'quarantined' WHERE status <> 'gone'").run().changes);
    db.prepare("INSERT INTO events (kind, payload_json, created_at) VALUES ('workspace.v04_imported', ?, ?)").run(JSON.stringify({ ...out, secrets: includeSecrets ? "imported" : "model_unconfigured" }), now);
    db.exec("COMMIT");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* not in a transaction */
    }
    throw e;
  } finally {
    db.close();
  }
  return out;
}

export function importV04(o: ImportV04Options): {
  workspaceId: string;
  storeUUID: string;
  before: ContentFacts;
  after: ContentFacts;
  identical: boolean;
  fenced: Record<string, number>;
  revoked: Record<string, number>;
  imagesToImport: { name: string; file: string; sha256: string }[];
  secrets: "imported" | "model_unconfigured";
} {
  const src = path.resolve(o.backupDir);
  const target = path.resolve(o.targetDataDir);
  if (fs.existsSync(target)) throw Object.assign(new Error(`${target} exists; an import never writes into an existing workspace`), { code: "CONFLICT" });
  const m = verifyFull(src); // every hash; throws on a damaged backup
  if (!/^0\.4\./.test(String(m.productVersion)) || !(m.schemaVersion <= 4)) {
    throw Object.assign(new Error(`not a v0.4 backup (product ${m.productVersion}, schema ${m.schemaVersion})`), { code: "IMPORT_INCOMPATIBLE" });
  }
  if (o.registeredStoreUUIDs.includes(m.storeUUID)) {
    throw Object.assign(new Error(`storeUUID ${m.storeUUID} already has a writable workspace on this machine; restore that workspace or use the new-machine copy flow`), { code: "STORE_ALREADY_REGISTERED" });
  }
  const staging = `${target}.import-staging`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    for (const rel of Object.keys(m.files)) {
      if (!safeName(rel)) throw Object.assign(new Error(`unsafe path ${rel}`), { code: "IMPORT_PATH_INVALID" });
      if (rel.startsWith("images/")) continue; // images go through the engine, never the graphroot
      copyFile(path.join(src, rel), path.join(staging, rel === "runtime/catalog.json" ? "import/catalog.json" : rel));
    }
    for (const a of m.artifacts) {
      const dir = a.id.replace(/^sha256:/, "");
      if (!/^[0-9a-f]{64}$/.test(dir)) throw Object.assign(new Error(`bad artifact id ${a.id}`), { code: "IMPORT_PATH_INVALID" });
      for (const f of Object.keys(a.files)) {
        if (!safeName(f)) throw Object.assign(new Error(`unsafe artifact path ${f}`), { code: "IMPORT_PATH_INVALID" });
        copyFile(path.join(src, "artifacts", dir, f), path.join(staging, "artifacts", dir, f));
      }
    }
    // Facts are read from the staging copy: even a read-only SQLite open can checkpoint/remove a -wal file, and
    // the source backup must stay byte-identical.
    const before = contentFacts(path.join(staging, "os.sqlite"));
    if (o.failAfter === "copy") throw new Error("fault: after copy");
    // schema 4 → 5 (controlled migration), then the identity binding
    const core = openCore(path.join(staging, "os.sqlite"));
    try {
      const meta = core.store.get<{ store_uuid: string; workspace_id: string | null }>("SELECT store_uuid, workspace_id FROM meta WHERE id = 1")!;
      if (meta.store_uuid !== m.storeUUID) throw Object.assign(new Error("os.sqlite storeUUID does not match the manifest"), { code: "PAIR_MISMATCH" });
      core.store.tx(() => core.store.run("UPDATE meta SET workspace_id = ?, identity_protocol_version = 2 WHERE id = 1", o.workspaceId));
      bindLegacyPrincipal(core.store, o.ownerUserId, o.workspaceId);
    } finally {
      core.store.close();
    }
    if (o.failAfter === "migrate") throw new Error("fault: after migrate");
    const fenced = applyV04Restore(staging, "v0.4 import");
    const revoked = invalidateAuthority(path.join(staging, "os.sqlite"), !!o.includeSecrets);
    // agent.sqlite pairing is checked by the Host's Pi bind on first start (marker storeUUID must match).
    const ag = new DatabaseSync(path.join(staging, "agent.sqlite"), { readOnly: true });
    const tables = (ag.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    let paired = false;
    for (const t of tables) {
      for (const c of (ag.prepare(`SELECT name FROM pragma_table_info('${t.replace(/'/g, "''")}')`).all() as { name: string }[]).map((x) => x.name)) {
        const n = ag.prepare(`SELECT COUNT(*) AS n FROM "${t.replace(/"/g, '""')}" WHERE CAST("${c.replace(/"/g, '""')}" AS TEXT) LIKE ?`).get(`%${m.storeUUID}%`) as { n: number };
        if (n.n > 0) paired = true;
      }
    }
    ag.close();
    if (!paired) throw Object.assign(new Error("agent.sqlite does not carry the backup's storeUUID"), { code: "PAIR_MISMATCH" });
    const after = contentFacts(path.join(staging, "os.sqlite"));
    if (o.failAfter === "facts") throw new Error("fault: after facts");
    const identical = canonicalJson(before as never) === canonicalJson(after as never);
    if (!identical) throw Object.assign(new Error("content changed during import"), { code: "IMPORT_CONTENT_CHANGED" });
    for (const f of ["os.sqlite-wal", "os.sqlite-shm"]) fs.rmSync(path.join(staging, f), { force: true });
    fs.renameSync(staging, target);
    const pfd = fs.openSync(path.dirname(target), "r");
    fs.fsyncSync(pfd);
    fs.closeSync(pfd);
    return {
      workspaceId: o.workspaceId,
      storeUUID: m.storeUUID,
      before,
      after,
      identical,
      fenced,
      revoked,
      imagesToImport: m.images.map((i) => ({ name: i.name, file: i.file, sha256: i.sha256 })),
      secrets: o.includeSecrets ? "imported" : "model_unconfigured",
    };
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}
