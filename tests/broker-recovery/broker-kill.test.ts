import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Broker, clearFaults, hasBroker, installed, setFault, simCtl, storeUUID, sudo, systemctl, unitActive, waitBroker, waitUntil } from "../v03.js";

/**
 * pnpm test:broker-recovery — real process kills (SIGKILL at fixed fault points of the broker and of the workers),
 * reconciliation from the broker's own log, cancel tombstones, reuse of requests and quarantine (spec §17, §26 R/F).
 */
const run = hasBroker() ? describe : describe.skip;
const sha = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;

run("broker recovery with real kills", () => {
  let b: Broker;
  const pol = installed()!;
  const managed = () => pol.managedRoots.find((m) => m.storeUuid === storeUUID())!.path;
  const demo = pol.units[0]!;
  const brokerPid = () => sudo(["systemctl", "show", "-p", "MainPID", "--value", "agentos-broker.service"]).trim();

  /** Submit, expect the broker to die at the fault point, wait for systemd to restart it, reconnect. */
  async function crashAt(fault: string, kind: string, cap: string, limits: Record<string, unknown>, params: Record<string, unknown>) {
    const g = await b.grant(kind, cap, limits);
    const env = b.envelope(g, cap, params);
    const pid = brokerPid();
    setFault(fault);
    await b.client.submit(env).catch(() => undefined);
    if (!fault.startsWith("worker.")) await waitUntil(() => brokerPid(), (p) => p !== pid && p !== "0", 25_000, 200);
    await waitBroker();
    await b.reopen();
    const op = await b.final(env.operationId, 40_000);
    return { env, op };
  }

  beforeAll(async () => {
    clearFaults();
    b = await new Broker().open();
    await b.releaseQuarantines();
  });
  beforeEach(() => clearFaults());
  afterAll(() => {
    clearFaults();
    b?.close();
  });

  it("V3-R01 the same operationId+hash returns the same execution; a different body is refused", async () => {
    const g = await b.grant("managed-root", "file.write_text_atomic", { maxBytes: 4096 });
    const env = b.envelope(g, "file.write_text_atomic", { path: `r01-${randomBytes(3).toString("hex")}.txt`, content: "r01\n", expectedAbsent: true });
    const a = await b.client.submit(env);
    const first = await b.final(env.operationId);
    const again = await b.client.submit(env);
    expect(again.operationId).toBe(a.operationId);
    expect(again.acceptedSeq).toBe(a.acceptedSeq);
    expect((await b.final(env.operationId)).updatedSeq).toBe(first.updatedSeq);
    const other = b.envelope(g, "file.write_text_atomic", { path: "other.txt", content: "x", expectedAbsent: true }, { operationId: env.operationId });
    await expect(b.client.submit(other)).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  });

  it("V3-R06 broker killed after committing the result but before replying: reconnect finds the same result", async () => {
    const name = `r06-${randomBytes(3).toString("hex")}.txt`;
    const g = await b.grant("managed-root", "file.write_text_atomic", { maxBytes: 4096 });
    const env = b.envelope(g, "file.write_text_atomic", { path: name, content: "r06\n", expectedAbsent: true });
    await b.client.submit(env);
    await b.final(env.operationId);
    const pid = brokerPid();
    setFault("broker.after_result_reply");
    await b.client.operationGet(b.identity, env.operationId).catch(() => undefined);
    await waitUntil(() => brokerPid(), (p) => p !== pid, 20_000, 200);
    await waitBroker();
    await b.reopen();
    const op = await b.client.operationGet(b.identity, env.operationId);
    expect(op.state).toBe("succeeded");
    expect(fs.readFileSync(path.join(managed(), name), "utf8")).toBe("r06\n");
  });

  it("V3-R03 broker killed right after accepting: the same envelope finds the original operation; one effect", async () => {
    const name = `r03-${randomBytes(3).toString("hex")}.txt`;
    const { env, op } = await crashAt("broker.after_accept", "managed-root", "file.write_text_atomic", { maxBytes: 4096 }, { path: name, content: "r03\n", expectedAbsent: true });
    expect(op.state).toBe("succeeded");
    const again = await b.client.submit(env);
    expect(again.operationId).toBe(env.operationId);
    expect(fs.readFileSync(path.join(managed(), name), "utf8")).toBe("r03\n");
  });

  it("V3-F06 file: kill after the temp write, after rename, and the worker before/after rename — never a third content", async () => {
    for (const fault of ["broker.after_temp", "broker.after_publish", "worker.file.die_before_rename", "worker.file.die_after_rename"]) {
      const name = `f06-${fault.replace(/\W/g, "")}-${randomBytes(2).toString("hex")}.txt`;
      // replace path: existing content "old", plan writes "new"
      await b.run("managed-root", "file.write_text_atomic", { maxBytes: 4096 }, { path: name, content: "old\n", expectedAbsent: true });
      const { op } = await crashAt(fault, "managed-root", "file.write_text_atomic", { maxBytes: 4096 }, { path: name, content: "new\n", expectedVersion: sha("old\n") });
      const now = fs.readFileSync(path.join(managed(), name), "utf8");
      expect(["old\n", "new\n"], fault).toContain(now);
      if (op.state === "succeeded") expect(now, fault).toBe("new\n");
      if (op.state === "failed_no_effect") expect(now, fault).toBe("old\n");
      expect(["succeeded", "failed_no_effect", "indeterminate"], fault).toContain(op.state);
      // no temp left behind once reconciled
      expect(fs.readdirSync(managed()).filter((n) => n.startsWith(".aos-tmp-")), fault).toEqual([]);
      // a third writer changed nothing: content is exactly one of the two hashes
      expect([sha("old\n"), sha("new\n")]).toContain(sha(now));
    }
  });

  it("V3-R04 kill after the execution fence, before the worker call: reconciled by evidence, not assumed", async () => {
    systemctl("stop", demo.unit);
    const { op } = await crashAt("broker.after_admission", "service", "service.ensure_state", { states: ["running", "stopped"] }, { state: "running" });
    // The unit was never asked to start; evidence decides (convergent class may finish it inside its deadline).
    expect(["succeeded", "failed_no_effect", "indeterminate"]).toContain(op.state);
    if (op.state === "succeeded") expect(unitActive(demo.unit)).toBe("active");
    if (op.state === "failed_no_effect") expect(unitActive(demo.unit)).not.toBe("active");
    expect(op.evidenceKind).not.toBeNull();
  });

  it("V3-R05 kill after the external effect, before the broker result: each provider follows its replay class", async () => {
    // service (convergent): job submitted, broker dies; reconcile reads the actual unit state
    systemctl("stop", demo.unit);
    const s = await crashAt("broker.after_job", "service", "service.ensure_state", { states: ["running", "stopped"] }, { state: "running" });
    expect(s.op.state).toBe("succeeded");
    expect(unitActive(demo.unit)).toBe("active");
    // network (convergent): commit happened, worker dies; rule hash + probe decide
    const n = await crashAt("worker.network.die_after_commit", "lab-network", "network.apply_profile", { profiles: ["local-allow", "local-deny"] }, { profileId: "local-deny" });
    expect(n.op.state).toBe("succeeded");
    expect(n.op.evidenceKind).toMatch(/rule_hash/);
    await b.run("lab-network", "network.apply_profile", { profiles: ["local-allow", "local-deny"] }, { profileId: "local-allow" });
    // serial (non-replayable): frame sent, worker dies; never resent, unknown and quarantined
    const before = JSON.parse(simCtl("status")) as { requests: number };
    const d = await crashAt("worker.serial.die_after_send", "serial", "serial.exchange", { commands: ["SAMPLE", "ECHO"] }, { command: "ECHO", text: "r05" });
    expect(d.op.state).toBe("indeterminate");
    expect(d.op.effectCertainty).toBe("unknown");
    await new Promise((r) => setTimeout(r, 2500));
    expect((JSON.parse(simCtl("status")) as { requests: number }).requests).toBe(before.requests + 1);
    await b.refresh();
    expect(b.res("serial").quarantineOperationId).toBe(d.env.operationId);
    // V3-R09: a broker restart never releases the quarantine of an unknown write.
    const pid = brokerPid();
    systemctl("restart", "agentos-broker.service");
    await waitUntil(() => brokerPid(), (p) => p !== pid, 20_000, 200);
    await waitBroker();
    await b.reopen();
    expect(b.res("serial").quarantineOperationId).toBe(d.env.operationId);
    const blocked = await b.grant("serial", "serial.exchange", { commands: ["SAMPLE", "ECHO"] });
    const env2 = b.envelope(blocked, "serial.exchange", { command: "SAMPLE", count: 1 });
    const res = await b.client.submit(env2).then(() => b.final(env2.operationId)).catch((e) => ({ state: "refused", error: { code: e.code } }));
    expect(res.state).not.toBe("succeeded");
    expect((res as { error: { code: string } | null }).error?.code).toMatch(/RESOURCE_BUSY|RECONCILIATION_REQUIRED/);
    await b.client.operationResolve(b.identity, d.env.operationId, "accept_unknown", { note: "r05 test" }, true);
  });

  it("V3-R07 a cancel that arrives before the request leaves a tombstone: the late request never runs", async () => {
    const name = `r07-${randomBytes(3).toString("hex")}.txt`;
    const g = await b.grant("managed-root", "file.write_text_atomic", { maxBytes: 4096 });
    const env = b.envelope(g, "file.write_text_atomic", { path: name, content: "late\n", expectedAbsent: true });
    const c = await b.client.operationCancel(b.identity, env.operationId, "user cancelled first");
    expect(c).toMatchObject({ state: "cancelled_no_effect", tombstone: true });
    // The tombstone survives a broker restart.
    systemctl("restart", "agentos-broker.service");
    await waitBroker();
    await b.reopen();
    const late = await b.client.submit(env).catch((e) => ({ state: "refused", code: e.code }));
    if ((late as { state: string }).state !== "refused") expect((await b.final(env.operationId)).state).toBe("cancelled_no_effect");
    expect(fs.existsSync(path.join(managed(), name))).toBe(false);
  });

  it("V3-R08 a cancel after admission does not claim no effect; the outcome is verified or unknown", async () => {
    simCtl("drop-next"); // the exchange waits its full 2 s deadline
    const g = await b.grant("serial", "serial.exchange", { commands: ["SAMPLE", "ECHO"] });
    const env = b.envelope(g, "serial.exchange", { command: "ECHO", text: "r08" });
    await b.client.submit(env);
    await waitUntil(() => b.client.operationGet(b.identity, env.operationId), (o) => o.state === "running", 5000, 50);
    const c = await b.client.operationCancel(b.identity, env.operationId, "too late");
    expect(c.state).not.toBe("cancelled_no_effect");
    const op = await b.final(env.operationId);
    expect(op.state).not.toBe("cancelled_no_effect");
    expect(["indeterminate", "succeeded"]).toContain(op.state);
    if (op.state === "indeterminate") await b.client.operationResolve(b.identity, env.operationId, "accept_unknown", { note: "r08" }, true);
  });

  it("V3-R12 reconciliation has a budget: a target that stays unreachable ends unknown, not in an endless retry", async () => {
    const name = `r12-${randomBytes(3).toString("hex")}.txt`;
    await b.run("managed-root", "file.write_text_atomic", { maxBytes: 4096 }, { path: name, content: "old\n", expectedAbsent: true });
    const g = await b.grant("managed-root", "file.write_text_atomic", { maxBytes: 4096 });
    const env = b.envelope(g, "file.write_text_atomic", { path: name, content: "new\n", expectedVersion: sha("old\n") }, { deadlineMs: Date.now() + 6000 });
    setFault("worker.file.die_after_rename");
    // Keep the file worker down so reconciliation cannot read the target.
    await b.client.submit(env);
    await new Promise((r) => setTimeout(r, 500));
    systemctl("stop", "agentos-worker-file.service");
    try {
      const op = await b.final(env.operationId, 60_000);
      expect(["indeterminate", "succeeded"]).toContain(op.state);
      expect(op.reconcileAttempts).toBeLessThanOrEqual(3);
    } finally {
      systemctl("start", "agentos-worker-file.service");
    }
    const op = await b.client.operationGet(b.identity, env.operationId);
    if (op.state === "indeterminate") await b.client.operationResolve(b.identity, env.operationId, "confirmed_applied", { note: "r12" }, true);
  });

  it("V3-R11 a missing broker log disables writes (no empty-log replay); diagnostics still answer", async () => {
    const db = "/var/lib/agentos-broker/broker.sqlite";
    systemctl("stop", "agentos-broker.service");
    sudo(["mv", db, `${db}.r11`]);
    for (const s of ["-wal", "-shm"]) sudo(["sh", "-c", `[ -e ${db}${s} ] && mv ${db}${s} ${db}.r11${s} || true`]);
    try {
      systemctl("start", "agentos-broker.service");
      await new Promise((r) => setTimeout(r, 1500));
      const c = new Broker();
      const h = await c.client.handshake({ machineInstallId: null, workspaceIncarnation: null });
      expect(h.brokerReady).toBe(false);
      expect(h.diagnostic ?? "").toMatch(/log|missing|history/i);
      expect(fs.existsSync(db)).toBe(false); // never recreated silently
      c.close();
    } finally {
      systemctl("stop", "agentos-broker.service");
      sudo(["mv", `${db}.r11`, db]);
      for (const s of ["-wal", "-shm"]) sudo(["sh", "-c", `[ -e ${db}.r11${s} ] && mv ${db}.r11${s} ${db}${s} || true`]);
      systemctl("start", "agentos-broker.service");
      await waitBroker();
      await b.reopen();
    }
    // A corrupted log (bad header, WAL gone so page 1 cannot be served from it) is refused the same way.
    systemctl("stop", "agentos-broker.service");
    for (const s of ["", "-wal", "-shm"]) sudo(["sh", "-c", `[ -e ${db}${s} ] && cp -a ${db}${s} ${db}.bak-r11${s} || true`]);
    sudo(["rm", "-f", `${db}-wal`, `${db}-shm`]);
    sudo(["sh", "-c", `printf 'garbage-garbage-garbage' | dd of=${db} bs=1 seek=0 conv=notrunc 2>/dev/null`]);
    try {
      systemctl("start", "agentos-broker.service");
      await new Promise((r) => setTimeout(r, 1500));
      const c = new Broker();
      const h = await c.client.handshake({ machineInstallId: null, workspaceIncarnation: null });
      expect(h.brokerReady).toBe(false);
      c.close();
    } finally {
      systemctl("stop", "agentos-broker.service");
      sudo(["rm", "-f", `${db}-wal`, `${db}-shm`]);
      for (const s of ["", "-wal", "-shm"]) sudo(["sh", "-c", `[ -e ${db}.bak-r11${s} ] && mv ${db}.bak-r11${s} ${db}${s} || true`]);
      systemctl("start", "agentos-broker.service");
      await waitBroker();
      await b.reopen();
    }
  });

  it("V3-G05 revocation committed first blocks new dispatch; the broker confirms it durably", async () => {
    const g = await b.grant("managed-root", "file.write_text_atomic", { maxBytes: 4096 });
    const pid = brokerPid();
    setFault("broker.after_revoke_commit");
    await b.client.grantRevoke(b.identity, g.grantId, 1).catch(() => undefined);
    await waitUntil(() => brokerPid(), (p) => p !== pid, 20_000, 200);
    await waitBroker();
    await b.reopen();
    // replaying the revoke is idempotent and the grant is revoked in the log
    const again = await b.client.grantRevoke(b.identity, g.grantId, 1);
    expect(again.state).toBe("revoked");
    const env = b.envelope(g, "file.write_text_atomic", { path: `g05-${randomBytes(3).toString("hex")}.txt`, content: "x", expectedAbsent: true });
    await expect(b.client.submit(env)).rejects.toMatchObject({ code: "GRANT_REVOKED" });
  });

  it("V3-G04 a grant sync replayed with the same intent never widens; a changed body under the same id is refused", async () => {
    const g = await b.grant("service", "service.set_limit", { CPUQuotaPerSecUSec: { min: 100000, max: 500000 } });
    const replay = await b.client.grantSync(g.body);
    expect(replay.grantId).toBe(g.grantId);
    const { requestHash: _h, ...body } = g.body;
    const wider = { ...body, limits: { CPUQuotaPerSecUSec: { min: 100000, max: 2000000 } } };
    const { sealGrant } = await import("@agentos/contracts");
    await expect(b.client.grantSync(sealGrant(wider as never))).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  });
});
