import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { assertTelemetryMatches, hasBroker, storeUUID, waitUntil } from "../v03.js";
import { startRig } from "../agent-helpers.js";

/**
 * pnpm test:telemetry. T01–T05 run in the eBPF acceptance guest (QEMU, Debian kernel with BTF; the InstaBox kernel has
 * no BTF/tracepoints) with the real daemon and the fixed object built in this checkout. T05/T06 also run on this host,
 * where the collector is unavailable, to check that nothing else degrades.
 */
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const VM = "/data/home/vm";
const SSH = ["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=15", "-i", `${VM}/id_ed25519`, "-p", "2222"];
const guest = fs.existsSync(`${VM}/id_ed25519`) && spawnSync("ssh", [...SSH, "agent@127.0.0.1", "true"], { timeout: 30_000 }).status === 0;

describe.skipIf(!guest)("V3-T01..T05 real eBPF in the acceptance guest", () => {
  let out: Record<string, any>;
  beforeAll(() => {
    const bin = path.join(ROOT, "native", "target", "release", "agentos-telemetry");
    const obj = path.join(ROOT, "native", "bpf", "exec_exit.bpf.o");
    expect(fs.existsSync(bin) && fs.existsSync(obj)).toBe(true);
    const scp = spawnSync("scp", ["-o", "StrictHostKeyChecking=no", "-i", `${VM}/id_ed25519`, "-P", "2222", bin, obj, path.join(import.meta.dirname, "guest-telemetry.py"), "agent@127.0.0.1:/tmp/"], { encoding: "utf8", timeout: 120_000 });
    expect(scp.status, scp.stderr).toBe(0);
    const r = spawnSync("ssh", [...SSH, "agent@127.0.0.1", "sudo -n python3 /tmp/guest-telemetry.py /tmp"], { encoding: "utf8", timeout: 540_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    out = JSON.parse(r.stdout.trim().split("\n").pop()!);
    fs.mkdirSync(path.join(ROOT, "docs", "evidence"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "docs", "evidence", "v0.3-telemetry-guest.json"), JSON.stringify(out, null, 2) + "\n");
    // the object loaded in the guest is byte-identical to the one built here
    expect(out.objectSha256).toBe(createHash("sha256").update(fs.readFileSync(obj)).digest("hex"));
  }, 600_000);

  it("V3-T01 the fixed object loads on the real kernel and captures the registered workload's exec/exit", () => {
    expect(out.btf).toBe(true);
    expect(out.T01_loaded).toBe(true);
    expect(out.T01, JSON.stringify(out)).toBe(true);
  });
  it("V3-T02 nothing from unregistered processes; no argv, env, content or payload", () => {
    expect(out.T02_unregistered_events).toBe(0);
    expect(out.T02, JSON.stringify(out)).toBe(true);
  });
  it("V3-T03 ring/user drops are counted and visible as gaps; resume outside the window is a gap", () => {
    expect(out.T03_kernelDrops).toBeGreaterThan(0);
    expect(out.T03, JSON.stringify(out)).toBe(true);
    expect(out.T03_resume_gap).toBe(true);
  });
  it("V3-T04 cgroup reuse: the old identity is never mapped onto the new workload", () => {
    expect(out.T04, JSON.stringify(out)).toBe(true);
  });
  it("V3-T05 a failing collector reports unavailable plus a gap", () => {
    expect(out.T05, JSON.stringify(out)).toBe(true);
    expect(out.scopeRefused).toBe(true);
  });
});

describe.skipIf(!hasBroker())("V3-T05/T06 on this host (collector unavailable)", () => {
  it("telemetry is reported unavailable separately; broker writes and app grants are unaffected; events trigger no actions", async () => {
    const rig = await startRig({ storeUuid: storeUUID() });
    try {
      await waitUntil(() => rig.caps.state().brokerReady, (x) => x === true, 20_000, 200);
      const st = rig.caps.state();
      expect(st.brokerReady).toBe(true);
      // The host view must match an independent probe of the collector in both directions (see assertTelemetryMatches).
      // Either way, telemetry must not create grants or system actions.
      await assertTelemetryMatches(() => rig.caps.observations.telemetry);
      // Telemetry being down does not change what a grant allows: grants still come only from the user.
      expect(rig.caps.grants.list({ principalKind: "app" }).filter((g) => g.state === "active")).toEqual([]);
      const before = rig.core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM system_actions")!.n;
      await new Promise((r) => setTimeout(r, 3000));
      expect(rig.core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM system_actions")!.n).toBe(before);
    } finally {
      await rig.close();
    }
  });
});
