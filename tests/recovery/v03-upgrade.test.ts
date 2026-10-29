import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Client, ROOT, startHost, stopHost, type HostProc } from "../proc.js";

/**
 * V3-O01 real v0.2 upgrade: a COPY of an actual v0.2 workspace (AGENTOS_UPGRADE_SOURCE, taken while its host was
 * stopped) is opened by the v0.3 host. Apps, revisions, records, epochs and service grants are unchanged; old apps
 * gain no system capability; an old code app still runs on its frozen ABI-1 lock.
 */
const SRC = process.env.AGENTOS_UPGRADE_SOURCE;
const run = SRC && fs.existsSync(path.join(SRC, "os.sqlite")) ? describe : describe.skip;

type Facts = { apps: unknown[]; revisions: unknown[]; records: unknown[]; grants: unknown[]; schema: number };
function facts(dir: string): Facts {
  const db = new DatabaseSync(path.join(dir, "os.sqlite"), { readOnly: true });
  try {
    const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t);
    return {
      schema: (db.prepare("SELECT schema_version AS v FROM meta WHERE id = 1").get() as { v: number }).v,
      apps: db.prepare("SELECT id, active_revision_id, epoch, contract_json FROM apps ORDER BY id").all(),
      revisions: db.prepare("SELECT app_id, id FROM revisions ORDER BY app_id, id").all(),
      records: db.prepare("SELECT app_id, id, version, data_json FROM records ORDER BY app_id, id").all(),
      grants: has("service_grants") ? db.prepare("SELECT * FROM service_grants ORDER BY id").all() : [],
    };
  } finally {
    db.close();
  }
}

run("V3-O01 a real v0.2 workspace opens on v0.3 unchanged", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-up-"));
  let host: HostProc | null = null;
  let before: Facts;
  beforeAll(() => {
    fs.cpSync(SRC!, dir, { recursive: true, filter: (p) => !p.endsWith("host.lock") });
    before = facts(dir);
  });
  afterAll(async () => {
    if (host) await stopHost(host);
  });

  it("migrates forward only additively; every v0.2 fact is preserved and old apps have no system bindings", async () => {
    host = await startHost(dir, {});
    const c = new Client(host);
    await c.login(dir);
    const st = (await c.get("/api/state")).data;
    // the current host (v0.4) opens the real v0.2 workspace directly: v0.2 → v0.4 migrations in one start
    expect(st.hostVersion).toBe("0.4.0");
    expect(st.ready).toBe(true);
    const after = facts(dir);
    expect(after.schema).toBeGreaterThan(before.schema);
    expect(after.apps).toEqual(before.apps);
    expect(after.revisions).toEqual(before.revisions);
    expect(after.records).toEqual(before.records);
    expect(after.grants).toEqual(before.grants);
    for (const a of st.apps as { appId: string; runtime: string }[]) {
      expect(a.runtime).not.toBe("isolated-code-v2");
      expect((await c.get(`/api/apps/${a.appId}/system-bindings`)).data.items).toEqual([]);
    }
    const code = (st.apps as { appId: string; runtime: string; appEpoch: number }[]).find((a) => a.runtime === "isolated-code-v1");
    if (code) {
      for (let i = 0; i < 180; i++) {
        if ((await c.get(`/api/apps/${code.appId}/runtime`)).data?.health === "ready") break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const q = await c.req("POST", `/api/apps/${code.appId}/queries/main`, { expectedAppEpoch: code.appEpoch, input: {} });
      expect(q.status, JSON.stringify(q.error)).toBe(200);
    }
  }, 300_000);
});

describe("V3-C07 new runtime profiles never rewrite old locks", () => {
  it("every lock of the released v0.2 catalog is byte-identical in the v0.3 catalog", () => {
    // fixtures/v0.2/catalog-v0.2.json = `git show 79377eb:runtime/catalog/catalog.json` (the released v0.2 catalog)
    const old = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "v0.2", "catalog-v0.2.json"), "utf8")) as { locks: { id: string }[] };
    const now = JSON.parse(fs.readFileSync(path.join(ROOT, "runtime", "catalog", "catalog.json"), "utf8")) as { locks: { id: string; abiVersion: number }[] };
    for (const l of old.locks) expect(JSON.stringify(now.locks.find((x) => x.id === l.id))).toBe(JSON.stringify(l));
    expect(now.locks.filter((l) => l.abiVersion === 2).map((l) => l.id).sort()).toEqual(["core-v2@1", "data-v2@1"]);
  });
});
