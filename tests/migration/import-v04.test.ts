// V1-M01/M02/M03/M05/M07/M08: import a REAL v0.4 cold backup (made by the frozen v0.4 code with its own
// `agentos-admin backup`, see scripts/v04-instance.mjs) into a new v1.0 workspace directory.
// Set AGENTOS_V04_BACKUP to that backup directory. The backup is copied to a temp dir first and never modified.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { importV04, contentFacts } from "../../packages/host/src/import-v04.js";
import { tmpDir } from "../helpers.js";

const SRC = process.env.AGENTOS_V04_BACKUP;
const OWNER = "22222222-2222-4222-8222-222222222222";
const WS = "44444444-4444-4444-8444-444444444444";

function copyBackup(): string {
  const d = path.join(tmpDir("agentos-v04src-"), "b");
  fs.cpSync(SRC!, d, { recursive: true });
  const w = (p: string) => {
    const st = fs.statSync(p);
    fs.chmodSync(p, st.isDirectory() ? 0o700 : 0o600);
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) w(path.join(p, n));
  };
  w(d);
  return d;
}
function treeHash(dir: string): string {
  const out: string[] = [];
  const walk = (r: string) => {
    for (const n of fs.readdirSync(path.join(dir, r)).sort()) {
      const rel = r ? `${r}/${n}` : n;
      const st = fs.lstatSync(path.join(dir, rel));
      if (st.isDirectory()) walk(rel);
      else out.push(`${rel}:${fs.readFileSync(path.join(dir, rel)).toString("base64")}`);
    }
  };
  walk("");
  return out.join("\n");
}

describe.skipIf(!SRC)("v0.4 backup import (real backup)", () => {
  it("imports with identical content, legacy principal bound, authority not carried, source untouched", () => {
    const src = copyBackup();
    const pristine = treeHash(src);
    const target = path.join(tmpDir("agentos-v1ws-"), "data");
    const r = importV04({ backupDir: src, targetDataDir: target, workspaceId: WS, ownerUserId: OWNER, registeredStoreUUIDs: [] });
    expect(r.identical).toBe(true);
    expect(r.before.apps.length).toBeGreaterThan(0);
    expect(r.before.apps[0]!.records).toBeGreaterThan(0);
    expect(r.secrets).toBe("model_unconfigured");
    expect(treeHash(src)).toBe(pristine); // M01: the original backup stays usable
    const db = new DatabaseSync(path.join(target, "os.sqlite"), { readOnly: true });
    const meta = db.prepare("SELECT schema_version, store_uuid, workspace_id FROM meta WHERE id = 1").get() as { schema_version: number; store_uuid: string; workspace_id: string };
    expect(meta).toEqual({ schema_version: 5, store_uuid: r.storeUUID, workspace_id: WS });
    // M03: user:local receipts unchanged, bound to the owner without rewriting
    expect(db.prepare("SELECT owner_user_id, workspace_id FROM legacy_principals WHERE legacy_key = 'user:local'").get()).toEqual({ owner_user_id: OWNER, workspace_id: WS });
    const principals = (db.prepare("SELECT DISTINCT principal FROM operations").all() as { principal: string }[]).map((p) => p.principal);
    expect(principals.every((p) => p === "user:local" || p.startsWith("system:") || p.startsWith("agent:") || p.startsWith("run:"))).toBe(true);
    // M05: no live policy, no unfinished run, no live grant
    expect((db.prepare("SELECT COUNT(*) AS n FROM maintenance_policies WHERE state IN ('enabled','syncing','pending_approval')").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running','blocked')").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM service_grants WHERE revoked_at IS NULL").get() as { n: number }).n).toBe(0);
    db.close();
    // files: 0600/0700, no links
    for (const f of ["os.sqlite", "agent.sqlite"]) expect(fs.statSync(path.join(target, f)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
    expect(contentFacts(path.join(target, "os.sqlite"))).toEqual(r.after);
  });

  it("M07: a second import of the same storeUUID is refused and leaves nothing", () => {
    const src = copyBackup();
    const first = path.join(tmpDir("agentos-v1ws-"), "data");
    const r = importV04({ backupDir: src, targetDataDir: first, workspaceId: WS, ownerUserId: OWNER, registeredStoreUUIDs: [] });
    const second = path.join(tmpDir("agentos-v1ws-"), "data");
    expect(() => importV04({ backupDir: src, targetDataDir: second, workspaceId: "55555555-5555-4555-8555-555555555555", ownerUserId: OWNER, registeredStoreUUIDs: [r.storeUUID] })).toThrow(/already has a writable workspace/);
    expect(fs.existsSync(second)).toBe(false);
    expect(fs.existsSync(`${second}.import-staging`)).toBe(false);
  });

  it("M07: a damaged backup or a failure at any step only affects staging", () => {
    for (const fault of ["copy", "migrate", "facts"] as const) {
      const src = copyBackup();
      const pristine = treeHash(src);
      const target = path.join(tmpDir("agentos-v1ws-"), "data");
      expect(() => importV04({ backupDir: src, targetDataDir: target, workspaceId: WS, ownerUserId: OWNER, registeredStoreUUIDs: [], failAfter: fault })).toThrow(/fault/);
      expect(fs.existsSync(target)).toBe(false);
      expect(fs.existsSync(`${target}.import-staging`)).toBe(false);
      expect(treeHash(src)).toBe(pristine);
      // and a retry succeeds
      expect(importV04({ backupDir: src, targetDataDir: target, workspaceId: WS, ownerUserId: OWNER, registeredStoreUUIDs: [] }).identical).toBe(true);
    }
    const bad = copyBackup();
    const db = new DatabaseSync(path.join(bad, "os.sqlite"));
    db.exec("UPDATE records SET data_json = '{\"title\":\"tampered\"}'");
    db.close();
    const t = path.join(tmpDir("agentos-v1ws-"), "data");
    expect(() => importV04({ backupDir: bad, targetDataDir: t, workspaceId: WS, ownerUserId: OWNER, registeredStoreUUIDs: [] })).toThrow(/does not match the manifest/);
    expect(fs.existsSync(t) || fs.existsSync(`${t}.import-staging`)).toBe(false);
  });

  it("M08: the imported schema 5 file is refused by the v0.4 schema rule (newer than supported)", async () => {
    const src = copyBackup();
    const target = path.join(tmpDir("agentos-v1ws-"), "data");
    importV04({ backupDir: src, targetDataDir: target, workspaceId: WS, ownerUserId: OWNER, registeredStoreUUIDs: [] });
    const v04 = process.env.AGENTOS_V04_TREE;
    if (!v04) return;
    const core = await import(path.join(v04, "packages/core/dist/index.js"));
    expect(() => core.openCore(path.join(target, "os.sqlite"))).toThrow();
  });
});
