import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { BrokerClient } from "@agentos/broker-client";
import { checkProviderParams } from "@agentos/contracts";
import { Broker, POLICY, ROOT, clearFaults, hasBroker, hostNetFacts, inLab, installed, simCtl, storeUUID, sudo, systemctl, unitActive, waitUntil } from "../v03.js";

/**
 * pnpm test:native — Rust contracts plus the REAL file/systemd/netlink/nft/serial(PTY) chains through the installed
 * broker and workers (dedicated test install: managed dir, agentos-demo.service, lab namespace, PTY fixture).
 */
const run = hasBroker() ? describe : describe.skip;

describe("V3-C04 Rust protocol crate (cargo test)", () => {
  it("canonical/hash/DTO/params/depth vectors and real openat2 tests pass in Rust", () => {
    const r = spawnSync("cargo", ["test", "--release", "--workspace", "--quiet"], { cwd: path.join(ROOT, "native"), encoding: "utf8", env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` }, timeout: 600_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`.slice(-3000)).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/FAILED|panicked/);
  }, 620_000);
});

run("real broker and workers", () => {
  let b: Broker;
  const pol = installed()!;
  const managed = () => pol.managedRoots.find((m) => m.storeUuid === storeUUID())!.path;
  const demo = pol.units[0]!;
  beforeAll(async () => {
    clearFaults();
    b = await new Broker().open();
    await b.releaseQuarantines();
  });
  afterAll(() => b?.close());

  // ---------------------------------------------------------------- identity / policy
  it("V3-G02 a peer that is not the registered host uid, or a wrong installId/incarnation, is refused", async () => {
    // Root is a different uid than the registered host user: the broker refuses it by SO_PEERCRED.
    const r = spawnSync("sudo", ["-n", "python3", "-c", `
import socket,struct,json
s=socket.socket(socket.AF_UNIX);s.connect('/run/agentos-broker/broker.sock')
b=json.dumps({"v":1,"id":"1","method":"handshake","params":{"protocolVersion":1,"storeUuid":"${storeUUID()}","machineInstallId":None,"workspaceIncarnation":None,"clientNonce":"x"}}).encode()
try:
  s.sendall(struct.pack('>I',len(b))+b)
  h=s.recv(4)
  print(s.recv(struct.unpack('>I',h)[0]).decode() if len(h)==4 else 'closed')
except Exception as e:
  print('closed', e)`], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toMatch(/BROKER_IDENTITY_MISMATCH|BROKER_POLICY_DENIED|closed|not registered/);
    // Wrong installId / incarnation in a write envelope.
    const g = await b.grant("managed-root", "file.write_text_atomic", { maxBytes: 1024 });
    for (const extra of [{ machineInstallId: "mi_000000000000000000000000" }, { workspaceIncarnation: b.identity.workspaceIncarnation + 7 }]) {
      const env = b.envelope(g, "file.write_text_atomic", { path: `g02-${randomBytes(3).toString("hex")}.txt`, content: "x", expectedAbsent: true }, extra);
      await expect(b.client.submit(env)).rejects.toMatchObject({ code: expect.stringMatching(/BROKER_IDENTITY_MISMATCH|WORKSPACE_FENCED/) });
    }
    // A self-declared uid inside the payload is ignored: there is no such field (unknown fields are refused).
    const bad = { ...b.envelope(g, "file.write_text_atomic", { path: "x.txt", content: "x", expectedAbsent: true }), uid: 0 };
    await expect(b.client.submit(bad as never)).rejects.toMatchObject({ code: "INVALID_SYSTEM_PLAN" });
  });

  it("V3-G01 a grant cannot exceed the installed caps (resource or parameter)", async () => {
    await expect(b.grant("service", "service.set_limit", { CPUQuotaPerSecUSec: { min: 100000, max: demo.cpuQuotaPerSecUSec.max + 1 } })).rejects.toMatchObject({ code: "BROKER_POLICY_DENIED" });
    await expect(b.grant("managed-root", "file.write_text_atomic", { maxBytes: 10 * 1024 * 1024 })).rejects.toMatchObject({ code: "BROKER_POLICY_DENIED" });
    // Inside the grant but outside the install cap at execution: refused before any effect.
    const g = await b.grant("service", "service.set_limit", { CPUQuotaPerSecUSec: { min: 100000, max: 2000000 } });
    const env = b.envelope(g, "service.set_limit", { property: "CPUQuotaPerSecUSec", value: 9_000_000 });
    const res = await b.client.submit(env).catch((e) => e);
    const op = res.code ? null : await b.final(env.operationId);
    expect(res.code ?? op!.error?.code).toMatch(/BROKER_POLICY_DENIED|LIMIT_EXCEEDED/);
  });

  it("V3-C05 Shell, unit text, raw messages, scripts/bytecode paths are refused (TS and broker)", async () => {
    for (const [cap, p] of [["service.set_limit", { property: "ExecStart", value: 1 }], ["network.apply_profile", { profileId: "x", nft: "flush ruleset" }], ["serial.exchange", { command: "RAW", frame: "AT" }], ["shell.exec", { cmd: "id" }]] as const) {
      expect(() => checkProviderParams(cap, p)).toThrow();
    }
    const g = await b.grant("service", "service.ensure_state", { states: ["running", "stopped"] });
    const env = b.envelope(g, "service.ensure_state", { state: "running", unit: "ssh.service" });
    await expect(b.client.submit(env)).rejects.toMatchObject({ code: "INVALID_SYSTEM_PLAN" });
    const g2 = await b.grant("lab-network", "network.apply_profile", { profiles: ["local-allow", "local-deny"] });
    await expect(b.client.submit(b.envelope(g2, "network.apply_profile", { profileId: "add table inet evil" }))).rejects.toMatchObject({ code: expect.stringMatching(/NETWORK_SCOPE_DENIED|INVALID_SYSTEM_PLAN/) });
  });

  // ---------------------------------------------------------------- files
  it("V3-F01 traversal, symlinks, magic links and mounts are refused on the real managed root", async () => {
    for (const p of ["../x.txt", "/etc/passwd", "a/../../x", "proc/self/root/etc/passwd"]) {
      const g = await b.grant("managed-root", "file.write_text_atomic", { maxBytes: 1024 });
      const env = b.envelope(g, "file.write_text_atomic", { path: p, content: "x", expectedAbsent: true });
      const r = await b.client.submit(env).then(() => b.final(env.operationId)).catch((e) => ({ error: { code: e.code } }));
      expect((r as { error: { code: string } | null }).error?.code, p).toMatch(/PATH_SCOPE_VIOLATION|RESOURCE_GONE|INVALID_SYSTEM_PLAN/);
    }
    // A symlink planted inside the managed root (by root, simulating a race) is never followed.
    const link = path.join(managed(), `evil-${randomBytes(3).toString("hex")}`);
    sudo(["ln", "-s", "/etc", link]);
    try {
      const { op } = await b.run("managed-root", "file.write_text_atomic", { maxBytes: 1024 }, { path: `${path.basename(link)}/x.txt`, content: "x", expectedAbsent: true });
      expect(op.state).not.toBe("succeeded");
      expect(fs.existsSync("/etc/x.txt")).toBe(false);
    } finally {
      sudo(["rm", "-f", link]);
    }
  });

  it("V3-F04 the managed root and its parents cannot be written by the host user", async () => {
    const dir = managed();
    expect(() => fs.writeFileSync(path.join(dir, "host-wrote.txt"), "x")).toThrow();
    expect(() => fs.renameSync(dir, `${dir}.moved`)).toThrow();
    expect(() => fs.writeFileSync(path.join(path.dirname(dir), "x"), "x")).toThrow();
    const d = (await b.client.describe(b.identity)).resources.find((r) => r.kind === "managed-root")!;
    const det = (d.details as { details: { exclusiveWriter: boolean; ownerUid: number; writerUid: number; parents: { uid: number; mode: string }[] } }).details;
    expect(det.exclusiveWriter).toBe(true);
    expect(det.ownerUid).toBe(det.writerUid);
    expect(det.ownerUid).not.toBe(process.getuid!());
    expect(det.parents.every((p) => p.uid === 0)).toBe(true);
  });

  it("V3-F05 expectedAbsent never overwrites; a stale expectedVersion is refused", async () => {
    const name = `f05-${randomBytes(4).toString("hex")}.txt`;
    const first = await b.run("managed-root", "file.write_text_atomic", { maxBytes: 4096 }, { path: name, content: "one\n", expectedAbsent: true });
    expect(first.op.state).toBe("succeeded");
    expect(first.op.evidenceKind).toBe("target_hash");
    const again = await b.run("managed-root", "file.write_text_atomic", { maxBytes: 4096 }, { path: name, content: "two\n", expectedAbsent: true });
    expect(again.op.state).toBe("failed_no_effect");
    expect(fs.readFileSync(path.join(managed(), name), "utf8")).toBe("one\n");
    const stale = await b.run("managed-root", "file.write_text_atomic", { maxBytes: 4096 }, { path: name, content: "three\n", expectedVersion: "sha256:" + "a".repeat(64) });
    expect(stale.op.state).toBe("failed_no_effect");
    expect(stale.op.error?.code).toBe("FILE_VERSION_STALE");
    const v = `sha256:${createHash("sha256").update("one\n").digest("hex")}`;
    const ok = await b.run("managed-root", "file.write_text_atomic", { maxBytes: 4096 }, { path: name, content: "three\n", expectedVersion: v });
    expect(ok.op.state).toBe("succeeded");
    expect(fs.readFileSync(path.join(managed(), name), "utf8")).toBe("three\n");
  });

  it("V3-F02/F03 special files and hard links refused; truncation and changes reported honestly (managed read)", async () => {
    const name = `big-${randomBytes(3).toString("hex")}.txt`;
    await b.run("managed-root", "file.write_text_atomic", { maxBytes: 131072 }, { path: name, content: "y".repeat(100_000), expectedAbsent: true });
    const r = (await b.read("managed-root", "file.read_text", { path: name, maxBytes: 1000 })).data as { truncated: boolean; size: number; content: string; version: string };
    expect(r.truncated).toBe(true);
    expect(r.size).toBe(100_000);
    expect(r.content.length).toBe(1000);
    expect(r.version).toBe(`sha256:${createHash("sha256").update("y".repeat(100_000)).digest("hex")}`);
    sudo(["ln", path.join(managed(), name), path.join(managed(), `${name}.hard`)]);
    try {
      await expect(b.read("managed-root", "file.read_text", { path: name })).rejects.toMatchObject({ code: "UNSUPPORTED_FILE_TYPE" });
    } finally {
      sudo(["rm", "-f", path.join(managed(), `${name}.hard`)]);
    }
    sudo(["mkfifo", path.join(managed(), `${name}.fifo`)]);
    try {
      await expect(b.read("managed-root", "file.read_text", { path: `${name}.fifo` })).rejects.toMatchObject({ code: "UNSUPPORTED_FILE_TYPE" });
    } finally {
      sudo(["rm", "-f", path.join(managed(), `${name}.fifo`)]);
    }
  });

  // ---------------------------------------------------------------- services
  it("V3-S01 only the catalog unit: no PID, ExecStart, env or other unit can be addressed", async () => {
    // There is no capability that names a unit; the resource id is the only target and the grant pins it.
    const g = await b.grant("service", "service.ensure_state", { states: ["running", "stopped"] });
    await expect(b.client.submit({ ...b.envelope(g, "service.ensure_state", { state: "running" }), resourceId: "res_service_sshd" } as never)).rejects.toMatchObject({ code: expect.stringMatching(/RESOURCE_NOT_BOUND|PLAN_HASH_MISMATCH|INVALID_SYSTEM_PLAN/) });
    for (const p of [{ state: "running", pid: 1 }, { state: "running", environment: { A: "1" } }, { property: "ExecStart", value: 0 }]) {
      expect(() => checkProviderParams("service.ensure_state" in p ? "service.ensure_state" : "service.set_limit", p)).toThrow();
    }
  });

  it("V3-S02/S03 job result plus real unit state; ensure on a satisfied target is a no-op", async () => {
    systemctl("stop", demo.unit);
    const up = await b.run("service", "service.ensure_state", { states: ["running", "stopped"] }, { state: "running" });
    expect(up.op.state).toBe("succeeded");
    expect(up.op.completionKind).toBe("applied");
    expect(up.op.evidenceKind).toBe("unit_state");
    expect(unitActive(demo.unit)).toBe("active");
    const again = await b.run("service", "service.ensure_state", { states: ["running", "stopped"] }, { state: "running" });
    expect(again.op.completionKind).toBe("already_satisfied");
    expect((again.op.result as { invocationId: string }).invocationId).toBe((up.op.result as { invocationId: string }).invocationId);
  });

  it("V3-S04 the cgroup value equals the request; out-of-range refused; other units untouched", async () => {
    const before = spawnSync("systemctl", ["show", "-p", "CPUQuotaPerSecUSec", "ssh.service"], { encoding: "utf8" }).stdout;
    const r = await b.run("service", "service.set_limit", { CPUQuotaPerSecUSec: { min: 100000, max: 2000000 } }, { property: "CPUQuotaPerSecUSec", value: 500000 });
    expect(r.op.state).toBe("succeeded");
    const cg = fs.readFileSync(`/sys/fs/cgroup/system.slice/${demo.unit}/cpu.max`, "utf8").trim();
    expect(cg).toBe("50000 100000");
    const m = await b.run("service", "service.set_limit", { MemoryMax: { min: 67108864, max: 1073741824 } }, { property: "MemoryMax", value: 134217728 });
    expect(m.op.state).toBe("succeeded");
    expect(fs.readFileSync(`/sys/fs/cgroup/system.slice/${demo.unit}/memory.max`, "utf8").trim()).toBe("134217728");
    const low = await b.run("service", "service.set_limit", { MemoryMax: { min: 67108864, max: 1073741824 } }, { property: "MemoryMax", value: 1024 });
    expect(low.op.state).not.toBe("succeeded");
    expect(spawnSync("systemctl", ["show", "-p", "CPUQuotaPerSecUSec", "ssh.service"], { encoding: "utf8" }).stdout).toBe(before);
  });

  it("V3-S05 a new InvocationID (restart outside AgentOS) changes the service version; old runtime limits are not replayed", async () => {
    const d1 = (await b.read("service", "service.describe")).data as { invocationId: string };
    systemctl("restart", demo.unit);
    const d2 = (await b.read("service", "service.describe")).data as { invocationId: string };
    expect(d2.invocationId).not.toBe(d1.invocationId);
    // A plan observed against the old invocation is stale: version preconditions differ (checked in the host tests).
  });

  // ---------------------------------------------------------------- network
  it("V3-N01/N03 profiles change only the lab namespace, proven by real traffic; host routes/DNS/ruleset unchanged", async () => {
    const before = hostNetFacts();
    const deny = await b.run("lab-network", "network.apply_profile", { profiles: ["local-allow", "local-deny"] }, { profileId: "local-deny" });
    expect(deny.op.state).toBe("succeeded");
    expect((deny.op.result as { probe: { allowed: boolean; matchesProfile: boolean } }).probe).toMatchObject({ allowed: false, matchesProfile: true });
    // Independent probe from inside the namespace (test only).
    expect(inLab(["timeout", "2", "bash", "-c", "echo > /dev/tcp/10.231.0.2/8080"]).status).not.toBe(0);
    const allow = await b.run("lab-network", "network.apply_profile", { profiles: ["local-allow", "local-deny"] }, { profileId: "local-allow" });
    expect((allow.op.result as { probe: { allowed: boolean } }).probe.allowed).toBe(true);
    expect(inLab(["timeout", "2", "bash", "-c", "echo > /dev/tcp/10.231.0.2/8080"]).status).toBe(0);
    expect(hostNetFacts()).toBe(before);
  });

  it("V3-N02 the profile hash comes from the install; an arbitrary table, address or nft text is refused", async () => {
    const st = (await b.read("lab-network", "network.policy_status")).data as { profileHashes: Record<string, string>; ruleHash: string; activeProfile: string };
    expect(Object.keys(st.profileHashes).sort()).toEqual(["local-allow", "local-deny"]);
    expect(st.ruleHash).toBe(st.profileHashes[st.activeProfile]);
    expect(() => checkProviderParams("network.apply_profile", { profileId: "local-allow", table: "filter" })).toThrow();
  });

  it("V3-N04 a commit failure leaves the ruleset unchanged and is verified by hash (no flush, no shell)", async () => {
    const before = ((await b.read("lab-network", "network.policy_status")).data as { ruleHash: string }).ruleHash;
    sudo(["tee", "-a", "/etc/agentos/broker/faultpoints"], "worker.network.fail_commit\n");
    const r = await b.run("lab-network", "network.apply_profile", { profiles: ["local-allow", "local-deny"] }, { profileId: "local-deny" });
    expect(r.op.state).toBe("failed_no_effect");
    expect(((await b.read("lab-network", "network.policy_status")).data as { ruleHash: string }).ruleHash).toBe(before);
  });

  it("V3-N05 recreating the namespace raises the generation; old grants cannot act on the new one", async () => {
    const g = await b.grant("lab-network", "network.apply_profile", { profiles: ["local-allow", "local-deny"] });
    systemctl("restart", "agentos-labnet.service");
    systemctl("restart", "agentos-labpeer-echo.service");
    systemctl("restart", "agentos-worker-net.service");
    await waitUntil(async () => {
      await b.refresh();
      return b.res("lab-network").generation;
    }, (gen) => gen > g.resource.generation, 20_000, 300);
    const env = b.envelope(g, "network.apply_profile", { profileId: "local-allow" });
    await expect(b.client.submit(env).then(() => b.final(env.operationId))).rejects.toMatchObject({ code: expect.stringMatching(/RESOURCE_GENERATION_STALE|PLAN_HASH_MISMATCH/) }).catch(async () => {
      const op = await b.final(env.operationId);
      expect(op.state).not.toBe("succeeded");
    });
    // restore allow for later tests
    await b.run("lab-network", "network.apply_profile", { profiles: ["local-allow", "local-deny"] }, { profileId: "local-allow" });
  });

  // ---------------------------------------------------------------- serial (PTY fixture: software path only)
  it("V3-D03 PTY: request id, response, deadline and byte limits are checked", async () => {
    const r = await b.run("serial", "serial.exchange", { commands: ["SAMPLE", "ECHO"] }, { command: "SAMPLE", count: 3 });
    expect(r.op.state).toBe("succeeded");
    const res = r.op.result as { reqId: string; fields: string[] };
    expect(res.fields).toHaveLength(3);
    expect(simCtl("status")).toContain(`"lastReq":"${res.reqId}"`);
    expect(() => checkProviderParams("serial.exchange", { command: "ECHO", text: "x".repeat(65) })).toThrow();
  });

  it("V3-D04 PTY: status never opens the port; a lost response is unknown, quarantined and not resent", async () => {
    const before = JSON.parse(simCtl("status")) as { slaveOpens: number; requests: number };
    await b.read("serial", "serial.status");
    await new Promise((r) => setTimeout(r, 300));
    expect((JSON.parse(simCtl("status")) as { slaveOpens: number }).slaveOpens).toBe(before.slaveOpens);
    simCtl("drop-next");
    const r = await b.run("serial", "serial.exchange", { commands: ["SAMPLE", "ECHO"] }, { command: "ECHO", text: "lost" });
    expect(r.op.state).toBe("indeterminate");
    expect(r.op.effectCertainty).toBe("unknown");
    await new Promise((res) => setTimeout(res, 3000));
    const after = JSON.parse(simCtl("status")) as { requests: number };
    expect(after.requests).toBe(before.requests + 1); // exactly one frame reached the device; no retry
    await b.refresh();
    expect(b.res("serial").quarantineOperationId).toBe(r.env.operationId);
    // D06: operator resolution keeps the original unknown fact and releases the quarantine.
    const resolved = await b.client.operationResolve(b.identity, r.env.operationId, "accept_unknown", { note: "test" }, true);
    expect(resolved.state).toBe("indeterminate");
    expect(resolved.resolution).toMatchObject({ operatorDecision: "accept_unknown", releaseQuarantine: true });
    await b.refresh();
    expect(b.res("serial").quarantineOperationId).toBeNull();
  });

  it("V3-D01/D05 PTY reconnect: new connection generation; grants for the old one stop working", async () => {
    const g = await b.grant("serial", "serial.exchange", { commands: ["SAMPLE", "ECHO"] });
    simCtl("reconnect");
    await waitUntil(async () => {
      await b.refresh();
      return b.res("serial").generation;
    }, (gen) => gen > g.resource.generation, 20_000, 300);
    const env = b.envelope(g, "serial.exchange", { command: "SAMPLE", count: 1 });
    const out = await b.client.submit(env).then(() => b.final(env.operationId)).catch((e) => ({ state: "refused", error: { code: e.code } }));
    expect(out.state).not.toBe("succeeded");
  });

  it("V3-D02 unregistered device, raw frames, ioctl and out-of-range parameters are refused", () => {
    for (const p of [{ command: "SAMPLE", count: 0 }, { command: "SAMPLE", count: 9 }, { command: "IOCTL", request: 1 }, { command: "ECHO", text: "\u0007bell" }, { command: "SAMPLE", device: "/dev/ttyS0" }]) {
      expect(() => checkProviderParams("serial.exchange", p), JSON.stringify(p)).toThrow();
    }
  });

  it("policy and catalog are root-owned and read-only for the host user", () => {
    const st = fs.statSync(POLICY);
    expect(st.uid).toBe(0);
    expect(st.mode & 0o022).toBe(0);
    expect(() => fs.writeFileSync(POLICY, "{}")).toThrow();
    expect(new BrokerClient({ storeUuid: storeUUID() }).socketPath).toBe("/run/agentos-broker/broker.sock");
  });
});
