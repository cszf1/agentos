import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { BROKER_SOCKET, domainHash, sealMaintenanceEnvelope, sealMaintenancePolicy, MAINTENANCE_FAMILY_ENSURE_RUNNING, type MaintenanceWriteEnvelope } from "@agentos/contracts";
import { Broker, clearFaults, hasBroker, installed, setFault, storeUUID, sudo, unitActive, waitBroker, waitUntil } from "../v03.js";

/**
 * Broker protocol 2 against the REAL installed v0.4 broker (deploy/v0.4/agentos-system-admin install --test-mode):
 * the maintenance principal, root install caps, policy version/revocation/expiry, workspace pause epochs, target
 * control epochs (user stop wins), count reservation that never resets, crash after accept, and no protocol downgrade.
 * Covers V4-B08, V4-P06, V4-P07, V4-P08, V4-H02, V4-H07.
 */
const caps = () => installed() as unknown as { maintenance?: { unitKey: string; perHour: number; per24h: number; cooldownSeconds: number }[] } | null;
const run = hasBroker() && (caps()?.maintenance?.length ?? 0) > 0 ? describe : describe.skip;
const id = (p: string) => `${p}_${randomBytes(10).toString("hex")}`;
const DEMO = "agentos-demo.service";

/** One raw frame on a fresh connection after a v1 handshake (to prove the broker refuses a downgraded request). */
async function raw(frames: { v: number; method: string; params: unknown }[]): Promise<{ ok: boolean; error?: { code: string } }[]> {
  const s = net.createConnection(BROKER_SOCKET);
  await new Promise<void>((r, j) => (s.once("connect", () => r()), s.once("error", j)));
  const out: { ok: boolean; error?: { code: string } }[] = [];
  let buf = Buffer.alloc(0);
  const want = frames.length + 1;
  const done = new Promise<void>((resolve) => {
    s.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const len = buf.readUInt32BE(0);
        out.push(JSON.parse(buf.subarray(4, 4 + len).toString("utf8")));
        buf = buf.subarray(4 + len);
        if (out.length >= want) resolve();
      }
    });
    s.on("close", () => resolve());
  });
  const send = (o: unknown) => {
    const b = Buffer.from(JSON.stringify(o));
    const h = Buffer.alloc(4);
    h.writeUInt32BE(b.length, 0);
    s.write(Buffer.concat([h, b]));
  };
  send({ v: 1, id: "h", method: "handshake", params: { protocolVersion: 1, storeUuid: storeUUID(), machineInstallId: null, workspaceIncarnation: null, clientNonce: "00" } });
  frames.forEach((f, i) => send({ v: f.v, id: String(i), method: f.method, params: f.params }));
  await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
  s.destroy();
  return out.slice(1);
}

