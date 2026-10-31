import { domainHash } from "@agentos/contracts";
import net from "node:net";
import { randomBytes } from "node:crypto";
import {
  AgentOsError,
  BROKER_PROTOCOL_VERSION,
  BROKER_SOCKET,
  MAX_BROKER_FRAME,
  MAX_JSON_DEPTH,
  checkGrantSync,
  checkWriteEnvelope,
  jsonDepth,
  type BrokerIdentity,
  type BrokerMethod,
  type ErrorCode,
  type GrantSyncBody,
  type WriteEnvelope,
  BROKER_PROTOCOL_V2,
  BROKER_METHODS_V2,
  checkMaintenanceEnvelope,
  type BrokerMethodV2,
  type BrokerMaintenanceState,
  type MaintenanceControlBody,
  type MaintenancePolicySyncBody,
  type MaintenanceWriteEnvelope,
} from "@agentos/contracts";

/**
 * Typed local client for the privileged broker (spec §12.2). Only the fixed method set exists here; there is no
 * generic "call" or command channel. Frames are 4-byte big-endian length + JSON, at most 512 KiB, depth ≤ 8.
 */
export interface HandshakeResult {
  protocolVersion: number;
  brokerInstanceId: string;
  machineInstallId: string;
  policyVersion: string;
  bootId: string;
  testMode: boolean;
  brokerReady: boolean;
  workspaceIncarnation: number | null;
  workspaceState: "active" | "quiescing" | "fenced" | "restoring" | "unavailable";
  identityMismatch?: string[];
  diagnostic?: string | null;
  /** v0.4 brokers list [1, 2]; absent on a v0.3 broker (no maintenance principal available) */
  supportedProtocols?: number[];
}

export interface BrokerOperation {
  operationId: string;
  actionId: string;
  incarnation: number;
  state: string;
  completionKind: string | null;
  effectCertainty: "none" | "verified" | "unknown" | null;
  evidenceKind: string | null;
  evidence: unknown;
  result: unknown;
  error: { code: string; message: string } | null;
  resolution: unknown;
  capabilityId: string;
  resourceId: string;
  resourceGeneration: number;
  acceptedSeq: number;
  updatedSeq: number;
  requestHash: string;
  planHash: string;
  compensatesOperationId: string | null;
  deadlineMs: number;
  cancelRequested: boolean;
  reconcileAttempts: number;
  steps?: { step: string; attempt: number; at: number }[];
  /** protocol-2 attribution (job/step/policy) of a maintenance operation; null for protocol-1 operations */
  maintenance?: { protocolVersion: 2; jobId: string; stepId: string; policyId: string; policyVersion: number; maintenanceEpoch: number; targetControlEpoch: number; triggerKey: string; actionFamily: string } | null;
}

export class BrokerError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
  toAgentOs(): AgentOsError {
    const known = this.code as ErrorCode;
    try {
      return new AgentOsError(known, this.message, (this.details ?? undefined) as Record<string, unknown> | undefined);
    } catch {
      return new AgentOsError("BROKER_UNAVAILABLE", `${this.code}: ${this.message}`);
    }
  }
}

export interface BrokerClientOptions {
  socketPath?: string;
  storeUuid: string;
  timeoutMs?: number;
}

/** v1.0 protocol-3 workspace envelope (spec §14.3) without its hash; built by the Host's machine mode. */
export type WorkspaceEnvelopeV3 = Record<string, unknown>;
export const BROKER_PROTOCOL_V3 = 3;
export const BROKER_V3_DOMAIN = "agentos.broker.workspace-write.v3";
export const BROKER_METHODS_V3 = ["grant-sync", "grant-revoke", "submit", "operation-cancel", "operation-resolve", "maintenance-policy-sync", "maintenance-policy-revoke", "maintenance-control", "maintenance-submit"] as const;

export class BrokerClient {
  #sock: net.Socket | null = null;
  #buf: Buffer = Buffer.alloc(0);
  #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }>();
  #seq = 0;
  #connecting: Promise<HandshakeResult> | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  handshakeResult: HandshakeResult | null = null;
  readonly socketPath: string;

