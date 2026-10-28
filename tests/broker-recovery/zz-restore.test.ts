import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { Client, ROOT, seedFixtures, startHost, stopHost, type HostProc } from "../proc.js";
import { Broker, hasBroker, installed, storeUUID, sudo, systemctl, waitBroker, waitUntil } from "../v03.js";

/**
 * V3-O02..O06 (spec §23): coordinated cold backup with the real broker, restore with a new workspace incarnation, no
 * replay of the old outbox, effects after the backup stay visible, restore interruption, broker reinstall.
 * Uses the real host process (bin/agentos-host), bin/agentos-admin and the installed broker.
 */
const run = hasBroker() ? describe : describe.skip;

function admin(dataDir: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(path.join(ROOT, "bin", "agentos-admin"), args, { env: { ...process.env, NODE_ENV: "test", AGENTOS_DATA_DIR: dataDir, ...env }, encoding: "utf8", timeout: 240_000 });
  const last = (r.stdout.trim().split("\n").pop() ?? "") || (r.stderr.trim().split("\n").pop() ?? "");
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(last);
  } catch {
    /* killed */
  }
  return { status: r.status, signal: r.signal, json, out: r.stdout + r.stderr };
}

run("coordinated backup / restore with the broker", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-o-"));
  const bdir = path.join(os.tmpdir(), `aos-bk-${randomBytes(4).toString("hex")}`);
  const managed = installed()!.managedRoots.find((m) => m.storeUuid === storeUUID())!.path;
  let host: HostProc | null = null;
  let c: Client;
  let mr = "";
  const start = async () => {
    host = await startHost(dataDir, { AGENTOS_RUNTIME: "off" });
    c = new Client(host);
    await c.login(dataDir);
    await waitUntil(() => c.get("/api/state"), (s) => s.data?.brokerReady === true, 20_000, 200);
  };
  const stop = async () => {
    if (host) await stopHost(host);
    host = null;
  };
  /** A system_plan run (faux) that freezes a file write; returns the prepared action. */
  const planFile = async (name: string) => {
    const r = await c.req("POST", "/api/runs", { intent: `写入 ${name}`, targetAppId: null, mode: "system_plan", resourceIds: [mr], capabilityScopes: ["file.write_text_atomic"] });
    expect(r.status, JSON.stringify(r.error)).toBe(202);
    const done = await c.waitRun(r.data.runId, 60_000);
    expect(String(done.preparedActionId), JSON.stringify(done)).toMatch(/^sa_/);
    return (await c.get(`/api/system-actions/${done.preparedActionId}`)).data;
  };
  const brokerOps = async (actionId: string) => {
    const b = await new Broker().open();
    try {
      const h = await b.client.historySync(b.identity.machineInstallId, 0, 500);
      return h.operations.filter((o) => o.actionId === actionId);
    } finally {
      b.close();
    }
  };

  beforeAll(async () => {
    await seedFixtures(dataDir, ["todo-v1.json"]);
    // Use the store UUID registered in the root policy for this host user.
    const db = new DatabaseSync(path.join(dataDir, "os.sqlite"));
    db.prepare("UPDATE meta SET store_uuid = ? WHERE id = 1").run(storeUUID());
    db.close();
    await start();
    mr = ((await c.get("/api/system-resources")).data.items as { resourceId: string; kind: string }[]).find((r) => r.kind === "managed-root")!.resourceId;
  }, 120_000);
  afterAll(async () => {
    await stop();
    systemctl("start", "agentos-broker.service");
  });

  let readyAction: { actionId: string; planHash: string } | null = null;
  const nameReady = `o03-${randomBytes(3).toString("hex")}.txt`;
  const nameAfter = `o05-${randomBytes(3).toString("hex")}.txt`;

  it("V3-O02 backup quiesces the broker, syncs results, records the checkpoint, and resumes afterwards", async () => {
    const a = await planFile(nameReady);
    // Confirm while the broker is down: the plan is approved but cannot be delivered (stays in the outbox).
    systemctl("stop", "agentos-broker.service");
    const conf = await c.req("POST", `/api/system-actions/${a.actionId}/confirm`, { planHash: a.planHash });
    expect(conf.status, JSON.stringify(conf.error)).toBe(202);
    expect(["granting", "executing"]).toContain(conf.data.phase);
    readyAction = { actionId: a.actionId, planHash: a.planHash };
    await stop();
    systemctl("start", "agentos-broker.service");
    await waitBroker();
    const r = admin(dataDir, ["backup", "--output", bdir]);
    expect(r.status, r.out).toBe(0);
    const m = JSON.parse(fs.readFileSync(path.join(bdir, "manifest.json"), "utf8"));
    expect(m.complete).toBe(true);
    expect(m.v03.brokerAvailable).toBe(true);
    expect(m.v03.checkpoint).toMatchObject({ machineInstallId: installed()!.machineInstallId });
    expect(m.v03.checkpoint.seq).toBeGreaterThan(0);
    expect(m.v03.providerCatalogHash).toMatch(/^sha256:/);
    expect(fs.existsSync(path.join(bdir, "system", "audit.json"))).toBe(true);
    expect(Object.keys(m.files)).toContain("system/audit.json");
    // broker.sqlite is never part of a workspace backup
    expect(fs.readdirSync(bdir).some((f) => f.startsWith("broker"))).toBe(false);
    // the quiesce ended (workspace active again)
    const b = await new Broker().open();
    const h = await b.client.handshake({ machineInstallId: b.identity.machineInstallId, workspaceIncarnation: b.identity.workspaceIncarnation });
    expect(h.workspaceState).toBe("active");
    b.close();
  });

  it("V3-O05 effects after the backup happen once and stay visible after restoring the older workspace", async () => {
    await start();
    // the outbox now delivers the approved action (after the backup)
    const done = await waitUntil(() => c.get(`/api/system-actions/${readyAction!.actionId}`), (r) => r.data?.phase === "done", 30_000, 300);
    expect(done.data.effectCertainty).toBe("verified");
    expect(fs.existsSync(path.join(managed, nameReady))).toBe(true);
    // and a second, unrelated action that the backup knows nothing about
    const a2 = await planFile(nameAfter);
    await c.req("POST", `/api/system-actions/${a2.actionId}/confirm`, { planHash: a2.planHash });
    await waitUntil(() => c.get(`/api/system-actions/${a2.actionId}`), (r) => r.data?.phase === "done", 30_000, 300);
    await stop();
    const r = admin(dataDir, ["restore", "--backup", bdir]);
    expect(r.status, r.out).toBe(0);
    await start();
    const ops = await c.get("/api/system-operations");
    expect(ops.data.brokerOnly.some((o: { actionId?: string; capabilityId: string; state: string }) => o.state === "succeeded" && o.capabilityId === "file.write_text_atomic")).toBe(true);
    expect(fs.existsSync(path.join(managed, nameAfter))).toBe(true); // restore does not roll the file back
  });

  it("V3-O03 the restored ready request is fenced: no second execution, the action shows the broker's fact", async () => {
    await new Promise((r) => setTimeout(r, 3000)); // give a (wrong) replay every chance
    const ops = await brokerOps(readyAction!.actionId);
    expect(ops).toHaveLength(1);
    const a = (await c.get(`/api/system-actions/${readyAction!.actionId}`)).data;
    expect(["done", "no_effect"]).toContain(a.phase);
    if (a.phase === "done") expect(a.evidenceKind).not.toBeNull();
    // old confirmation cannot be replayed
    // re-confirming the old plan only answers its recorded state; it never executes again
    await c.req("POST", `/api/system-actions/${readyAction!.actionId}/confirm`, { planHash: readyAction!.planHash });
    await new Promise((r) => setTimeout(r, 2000));
    expect(await brokerOps(readyAction!.actionId)).toHaveLength(1);
    expect((await c.get(`/api/system-actions/${readyAction!.actionId}`)).data.phase).toBe(a.phase);
    // provider grants are void after a restore
    const gs = (await c.get("/api/provider-grants")).data.items as { state: string; principal: { kind: string } }[];
    expect(gs.filter((g) => g.principal.kind === "app" && g.state === "active")).toEqual([]);
  });

  it("V3-O04 an interrupted restore keeps writes closed and completes idempotently with the same incarnation step", async () => {
    await stop();
    const b0 = await new Broker().open();
    const inc0 = b0.identity.workspaceIncarnation;
    b0.close();
    const r1 = admin(dataDir, ["restore", "--backup", bdir], { AGENTOS_FAULTS: "1", AGENTOS_FAULT_POINT: "restore.after_first_replace" });
    expect(r1.status === 0).toBe(false);
    // the host refuses to open normally while the restore is unfinished
    const h = await startHost(dataDir, { AGENTOS_RUNTIME: "off" }, { waitReady: false });
    const code = await Promise.race([h.exit, new Promise<string>((r) => setTimeout(() => r("running"), 8000))]);
    if (code === "running") {
      const cc = new Client(h);
      await cc.login(dataDir).catch(() => undefined);
      const st = await cc.get("/api/state");
      expect(st.data?.ready ?? false).toBe(false);
      await stopHost(h);
    }
    const r2 = admin(dataDir, ["restore", "--backup", bdir]);
    expect(r2.status, r2.out).toBe(0);
    const b1 = await new Broker().open();
    expect(b1.identity.workspaceIncarnation).toBe(inc0 + 1);
    b1.close();
    await start();
  });

  it("V3-O06 a reinstalled broker log (new machineInstallId) voids old plans and keeps system writes off", async () => {
    const pending = await planFile(`o06-${randomBytes(3).toString("hex")}.txt`);
    await stop();
    const oldId = installed()!.machineInstallId;
    sudo(["bash", path.join(ROOT, "deploy", "v0.3", "agentos-system-admin"), "reinstall-log", "--yes"]);
    await waitBroker();
    expect(installed()!.machineInstallId).not.toBe(oldId);
    host = await startHost(dataDir, { AGENTOS_RUNTIME: "off" });
    c = new Client(host);
    await c.login(dataDir);
    const st = (await c.get("/api/state")).data;
    expect(st.brokerReady).toBe(false);
    expect(JSON.stringify(st.system ?? {})).toMatch(/mismatch|not the one/);
    const conf = await c.req("POST", `/api/system-actions/${pending.actionId}/confirm`, { planHash: pending.planHash });
    expect(conf.status).toBeGreaterThanOrEqual(400);
    expect(conf.error?.code ?? "").toMatch(/BROKER_IDENTITY_MISMATCH|BROKER_UNAVAILABLE|PLAN_EXPIRED|WORKSPACE_FENCED/);
    // An explicit administrator rebind adopts the new install; the old plan stays void and is never executed.
    await stop();
    const rb = admin(dataDir, ["rebind-broker", "--confirm-new-install"]);
    expect(rb.status, rb.out).toBe(0);
    await start();
    const old = (await c.get(`/api/system-actions/${pending.actionId}`)).data;
    expect(old.phase).toBe("no_effect");
    expect((await brokerOps(pending.actionId))).toHaveLength(0);
    // resources of the retired install are gone; the new install's ids are used from now on
    mr = ((await c.get("/api/system-resources")).data.items as { resourceId: string; kind: string; status: string }[]).find((r) => r.kind === "managed-root" && r.status === "available")!.resourceId;
    const fresh = await planFile(`o06b-${randomBytes(3).toString("hex")}.txt`);
    await c.req("POST", `/api/system-actions/${fresh.actionId}/confirm`, { planHash: fresh.planHash });
    expect((await waitUntil(() => c.get(`/api/system-actions/${fresh.actionId}`), (r) => ["done", "no_effect", "unknown"].includes(r.data?.phase), 30_000, 300)).data.phase).toBe("done");
  });
});