run("broker protocol 2: maintenance principal", () => {
  let b: Broker;
  let epoch = Date.now(); // epochs only move forward inside one incarnation; start above anything an earlier run used
  let ctl = Date.now();
  const svc = () => b.res("service");

  async function control(state: "running" | "paused", target?: number) {
    return b.client.maintenanceControl({ identity: b.identity, state, maintenanceEpoch: epoch, ...(target !== undefined ? { target: { resourceId: svc().resourceId, controlEpoch: target } } : {}) });
  }
  async function policy(bounds: { perHour: number; per24h: number; cooldownSeconds: number }, o: { policyId?: string; policyVersion?: number; expiresAtMs?: number; resourceId?: string } = {}) {
    await b.refresh();
    const body = sealMaintenancePolicy({
      identity: b.identity, policyId: o.policyId ?? id("mp"), policyVersion: o.policyVersion ?? 1, policyHash: domainHash("agentos.test-policy.v1", { n: randomBytes(4).toString("hex") }),
      resourceId: o.resourceId ?? svc().resourceId, resourceGeneration: svc().generation, actionFamily: MAINTENANCE_FAMILY_ENSURE_RUNNING, bounds,
      expiresAtMs: o.expiresAtMs ?? Date.now() + 3_600_000, maintenanceEpoch: epoch,
    });
    return { body, res: await b.client.maintenancePolicySync(body) };
  }
  function envelope(p: { policyId: string; policyVersion: number }, o: Partial<MaintenanceWriteEnvelope> = {}): MaintenanceWriteEnvelope {
    const op = id("op");
    const { requestHash: _h, ...rest } = { requestHash: "", ...o } as MaintenanceWriteEnvelope;
    return sealMaintenanceEnvelope({
      protocolVersion: 2, machineInstallId: b.identity.machineInstallId, storeUuid: b.identity.storeUuid, workspaceIncarnation: b.identity.workspaceIncarnation,
      operationId: op, actionId: id("sa"), planHash: domainHash("agentos.test-plan.v1", { op }), capabilityId: "service.ensure_state", contractVersion: 1,
      resourceId: svc().resourceId, resourceGeneration: svc().generation, preconditions: {}, deadlineMs: Date.now() + 30_000, params: { state: "running" },
      jobId: id("job"), stepId: "ensure-running", policyId: p.policyId, policyVersion: p.policyVersion, maintenanceEpoch: epoch, targetControlEpoch: ctl, triggerKey: `test:${op}`,
      ...rest,
    } as never);
  }
  const attempts = async () => {
    const st = await b.client.maintenanceState(b.identity);
    const p = st.policies.find((x) => x.resourceId === svc().resourceId);
    return { hour: p?.attempts.lastHour ?? 0, day: p?.attempts.last24h ?? 0, state: st };
  };
  /** A policy whose hourly limit leaves exactly `room` more admissions (counts are global and never reset). */
  async function roomy(room: number, cooldownSeconds?: number) {
    const a = await attempts();
    const cap = caps()!.maintenance![0]!;
    if (a.hour + room > cap.perHour || a.day + room > cap.per24h) throw new Error(`test install caps exhausted (${a.hour}/${cap.perHour} this hour); reinstall with wider AGENTOS_MAINT_CAPS or wait`);
    const cd = cooldownSeconds ?? cap.cooldownSeconds;
    await cooldown(cd);
    return policy({ perHour: a.hour + room, per24h: Math.min(cap.per24h, a.day + room + 50), cooldownSeconds: cd });
  }
  /** Cooldown is measured from the last admission for this target (any job, any policy): wait it out. */
  async function cooldown(seconds: number) {
    const st = await b.client.maintenanceState(b.identity);
    const last = Math.max(0, ...st.policies.filter((x) => x.resourceId === svc().resourceId).map((x) => x.attempts.lastAdmittedAtMs ?? 0));
    const wait = last + seconds * 1000 + 50 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  async function crashService() {
    sudo(["systemctl", "stop", DEMO]);
    await waitUntil(() => unitActive(DEMO), (s) => s !== "active", 10_000);
  }

  beforeAll(async () => {
    clearFaults();
    b = await new Broker().open();
    await b.releaseQuarantines();
    expect(b.client.maintenanceCapable).toBe(true);
    await control("running", ctl);
  });
  beforeEach(async () => {
    clearFaults();
    epoch += 1;
    await control("running");
  });
  afterAll(() => {
    clearFaults();
    b?.close();
  });

  it("V4-B08 handshake lists [1,2]; protocol-2 methods are refused under v=1 and protocol-1 submit cannot carry maintenance fields", async () => {
    expect(b.client.handshakeResult?.supportedProtocols).toEqual([1, 2]);
    const env = envelope({ policyId: "mp_x", policyVersion: 1 });
    const r = await raw([
      { v: 1, method: "maintenance-submit", params: env },
      { v: 1, method: "maintenance-state", params: { identity: b.identity } },
      { v: 2, method: "describe", params: { identity: b.identity } },
      { v: 1, method: "submit", params: { ...env, protocolVersion: 1, grantId: "pg_x", grantVersion: 1, compensatesOperationId: null } },
    ]);
    expect(r[0]).toMatchObject({ ok: false, error: { code: "CAPABILITY_VERSION_UNSUPPORTED" } });
    expect(r[1]).toMatchObject({ ok: false, error: { code: "CAPABILITY_VERSION_UNSUPPORTED" } });
    expect(r[2]).toMatchObject({ ok: false, error: { code: "CAPABILITY_VERSION_UNSUPPORTED" } });
    expect(r[3]!.ok).toBe(false); // unknown fields (jobId, policyId, …) in a v1 envelope: refused, never executed
    // The client itself never sends a malformed or downgraded maintenance write.
    await expect(b.client.maintenanceSubmit({ ...env, params: { state: "stopped" } as never })).rejects.toBeTruthy();
    await expect(b.client.maintenanceSubmit({ ...env, protocolVersion: 1 as never })).rejects.toBeTruthy();
  });

  it("V4-P06 a user policy cannot exceed the install caps, cover an unregistered resource, or live past a year", async () => {
    const cap = caps()!.maintenance![0]!;
    await expect(policy({ perHour: cap.perHour + 1, per24h: cap.per24h, cooldownSeconds: cap.cooldownSeconds })).rejects.toMatchObject({ code: "BROKER_POLICY_DENIED" });
    await expect(policy({ perHour: 1, per24h: cap.per24h + 1, cooldownSeconds: cap.cooldownSeconds })).rejects.toMatchObject({ code: "BROKER_POLICY_DENIED" });
    if (cap.cooldownSeconds > 0) await expect(policy({ perHour: 1, per24h: 1, cooldownSeconds: cap.cooldownSeconds - 1 })).rejects.toMatchObject({ code: "BROKER_POLICY_DENIED" });
    await expect(policy({ perHour: 0, per24h: 1, cooldownSeconds: cap.cooldownSeconds })).rejects.toMatchObject({ code: "BROKER_POLICY_DENIED" });
    await expect(policy({ perHour: 1, per24h: 1, cooldownSeconds: cap.cooldownSeconds }, { resourceId: b.res("managed-root").resourceId })).rejects.toMatchObject({ code: "BROKER_POLICY_DENIED" });
    await expect(policy({ perHour: 1, per24h: 1, cooldownSeconds: cap.cooldownSeconds }, { expiresAtMs: Date.now() + 400 * 86_400_000 })).rejects.toMatchObject({ code: "INVALID_SYSTEM_PLAN" });
    // Same id+version with a different body is a conflict, the same body replays.
    const { body } = await policy({ perHour: 1, per24h: 1, cooldownSeconds: cap.cooldownSeconds });
    expect((await b.client.maintenancePolicySync(body)).replayed).toBe(true);
    const tampered = sealMaintenancePolicy({ ...body, bounds: { ...body.bounds, per24h: 2 }, requestHash: undefined } as never);
    await expect(b.client.maintenancePolicySync(tampered)).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    // A forged hash is refused before anything is recorded.
    await expect(b.client.maintenancePolicySync({ ...body, policyVersion: 2 })).rejects.toMatchObject({ code: "PLAN_HASH_MISMATCH" });
  });

  it("V4-H06 an admitted ensure-running really starts the stopped unit and records the maintenance origin", async () => {
    const { body } = await roomy(1);
    await crashService();
    const env = envelope(body);
    const acc = await b.client.maintenanceSubmit(env);
    expect(acc.maintenance).toMatchObject({ protocolVersion: 2, jobId: env.jobId, policyId: body.policyId, policyVersion: 1 });
    const fin = await b.final(env.operationId, 40_000);
    expect(fin.state).toBe("succeeded");
    expect(unitActive(DEMO)).toBe("active");
    // Same operationId + hash: the same operation, no second count.
    const before = await attempts();
    const again = await b.client.maintenanceSubmit(env);
    expect(again.operationId).toBe(env.operationId);
    expect((await attempts()).hour).toBe(before.hour);
    // Same operationId, different body: conflict.
    await expect(b.client.maintenanceSubmit(envelope(body, { operationId: env.operationId, triggerKey: "other" }))).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  });

  it("V4-H07 counts are reserved at admission and never reset by a new jobId or a new policy version", async () => {
    const { body } = await roomy(1);
    const ok = envelope(body);
    await b.client.maintenanceSubmit(ok);
    await b.final(ok.operationId, 40_000);
    // The hourly limit is now reached: a new job, a new trigger and a newer policy version (same bounds) are all refused.
    await expect(b.client.maintenanceSubmit(envelope(body))).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
    const v2 = sealMaintenancePolicy({ ...body, policyVersion: 2, maintenanceEpoch: epoch, requestHash: undefined } as never);
    await b.client.maintenancePolicySync(v2);
    await expect(b.client.maintenanceSubmit(envelope(v2))).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
    // v1 was superseded by v2.
    await expect(b.client.maintenanceSubmit(envelope(body))).rejects.toMatchObject({ code: "POLICY_VERSION_STALE" });
  });

  it("V4-H07 cooldown is enforced from the last admission", async () => {
    const cap = caps()!.maintenance![0]!;
    const { body } = await roomy(2, cap.cooldownSeconds + 3);
    const a = envelope(body);
    await b.client.maintenanceSubmit(a);
    await b.final(a.operationId, 40_000);
    await expect(b.client.maintenanceSubmit(envelope(body))).rejects.toMatchObject({ code: "CIRCUIT_OPEN", details: { cooldownUntilMs: expect.any(Number) } });
  });

  it("V4-P07/J08 a paused workspace or an old maintenance epoch is refused; a late older control never re-opens it", async () => {
    const { body } = await roomy(1);
    const paused = await b.client.maintenanceControl({ identity: b.identity, state: "paused", maintenanceEpoch: epoch + 1 });
    expect(paused.state).toBe("paused");
    await expect(b.client.maintenanceSubmit(envelope(body, { maintenanceEpoch: epoch }))).rejects.toMatchObject({ code: "MAINTENANCE_DISABLED" });
    await expect(b.client.maintenanceSubmit(envelope(body, { maintenanceEpoch: epoch + 1 }))).rejects.toMatchObject({ code: "MAINTENANCE_DISABLED" });
    // A delayed "running" at the old epoch arrives after the pause: not applied.
    const late = await b.client.maintenanceControl({ identity: b.identity, state: "running", maintenanceEpoch: epoch });
    expect(late.applied).toBe(false);
    expect(late.state).toBe("paused");
    epoch += 2;
    await control("running");
    // Old-epoch requests stay refused after resuming at a newer epoch.
    await expect(b.client.maintenanceSubmit(envelope(body, { maintenanceEpoch: epoch - 2 }))).rejects.toMatchObject({ code: "MAINTENANCE_DISABLED" });
    expect((await attempts()).hour).toBeGreaterThanOrEqual(0);
  });

  it("V4-H02 a user stop (newer target control epoch) wins over a queued maintenance request", async () => {
    const { body } = await roomy(1);
    const env = envelope(body); // carries ctl
    ctl += 1;
    const r = await control("running", ctl); // the user stopped the service: control epoch moves forward
    expect(r.targetControlEpoch).toBe(ctl);
    await expect(b.client.maintenanceSubmit(env)).rejects.toMatchObject({ code: "EXECUTION_EPOCH_STALE" });
    // An older control epoch never moves it back.
    const back = await control("running", ctl - 5);
    expect(back.targetControlEpoch).toBe(ctl);
  });

  it("V4-P07 a revoked or expired policy is refused, including a late sync of a revoked version", async () => {
    const { body } = await roomy(1);
    await b.client.maintenancePolicyRevoke(b.identity, body.policyId, 1);
    await expect(b.client.maintenanceSubmit(envelope(body))).rejects.toMatchObject({ code: "POLICY_VERSION_STALE" });
    // Revoking a version the broker never saw leaves a tombstone: a late sync of it cannot activate.
    const pid = id("mp");
    await b.client.maintenancePolicyRevoke(b.identity, pid, 3);
    await expect(policy({ ...body.bounds }, { policyId: pid, policyVersion: 3 })).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    expect((await attempts()).state.policies.find((x) => x.policyId === pid)).toBeUndefined();
    // Expiry: a policy that expires seconds from now is refused once it expired.
    const short = await policy({ ...body.bounds }, { expiresAtMs: Date.now() + 1500 });
    await new Promise((r) => setTimeout(r, 1700));
    await expect(b.client.maintenanceSubmit(envelope(short.body))).rejects.toMatchObject({ code: "POLICY_VERSION_STALE" });
  });

  it("V4-P08 a maintenance policy cannot authorize a protocol-1 write, and a grant cannot authorize a maintenance write", async () => {
    const { body } = await roomy(1);
    // The policy id is not a grant.
    const g = { grantId: body.policyId, resource: svc() };
    const v1 = b.envelope(g, "service.ensure_state", { state: "running" });
    await expect(b.client.submit(v1)).rejects.toMatchObject({ code: expect.stringMatching(/GRANT|POLICY|DENIED/) });
    // A real grant id used as a maintenance policy id: no such maintenance policy.
    const grant = await b.grant("service", "service.ensure_state", { states: ["running"] });
    await expect(b.client.maintenanceSubmit(envelope({ policyId: grant.grantId, policyVersion: 1 }))).rejects.toMatchObject({ code: "POLICY_VERSION_STALE" });
  });

  it("V4-H07 broker killed right after a maintenance accept: the same envelope finds the original operation and one count", async () => {
    const { body } = await roomy(1);
    await crashService();
    const before = (await attempts()).hour;
    const env = envelope(body);
    const pid = sudo(["systemctl", "show", "-p", "MainPID", "--value", "agentos-broker.service"]).trim();
    setFault("broker.after_maintenance_accept");
    await b.client.maintenanceSubmit(env).catch(() => undefined);
    await waitUntil(() => sudo(["systemctl", "show", "-p", "MainPID", "--value", "agentos-broker.service"]).trim(), (p) => p !== pid && p !== "0", 25_000, 200);
    await waitBroker();
    await b.reopen();
    const again = await b.client.maintenanceSubmit(env);
    expect(again.operationId).toBe(env.operationId);
    const fin = await b.final(env.operationId, 40_000);
    expect(fin.state).toBe("succeeded");
    expect(unitActive(DEMO)).toBe("active");
    expect((await attempts()).hour).toBe(before + 1);
  });
});