  /**
   * v1.0: when set (machine mode), every write method travels as protocol 3 wrapped in the workspace envelope this
   * returns; returning null refuses to send the write at all (never a silent downgrade to protocol 1/2).
   */
  v3: ((method: string, params: unknown) => WorkspaceEnvelopeV3 | null) | null = null;
  /**
   * Machine mode: a registered workspace accepts only protocol-3 writes. Until `v3` is installed (after the first
   * registry pull) a write is held back as BROKER_UNAVAILABLE (callers retry the same frozen request) instead of going
   * out as protocol 2 and being refused for good. m3 run 41203693428: a control replayed right after a Host restart
   * went out before the member authority was loaded and failed with "legacy protocol cannot write".
   */
  v3Required = false;

  constructor(readonly opts: BrokerClientOptions) {
    this.socketPath = opts.socketPath ?? process.env.AGENTOS_BROKER_SOCKET ?? BROKER_SOCKET;
  }

  get connected(): boolean {
    return this.#sock !== null && !this.#sock.destroyed;
  }

  close(): void {
    this.#sock?.destroy();
    this.#sock = null;
    this.handshakeResult = null;
  }

  async #open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const s = net.createConnection({ path: this.socketPath });
      const fail = (e: Error) => {
        s.destroy();
        reject(new BrokerError("BROKER_UNAVAILABLE", `broker socket: ${e.message}`));
      };
      s.once("error", fail);
      s.once("connect", () => {
        s.off("error", fail);
        this.#sock = s;
        this.#buf = Buffer.alloc(0);
        s.on("data", (c: Buffer) => this.#onData(c));
        s.on("close", () => this.#onClose());
        s.on("error", () => this.#onClose());
        resolve();
      });
    });
  }

