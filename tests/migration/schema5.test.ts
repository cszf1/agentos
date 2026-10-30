import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { bundleHash } from "@agentos/contracts";
import { MIGRATIONS, bindLegacyPrincipal, openCore } from "@agentos/core";
import { fixture, tmpDir } from "../helpers.js";

const V1_HASH = "sha256:428df8c73bfcf3a1bc07029d9b5e31286728c4026d4cfe4a203fbc87211332d5";
const RECEIPT = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OWNER = "22222222-2222-4222-8222-222222222222";
const WS = "44444444-4444-4444-8444-444444444444";

describe("schema 5 migration", () => {
  it("keeps a v0.3 operation receipt and the v0.1 bundle hash", () => {
    expect(bundleHash(fixture("todo-v1.json"))).toBe(V1_HASH);
    const dir = tmpDir("agentos-schema5-");
    const file = path.join(dir, "os.sqlite");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys = ON; CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const now = new Date().toISOString();
    const v04 = MIGRATIONS.findIndex((m) => typeof m !== "string");
    expect(v04).toBeGreaterThan(0);
    for (let v = 1; v <= v04; v++) {
      const m = MIGRATIONS[v - 1]!;
      expect(typeof m).toBe("string");
      db.exec(m as string);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v, now);
      if (v === 1) db.prepare("INSERT INTO meta (id, schema_version, store_uuid, client_epoch, agent_binding_state, created_at) VALUES (1, 1, ?, 1, 'pending', ?)").run("11111111-2222-4333-8444-555555555555", now);
      else db.prepare("UPDATE meta SET schema_version = ? WHERE id = 1").run(v);
    }
    db.prepare("INSERT INTO operations (principal, operation_key, request_hash, status_code, result_json, created_at) VALUES ('user:local', 'legacy-key', ?, 200, '{\"ok\":true}', ?)").run(RECEIPT, now);
    db.close();

    const core = openCore(file);
    try {
      expect(core.store.schemaVersion).toBe(5);
      const receipt = core.store.get<{ principal: string; request_hash: string }>("SELECT principal, request_hash FROM operations WHERE operation_key = 'legacy-key'");
      expect(receipt).toEqual({ principal: "user:local", request_hash: RECEIPT });
      const cols = (core.store.all("PRAGMA table_info(runs)") as { name: string }[]).map((c) => c.name);
      expect(cols).toContain("initiator_user_id");
      expect(cols).toContain("member_version");
      expect(cols).toContain("scope_hash");
      bindLegacyPrincipal(core.store, OWNER, WS);
      expect(core.store.get("SELECT principal, request_hash FROM operations WHERE operation_key = 'legacy-key'")).toEqual({ principal: "user:local", request_hash: RECEIPT });
      expect(core.store.get("SELECT owner_user_id, workspace_id FROM legacy_principals WHERE legacy_key = 'user:local'")).toEqual({ owner_user_id: OWNER, workspace_id: WS });
    } finally {
      core.store.close();
    }
    expect(fs.existsSync(file)).toBe(true);
  });
});