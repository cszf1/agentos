import net from "node:net";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { encodeFrame, FrameDecoder, FRAME_LIMITS, RUNNER_PROTOCOL_VERSION, type Frame, type FrameType } from "@agentos/contracts";

/**
 * Host end of one instance's bridge (spec §11.2). The host listens on a socket inside a 0700 directory that only this
 * instance mounts; the endpoint itself identifies the instance. Messages are length-prefixed strict JSON with bounded
 * sizes; replies must match an outstanding request id; unknown or out-of-order replies close the connection.
 */
export interface BridgeEvents {
  onServiceCall?: (f: Frame) => void;
  onProviderRead?: (f: Frame) => void;
  onLog?: (level: string, text: string) => void;
  onBuild?: (f: Frame) => void;
  onClose?: (reason: string) => void;
}

export class InstanceBridge {
  readonly dir: string;
  readonly socketPath: string;
  #server: net.Server | null = null;
  #conn: net.Socket | null = null;
  #decoder: FrameDecoder;
  #pending = new Map<string, { resolve: (f: Frame) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  #connected: Promise<void>;
  #resolveConnected!: () => void;
  #closed = false;
  #logBytes = 0;
  #logWindow = Date.now();
  logDropped = 0;
  closeReason: string | null = null;

  constructor(dir: string, private readonly events: BridgeEvents = {}, maxIncoming: number = FRAME_LIMITS.runnerToHost) {
    this.#decoder = new FrameDecoder(maxIncoming);
    this.dir = dir;
    this.socketPath = path.join(dir, "host.sock");
    this.#connected = new Promise((r) => (this.#resolveConnected = r));
  }

  /** Create the 0700 directory and listen on a 0600 socket. */
  async listen(): Promise<void> {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer({ allowHalfOpen: false }, (sock) => this.#accept(sock));
      server.maxConnections = 1;
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        chmodSync(this.socketPath, 0o600);
        resolve();
      });
      this.#server = server;
    });
  }

  #accept(sock: net.Socket): void {
    if (this.#conn !== null || this.#closed) {
      sock.destroy();
      return;
    }
    this.#conn = sock;
    sock.on("data", (chunk: Buffer) => {
      let frames: Frame[];
      try {
        frames = this.#decoder.push(chunk);
      } catch (e) {
        this.close(`protocol error: ${(e as Error).message}`);
        return;
      }
      for (const f of frames) this.#dispatch(f);
    });
    sock.on("close", () => this.close("connection closed"));
    sock.on("error", () => this.close("connection error"));
    this.#resolveConnected();
  }

  #dispatch(f: Frame): void {
    if (f.replyTo !== undefined) {
      const w = this.#pending.get(f.replyTo);
      if (!w) {
        this.close(`unexpected reply ${f.replyTo}`);
        return;
      }
      this.#pending.delete(f.replyTo);
      clearTimeout(w.timer);
      w.resolve(f);
      return;
    }
    switch (f.type) {
      case "providerRead":
        this.events.onProviderRead?.(f);
        return;
      case "serviceCall":
        this.events.onServiceCall?.(f);
        return;
      case "log": {
        const p = f.payload as { level?: unknown; text?: unknown };
        const text = typeof p?.text === "string" ? p.text.slice(0, 2048) : "";
        const now = Date.now();
        if (now - this.#logWindow > 60_000) {
          this.#logWindow = now;
          this.#logBytes = 0;
        }
        if (this.#logBytes + text.length > FRAME_LIMITS.logBytesPerMinute) {
          this.logDropped++;
          return;
        }
        this.#logBytes += text.length;
        this.events.onLog?.(typeof p?.level === "string" ? p.level.slice(0, 8) : "info", text);
        return;
      }
      case "buildOutput":
      case "buildFailed":
        this.events.onBuild?.(f);
        return;
      default:
        this.close(`unknown request type ${f.type}`);
    }
  }

  waitConnected(timeoutMs: number): Promise<void> {
    return Promise.race([
      this.#connected,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("runner did not connect in time")), timeoutMs).unref()),
    ]);
  }

  get connected(): boolean {
    return this.#conn !== null && !this.#closed;
  }

  send(type: FrameType, payload: unknown, replyTo?: string): string {
    if (!this.#conn || this.#closed) throw new Error(this.closeReason ?? "bridge not connected");
    const messageId = randomUUID();
    const f: Frame = { protocolVersion: RUNNER_PROTOCOL_VERSION, messageId, type, payload };
    if (replyTo !== undefined) f.replyTo = replyTo;
    const buf = encodeFrame(f);
    if (buf.length - 4 > FRAME_LIMITS.hostToRunner) throw new Error("frame exceeds the host→runner limit");
    this.#conn.write(buf);
    return messageId;
  }

  /** Send a request and wait for its reply (or reject on timeout/close). */
  request(type: FrameType, payload: unknown, timeoutMs: number): Promise<Frame> {
    if (this.#pending.size >= FRAME_LIMITS.maxPendingFrames) return Promise.reject(new Error("too many outstanding requests"));
    return new Promise((resolve, reject) => {
      let id: string;
      try {
        id = this.send(type, payload);
      } catch (e) {
        reject(e as Error);
        return;
      }
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(Object.assign(new Error(`${type} timed out after ${timeoutMs} ms`), { timeout: true }));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
    });
  }

  close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.closeReason = reason;
    for (const [, w] of this.#pending) {
      clearTimeout(w.timer);
      w.reject(new Error(`bridge closed: ${reason}`));
    }
    this.#pending.clear();
    this.#conn?.destroy();
    this.#server?.close();
    this.events.onClose?.(reason);
  }

  /** Close and remove the directory. */
  dispose(): void {
    this.close("disposed");
    rmSync(this.dir, { recursive: true, force: true });
  }
}
