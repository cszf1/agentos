import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GcService, ArtifactStore, RUNTIME_POLICY, openCore } from "@agentos/core";
import type { HostConfig } from "./config.js";
import { catalogProblems, createDriver, loadCatalog } from "./runtime-setup.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * pnpm runtime:doctor (spec §22): rootless engine, user namespace and UID mapping, cgroup v2 controllers, security
 * policy, image platform, socket permissions, and the actual limits seen from inside a probe container.
 */
export async function doctor(config: HostConfig): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const user = os.userInfo().username;
  const sub = (f: string) => {
    try {
      return fs.readFileSync(f, "utf8").split("\n").find((l) => l.startsWith(`${user}:`)) ?? null;
    } catch {
      return null;
    }
  };
  const su = sub("/etc/subuid");
  const sg = sub("/etc/subgid");
  add("subuid/subgid", !!su && !!sg, `subuid ${su ?? "missing"}; subgid ${sg ?? "missing"}`);
  const maxNs = Number(fs.readFileSync("/proc/sys/user/max_user_namespaces", "utf8").trim());
  add("user namespaces", maxNs > 0, `max_user_namespaces=${maxNs}`);
  let procOver = "";
  try {
    procOver = fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n").filter((l) => / \/proc\/\S+ /.test(l) && !l.includes("binfmt_misc")).map((l) => l.split(" ")[4]).join(", ");
  } catch {
    /* ignore */
  }
  add("no /proc overmounts", procOver === "", procOver ? `file overmounts under /proc block a fresh proc mount in containers: ${procOver} (unmount them, e.g. sudo umount /proc/sys/kernel/random/boot_id)` : "none");
  if (!config.podmanSocket) {
    add("engine socket", false, "AGENTOS_RUNTIME=off");
    return { ok: false, checks };
  }
  try {
    const st = fs.statSync(config.podmanSocket);
    const mode = st.mode & 0o777;
    add("engine socket permissions", st.uid === process.getuid!() && (mode & 0o007) === 0, `${config.podmanSocket} mode ${mode.toString(8)} uid ${st.uid}`);
  } catch (e) {
    add("engine socket", false, `${config.podmanSocket}: ${(e as Error).message} (systemctl --user enable --now podman.socket)`);
    return { ok: false, checks };
  }
  const catalog = loadCatalog(config);
  const cp = catalogProblems(config, catalog);
  add("catalog matches platform files", cp.length === 0, cp.join("; ") || `${catalog.locks().length} locks for ${config.platform}`);
  const driver = createDriver(config, catalog)!;
  const env = await driver.checkEnvironment();
  add("rootless engine", env.rootless, `podman ${env.podmanVersion}, ${env.ociRuntime}, kernel ${env.kernel}`);
  add("cgroup v2 controllers", env.cgroupVersion === "v2" && ["cpu", "memory", "pids"].every((c) => env.cgroupControllers.includes(c)), `${env.cgroupVersion}: ${env.cgroupControllers.join(",")}`);
  add("seccomp", env.seccomp, `seccomp ${env.seccomp}; apparmor ${env.apparmor}; selinux ${env.selinux} (LSM policy applied when the host provides one)`);
  add("engine platform", env.platform === config.platform, `${env.platform} (catalog ${config.platform})`);
  const lock = catalog.locks()[0];
  if (!lock) return { ok: false, checks };
  const img = await driver.inspectImage(lock.runtimeImage.name);
  add("runtime image present", img.present, img.present ? `${lock.runtimeImage.name} ${img.architecture}` : "run pnpm runtime:prefetch");
  if (img.present) {
    add("image architecture", `linux/${img.architecture}` === config.platform, String(img.architecture));
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-doctor-"));
    const bridge = path.join(probeDir, "bridge");
    fs.mkdirSync(bridge, { mode: 0o700 });
    const name = `agentos-doctor-${randomUUID().slice(0, 8)}`;
    const script = `const fs=require("fs");const net=require("net");const os=require("os");const r={};
r.mem=fs.readFileSync("/sys/fs/cgroup/memory.max","utf8").trim();r.cpu=fs.readFileSync("/sys/fs/cgroup/cpu.max","utf8").trim();r.pids=fs.readFileSync("/sys/fs/cgroup/pids.max","utf8").trim();
r.ifaces=Object.keys(os.networkInterfaces()).join(",");r.status=fs.readFileSync("/proc/self/status","utf8").split("\\n").filter(l=>/^(CapEff|NoNewPrivs|Seccomp):/.test(l)).join(" ");
try{fs.writeFileSync("/x","1");r.rootfs="WRITABLE"}catch(e){r.rootfs=e.code}
const s=net.connect({host:"1.1.1.1",port:443,timeout:1500});s.on("error",e=>{r.net=e.code;done()});s.on("connect",()=>{r.net="CONNECTED";done()});s.on("timeout",()=>{r.net="TIMEOUT";done()});
function done(){console.log(JSON.stringify(r));process.exit(0)}`;
    try {
      const { id } = await driver.create({
        name, image: lock.runtimeImage.name, role: "preview",
        labels: { "agentos.store": "doctor", "agentos.role": "preview", "agentos.app": "doctor", "agentos.revision": "doctor", "agentos.instance": name, "agentos.boot": "doctor" },
        readOnlyMount: { hostPath: probeDir, containerPath: "/app" }, bridgeDir: bridge, command: ["node", "-e", script], env: { TZ: "UTC" }, limits: { ...RUNTIME_POLICY.app },
      });
      await driver.start(id);
      const st = await driver.wait(id, 20_000);
      const out = await driver.diagnostics(id, 4000);
      await driver.remove(id);
      const line = out.split("\n").find((l) => l.startsWith("{"));
      if (st.exitCode !== 0 || !line) add("probe container", false, `exit ${st.exitCode}: ${out.slice(-400)}`);
      else {
        const r = JSON.parse(line) as Record<string, string>;
        add("probe container", true, "started with the app policy");
        add("memory limit", r.mem === String(RUNTIME_POLICY.app.memoryBytes), r.mem);
        add("cpu limit", r.cpu === `${RUNTIME_POLICY.app.cpus * 100000} 100000`, r.cpu);
        add("pids limit", r.pids === String(RUNTIME_POLICY.app.pids), r.pids);
        add("no network", r.ifaces === "lo" && r.net !== "CONNECTED", `interfaces ${r.ifaces}; egress ${r.net}`);
        add("read-only rootfs", r.rootfs === "EROFS", r.rootfs);
        add("capabilities / no_new_privs / seccomp", /CapEff:\s+0+\b/.test(r.status) && /NoNewPrivs:\s+1/.test(r.status) && /Seccomp:\s+2/.test(r.status), r.status);
      }
    } catch (e) {
      add("probe container", false, (e as Error).message);
      await driver.remove(name).catch(() => undefined);
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
}

/** pnpm runtime:prefetch: build/verify every approved image of this platform from its recipe; report offline readiness. */
export async function prefetch(config: HostConfig): Promise<{ ok: boolean; locks: { runtimeLockId: string; builder: string; runtime: string; offlineReady: boolean; error?: string }[] }> {
  const catalog = loadCatalog(config);
  const problems = catalogProblems(config, catalog);
  if (problems.length > 0) throw new Error(`platform files do not match the catalog: ${problems.join("; ")}`);
  const driver = createDriver(config, catalog);
  if (!driver) throw new Error("AGENTOS_RUNTIME=off");
  const out = [];
  for (const l of catalog.locks()) {
    try {
      await driver.ensureImage({ ...l.builderImage, role: "builder", profileId: l.profileId }, { allowBuild: true });
      await driver.ensureImage({ ...l.runtimeImage, role: "runtime", profileId: l.profileId }, { allowBuild: true });
      out.push({ runtimeLockId: l.id, builder: l.builderImage.name, runtime: l.runtimeImage.name, offlineReady: true });
    } catch (e) {
      out.push({ runtimeLockId: l.id, builder: l.builderImage.name, runtime: l.runtimeImage.name, offlineReady: false, error: (e as Error).message });
    }
  }
  return { ok: out.every((o) => o.offlineReady), locks: out };
}

/** pnpm runtime:gc [-- --dry-run]: workspace-only, reference-checked cleanup (host stopped, lock held). */
export async function gc(config: HostConfig, dryRun: boolean, includeImages = false): Promise<unknown> {
  const core = openCore(path.join(config.dataDir, "os.sqlite"));
  try {
    const catalog = loadCatalog(config);
    const driver = createDriver(config, catalog);
    const own = core.store.meta().store_uuid;
    // Platform images are shared by every workspace of this user's engine: keep whatever another workspace claims.
    const claimed = (): Set<string> => {
      const dir = path.join(os.homedir(), ".local", "share", "agentos", "image-claims");
      const out = new Set<string>();
      if (!fs.existsSync(dir)) return out;
      for (const n of fs.readdirSync(dir)) {
        if (!n.endsWith(".json") || n === `${own}.json`) continue;
        try {
          const c = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as { images?: string[]; dataDir?: string };
          if (c.dataDir && !fs.existsSync(path.join(c.dataDir, "os.sqlite"))) continue;
          for (const i of c.images ?? []) out.add(i);
        } catch {
          return new Set(["*"]);
        }
      }
      return out;
    };
    const svc = new GcService(core.store, new ArtifactStore(path.join(config.dataDir, "artifacts")), driver, () => catalog.locks().flatMap((l) => [l.builderImage.name, l.runtimeImage.name]), () => new Set(), claimed);
    const plan = dryRun ? await svc.plan() : await svc.run({ includeImages });
    return { dryRun, includeImages, ...plan };
  } finally {
    core.store.close();
  }
}
