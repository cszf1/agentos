import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { Client, seedFixtures, startHost, stopHost, type HostProc } from "../proc.js";
import { Broker, hasBroker, installed, storeUUID, waitUntil } from "../v03.js";
import { historyAll } from "../../packages/host/src/backup-v3.js";

/**
 * V3-R02 / R03 / R06 on the HOST side: the real host process is SIGKILLed at fixed points around the system outbox
 * (spec §17.2). After a restart the same frozen envelope is delivered with the same identity, exactly once.
 */
const run = hasBroker() ? describe : describe.skip;

run("host crashes around the system outbox", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-hc-"));
  const managed = installed()!.managedRoots.find((m) => m.storeUuid === storeUUID())!.path;
  let host: HostProc | null = null;
  let c: Client;
  let mr = "";
  const start = async (env: Record<string, string> = {}) => {
    host = await startHost(dataDir, { AGENTOS_RUNTIME: "off", ...env });
    c = new Client(host);
    await c.login(dataDir);
    await waitUntil(() => c.get("/api/state"), (s) => s.data?.brokerReady === true, 20_000, 200);
  };
  const planFile = async (name: string) => {
    const r = await c.req("POST", "/api/runs", { intent: `写入 ${name}`, targetAppId: null, mode: "system_plan", resourceIds: [mr], capabilityScopes: ["file.write_text_atomic"] });
    const done = await c.waitRun(r.data.runId, 60_000);
    expect(String(done.preparedActionId), JSON.stringify(done)).toMatch(/^sa_/);
    return (await c.get(`/api/system-actions/${done.preparedActionId}`)).data as { actionId: string; planHash: string };
  };
  const opsOf = async (actionId: string) => {
    const b = await new Broker().open();
    try {
      return (await historyAll(b.client, b.identity.machineInstallId)).ops.filter((o) => o.actionId === actionId);
    } finally {
      b.close();
    }
  };

  beforeAll(async () => {
    await seedFixtures(dataDir, ["todo-v1.json"]);
    const db = new DatabaseSync(path.join(dataDir, "os.sqlite"));
    db.prepare("UPDATE meta SET store_uuid = ? WHERE id = 1").run(storeUUID());
    db.close();
    await start();
    mr = ((await c.get("/api/system-resources")).data.items as { resourceId: string; kind: string; status: string }[]).find((r) => r.kind === "managed-root" && r.status === "available")!.resourceId;
  }, 120_000);
  afterAll(async () => {
    if (host) await stopHost(host);
  });

  for (const point of ["system.after_outbox_commit", "system.before_submit", "system.after_submit_before_record", "system.after_result_projection"]) {
    it(`V3-R02/R03/R06 kill at ${point}: one execution with the original identity after restart`, async () => {
      const name = `hc-${point.replace(/\W/g, "")}-${randomBytes(3).toString("hex")}.txt`;
      const a = await planFile(name);
      await stopHost(host!);
      await start({ AGENTOS_FAULTS: "1", AGENTOS_FAULT_POINT: point });
      const conf = await c.req("POST", `/api/system-actions/${a.actionId}/confirm`, { planHash: a.planHash }).catch(() => ({ status: 0 }));
      expect([0, 202]).toContain(conf.status);
      await waitUntil(() => host!.proc.exitCode !== null || host!.proc.signalCode !== null, (x) => x, 30_000, 100);
      await start();
      const f = await waitUntil(() => c.get(`/api/system-actions/${a.actionId}`), (r) => ["done", "no_effect", "unknown"].includes(r.data?.phase), 40_000, 300);
      expect(f.data.phase, JSON.stringify(f.data)).toBe("done");
      const ops = await opsOf(a.actionId);
      expect(ops).toHaveLength(1);
      expect(f.data.operationId).toBe(ops[0]!.operationId);
      expect(fs.existsSync(path.join(managed, name))).toBe(true);
    });
  }

  it("V3-G06 broker lost: revoke blocks at once on the host, shows 'revoking', and is confirmed by the broker later", async () => {
    // a run-read grant is enough to see the host-side behavior: revoke it while the broker is down
    const gs = (await c.get("/api/provider-grants")).data.items as { grantId: string; state: string; principal: { kind: string } }[];
    const g = gs.find((x) => x.state === "active" && x.principal.kind !== "app");
    if (!g) return;
    const { systemctl } = await import("../v03.js");
    systemctl("stop", "agentos-broker.service");
    try {
      const r = await c.req("POST", `/api/provider-grants/${g.grantId}/revoke`, {});
      expect(r.status).toBe(202);
      const v = ((await c.get("/api/provider-grants")).data.items as { grantId: string; state: string; revocationConfirmed: boolean }[]).find((x) => x.grantId === g.grantId)!;
      expect(v.state).toBe("revoking");
      expect(v.revocationConfirmed).toBe(false);
      const st = (await c.get("/api/state")).data;
      expect(st.brokerReady).toBe(false);
    } finally {
      systemctl("start", "agentos-broker.service");
    }
    const done = await waitUntil(async () => ((await c.get("/api/provider-grants")).data.items as { grantId: string; state: string }[]).find((x) => x.grantId === g.grantId)!.state, (s) => s === "revoked", 40_000, 500);
    expect(done).toBe("revoked");
  });
});
