import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { BrokerClient, TelemetryClient, type BrokerResource } from "@agentos/broker-client";
import { BROKER_SOCKET, domainHash, sealEnvelope, sealGrant, type BrokerIdentity } from "@agentos/contracts";

/** Shared helpers for v0.3 tests against the REAL installed broker, workers, lab namespace and PTY fixture. */
export const POLICY = "/etc/agentos/broker/policy.json";
export const ROOT = path.resolve(import.meta.dirname, "..");

export interface InstalledPolicy {
  machineInstallId: string;
  hosts: { uid: number; storeUuid: string }[];
  managedRoots: { key: string; storeUuid: string; path: string; maxFileBytes: number; quotaBytes: number }[];
  units: { key: string; unit: string; cpuQuotaPerSecUSec: { min: number; max: number }; memoryMax: { min: number; max: number } }[];
  labNetworks: { key: string; netnsPath: string; table: string; peerAddress: string; peerPort: number }[];
  serial: { key: string; kind: string; path: string }[];
  testMode: boolean;
}

export function installed(): InstalledPolicy | null {
  try {
    return JSON.parse(fs.readFileSync(POLICY, "utf8")) as InstalledPolicy;
  } catch {
    return null;
  }
}

export const hasBroker = (): boolean => fs.existsSync(BROKER_SOCKET) && !!installed()?.testMode;
export const storeUUID = (): string => installed()!.hosts.find((h) => h.uid === process.getuid!())!.storeUuid;

