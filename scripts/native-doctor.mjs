#!/usr/bin/env node
// pnpm native:doctor — report each native capability separately (never one boolean).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";

const ROOT = path.resolve(import.meta.dirname, "..");
const bin = path.join(ROOT, "native", "target", "release");
const out = {};
// review F13: product release vs Host runtime compatibility line, read from the same places the packages use
out.versions = { product: JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version, hostRuntime: (fs.readFileSync(path.join(ROOT, "packages/contracts/src/index.ts"), "utf8").match(/HOST_VERSION = "([^"]+)"/) ?? [])[1] ?? null };
const tryRun = (f) => {
  try {
    return f();
  } catch (e) {
    return { ok: false, error: String(e.message ?? e).slice(0, 300) };
  }
};
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : null);

function frame(obj) {
  const b = Buffer.from(JSON.stringify(obj));
  const h = Buffer.alloc(4);
  h.writeUInt32BE(b.length, 0);
  return Buffer.concat([h, b]);
}
async function ask(sock, obj, timeout = 3000) {
  return new Promise((resolve) => {
    const s = net.createConnection({ path: sock });
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => (s.destroy(), resolve({ ok: false, error: "timeout" })), timeout);
    s.on("error", (e) => (clearTimeout(t), resolve({ ok: false, error: e.message })));
    s.on("connect", () => s.write(frame(obj)));
    s.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        clearTimeout(t);
        s.destroy();
        resolve(JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0)).toString()));
      }
    });
  });
}

// provider-user probe: openat2, system bus, rtnetlink, udev (as this user)
out.providerUser = tryRun(() => {
  const r = spawnSync(path.join(bin, "agentos-provider-user"), ["serve"], { input: frame({ id: 1, op: "probe", params: {} }), timeout: 5000 });
  const b = r.stdout;
  return b.length > 4 ? JSON.parse(b.subarray(4, 4 + b.readUInt32BE(0)).toString()) : { ok: false, error: `exit ${r.status}` };
});
out.kernel = { release: read("/proc/sys/kernel/osrelease"), btf: fs.existsSync("/sys/kernel/btf/vmlinux"), tracefs: fs.existsSync("/sys/kernel/tracing") || fs.existsSync("/sys/kernel/debug/tracing"), unprivilegedBpfDisabled: read("/proc/sys/kernel/unprivileged_bpf_disabled"), lsm: read("/sys/kernel/security/lsm") };
out.cgroup = { v2: fs.existsSync("/sys/fs/cgroup/cgroup.controllers"), controllers: read("/sys/fs/cgroup/cgroup.controllers") };
out.systemd = tryRun(() => ({ ok: true, version: execFileSync("systemctl", ["--version"], { encoding: "utf8" }).split("\n")[0] }));
out.rootPolicy = tryRun(() => {
  const st = fs.statSync("/etc/agentos/broker/policy.json");
  const p = JSON.parse(fs.readFileSync("/etc/agentos/broker/policy.json", "utf8"));
  return { ok: st.uid === 0 && (st.mode & 0o022) === 0, ownerUid: st.uid, mode: (st.mode & 0o777).toString(8), machineInstallId: p.machineInstallId, testMode: p.testMode, units: p.units.map((u) => u.unit), labNetworks: p.labNetworks.map((n) => n.key), serial: p.serial.map((s) => `${s.key}:${s.kind}`) };
});
const store = out.rootPolicy.ok !== false ? JSON.parse(fs.readFileSync("/etc/agentos/broker/policy.json", "utf8")).hosts.find((h) => h.uid === process.getuid())?.storeUuid : null;
out.broker = store ? await ask("/run/agentos-broker/broker.sock", { v: 1, id: "1", method: "handshake", params: { protocolVersion: 1, storeUuid: store, machineInstallId: null, workspaceIncarnation: null, clientNonce: "doctor" } }) : { ok: false, error: "this uid is not registered in the root policy" };
out.network = { labNamespace: fs.existsSync("/run/netns/agentos-lab"), libnftables: fs.existsSync("/usr/lib/x86_64-linux-gnu/libnftables.so.1") };
out.serial = { ttyACM: fs.readdirSync("/dev").filter((d) => /^tty(ACM|USB)\d+$/.test(d)), ptyFixture: fs.existsSync("/run/agentos-serial/sim0") };
out.telemetry = await ask("/run/agentos-telemetry/telemetry.sock", { op: "status" });
out.units = Object.fromEntries(["agentos-broker", "agentos-worker-file", "agentos-worker-service", "agentos-worker-net", "agentos-worker-serial", "agentos-telemetry", "agentos-labnet", "agentos-demo"].map((u) => [u, spawnSync("systemctl", ["is-active", u], { encoding: "utf8" }).stdout.trim()]));
console.log(JSON.stringify(out, null, 2));
