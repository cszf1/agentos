import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Client, seedFixtures, startHost, stopHost, type HostProc } from "../proc.js";
import { Broker, hasBroker, installed, storeUUID, sudo, unitActive, waitUntil } from "../v03.js";
import { historyAll } from "../../packages/host/src/backup-v3.js";

/**
 * V4-H06 / V4-R03 on the real host + real broker: the user enables a bounded "keep running" policy for the demo unit
 * through the HTTP API, the broker confirms it (POLICY_SYNC_PENDING until then), the unit is stopped outside AgentOS,
 * a check runs, and the host process is SIGKILLed at a fixed point around the maintenance submit. After a restart the
 * same frozen envelope is found (or delivered once), the unit runs again and the broker holds exactly one operation for
 * the job. One admission per run (the template's minimum cooldown is 600 s): MAINT_KILL_POINT selects the point.
 */
const caps = () => (installed() as unknown as { maintenance?: unknown[] } | null)?.maintenance ?? [];
const run = hasBroker() && caps().length > 0 ? describe : describe.skip;
const POINT = process.env.MAINT_KILL_POINT ?? "maintenance.service.after_submit_before_record";
// the test-install second demo unit: its recovery history is independent of the protocol-2 suite (3/24 h caps)
const DEMO = "agentos-demo2.service";