export function sudo(args: string[], input?: string): string {
  const r = spawnSync("sudo", ["-n", ...args], { input, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`sudo ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** One-shot broker / worker fault point (test installs only). */
export function setFault(...names: string[]): void {
  sudo(["tee", "-a", "/etc/agentos/broker/faultpoints"], names.map((n) => `${n}\n`).join(""));
}
export function clearFaults(): void {
  sudo(["sh", "-c", ": > /etc/agentos/broker/faultpoints"]);
}

export function systemctl(...args: string[]): string {
  return sudo(["systemctl", ...args]);
}

export function unitActive(unit: string): string {
  return spawnSync("systemctl", ["is-active", unit], { encoding: "utf8" }).stdout.trim();
}

export async function waitUntil<T>(f: () => T | Promise<T>, ok: (v: T) => boolean, timeoutMs = 15_000, stepMs = 100): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let v: T | undefined;
    try {
      v = await f();
    } catch {
      v = undefined;
    }
    if (v !== undefined && ok(v)) return v;
    if (Date.now() > until) throw new Error(`timeout; last value ${JSON.stringify(v)?.slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Broker restarted by systemd after a fault point: wait until it answers again. */
export async function waitBroker(): Promise<void> {
  await waitUntil(async () => {
    const c = new BrokerClient({ storeUuid: storeUUID() });
    try {
      const h = await c.handshake({ machineInstallId: null, workspaceIncarnation: null });
      return h.brokerReady;
    } finally {
      c.close();
    }
  }, (x) => x === true, 20_000, 200);
}

export class Broker {
  client: BrokerClient;
  identity!: BrokerIdentity;
  resources: BrokerResource[] = [];
  constructor() {
    this.client = new BrokerClient({ storeUuid: storeUUID(), timeoutMs: 20_000 });
  }
  async open(): Promise<this> {
    const h = await this.client.handshake({ machineInstallId: null, workspaceIncarnation: null });
    if (!h.brokerReady) throw new Error(`broker not ready: ${h.diagnostic}`);
    this.identity = { machineInstallId: h.machineInstallId, storeUuid: storeUUID(), workspaceIncarnation: h.workspaceIncarnation! };
    this.resources = (await this.client.describe(this.identity)).resources;
    return this;
  }
  /** Test hygiene: release quarantines left by an earlier failed run (the unknown facts stay recorded). */
  async releaseQuarantines(): Promise<void> {
    await this.refresh();
    for (const r of this.resources) {
      if (r.quarantineOperationId) await this.client.operationResolve(this.identity, r.quarantineOperationId, "accept_unknown", { note: "test setup: leftover from an earlier run" }, true).catch(() => undefined);
    }
    await this.refresh();
  }
  async reopen(): Promise<this> {
    this.client.close();
    this.client = new BrokerClient({ storeUuid: storeUUID(), timeoutMs: 20_000 });
    return this.open();
  }
  res(kind: string): BrokerResource {
    const r = this.resources.find((x) => x.kind === kind);
    if (!r) throw new Error(`no installed ${kind}`);
    return r;
  }
  async refresh(): Promise<void> {
    this.resources = (await this.client.describe(this.identity)).resources;
  }
  async grant(kind: string, capabilityId: string, limits: Record<string, unknown>, opts: { paramsHash?: string | null; principal?: Record<string, string>; ttlMs?: number } = {}) {
    await this.refresh();
    const r = this.res(kind);
    const grantId = `pg_${randomBytes(10).toString("hex")}`;
    const g = sealGrant({
      identity: this.identity, grantId, grantVersion: 1, principal: (opts.principal ?? { kind: "app", appId: "test-app", revisionId: "sha256:" + "1".repeat(64) }) as never,
      capabilityId, contractVersion: 1, resourceId: r.resourceId, resourceGeneration: r.generation, limits, paramsHash: opts.paramsHash ?? null, expiresAtMs: Date.now() + (opts.ttlMs ?? 3_600_000),
    });
    const res = await this.client.grantSync(g);
    return { grantId, res, resource: r, body: g };
  }
  envelope(grant: { grantId: string; resource: BrokerResource }, capabilityId: string, params: Record<string, unknown>, extra: Partial<Record<string, unknown>> = {}) {
    const op = `op_${randomBytes(12).toString("hex")}`;
    return sealEnvelope({
      protocolVersion: 1, machineInstallId: this.identity.machineInstallId, storeUuid: this.identity.storeUuid, workspaceIncarnation: this.identity.workspaceIncarnation,
      operationId: op, actionId: `sa_${randomBytes(12).toString("hex")}`, planHash: domainHash("agentos.test-plan.v1", { op }), capabilityId, contractVersion: 1,
      resourceId: grant.resource.resourceId, resourceGeneration: grant.resource.generation, grantId: grant.grantId, grantVersion: 1, preconditions: {},
      deadlineMs: Date.now() + 30_000, params, compensatesOperationId: null, ...(extra as object),
    } as never);
  }
  async final(operationId: string, timeoutMs = 25_000) {
    return waitUntil(() => this.client.operationGet(this.identity, operationId), (o) => !["accepted", "running", "reconciling"].includes(o.state), timeoutMs, 150);
  }
  async run(kind: string, capabilityId: string, limits: Record<string, unknown>, params: Record<string, unknown>) {
    const g = await this.grant(kind, capabilityId, limits);
    const env = this.envelope(g, capabilityId, params);
    await this.client.submit(env);
    return { env, op: await this.final(env.operationId), grant: g };
  }
  async read(kind: string, capabilityId: string, params: Record<string, unknown> = {}) {
    const g = await this.grant(kind, capabilityId, {});
    return this.client.read({ identity: this.identity, grantId: g.grantId, capabilityId, contractVersion: 1, resourceId: g.resource.resourceId, resourceGeneration: g.resource.generation, params }, 5000);
  }
  close(): void {
    this.client.close();
  }
}

/** PTY fixture control channel (software protocol path only). */
export function simCtl(cmd: string): string {
  const r = spawnSync("python3", ["-c", `import socket,sys;s=socket.socket(socket.AF_UNIX);s.connect('/run/agentos-serial/sim0.ctl');s.sendall(b'${cmd}\\n');print(s.recv(4096).decode().strip())`], { encoding: "utf8" });
  return r.stdout.trim();
}

/** Run a command inside the lab namespace (test only, through sudo). */
export function inLab(cmd: string[]): { status: number | null; out: string } {
  const r = spawnSync("sudo", ["-n", "ip", "netns", "exec", "agentos-lab", ...cmd], { encoding: "utf8" });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

export function hostNetFacts(): string {
  // Host routes, DNS config and the global ruleset (outside the lab namespace) for before/after comparison.
  const routes = execFileSync("ip", ["route"], { encoding: "utf8" });
  const dns = fs.existsSync("/etc/resolv.conf") ? fs.readFileSync("/etc/resolv.conf", "utf8") : "";
  let nft = "";
  try {
    nft = sudo(["nft", "list", "ruleset"]);
  } catch {
    nft = "(nft unavailable)";
  }
  return `${routes}\n--\n${dns}\n--\n${nft}`;
}

export const telemetry = () => new TelemetryClient("/run/agentos-telemetry/telemetry.sock");
