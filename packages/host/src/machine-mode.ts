/**
 * v1.0 machine mode (spec §8, §9, §13, §14): one Host per workspace execution UID.
 *  - MachineLink: control socket to agentos-machined. The kernel peer UID proves which workspace this Host is;
 *    the Host never names a user. Registry messages (membership, revocation, barriers) are applied in os.sqlite
 *    before they are acked, so the ack means "this Host now enforces it" (spec §7.3).
 *  - GatewayLink: the Host dials the root-owned gateway socket; requests arrive only from that root process and run
 *    inside the trusted identity context through fastify.inject. No TCP port is opened in this mode.
 *  - Machine permits for model requests (ModelBudgets.machineGate).
 */
import net from "node:net";
import fs from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { identityContext, type Core, type MachineGate, type WorkspaceIdentity } from "@agentos/core";
import type { HostRuntime } from "./http.js";
import type { Logger } from "./log.js";

const MAX_FRAME = 4 * 1024 * 1024;

/** 4-byte big-endian length + UTF-8 JSON, the framing of machined, gateway and native-rpc/1. */
class FrameConn {
  #sock: net.Socket;
  #buf = Buffer.alloc(0);
  onFrame: (v: unknown) => void = () => {};
  onClose: () => void = () => {};
  constructor(path: string) {
    this.#sock = net.createConnection(path);
    this.#sock.on("data", (d) => {
      this.#buf = Buffer.concat([this.#buf, d]);
      for (;;) {
        if (this.#buf.length < 4) return;
        const n = this.#buf.readUInt32BE(0);
        if (n > MAX_FRAME) {
          this.#sock.destroy();
          return;
        }
        if (this.#buf.length < 4 + n) return;
        const body = this.#buf.subarray(4, 4 + n);
        this.#buf = this.#buf.subarray(4 + n);
        try {
          this.onFrame(JSON.parse(body.toString("utf8")));
        } catch {
          this.#sock.destroy();
          return;
        }
      }
    });
    this.#sock.on("close", () => this.onClose());
    this.#sock.on("error", () => {});
  }
  ready(): Promise<void> {
    return new Promise((res, rej) => {
      this.#sock.once("connect", () => res());
      this.#sock.once("error", rej);
    });
  }
  send(v: unknown): void {
    const b = Buffer.from(JSON.stringify(v), "utf8");
    const h = Buffer.alloc(4);
    h.writeUInt32BE(b.length, 0);
    this.#sock.write(Buffer.concat([h, b]));
  }
  close(): void {
    this.#sock.destroy();
  }
}

export class MachineCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Serialized request/response client of machined (one request in flight per connection). */
export class MachineLink {
  #conn: FrameConn | null = null;
  #queue: { op: string; args: unknown; res: (v: unknown) => void; rej: (e: Error) => void }[] = [];
  #busy = false;
  #waiting: { res: (v: unknown) => void; rej: (e: Error) => void } | null = null;
  constructor(readonly socket: string) {}

  async #connect(): Promise<FrameConn> {
    if (this.#conn) return this.#conn;
    const c = new FrameConn(this.socket);
    await c.ready();
    c.onFrame = (v) => {
      const w = this.#waiting;
      this.#waiting = null;
      const r = v as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
      if (w) r.ok ? w.res(r.data) : w.rej(new MachineCallError(r.error?.code ?? "INTERNAL", r.error?.message ?? "machine error"));
      this.#busy = false;
      this.#pump();
    };
    c.onClose = () => {
      this.#conn = null;
      const w = this.#waiting;
      this.#waiting = null;
      this.#busy = false;
      w?.rej(new MachineCallError("STORE_UNAVAILABLE", "machine service connection closed"));
      this.#pump();
    };
    this.#conn = c;
    return c;
  }

  call<T = unknown>(op: string, args: unknown = {}): Promise<T> {
    return new Promise<T>((res, rej) => {
      this.#queue.push({ op, args, res: res as (v: unknown) => void, rej });
      this.#pump();
    });
  }