run("host maintenance: keep a registered unit running through broker protocol 2", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-hm-"));
  let host: HostProc | null = null;
  let c: Client;
  const start = async (env: Record<string, string> = {}) => {
    host = await startHost(dataDir, { AGENTOS_RUNTIME: "off", ...env });
    c = new Client(host);
    await c.login(dataDir);
    await waitUntil(() => c.get("/api/state"), (s) => s.data?.brokerReady === true, 20_000, 200);
  };

  beforeAll(async () => {
    await seedFixtures(dataDir, ["todo-v1.json"]);
    const db = new DatabaseSync(path.join(dataDir, "os.sqlite"));
    db.prepare("UPDATE meta SET store_uuid = ? WHERE id = 1").run(storeUUID());
    db.close();
    await start();
  }, 120_000);
  afterAll(async () => {
    if (host) await stopHost(host);
    if (unitActive(DEMO) !== "active") sudo(["systemctl", "start", DEMO]);
  });

  it(`V4-H06/R03 policy sync, real recovery, and a host kill at ${POINT}: one broker operation, unit running`, async () => {
    const res = ((await c.get("/api/system-resources")).data.items as { resourceId: string; kind: string; status: string }[]).find((r) => r.kind === "service" && r.status === "available" && /2/.test((r as unknown as { displayName?: string }).displayName ?? ""));
    expect(res, "demo service resource").toBeTruthy();
    // maintenance on, and confirmed by the broker
    await c.req("POST", "/api/maintenance/control", { action: "resume" });
    await waitUntil(() => c.get("/api/maintenance/state"), (s) => s.data?.root === "synced" && s.data?.state === "running", 30_000, 300);
    // the user enables a policy: the broker must confirm it before it is usable
    const created = await c.req("POST", "/api/maintenance/policies", { templateId: "service-ensure-running", target: { kind: "service", id: res!.resourceId }, mode: "automatic", trigger: { kind: "manual" } });
    expect(created.status, JSON.stringify(created)).toBe(201);
    const ap = await c.req("POST", `/api/maintenance/policies/${created.data.policyId}/approve`, { version: created.data.version, policyHash: created.data.policyHash });
    expect([200, 202]).toContain(ap.status);
    const pol = await waitUntil(() => c.get("/api/maintenance/policies"), (r) => r.data?.items?.some((p: { policyId: string; state: string }) => p.policyId === created.data.policyId && p.state === "enabled"), 30_000, 300);
    const bp = await new Broker().open();
    const bstate = await bp.client.maintenanceState(bp.identity);
    bp.close();
    expect(bstate.policies.some((p) => p.policyId === created.data.policyId && !p.revoked)).toBe(true);
    void pol;

    // the unit stops outside AgentOS
    sudo(["systemctl", "stop", DEMO]);
    await waitUntil(() => unitActive(DEMO), (s) => s !== "active", 10_000);

    // This shared test broker holds target-control epochs from earlier suites that this fresh os.sqlite never saw: the
    // host must not guess the intent behind them (it may be a user stop). A check observes and does nothing.
    const b0 = await new Broker().open();
    const rootTarget = (await b0.client.maintenanceState(b0.identity)).targets.find((t) => t.resourceId === res!.resourceId);
    b0.close();
    if (rootTarget && rootTarget.controlEpoch > 0) {
      const c0 = await c.req("POST", "/api/maintenance/checks", { templateId: "service-ensure-running", target: { kind: "service", id: res!.resourceId } });
      const j0 = await waitUntil(() => c.get(`/api/maintenance/jobs/${c0.data.jobId}`), (r) => ["succeeded", "no_change", "failed_no_effect", "needs_attention", "indeterminate"].includes(r.data?.state), 60_000, 500);
      expect(j0.data.state, JSON.stringify(j0.data)).not.toBe("succeeded");
      expect(JSON.stringify(j0.data)).toMatch(/newer control|explicit start/);
      expect(unitActive(DEMO)).not.toBe("active");
    }
    // the user explicitly allows it to run again: a new control epoch above the root's
    const uc = await c.req("POST", `/api/system-resources/${res!.resourceId}/maintenance-control`, { intent: "running" });
    expect(uc.status, JSON.stringify(uc)).toBe(200);
    expect(uc.data.controlEpoch).toBeGreaterThan(rootTarget?.controlEpoch ?? 0);
    await waitUntil(async () => {
      const bb = await new Broker().open();
      try {
        return (await bb.client.maintenanceState(bb.identity)).targets.find((t) => t.resourceId === res!.resourceId)?.controlEpoch;
      } finally {
        bb.close();
      }
    }, (e) => e === uc.data.controlEpoch, 30_000, 500);

    // The broker's admission counts follow the real resource across runs (spec §12.3): an admission left by an earlier run
    // of this suite (or an aborted one) inside the cooldown makes the broker refuse with CIRCUIT_OPEN before the fault
    // point is reached. Wait the cooldown out rather than mistaking it for a recovery failure; an exhausted hour/24 h cap
    // cannot be waited out inside one test and is reported as such.
    {
      const bw = await new Broker().open();
      const ms = await bw.client.maintenanceState(bw.identity);
      bw.close();
      const p = (ms.policies as { policyId: string; bounds?: { cooldownSeconds?: number; perHour?: number; per24h?: number }; attempts?: { lastHour: number; last24h: number; lastAdmittedAtMs: number | null } }[]).find((x) => x.policyId === created.data.policyId);
      const cap = (ms.installCaps as { cooldownSeconds: number; perHour: number; per24h: number }[] | undefined)?.[0];
      const cooldownMs = Math.max(p?.bounds?.cooldownSeconds ?? 0, cap?.cooldownSeconds ?? 0) * 1000;
      const perHour = Math.min(p?.bounds?.perHour ?? Infinity, cap?.perHour ?? Infinity);
      const per24h = Math.min(p?.bounds?.per24h ?? Infinity, cap?.per24h ?? Infinity);
      expect(p?.attempts?.lastHour ?? 0, `hourly cap exhausted by earlier runs: ${JSON.stringify(p?.attempts)}`).toBeLessThan(perHour);
      expect(p?.attempts?.last24h ?? 0, `24 h cap exhausted by earlier runs: ${JSON.stringify(p?.attempts)}`).toBeLessThan(per24h);
      const last = p?.attempts?.lastAdmittedAtMs;
      if (last) {
        const wait = last + cooldownMs + 2_000 - Date.now();
        if (wait > 0) {
          console.log(`[host-maintenance] waiting ${Math.ceil(wait / 1000)} s for the broker cooldown left by an earlier admission`);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }

    // restart the host with the fault point armed, start the check, and wait for the SIGKILL
    await stopHost(host!);
    await start({ AGENTOS_FAULTS: "1", AGENTOS_FAULT_POINT: POINT });
    const chk = await c.req("POST", "/api/maintenance/checks", { templateId: "service-ensure-running", target: { kind: "service", id: res!.resourceId } });
    expect(chk.status, JSON.stringify(chk)).toBe(202);
    const jobId = chk.data.jobId as string;
    try {
      await waitUntil(() => host!.proc.exitCode !== null || host!.proc.signalCode !== null, (x) => x, 120_000, 200);
    } catch (e) {
      const js = await c.get(`/api/maintenance/jobs/${jobId}`).catch(() => null);
      throw new Error(`host not killed at ${POINT} within 120 s; job: ${JSON.stringify(js?.data ?? null)} (${(e as Error).message})`);
    }
    expect(host!.logs.join("")).toContain(`[fault] ${POINT}`);

    // restart: the job resumes from os.sqlite alone; the same operation is found or delivered once
    await start();
    const job = await waitUntil(() => c.get(`/api/maintenance/jobs/${jobId}`), (r) => ["succeeded", "failed_no_effect", "indeterminate", "needs_attention", "no_change"].includes(r.data?.state), 180_000, 1000);
    expect(job.data.state, JSON.stringify(job.data)).toBe("succeeded");
    expect(unitActive(DEMO)).toBe("active");
    const b = await new Broker().open();
    try {
      const ops = (await historyAll(b.client, b.identity.machineInstallId)).ops.filter((o) => o.maintenance?.jobId === jobId);
      expect(ops).toHaveLength(1);
      expect(ops[0]!.state).toBe("succeeded");
      expect(ops[0]!.maintenance).toMatchObject({ protocolVersion: 2, policyId: created.data.policyId });
    } finally {
      b.close();
    }
  }, 1_500_000);
});
