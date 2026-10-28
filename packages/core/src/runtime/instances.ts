import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { AgentOsError, RUNNER_ABI_VERSION, type CallPayload, type CodeBundle, type Frame, type HandlerContext, type ReadyPayload, type ResultPayload, type RuntimeLock } from "@agentos/contracts";
import { InstanceBridge } from "./bridge.js";
import type { RuntimeDriver } from "./driver.js";
import { RUNTIME_POLICY } from "./policy.js";
import type { ArtifactStore } from "../builds/artifact-store.js";

/** In-memory handle of one running app or preview container. Authority always comes from the database row. */
export interface LiveInstance {
  id: string;
  appId: string;
  revisionId: string;
  artifactId: string;
  generation: number;
  bootId: string;
  leaseDigest: string;
  containerName: string;
  containerId: string | null;
  bridge: InstanceBridge;
  bundle: CodeBundle;
  /** Set when the host withdrew this instance's right to serve; nothing it returns afterwards is used. */
  revoked: boolean;
  /** Intentional shutdown by the host (not a crash). */
  stopping: boolean;
  /** The host SIGKILLed it (timeout, failed probe): an exit 137 is then not a memory kill. */
  killedByHost: boolean;
  /** Set by the lifecycle owner when the container's exit was inspected (before removal). */
  exitInfo: { exitCode: number | null; oom: boolean } | null;
  dead: boolean;
  busy: boolean;
  queue: (() => void)[];
  lastProbeAt: number;
  currentCallId: string | null;
  /** Kind of the current top-level call; only queries may call services (spec §17.2). */
  callKind: "query" | "command" | "service" | null;
  serviceCalls: number;
  /** Grants used by the current query (re-checked before its result is returned). */
  usedGrants: string[];
  callDeadline: number;
  exitReason: string | null;
  logs: { level: string; text: string; at: string }[];
}

export interface LaunchSpec {
  id: string;
  appId: string;
  revisionId: string;
  artifactId: string;
  generation: number;
  bootId: string;
  containerName: string;
  role: "app" | "preview";
  bundle: CodeBundle;
  lock: RuntimeLock;
  storeUUID: string;
}

export type InstanceExitHandler = (inst: LiveInstance, reason: string) => void;
export type ServiceCallHandler = (inst: LiveInstance, frame: Frame) => Promise<unknown>;

export function leaseDigest(id: string, generation: number, bootId: string, challenge: string): string {
  return `sha256:${createHash("sha256").update(`${id}\n${generation}\n${bootId}\n${challenge}`).digest("hex")}`;
}

/**
 * Starts containers through the driver, performs the runner handshake (spec §7.2), and runs one top-level call at a
 * time per instance with a bounded queue (spec §11.3). It never decides what is active: callers check the database.
 */
export class InstanceHost {
  readonly live = new Map<string, LiveInstance>();
  onExit: InstanceExitHandler | null = null;
  onServiceCall: ServiceCallHandler | null = null;
  onContainerId: ((instanceId: string, containerId: string) => void) | null = null;

  constructor(
    private readonly driver: RuntimeDriver,
    private readonly artifacts: ArtifactStore,
    private readonly runDir: string,
    private readonly log?: (msg: string, fields?: Record<string, unknown>) => void,
  ) {}

  get(id: string): LiveInstance | undefined {
    return this.live.get(id);
  }