  #pump(): void {
    if (this.#busy) return;
    const next = this.#queue.shift();
    if (!next) return;
    this.#busy = true;
    this.#connect()
      .then((c) => {
        this.#waiting = { res: next.res, rej: next.rej };
        c.send({ op: next.op, args: next.args });
      })
      .catch((e: Error) => {
        this.#busy = false;
        next.rej(new MachineCallError("STORE_UNAVAILABLE", `machine service unreachable: ${e.message}`));
        setTimeout(() => this.#pump(), 200);
      });
  }
}

export interface MachineModeConfig {
  workspaceId: string;
  storeUUID: string;
  machineSocket: string;
  gatewaySocket: string;
}

export function machineModeFromEnv(env: NodeJS.ProcessEnv): MachineModeConfig | null {
  if (env.AGENTOS_MACHINE_MODE !== "1") return null;
  const ws = env.AGENTOS_WORKSPACE_ID ?? "";
  const store = env.AGENTOS_STORE_UUID ?? "";
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  // storeUUID is optional here: start() takes it from machined's registration and requires os.sqlite to match.
  if (!uuid.test(ws) || (store !== "" && !uuid.test(store))) throw new Error("machine mode needs AGENTOS_WORKSPACE_ID (and a valid AGENTOS_STORE_UUID if given)");
  return {
    workspaceId: ws,
    storeUUID: store,
    machineSocket: env.AGENTOS_MACHINE_SOCKET || "/run/agentos/machine/machine.sock",
    gatewaySocket: env.AGENTOS_GATEWAY_HOST_SOCKET || "/run/agentos/gateway/host.sock",
  };
}

type RegistryMessage = { registrySeq: number; kind: string; body: Record<string, unknown> };
type MemberRow = { userId: string; role: string; memberVersion: number; state: string };

/** Apply one registry message in a single workspace transaction (spec §7.3, §15.3). */
export function applyRegistry(core: Core, rt: HostRuntime, m: RegistryMessage, log: Logger): void {
  const s = core.store;
  const now = new Date().toISOString();
  const snapshot = (members: MemberRow[] | undefined) => {
    for (const x of members ?? []) {
      s.run(
        "INSERT INTO membership_mirror (user_id, member_version, role, state, registry_seq) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET member_version = excluded.member_version, role = excluded.role, state = excluded.state, registry_seq = excluded.registry_seq WHERE excluded.registry_seq >= membership_mirror.registry_seq",
        x.userId, x.memberVersion, x.role, x.state, m.registrySeq,
      );
    }
  };
  /** Close every future right of one user here: runs, pending plans, approvals (spec §7.3, V1-I06/I07/I09). */
  const fenceUser = (userId: string, reason: string) => {
    const runs = s.all<{ id: string }>("SELECT id FROM runs WHERE initiator_user_id = ? AND status IN ('queued','running','blocked')", userId);
    s.run("UPDATE maintenance_policies SET state = 'paused_needs_review' WHERE approved_user_id = ? AND state IN ('enabled','syncing','pending_approval')", userId);
    s.event("membership.revoking", { userId, reason, runs: runs.map((r) => r.id) });
    return runs.map((r) => r.id);
  };
  let toStop: string[] = [];
  s.tx(() => {
    switch (m.kind) {
      case "members.snapshot":
      case "workspace.incarnation":
        snapshot(m.body.members as MemberRow[]);
        break;
      case "member.revoking": {
        snapshot(m.body.members as MemberRow[]);
        const uid = String(m.body.revokedUserId);
        toStop = fenceUser(uid, "member_revoked");
        s.run("INSERT OR IGNORE INTO revocation_receipts (revocation_id, member_version, recorded_at) VALUES (?, ?, ?)", String(m.body.revocationId), Number(m.body.newMemberVersion), now);
        break;
      }
      case "owner.changed": {
        snapshot(m.body.members as MemberRow[]);
        // Approvals given by the former owner need the new owner's review (spec V1-I09).
        const from = String(m.body.ownerChangedFrom);
        s.run("UPDATE maintenance_policies SET state = 'paused_needs_review' WHERE approved_user_id = ? AND state IN ('enabled','syncing','pending_approval')", from);
        break;
      }
      case "user.disabled": {
        const uid = String(m.body.userId);
        s.run("UPDATE membership_mirror SET state = 'revoked', member_version = member_version + 1, registry_seq = ? WHERE user_id = ?", m.registrySeq, uid);
        toStop = fenceUser(uid, "account_disabled");
        s.run("INSERT OR IGNORE INTO revocation_receipts (revocation_id, member_version, recorded_at) VALUES (?, ?, ?)", String(m.body.revocationId), Number(m.body.authVersion), now);
        break;
      }
      case "barrier.held":
        s.event("barrier.held", { barrierId: m.body.barrierId });
        break;
      case "barrier.released":
        s.event("barrier.released", { barrierId: m.body.barrierId });
        break;
      case "workspace.settings":
      case "workspace.quiesce":
        s.event(m.kind, m.body);
        break;
      default:
        break;
    }
  });
  for (const r of toStop) core.runs.requestStop(r, "membership_revoked");
  if (m.kind === "barrier.held") {
    core.scheduler.paused = true;
    rt.barrier = String(m.body.barrierId);
  } else if (m.kind === "barrier.released") {
    rt.barrier = null;
    core.scheduler.paused = false;
  }
  if (toStop.length) {
    void rt.coord?.kick();
    log.info("membership fence applied", { kind: m.kind, runs: toStop.length });
  }
}

export class MachineMode {
  readonly link: MachineLink;
  readonly instanceId = randomUUID();
  readonly bridgeSecret = randomBytes(32).toString("hex");
  #gw: FrameConn | null = null;
  #stopped = false;
  #lastEventSeq = 0;
  #ring: { seq: number; frame: Record<string, unknown> }[] = [];