  #onClose(): void {
    this.#sock = null;
    this.handshakeResult = null;
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new BrokerError("BROKER_UNAVAILABLE", "broker connection closed before the reply; the request may have been received"));
    }
    this.#pending.clear();
  }

  #onData(chunk: Buffer): void {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    for (;;) {
      if (this.#buf.length < 4) return;
      const len = this.#buf.readUInt32BE(0);
      if (len > MAX_BROKER_FRAME) {
        this.#sock?.destroy();
        return;
      }
      if (this.#buf.length < 4 + len) return;
      const text = this.#buf.subarray(4, 4 + len).toString("utf8");
      this.#buf = this.#buf.subarray(4 + len);
      let msg: { id?: string; ok?: boolean; result?: unknown; error?: { code: string; message: string; details?: unknown } };
      try {
        msg = JSON.parse(text);
      } catch {
        this.#sock?.destroy();
        return;
      }
      const p = this.#pending.get(String(msg.id ?? ""));
      if (!p) {
        // Error frames without an id (refused connection) fail every waiter.
        if (msg.ok === false && msg.error) for (const [, w] of this.#pending) w.reject(new BrokerError(msg.error.code, msg.error.message, msg.error.details));
        continue;
      }
      this.#pending.delete(String(msg.id));
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new BrokerError(msg.error?.code ?? "BROKER_UNAVAILABLE", msg.error?.message ?? "broker error", msg.error?.details));
    }
  }

  #send(method: BrokerMethod | BrokerMethodV2, params: unknown, timeoutMs?: number): Promise<unknown> {
    // eslint-disable-next-line no-param-reassign
    const s = this.#sock;
    if (!s) return Promise.reject(new BrokerError("BROKER_UNAVAILABLE", "not connected"));
    const id = String(++this.#seq);
    // Protocol-2 methods always travel as v=2; protocol-1 methods as v=1 (never downgraded, spec §13.3).
    let v: number = (BROKER_METHODS_V2 as readonly string[]).includes(method) ? BROKER_PROTOCOL_V2 : BROKER_PROTOCOL_VERSION;
    if (!this.v3 && this.v3Required && (BROKER_METHODS_V3 as readonly string[]).includes(method)) {
      return Promise.reject(new BrokerError("BROKER_UNAVAILABLE", `${method}: the workspace's member authority is not loaded yet; not sent (retried as protocol 3, never downgraded)`));
    }
    if (this.v3 && (BROKER_METHODS_V3 as readonly string[]).includes(method)) {
      const w = this.v3(method, params);
      if (!w) return Promise.reject(new BrokerError("MEMBERSHIP_REVOKED", `no current member authority for ${method}; the write is not sent`));
      const envelopeHash = domainHash(BROKER_V3_DOMAIN, { workspace: w, body: params });
      params = { workspace: { ...w, envelopeHash }, body: params };
      v = BROKER_PROTOCOL_V3;
    }
    const body = JSON.stringify({ v, id, method, params });
    if (Buffer.byteLength(body) > MAX_BROKER_FRAME) return Promise.reject(new BrokerError("LIMIT_EXCEEDED", "broker request exceeds 512 KiB"));
    if (jsonDepth(body) > MAX_JSON_DEPTH) return Promise.reject(new BrokerError("INVALID_SYSTEM_PLAN", "broker request is nested deeper than 8"));
    const head = Buffer.alloc(4);
    head.writeUInt32BE(Buffer.byteLength(body), 0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BrokerError("BROKER_UNAVAILABLE", `broker did not answer ${method} in time; the request may have been received`));
      }, timeoutMs ?? this.opts.timeoutMs ?? 10_000);
      this.#pending.set(id, { resolve, reject, timer });
      s.write(Buffer.concat([head, Buffer.from(body)]));
    });
  }

  /** Connect (if needed) and run the handshake; the result binds this connection to the workspace. */
  async handshake(expected: { machineInstallId: string | null; workspaceIncarnation: number | null }): Promise<HandshakeResult> {
    if (!this.connected) {
      this.handshakeResult = null;
      await this.#open();
    }
    const r = (await this.#send("handshake", {
      protocolVersion: BROKER_PROTOCOL_VERSION,
      storeUuid: this.opts.storeUuid,
      machineInstallId: expected.machineInstallId,
      workspaceIncarnation: expected.workspaceIncarnation,
      clientNonce: randomBytes(8).toString("hex"),
    })) as HandshakeResult;
    this.handshakeResult = r;
    return r;
  }

  /** Serialize calls on the single connection. */
  #call<T>(method: BrokerMethod | BrokerMethodV2, params: unknown, timeoutMs?: number): Promise<T> {
    const run = async () => {
      if (!this.connected || !this.handshakeResult) throw new BrokerError("BROKER_UNAVAILABLE", "broker not connected; handshake first");
      return (await this.#send(method, params, timeoutMs)) as T;
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => undefined);
    return p;
  }

  describe(identity: BrokerIdentity) {
    return this.#call<{ resources: BrokerResource[]; policyVersion: string; machineInstallId: string }>("describe", { identity }, 15_000);
  }
  read(p: { identity: BrokerIdentity; grantId: string; capabilityId: string; contractVersion: number; resourceId: string; resourceGeneration: number; params: Record<string, unknown> }, timeoutMs = 3000) {
    return this.#call<{ resourceId: string; resourceGeneration: number; observedAt: number; data: unknown }>("read", p, timeoutMs);
  }
  grantSync(g: GrantSyncBody) {
    const why = checkGrantSync(g);
    if (why) return Promise.reject(new BrokerError("INVALID_SYSTEM_PLAN", why));
    return this.#call<{ grantId: string; grantVersion: number; state: string; seq?: number; replayed?: boolean }>("grant-sync", g);
  }
  grantRevoke(identity: BrokerIdentity, grantId: string, grantVersion: number) {
    return this.#call<{ grantId: string; state: string; revokedSeq: number }>("grant-revoke", { identity, grantId, grantVersion });
  }
  submit(env: WriteEnvelope) {
    const why = checkWriteEnvelope(env);
    if (why) return Promise.reject(new BrokerError("INVALID_SYSTEM_PLAN", why));
    return this.#call<BrokerOperation>("submit", env);
  }
  operationGet(identity: BrokerIdentity, operationId: string) {
    return this.#call<BrokerOperation>("operation-get", { identity, operationId });
  }
  operationCancel(identity: BrokerIdentity, operationId: string, reason: string) {
    return this.#call<Partial<BrokerOperation> & { state: string; tombstone?: boolean }>("operation-cancel", { identity, operationId, reason });
  }
  operationResolve(identity: BrokerIdentity, operationId: string, decision: "confirmed_applied" | "confirmed_not_applied" | "accept_unknown", observedEvidence: Record<string, unknown>, releaseQuarantine: boolean) {
    return this.#call<BrokerOperation>("operation-resolve", { identity, operationId, decision, observedEvidence, releaseQuarantine });
  }
  historySync(machineInstallId: string, sinceSeq: number, limit = 200) {
    return this.#call<{ operations: BrokerOperation[]; lastSeq: number }>("history-sync", { storeUuid: this.opts.storeUuid, machineInstallId, sinceSeq, limit });
  }
  quiesce(identity: BrokerIdentity, reason: string, timeoutMs: number) {
    return this.#call<{ state: string; checkpointSeq: number; workspaceIncarnation: number; machineInstallId: string; indeterminate: { operationId: string; resourceId: string }[]; acceptedNotAdmitted: string[]; fileWorkerIdle: boolean }>(
      "workspace-quiesce", { identity, reason, timeoutMs }, timeoutMs + 5000);
  }
  resume(identity: BrokerIdentity) {
    return this.#call<{ state: string; seq: number }>("workspace-resume", { identity });
  }
  restoreBegin(machineInstallId: string, restoreRequestId: string, sourceIncarnation: number | null) {
    return this.#call<RestoreSession>("restore-begin", { storeUuid: this.opts.storeUuid, machineInstallId, restoreRequestId, sourceIncarnation }, 70_000);
  }
  restoreStatus(machineInstallId: string, restoreRequestId: string) {
    return this.#call<RestoreSession>("restore-status", { storeUuid: this.opts.storeUuid, machineInstallId, restoreRequestId });
  }
  restoreComplete(machineInstallId: string, restoreRequestId: string) {
    return this.#call<RestoreSession>("restore-complete", { storeUuid: this.opts.storeUuid, machineInstallId, restoreRequestId });
  }

  // ------------------------------------------------------------ protocol 2: maintenance principal (v0.4)

  /** true when the connected broker speaks protocol 2 */
  get maintenanceCapable(): boolean {
    return !!this.handshakeResult?.supportedProtocols?.includes(BROKER_PROTOCOL_V2);
  }
  #needV2(): void {
    if (!this.maintenanceCapable) throw new BrokerError("CAPABILITY_VERSION_UNSUPPORTED", "the broker does not speak protocol 2 (maintenance); no maintenance write is sent");
  }
  async maintenancePolicySync(b: MaintenancePolicySyncBody) {
    this.#needV2();
    return this.#call<{ policyId: string; policyVersion: number; state: string; seq?: number; replayed?: boolean }>("maintenance-policy-sync", b);
  }
  async maintenancePolicyRevoke(identity: BrokerIdentity, policyId: string, policyVersion: number) {
    this.#needV2();
    return this.#call<{ policyId: string; policyVersion: number; state: string; revokedSeq: number }>("maintenance-policy-revoke", { identity, policyId, policyVersion });
  }
  async maintenanceControl(b: MaintenanceControlBody) {
    this.#needV2();
    return this.#call<{ state: string; maintenanceEpoch: number; applied: boolean; targetControlEpoch: number | null; seq: number }>("maintenance-control", b);
  }
  async maintenanceState(identity: BrokerIdentity) {
    this.#needV2();
    return this.#call<BrokerMaintenanceState>("maintenance-state", { identity });
  }
  async maintenanceSubmit(env: MaintenanceWriteEnvelope) {
    this.#needV2();
    const why = checkMaintenanceEnvelope(env);
    if (why) throw new BrokerError("INVALID_SYSTEM_PLAN", why);
    return this.#call<BrokerOperation>("maintenance-submit", env);
  }
}

