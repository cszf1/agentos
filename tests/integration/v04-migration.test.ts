/**
 * V4-B07 data migration constraints (spec §21.1, §3.3): a v0.3-format os.sqlite is upgraded by the formal structural
 * migration: the single-slot unique index goes, target_app_id becomes nullable, the new modes/origins are allowed by
 * CHECK, every row, index and trigger survives, and an unfinished v0.3 run refuses the upgrade without touching the
 * store. Real node:sqlite files and the real Store; no mocks.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, openCore } from "@agentos/core";
import { tmpDir } from "../helpers.js";

const V04_INDEX = MIGRATIONS.findIndex((m) => typeof m !== "string" && m.rebuild.some((r) => r.table === "runs" && r.dropIndexes?.includes("runs_single_active")));

/** Build a store exactly at the last v0.3 schema version (everything before the v0.4 structural migration). */
function v03Store(dir: string, unfinished: boolean): string {
  const file = path.join(dir, "os.sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const now = new Date().toISOString();
  for (let v = 1; v <= V04_INDEX; v++) {
    const m = MIGRATIONS[v - 1]!;
    expect(typeof m).toBe("string");
    db.exec(m as string);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v, now);
    if (v === 1) db.prepare("INSERT INTO meta (id, schema_version, store_uuid, client_epoch, agent_binding_state, created_at) VALUES (1, 1, ?, 1, 'pending', ?)").run("11111111-2222-4333-8444-555555555555", now);
    else db.prepare("UPDATE meta SET schema_version = ? WHERE id = 1").run(v);
  }
  // a v0.3 app and a finished (or unfinished) v0.3 run on it
  const runCols = (db.prepare("PRAGMA table_info(runs)").all() as { name: string; notnull: number; dflt_value: unknown }[]);
  db.prepare("INSERT INTO apps (id, active_revision_id, epoch, contract_json, created_at, updated_at) VALUES ('app-1', NULL, 0, '{}', ?, ?)").run(now, now);
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare(
    `INSERT INTO runs (id, request_key, request_hash, target_app_id, expected_app_epoch, intent, frozen_submit_json, submit_hash, status, dispatch_state, deadline_at, created_at, updated_at)
     VALUES ('run-1', 'rk-1', 'h', 'app-1', 0, 'v0.3 run', '{}', 's', ?, 'submitted', ?, ?, ?)`,
  ).run(unfinished ? "running" : "succeeded", now, now, now);
  void runCols;
  db.close();
  return file;
}

describe("V4-B07 v0.3 → v0.4 structural migration", () => {
  it("drops the single-slot index, makes target nullable, widens CHECKs, keeps rows/indexes/triggers", () => {
    expect(V04_INDEX).toBeGreaterThan(0);
    const dir = tmpDir("agentos-mig-");
    const file = v03Store(dir, false);
    const before = new DatabaseSync(file, { readOnly: true });
    expect(before.prepare("SELECT name FROM sqlite_master WHERE name = 'runs_single_active'").get()).toBeTruthy();
    const triggersBefore = (before.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'runs'").all() as { name: string }[]).map((t) => t.name).sort();
    before.close();

    const core = openCore(file);
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'runs_single_active'").get()).toBeUndefined();
      const target = (db.prepare("PRAGMA table_info(runs)").all() as { name: string; notnull: number }[]).find((c) => c.name === "target_app_id")!;
      expect(target.notnull).toBe(0);
      const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'runs'").get() as { sql: string }).sql;
      expect(sql).toContain("'maintenance_refactor'");
      expect((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'deployments'").get() as { sql: string }).sql).toContain("'proposal_accept'");
      // every v0.3 row and trigger is still there; the identity trigger still freezes old rows
      expect(db.prepare("SELECT id, status, target_app_id FROM runs").all()).toEqual([{ id: "run-1", status: "succeeded", target_app_id: "app-1" }]);
      const triggersAfter = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'runs'").all() as { name: string }[]).map((t) => t.name);
      for (const t of triggersBefore) expect(triggersAfter).toContain(t);
      expect((db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length).toBe(0);
      expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: MIGRATIONS.length });
      db.close();
      expect(() => core.store.run("UPDATE runs SET target_app_id = NULL WHERE id = 'run-1'")).toThrow(/frozen/);
      // a run without a target app is a real NULL, never a hidden placeholder app
      expect(core.store.all("SELECT id FROM apps")).toEqual([{ id: "app-1" }]);
    } finally {
      core.store.close();
    }
  });

  it("an unfinished v0.3 run refuses the upgrade and leaves the store at its v0.3 version", () => {
    const dir = tmpDir("agentos-mig-");
    const file = v03Store(dir, true);
    const size = fs.statSync(file).size;
    expect(() => openCore(file)).toThrow(/unfinished v0.3 run/);
    const db = new DatabaseSync(file, { readOnly: true });
    expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: V04_INDEX });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'runs_single_active'").get()).toBeTruthy();
    expect(db.prepare("SELECT status FROM runs").get()).toEqual({ status: "running" });
    db.close();
    expect(fs.statSync(file).size).toBeGreaterThan(0);
    void size;
  });
});