  constructor(
    readonly cfg: MachineModeConfig,
    readonly rt: HostRuntime,
    readonly server: FastifyInstance,
  ) {
    this.link = new MachineLink(cfg.machineSocket);
  }

  bootId(): string {
    try {
      return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      return "unknown";
    }
  }

  async start(): Promise<void> {
    const { core, log } = this.rt;
    const self = await this.link.call<{ workspaceId: string; storeUUID: string }>("workspace.self", {});
    if (self.workspaceId !== this.cfg.workspaceId) throw new Error("machined registers this execution UID for another workspace");
    if (this.cfg.storeUUID && this.cfg.storeUUID !== self.storeUUID) throw new Error("AGENTOS_STORE_UUID differs from the machine registration");
    this.cfg.storeUUID = self.storeUUID;
    if (this.rt.machine) this.rt.machine.storeUUID = self.storeUUID;
    const meta = core.store.get<{ workspace_id: string | null; store_uuid: string }>("SELECT workspace_id, store_uuid FROM meta WHERE id = 1");
    if (!meta || meta.store_uuid !== this.cfg.storeUUID || meta.workspace_id !== this.cfg.workspaceId) {
      throw new Error("os.sqlite does not belong to the registered workspace (storeUUID/workspaceId mismatch)");
    }
    const hello = await this.link.call<{ membership: { members: MemberRow[]; machineControlEpoch?: number; workspaceIncarnation?: number } }>("host.hello", { instanceId: this.instanceId, bootId: this.bootId() });
    this.controlEpoch = hello.membership.machineControlEpoch ?? 1;
    this.incarnation = hello.membership.workspaceIncarnation ?? 1;
    applyRegistry(core, this.rt, { registrySeq: 0, kind: "members.snapshot", body: { members: hello.membership.members } }, log);
    core.budgets.machineGate = this.gate();
    this.#ringStoreSeq = core.store.eventSeq();
    void this.#registryLoop();
    this.#dialGateway();
    setInterval(() => this.#pumpEvents(), 250).unref();
  }

  async #registryLoop(): Promise<void> {
    const { core, log } = this.rt;
    while (!this.#stopped) {
      try {
        const r = await this.link.call<{ messages: RegistryMessage[] }>("registry.pull", {});
        let last = 0;
        for (const m of r.messages) {
          applyRegistry(core, this.rt, m, log);
          last = m.registrySeq;
          this.registrySeq = Math.max(this.registrySeq, m.registrySeq);
          const b = m.body as { machineControlEpoch?: number; workspaceIncarnation?: number };
          if (typeof b.machineControlEpoch === "number") this.controlEpoch = b.machineControlEpoch;
          if (typeof b.workspaceIncarnation === "number") this.incarnation = b.workspaceIncarnation;
        }
        // Protocol-3 broker writes once the system layer exists (spec §14.3).
        if (this.rt.caps && !this.rt.caps.broker.client.v3) this.rt.caps.broker.client.v3 = (method, params) => this.v3Envelope(method, params);
        if (last) await this.link.call("registry.ack", { registrySeq: last });
      } catch (e) {
        log.warn("machine registry unavailable", { error: (e as Error).message });
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  #dialGateway(): void {
    if (this.#stopped) return;
    const c = new FrameConn(this.cfg.gatewaySocket);
    c.ready()
      .then(() => {
        this.#gw = c;
        c.send({ t: "hello", workspaceId: this.cfg.workspaceId, storeUUID: this.cfg.storeUUID, clientEpoch: this.rt.core.store.meta().client_epoch, instanceId: this.instanceId });
      })
      .catch(() => {});
    c.onFrame = (v) => void this.#onGateway(c, v as Record<string, unknown>);
    c.onClose = () => {
      if (this.#gw === c) this.#gw = null;
      setTimeout(() => this.#dialGateway(), 500);
    };
  }

  async #onGateway(c: FrameConn, v: Record<string, unknown>): Promise<void> {
    if (v.t !== "req") return;
    const id = v.id;
    const clientEpoch = this.rt.core.store.meta().client_epoch;
    if (v.method === "EVENTS") {
      const after = Number((v.body as { after?: number } | null)?.after ?? 0);
      const oldest = this.#ring[0]?.seq ?? this.#lastEventSeq + 1;
      const gap = after + 1 < oldest && after < this.#lastEventSeq;
      if (!gap) for (const e of this.#ring) if (e.seq > after) c.send(e.frame);
      c.send({ t: "res", id, status: gap ? 410 : 200, body: { gap }, clientEpoch });
      return;
    }
    const p = v.principal as Record<string, unknown>;
    const ident: WorkspaceIdentity = {
      kind: "user",
      userId: String(p.userId),
      workspaceId: String(p.workspaceId),
      storeUUID: String(p.storeUUID),
      memberVersion: Number(p.memberVersion),
      role: p.role as WorkspaceIdentity["role"],
      sessionId: String(p.sessionId),
      sessionEpoch: Number(p.sessionEpoch),
      workspaceIncarnation: Number(p.workspaceIncarnation),
      requestId: String(v.requestId),
    };
    if (ident.workspaceId !== this.cfg.workspaceId || ident.storeUUID !== this.cfg.storeUUID) {
      c.send({ t: "res", id, status: 404, body: { error: { code: "NOT_FOUND_OR_FORBIDDEN", message: "not found" } }, clientEpoch });
      return;
    }
    if (this.rt.barrier && v.method !== "GET") {
      c.send({ t: "res", id, status: 503, body: { error: { code: "CHECKPOINT_INCOMPLETE", message: "a machine barrier holds writes; try again after it is released" } }, clientEpoch });
      return;
    }
    const headers: Record<string, string> = { "x-agentos-bridge": this.bridgeSecret, host: "agentos.bridge", "x-agentos-epoch": String(v.clientEpoch ?? clientEpoch) };
    if (typeof v.idempotencyKey === "string") headers["idempotency-key"] = v.idempotencyKey;
    let url = String(v.path);
    if (!url.startsWith("/") || url.includes("..") || url.includes("?")) {
      c.send({ t: "res", id, status: 400, body: { error: { code: "INVALID_REQUEST", message: "bad path" } }, clientEpoch });
      return;
    }
    url = `/api${url}`;
    if (v.query && typeof v.query === "object") {
      const q = new URLSearchParams();
      for (const [k, val] of Object.entries(v.query as Record<string, unknown>)) if (val !== undefined && val !== null) q.set(k, typeof val === "string" ? val : JSON.stringify(val));
      url += `?${q.toString()}`;
    }
    const method = String(v.method) as "GET" | "POST" | "PATCH" | "DELETE";
    const res = await identityContext.run(ident, () =>
      this.server.inject({ method, url, headers: method === "GET" ? headers : { ...headers, "content-type": "application/json" }, payload: method === "GET" ? undefined : JSON.stringify(v.body ?? {}) }),
    );
    let body: unknown = null;
    try {
      body = res.body ? JSON.parse(res.body) : null;
    } catch {
      body = null;
    }
    c.send({ t: "res", id, status: res.statusCode, body, clientEpoch: this.rt.core.store.meta().client_epoch });
    if (method !== "GET" && res.statusCode < 400) this.#emit("request.accepted", { requestId: ident.requestId, status: res.statusCode });
  }

  #emit(kind: string, data: Record<string, unknown>): void {
    const seq = ++this.#lastEventSeq;
    const frame = { t: "evt", seq, kind, data, clientEpoch: this.rt.core.store.meta().client_epoch };
    this.#ring.push({ seq, frame });
    if (this.#ring.length > 1000) this.#ring.shift();
    this.#gw?.send(frame);
  }

  /** Workspace event log → gateway, in seq order. Bodies carry ids and states only, never record content. */
  #pumpEvents(): void {
    const rows = this.rt.core.store.all<{ seq: number; kind: string; app_id: string | null; run_id: string | null }>("SELECT seq, kind, app_id, run_id FROM events WHERE seq > ? ORDER BY seq LIMIT 200", this.#ringStoreSeq);
    for (const r of rows) {
      this.#ringStoreSeq = r.seq;
      const kind = r.kind.startsWith("run.") || r.kind.startsWith("deployment.") || r.kind.startsWith("system_action") ? "operation.state_changed" : r.kind.startsWith("membership") ? r.kind : "workspace.state_changed";
      this.#emit(kind, { source: r.kind, appId: r.app_id, runId: r.run_id });
    }
  }
  #ringStoreSeq = 0;
  /** registry state this Host last applied: the protocol-3 envelope names it (spec §14.3). */
  registrySeq = 0;
  controlEpoch = 1;
  incarnation = 1;

  /**
   * Protocol-3 principal of a broker write, read from the rows that recorded who decided it: the confirming member of
   * a system action, the approving member of a grant, the approving owner of a maintenance policy. Unknown → null
   * (the client then refuses to send).
   */
  v3Envelope(method: string, params: unknown): Record<string, unknown> | null {
    const s = this.rt.core.store;
    const p = (params ?? {}) as Record<string, unknown>;
    const base = {
      workspaceId: this.cfg.workspaceId,
      storeUuid: this.cfg.storeUUID,
      executionUid: typeof process.getuid === "function" ? process.getuid() : -1,
      workspaceIncarnation: this.incarnation,
      machineControlEpoch: this.controlEpoch,
      registrySeq: this.registrySeq,
    };
    const member = (userId: string | null | undefined, version: number | null | undefined) => {
      if (!userId || version === null || version === undefined) return null;
      const m = s.get<{ member_version: number; state: string }>("SELECT member_version, state FROM membership_mirror WHERE user_id = ?", userId);
      if (!m || m.state !== "active" || m.member_version !== version) return null;
      return { userId, memberVersion: version };
    };
    if (method === "submit" || method === "operation-cancel" || method === "operation-resolve") {
      const a = method === "submit"
        ? s.get<{ u: string | null; v: number | null; run: string | null }>("SELECT approved_user_id AS u, approved_member_version AS v, run_id AS run FROM system_actions WHERE id = ?", String(p.actionId ?? ""))
        : s.get<{ u: string | null; v: number | null; run: string | null }>("SELECT approved_user_id AS u, approved_member_version AS v, run_id AS run FROM system_actions WHERE operation_id = ?", String(p.operationId ?? ""));
      const cur = identityContext.getStore();
      const who = cur && method !== "submit" ? member(cur.userId, cur.memberVersion) : member(a?.u, a?.v);
      return who ? { ...base, principalKind: "user", ...who, approvedByUserId: null, approvedMemberVersion: null } : null;
    }
    if (method === "grant-sync" || method === "grant-revoke") {
      const g = s.get<{ u: string | null; v: number | null }>("SELECT approved_user_id AS u, approved_member_version AS v FROM provider_grants WHERE id = ?", String(p.grantId ?? ""));
      const who = member(g?.u, g?.v);
      return who ? { ...base, principalKind: "user", ...who, approvedByUserId: null, approvedMemberVersion: null } : null;
    }
    // maintenance-*: the owner who approved the policy (spec §14.3 approvedByUserId/approvedMemberVersion).
    const pid = String(p.policyId ?? "");
    const pol = pid
      ? s.get<{ u: string | null; v: number | null }>("SELECT approved_user_id AS u, approved_member_version AS v FROM maintenance_policies WHERE id = ? ORDER BY version DESC LIMIT 1", pid)
      : s.get<{ u: string | null; v: number | null }>("SELECT user_id AS u, member_version AS v FROM membership_mirror WHERE role = 'owner' AND state = 'active'");
    const who = member(pol?.u, pol?.v);
    return who ? { ...base, principalKind: "maintenance", userId: null, memberVersion: null, approvedByUserId: who.userId, approvedMemberVersion: who.memberVersion } : null;
  }

  gate(): MachineGate {
    const link = this.link;
    const ws = this.cfg.workspaceId;
    const instanceId = this.instanceId;
    return {
      acquire: async (req, signal) => {
        let p: { permitId: string; state: string };
        try {
          p = await link.call("permits.request", {
            workspaceId: ws, executionEpoch: req.executionEpoch, ownerKind: req.ownerKind, ownerId: req.ownerId, attemptId: req.attemptId, resourceClass: "model",
            background: req.background, bodyHash: req.bodyHash, memberVersion: req.memberVersion, userId: req.userId, instanceId, deadlineMs: Math.max(1000, req.deadlineMs - Date.now()),
          });
        } catch (e) {
          const code = (e as MachineCallError).code === "MEMBERSHIP_REVOKED" ? "MEMBERSHIP_REVOKED" : "MACHINE_CAPACITY";
          return { ok: false, reason: (e as Error).message, code };
        }
        // Wait without holding anything else (spec §13.2): queued → reserved, or revoked / deadline.
        while (p.state === "queued") {
          if (signal?.aborted || Date.now() > req.deadlineMs) {
            link.call("permits.release", { permitId: p.permitId, usage: "unused" }).catch(() => {});
            return { ok: false, reason: "no machine permit before the deadline", code: "DEADLINE" };
          }
          await new Promise((r) => setTimeout(r, 100));
          try {
            p = await link.call("permits.get", { permitId: p.permitId });
          } catch {
            /* machined restarting: keep waiting until the deadline */
          }
        }
        if (p.state !== "reserved") return { ok: false, reason: `machine permit ${p.state}`, code: p.state === "revoked" ? "MEMBERSHIP_REVOKED" : "MACHINE_CAPACITY" };
        return { ok: true, permitId: p.permitId };
      },
      use: async (permitId, memberVersion) => {
        try {
          await link.call("permits.use", { permitId, memberVersion });
          return true;
        } catch {
          return false;
        }
      },
      release: (permitId, usage, usageJson) => {
        link.call("permits.release", { permitId, usage, usage_json: usageJson ?? null }).catch(() => {});
      },
    };
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    try {
      await this.link.call("host.bye", { instanceId: this.instanceId });
    } catch {
      /* machined gone: it reconciles instances itself */
    }
    this.#gw?.close();
  }
}