  async launch(spec: LaunchSpec): Promise<LiveInstance> {
    const bridgeDir = path.join(this.runDir, `i-${spec.id.slice(0, 12)}`);
    const challenge = randomBytes(16).toString("hex");
    const inst: LiveInstance = {
      id: spec.id,
      appId: spec.appId,
      revisionId: spec.revisionId,
      artifactId: spec.artifactId,
      generation: spec.generation,
      bootId: spec.bootId,
      leaseDigest: leaseDigest(spec.id, spec.generation, spec.bootId, challenge),
      containerName: spec.containerName,
      containerId: null,
      bridge: null as unknown as InstanceBridge,
      bundle: spec.bundle,
      revoked: false,
      stopping: false,
      killedByHost: false,
      exitInfo: null,
      dead: false,
      busy: false,
      queue: [],
      lastProbeAt: 0,
      currentCallId: null,
      callKind: null,
      serviceCalls: 0,
      usedGrants: [],
      callDeadline: 0,
      exitReason: null,
      logs: [],
    };
    inst.bridge = new InstanceBridge(bridgeDir, {
      onLog: (level, text) => {
        inst.logs.push({ level, text, at: new Date().toISOString() });
        if (inst.logs.length > 50) inst.logs.shift();
      },
      onServiceCall: (f) => void this.#serviceCall(inst, f),
      onClose: (reason) => this.#exited(inst, reason),
    });
    this.live.set(inst.id, inst);
    try {
      await inst.bridge.listen();
      try {
        await this.driver.ensureImage({ ...spec.lock.runtimeImage, role: "runtime", profileId: spec.lock.profileId }, { allowBuild: true });
      } catch (e) {
        throw new AgentOsError("IMAGE_UNAVAILABLE", `runtime image for ${spec.lock.id} is not available: ${(e as Error).message}`);
      }
      const { id: containerId } = await this.driver.create({
        name: spec.containerName,
        image: spec.lock.runtimeImage.name,
        role: spec.role,
        labels: {
          "agentos.store": spec.storeUUID,
          "agentos.role": spec.role,
          "agentos.app": spec.appId,
          "agentos.revision": spec.revisionId,
          "agentos.instance": spec.id,
          "agentos.boot": spec.bootId,
        },
        readOnlyMount: { hostPath: this.artifacts.dirOf(spec.artifactId), containerPath: "/app" },
        bridgeDir,
        command: ["node", "--disallow-code-generation-from-strings", "/opt/agentos/runner/runner.js"],
        env: {
          AGENTOS_SOCKET: "/run/agentos/host.sock",
          AGENTOS_INSTANCE_ID: spec.id,
          AGENTOS_REVISION_ID: spec.revisionId,
          AGENTOS_ABI: String(RUNNER_ABI_VERSION),
          TZ: "UTC",
          NODE_OPTIONS: "--max-old-space-size=192",
        },
        limits: { ...RUNTIME_POLICY.app },
      });
      inst.containerId = containerId;
      this.onContainerId?.(spec.id, containerId);
      await this.driver.start(containerId);
      await inst.bridge.waitConnected(RUNTIME_POLICY.handshakeTimeoutMs);
      const reply = await inst.bridge.request("hello", { challenge, instanceId: spec.id, revisionId: spec.revisionId, artifactId: spec.artifactId, mode: spec.role === "preview" ? "preview" : "active" }, RUNTIME_POLICY.handshakeTimeoutMs);
      this.#checkReady(inst, reply, challenge);
      inst.lastProbeAt = Date.now();
      return inst;
    } catch (e) {
      const tail = inst.containerId ? await this.driver.diagnostics(inst.containerId, 1024).catch(() => "") : "";
      const logs = inst.logs.map((l) => l.text).join("\n");
      await this.destroy(inst, "launch failed");
      if (e instanceof AgentOsError) throw e;
      throw new AgentOsError("INSTANCE_NOT_READY", `instance failed to start: ${(e as Error).message}`, { diagnostics: `${logs}\n${tail}`.trim().slice(-1500) });
    }
  }