export interface RestoreSession {
  restoreRequestId: string;
  storeUUID: string;
  sourceIncarnation: number | null;
  previousIncarnation: number;
  targetIncarnation: number;
  checkpointSeq: number;
  phase: "fenced" | "complete";
}

export interface BrokerResource {
  resourceId: string;
  kind: "managed-root" | "service" | "lab-network" | "serial";
  catalogKey: string;
  displayName: string;
  generation: number;
  status: string;
  identityDigest: string | null;
  version: string | null;
  details: unknown;
  limits: Record<string, unknown>;
  quarantineOperationId: string | null;
  error: { code: string; message: string } | null;
}

/** Telemetry collector client: status, workload registration and the event subscription. */
export class TelemetryClient {
  constructor(readonly socketPath: string) {}

  #oneShot<T>(req: unknown, timeoutMs = 3000): Promise<T> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ path: this.socketPath });
      let buf = Buffer.alloc(0);
      const t = setTimeout(() => {
        s.destroy();
        reject(new BrokerError("TELEMETRY_UNAVAILABLE", "telemetry collector did not answer"));
      }, timeoutMs);
      s.once("error", (e) => {
        clearTimeout(t);
        reject(new BrokerError("TELEMETRY_UNAVAILABLE", `telemetry socket: ${e.message}`));
      });
      s.on("connect", () => {
        const body = Buffer.from(JSON.stringify(req));
        const h = Buffer.alloc(4);
        h.writeUInt32BE(body.length, 0);
        s.write(Buffer.concat([h, body]));
      });
      s.on("data", (c: Buffer) => {
        buf = Buffer.concat([buf, c]);
        if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
          clearTimeout(t);
          const m = JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0)).toString("utf8")) as { ok: boolean; result?: T; error?: { code: string; message: string } };
          s.destroy();
          if (m.ok) resolve(m.result as T);
          else reject(new BrokerError(m.error?.code ?? "TELEMETRY_UNAVAILABLE", m.error?.message ?? "telemetry error"));
        }
      });
    });
  }

  status() {
    return this.#oneShot<{ available: boolean; reason: string; sourceEpoch: string; lastSeq: number; kernelDrops: number; userDrops: number; unattributed: number; objectSha256: string; ringBytes: number; bootId: string; workloads: { workloadKey: string; kind: string; cgroupId: number; generation: number }[]; testMode: boolean }>({ op: "status" });
  }
  register(workloadKey: string, cgroupPath: string, kind: "unit" | "app-instance") {
    return this.#oneShot<{ workloadKey: string; cgroupId: number; workloadGeneration: number; available: boolean }>({ op: "register", workloadKey, cgroupPath, kind });
  }
  unregister(workloadKey: string) {
    return this.#oneShot<Record<string, never>>({ op: "unregister", workloadKey });
  }
  testControl(op: "test-pause" | "test-detach", ms?: number) {
    return this.#oneShot<Record<string, never>>({ op, ms });
  }

  /** Long-lived subscription. Returns a stop function. */
  subscribe(since: { sourceEpoch: string | null; sinceSeq: number }, onFrame: (f: Record<string, unknown>) => void, onEnd: (why: string) => void): () => void {
    const s = net.createConnection({ path: this.socketPath });
    let buf = Buffer.alloc(0);
    let ended = false;
    const end = (why: string) => {
      if (ended) return;
      ended = true;
      s.destroy();
      onEnd(why);
    };
    s.on("connect", () => {
      const body = Buffer.from(JSON.stringify({ op: "subscribe", sinceSeq: since.sinceSeq, sourceEpoch: since.sourceEpoch }));
      const h = Buffer.alloc(4);
      h.writeUInt32BE(body.length, 0);
      s.write(Buffer.concat([h, body]));
    });
    s.on("data", (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len > MAX_BROKER_FRAME) return end("frame too large");
        if (buf.length < 4 + len) return;
        const f = JSON.parse(buf.subarray(4, 4 + len).toString("utf8")) as Record<string, unknown>;
        buf = buf.subarray(4 + len);
        onFrame(f);
      }
    });
    s.on("error", (e) => end(e.message));
    s.on("close", () => end("closed"));
    return () => end("stopped");
  }
}
