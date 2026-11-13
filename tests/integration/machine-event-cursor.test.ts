import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MachineCallError, MachineMode } from "../../packages/host/src/machine-mode.js";

// Actual MachineMode UDS framing/replay with scripted HTTP and registry peers, NOT a Host authorization test.
type Frame = Record<string, unknown>;
type StoredEvent = { seq: number; kind: string; app_id: string | null; run_id: string | null; payload_json: string };
const WS = "11111111-1111-4111-8111-111111111111";
const STORE = "22222222-2222-4222-8222-222222222222";

describe("machine gateway event watermarks", () => {
  let dir: string, gateway: Server, peer: Socket | undefined, mode: MachineMode | undefined;
  let frames: Frame[], nextId: number, writes: number, storedEvents: StoredEvent[];
  let readGate: Promise<void> | undefined, releaseRead: (() => void) | undefined, onRead: () => void;

  function send(method: string, body: Frame = {}): number {
    const id = nextId++;
    const payload = Buffer.from(JSON.stringify({
      t: "req", id, method, path: method === "EVENTS" ? "/replay" : method === "GET" ? "/api/state" : "/api/runs",
      requestId: randomUUID(), clientEpoch: 2, body,
      principal: { userId: "test-user", workspaceId: WS, storeUUID: STORE, memberVersion: 1, role: "owner", sessionId: "test-session", sessionEpoch: 1, workspaceIncarnation: 1 },
    }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length);
    if (!peer) throw new Error("gateway fixture is not connected");
    peer.write(Buffer.concat([header, payload]));
    return id;
  }
  async function reply(id: number): Promise<Frame> {
    return vi.waitFor(() => {
      const frame = frames.find((f) => f.t === "res" && f.id === id);
      if (!frame) throw new Error(`no reply for ${id}`);
      return frame;
    }, { timeout: 5000 });
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-cursor-"));
    frames = []; nextId = 1; writes = 0; storedEvents = []; peer = undefined; readGate = undefined; releaseRead = undefined; onRead = () => {};
    gateway = createServer((socket) => {
      peer = socket;
      let pending = Buffer.alloc(0);
      socket.on("data", (data) => {
        pending = Buffer.concat([pending, data]);
        while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
          const n = pending.readUInt32BE(0);
          frames.push(JSON.parse(pending.subarray(4, 4 + n).toString()) as Frame);
          pending = pending.subarray(4 + n);
        }
      });
    });
    const socket = path.join(dir, "gateway.sock");
    gateway.listen(socket);
    await once(gateway, "listening");
    const rt = {
      config: { dataDir: dir },
      core: { store: {
        get: () => ({ workspace_id: WS, store_uuid: STORE }),
        tx: (fn: () => unknown) => fn(), run: () => {},
        all: (sql: string, after: number) => sql.includes("FROM events") ? storedEvents.filter((e) => e.seq > after).map((e) =>
          sql.includes("payload_json") ? e : { seq: e.seq, kind: e.kind, app_id: e.app_id, run_id: e.run_id }) : [],
        eventSeq: () => 9000, meta: () => ({ client_epoch: 2 }),
      }, budgets: {} },
      sys: { builds: {} }, log: { warn: () => {} },
    } as unknown as ConstructorParameters<typeof MachineMode>[1];
    const http = { inject: async (q: { method: string }) => {
      if (q.method === "GET") {
        const body = JSON.stringify({ data: { clientEpoch: 2, eventSeq: 9000, writes } });
        onRead();
        await readGate;
        return { statusCode: 200, body };
      }
      writes++;
      return { statusCode: 201, body: JSON.stringify({ data: { writes } }) };
    } } as unknown as ConstructorParameters<typeof MachineMode>[2];
    mode = new MachineMode({ workspaceId: WS, storeUUID: STORE, machineSocket: path.join(dir, "unused.sock"), gatewaySocket: socket }, rt, http);
    mode.link.call = (async (op: string) => {
      if (op === "workspace.self") return { workspaceId: WS, storeUUID: STORE };
      if (op === "host.hello") return { membership: { members: [] } };
      if (op === "registry.pull") return { messages: [] };
      if (op === "host.bye") return {};
      throw new Error(`unexpected fixture registry call: ${op}`);
    }) as typeof mode.link.call;
    await mode.start();
    await vi.waitFor(() => expect(frames.some((f) => f.t === "hello")).toBe(true));
  });

  afterEach(async () => {
    releaseRead?.();
    await mode?.stop();
    peer?.destroy();
    if (gateway?.listening) await new Promise<void>((resolve) => gateway.close(() => resolve()));
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("retries the same completed permit after release during an outage", async () => {
    if (!mode) throw new Error("mode not started");
    const running = mode;
    const original = running.link.call.bind(running.link);
    let offline = false;
    let releases = 0;
    running.link.call = (async (op: string, args: unknown) => {
      if (op === "permits.release") {
        releases++;
        expect(args).toEqual({ permitId: "completed-permit", usage: "used" });
        if (offline) throw new MachineCallError("STORE_UNAVAILABLE", "machined stopped");
        return { permitId: "completed-permit", state: "released" };
      }
      if (offline) throw new MachineCallError("STORE_UNAVAILABLE", "machined stopped");
      return original(op, args);
    }) as typeof running.link.call;
    offline = true;
    running.gate().release("completed-permit", "used");
    await vi.waitFor(() => expect(releases).toBeGreaterThan(0));
    expect(fs.existsSync(path.join(dir, "machine-permit-releases.sqlite"))).toBe(true);
    offline = false;
    running.link.connectionGeneration++;
    await vi.waitFor(() => expect(releases).toBeGreaterThan(1));
  });

  it("reports live attempts on reconnect and never releases them at the request deadline", async () => {
    if (!mode) throw new Error("mode not started");
    const running = mode;
    const original = running.link.call.bind(running.link);
    const reports: unknown[] = [];
    let releases = 0;
    running.link.call = (async (op: string, args: unknown) => {
      if (op === "permits.request") return { permitId: "live-permit", state: "reserved" };
      if (op === "permits.use") return { permitId: "live-permit", state: "in_use" };
      if (op === "permits.report") { reports.push(args); return { permitId: "live-permit", state: "in_use" }; }
      if (op === "permits.release") { releases++; throw new Error("live work must not be released"); }
      return original(op, args);
    }) as typeof running.link.call;
    const gate = running.gate();
    expect(await gate.acquire({ ownerKind: "run", ownerId: "live-run", executionEpoch: 1, attemptId: "attempt", background: false,
      userId: "test-user", memberVersion: 1, deadlineMs: Date.now() + 10, bodyHash: "sha256:faux" })).toEqual({ ok: true, permitId: "live-permit" });
    expect(await gate.use("live-permit", 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    running.link.connectionGeneration++;
    await vi.waitFor(() => expect(reports).toContainEqual({ permitId: "live-permit", holderState: "in_use" }));
    expect(releases).toBe(0);
  });

  it.each(["model", "build"] as const)("treats an expired %s permit as a deadline even if the poll returns a revoked row", async (kind) => {
    if (!mode) throw new Error("mode not started");
    const running = mode;
    const original = running.link.call.bind(running.link);
    const deadline = Date.now() + 1000;
    let now = deadline - 500;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const permitId = "expired-permit";
      running.link.call = (async (op: string, args: unknown) => {
        if (op === "permits.request") return { permitId, state: "queued" };
        if (op === "permits.get") {
          now = deadline + 1;
          return { permitId, state: "revoked" };
        }
        return original(op, args);
      }) as typeof running.link.call;
      const result = kind === "build" ? await running.buildGate().acquire("job", deadline) : await running.gate().acquire({
        ownerKind: "run", ownerId: "run", executionEpoch: 1, attemptId: "attempt", background: false,
        userId: "test-user", memberVersion: 1, deadlineMs: deadline, bodyHash: "sha256:faux",
      });
      expect(result).toMatchObject({ ok: false, code: "DEADLINE" });
    } finally {
      clock.mockRestore();
    }
  });

  it("captures the wire watermark before an asynchronous snapshot, not the later cursor or Store eventSeq", async () => {
    await reply(send("POST"));
    await vi.waitFor(() => expect(frames.some((f) => f.t === "evt" && f.seq === 1)).toBe(true));
    readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const started = new Promise<void>((resolve) => { onRead = resolve; });
    const snapshot = send("GET");
    await started;
    await reply(send("POST"));
    await vi.waitFor(() => expect(frames.some((f) => f.t === "evt" && f.seq === 2)).toBe(true));
    releaseRead!();
    const r = await reply(snapshot);
    expect(r.body).toEqual({ data: { clientEpoch: 2, eventSeq: 9000, writes: 1 } });
    expect(r.eventCursor).toBe(1);
    const begin = frames.length;
    await reply(send("EVENTS", { after: r.eventCursor }));
    expect(frames.slice(begin).filter((f) => f.t === "evt").map((f) => f.seq)).toEqual([2]);
  });

  it("preserves the revoked subject id without forwarding the stored private payload", async () => {
    storedEvents.push({ seq: 9001, kind: "membership.revoking", app_id: null, run_id: null,
      payload_json: JSON.stringify({ userId: "another-user", reason: "private reason", runs: ["private-run"], text: "do-not-forward" }) });
    const event = await vi.waitFor(() => {
      const e = frames.find((f) => f.t === "evt" && f.kind === "membership.revoking");
      if (!e) throw new Error("membership event not pumped");
      return e;
    });
    expect(event.data).toEqual({ source: "membership.revoking", appId: null, runId: null, userId: "another-user" });
    expect(event.seq).toBe(1);
  });

  it("a malformed old membership payload stays ambiguous instead of crashing or inventing a subject", async () => {
    storedEvents.push({ seq: 9001, kind: "membership.revoked", app_id: null, run_id: null, payload_json: "{broken" });
    const event = await vi.waitFor(() => {
      const e = frames.find((f) => f.t === "evt" && f.kind === "membership.revoked");
      if (!e) throw new Error("legacy membership event not pumped");
      return e;
    });
    expect(event.data).toEqual({ source: "membership.revoked", appId: null, runId: null });
    expect((await reply(send("GET"))).status).toBe(200);
  });

  it("refuses a cursor from a previous Host whose wire sequence was higher", async () => {
    const r = await reply(send("EVENTS", { after: 99 }));
    expect(r.status).toBe(410);
    expect(r.body).toEqual({ gap: true, cursor: 0 });
  });

  it("a full snapshot leaves an overflowed history without replaying the old burst again", async () => {
    let last = 0;
    for (let i = 0; i < 1001; i++) last = send("POST");
    await reply(last);
    await vi.waitFor(() => expect(frames.some((f) => f.t === "evt" && f.seq === 1001)).toBe(true));
    expect((await reply(send("EVENTS", { after: 0 }))).status).toBe(410);
    const snapshot = await reply(send("GET"));
    expect(snapshot.eventCursor).toBe(1001);
    const begin = frames.length;
    const resumed = await reply(send("EVENTS", { after: snapshot.eventCursor }));
    expect(resumed.body).toEqual({ gap: false, cursor: 1001 });
    expect(frames.slice(begin).filter((f) => f.t === "evt")).toHaveLength(0);
  });

  it("replays from the requested cursor in order and reports the actual wire watermark", async () => {
    for (let i = 0; i < 3; i++) await reply(send("POST"));
    await vi.waitFor(() => expect(frames.filter((f) => f.t === "evt")).toHaveLength(3));
    const begin = frames.length;
    const r = await reply(send("EVENTS", { after: 1 }));
    expect(frames.slice(begin).filter((f) => f.t === "evt").map((f) => f.seq)).toEqual([2, 3]);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ gap: false, cursor: 3 });
  });
});
