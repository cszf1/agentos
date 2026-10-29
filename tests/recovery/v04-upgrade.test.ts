/**
 * V4-B02 a real v0.3 workspace (made by the real v0.3 host build, scripts/make-v03-workspace.mjs) opens on v0.4:
 * apps, revisions (hashes), records, receipts and run history are unchanged; the pairing with agent.sqlite holds; the
 * schema moves forward once; a new v0.4 task and the code app's runtime work afterwards. AGENTOS_V03_WORKSPACE points
 * at the stopped v0.3 data directory (copied, never modified).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client, startHost, stopHost, type HostProc } from "../proc.js";

const SRC = process.env.AGENTOS_V03_WORKSPACE;
const d = SRC && fs.existsSync(path.join(SRC, "os.sqlite")) ? describe : describe.skip;

function facts(dir: string) {
  const db = new DatabaseSync(path.join(dir, "os.sqlite"), { readOnly: true });
  try {
    return {
      schema: (db.prepare("SELECT schema_version AS v FROM meta WHERE id = 1").get() as { v: number }).v,
      store: (db.prepare("SELECT store_uuid AS s FROM meta WHERE id = 1").get() as { s: string }).s,
      apps: db.prepare("SELECT id, active_revision_id, epoch, contract_json FROM apps ORDER BY id").all(),
      revisions: db.prepare("SELECT app_id, id, bundle_json FROM revisions ORDER BY app_id, id").all(),
      records: db.prepare("SELECT app_id, id, version, data_json FROM records ORDER BY app_id, id").all(),
      runs: db.prepare("SELECT id, status, target_app_id, applied_revision_id, request_key FROM runs ORDER BY id").all(),
      operations: db.prepare("SELECT COUNT(*) AS n FROM operations").get(),
      deployments: db.prepare("SELECT id, status, origin, target_revision_id FROM deployments ORDER BY id").all(),
    };
  } finally {
    db.close();
  }
}

d("V4-B02 real v0.3 workspace upgrade", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-up4-"));
  let host: HostProc | null = null;
  let before: ReturnType<typeof facts>;
  beforeAll(() => {
    fs.cpSync(SRC!, dir, { recursive: true, filter: (p) => !p.endsWith("host.lock") });
    before = facts(dir);
  });
  afterAll(async () => {
    if (host) {
      if (host.proc.exitCode !== null || host.proc.signalCode !== null) console.log("HOST EXITED", host.proc.exitCode, host.proc.signalCode, host.logs.join("").slice(-4000));
      await stopHost(host).catch(() => undefined);
    }
  });

  it("opens unchanged, migrates once, keeps the pair, and runs v0.4 work", async () => {
    expect(before.apps.length).toBeGreaterThanOrEqual(2);
    host = await startHost(dir, { AGENTOS_MODEL_MODE: "faux" });
    const c = new Client(host);
    await c.login(dir);
    const after = facts(dir);
    expect(after.schema).toBeGreaterThan(before.schema);
    expect(after.store).toBe(before.store);
    expect(after.apps).toEqual(before.apps);
    expect(after.revisions).toEqual(before.revisions);
    expect(after.records).toEqual(before.records);
    expect(after.runs).toEqual(before.runs);
    expect(after.operations).toEqual(before.operations);
    expect(after.deployments).toEqual(before.deployments);
    const st = await c.get("/api/state");
    expect(st.status).toBe(200);
    expect(st.data.apps.length).toBe(before.apps.length);
    // the old run history and its transcripts are readable
    for (const r of before.runs as { id: string }[]) expect((await c.get(`/api/runs/${r.id}`)).status).toBe(200);
    // a new v0.4 task runs in its own conversation
    const todo = (before.apps as { id: string; epoch: number }[])[0]!;
    const app = await c.get(`/api/apps/${todo.id}`);
    const r = await c.req("POST", "/api/runs", { intent: "增加备注", targetAppId: todo.id, expectedAppEpoch: app.data.appEpoch });
    expect(r.status, JSON.stringify(r)).toBe(202);
    const fin = await c.waitRun(r.data.runId, 240_000);
    expect(fin.status).toBe("succeeded");
    const tr = await c.get(`/api/runs/${r.data.runId}/transcript`);
    expect(tr.data.conversationId).toBeTruthy();
    // every code app's runtime comes back ready
    for (const a of before.apps as { id: string }[]) {
      const rt = await c.get(`/api/apps/${a.id}/runtime`);
      if (rt.status === 200 && rt.data?.health !== undefined && rt.data.health !== "none") {
        const until = Date.now() + 120_000;
        let h = rt.data.health;
        while (h !== "ready" && Date.now() < until) {
          await new Promise((res) => setTimeout(res, 1000));
          h = (await c.get(`/api/apps/${a.id}/runtime`)).data?.health;
        }
        expect(h).toBe("ready");
      }
    }
  }, 600_000);
});