  #checkReady(inst: LiveInstance, f: Frame, challenge: string): void {
    if (f.type !== "ready") throw new AgentOsError("ABI_MISMATCH", `expected ready, got ${f.type}`);
    const p = f.payload as Partial<ReadyPayload>;
    const manifest = this.artifacts.manifestOf(inst.artifactId);
    const problems: string[] = [];
    if (p.abiVersion !== RUNNER_ABI_VERSION) problems.push(`abi ${String(p.abiVersion)} != ${RUNNER_ABI_VERSION}`);
    if (p.instanceId !== inst.id) problems.push("instance id mismatch");
    if (p.revisionId !== inst.revisionId) problems.push("revision id mismatch");
    if (p.artifactId !== inst.artifactId) problems.push("artifact id mismatch");
    if (p.appSha256 !== manifest.files["app.mjs"]) problems.push("app.mjs hash mismatch");
    if (p.challenge !== challenge) problems.push("challenge mismatch");
    if (problems.length > 0) throw new AgentOsError("ABI_MISMATCH", `runner handshake rejected: ${problems.join("; ")}`);
    const want = { queries: Object.keys(inst.bundle.queries).sort(), commands: Object.keys(inst.bundle.commands).sort() };
    const got = { queries: [...(p.handlers?.queries ?? [])].sort(), commands: [...(p.handlers?.commands ?? [])].sort() };
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      throw new AgentOsError("UNKNOWN_HANDLER", `the module exports ${JSON.stringify(got)}, the bundle declares ${JSON.stringify(want)}`, { declared: want, exported: got });
    }
  }

  async #serviceCall(inst: LiveInstance, f: Frame): Promise<void> {
    const p = f.payload as { callId?: string };
    let payload: unknown;
    try {
      if (!this.onServiceCall) throw new AgentOsError("SERVICE_UNAVAILABLE", "services are not available");
      payload = await this.onServiceCall(inst, f);
    } catch (e) {
      const err = e instanceof AgentOsError ? { code: e.code, message: e.message } : { code: "SERVICE_UNAVAILABLE", message: (e as Error).message };
      payload = { callId: p?.callId ?? "", ok: false, error: err };
    }
    if (inst.bridge.connected && !inst.revoked) {
      try {
        inst.bridge.send("serviceResult", payload, f.messageId);
      } catch {
        /* connection went away */
      }
    }
  }

  #exited(inst: LiveInstance, reason: string): void {
    if (inst.dead) return;
    inst.dead = true;
    inst.exitReason = reason;
    for (const w of inst.queue.splice(0)) w();
    this.onExit?.(inst, reason);
  }

  /**
   * Run one call. Admission: one in flight per instance, queue up to 16 (immediate=true refuses when busy).
   * On timeout the call loses its commit right first, then the container is killed (spec §11.3).
   */
  async call(inst: LiveInstance, kind: "query" | "command", handlerId: string, input: unknown, context: HandlerContext, timeoutMs: number, opts: { immediate?: boolean; onTimeout?: () => void; asService?: boolean } = {}): Promise<unknown> {
    if (inst.revoked || inst.dead) throw new AgentOsError("INSTANCE_STALE", "this instance no longer serves calls");
    if (inst.busy) {
      if (opts.immediate) throw new AgentOsError("APP_BUSY", "the app is busy");
      if (inst.queue.length >= RUNTIME_POLICY.queueLimit) throw new AgentOsError("APP_BUSY", "the app's queue is full");
      await new Promise<void>((resolve) => inst.queue.push(resolve));
      if (inst.revoked || inst.dead) throw new AgentOsError("INSTANCE_STALE", "this instance no longer serves calls");
      if (Date.parse(context.deadline) <= Date.now()) throw new AgentOsError("APP_TIMEOUT", "the call deadline passed while queued");
    }
    inst.busy = true;
    inst.currentCallId = context.callId;
    inst.callKind = opts.asService ? "service" : kind;
    inst.serviceCalls = 0;
    inst.usedGrants = [];
    inst.callDeadline = Date.parse(context.deadline);
    try {
      const payload: CallPayload = { callId: context.callId, kind, handlerId, input, context };
      let reply: Frame;
      try {
        reply = await inst.bridge.request("call", payload, timeoutMs);
      } catch (e) {
        if ((e as { timeout?: boolean }).timeout) {
          inst.revoked = true;
          opts.onTimeout?.();
          await this.kill(inst, "call timeout");
          throw new AgentOsError("APP_TIMEOUT", `${kind} ${handlerId} exceeded ${timeoutMs} ms; the app was stopped`);
        }
        const until = Date.now() + 4000;
        while (!inst.exitInfo && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
        let info = inst.exitInfo;
        if (!info && inst.containerId) {
          const st = await this.driver.wait(inst.containerId, 1000).catch(() => null);
          if (st) info = { exitCode: st.exitCode, oom: st.oomKilled || (st.exitCode === 137 && !inst.killedByHost) };
        }
        if (info?.oom) throw new AgentOsError("APP_RESOURCE_LIMIT", `the app exceeded its memory limit and was stopped (exit ${info.exitCode})`);
        throw new AgentOsError("INSTANCE_STALE", `the app stopped during the call: ${(e as Error).message}${info ? ` (exit ${info.exitCode})` : ""}`);
      }
      if (inst.revoked) throw new AgentOsError("INSTANCE_STALE", "the instance was revoked during the call");
      const r = reply.payload as ResultPayload;
      if (reply.type !== "result" || r.callId !== context.callId) throw new AgentOsError("ABI_MISMATCH", "out-of-order result");
      if (!r.ok) {
        const code = r.error.code === "UNKNOWN_HANDLER" ? "UNKNOWN_HANDLER" : "INVALID_REQUEST";
        throw new AgentOsError(code, `${kind} ${handlerId} failed: ${String(r.error.message).slice(0, 500)}`, { appError: r.error.code });
      }
      return r.output;
    } finally {
      inst.busy = false;
      inst.currentCallId = null;
      inst.callKind = null;
      inst.queue.shift()?.();
    }
  }

  /** Liveness probe, only when idle (a busy instance is not killed for missing a probe). */
  async probe(inst: LiveInstance): Promise<boolean> {
    if (inst.dead || inst.revoked) return false;
    if (inst.busy) return true;
    try {
      const f = await inst.bridge.request("ping", {}, RUNTIME_POLICY.probeTimeoutMs);
      if (f.type !== "pong") return false;
      inst.lastProbeAt = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  async kill(inst: LiveInstance, reason: string): Promise<void> {
    inst.revoked = true;
    inst.killedByHost = true;
    try {
      await this.driver.kill(inst.containerId ?? inst.containerName);
    } catch (e) {
      this.log?.("container kill failed", { instance: inst.id, error: (e as Error).message });
    }
    inst.bridge.close(reason);
  }

  /** Revoke, stop and remove the container, delete the bridge directory. Idempotent. */
  async destroy(inst: LiveInstance, reason: string): Promise<void> {
    inst.revoked = true;
    inst.stopping = true;
    try {
      if (inst.bridge.connected) inst.bridge.send("shutdown", {});
    } catch {
      /* ignore */
    }
    inst.bridge.dispose();
    try {
      await this.driver.remove(inst.containerId ?? inst.containerName);
    } catch (e) {
      this.log?.("container removal failed; the reconciler retries", { instance: inst.id, reason, error: (e as Error).message });
    }
    if (!inst.dead) {
      inst.dead = true;
      inst.exitReason = reason;
    }
    this.live.delete(inst.id);
  }
}
