import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AgentOsError, type ErrorCode } from "@agentos/contracts";

/**
 * Client of agentos-provider-user (spec §12.3): the unprivileged native reader started as the host's own user. It is
 * the only way the host touches import roots, host network state, udev metadata and unit properties. Requests are
 * length-prefixed JSON on stdin/stdout; the child is restarted when it dies.
 */
export function nativeBinDir(): string {
  if (process.env.AGENTOS_NATIVE_BIN) return process.env.AGENTOS_NATIVE_BIN;
  // packages/core/dist/providers → repo root
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, "..", "..", "..", "..", "native", "target", "release");
}

export class NativeUserError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
  toAgentOs(): AgentOsError {
    try {
      return new AgentOsError(this.code as ErrorCode, this.message);
    } catch {
      return new AgentOsError("PROVIDER_UNAVAILABLE", `${this.code}: ${this.message}`);
    }
  }
}

export class NativeUser {
  #child: ChildProcess | null = null;
  #buf: Buffer = Buffer.alloc(0);
  #seq = 0;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }>();
  readonly bin: string;

  constructor(binDir = nativeBinDir()) {
    this.bin = path.join(binDir, "agentos-provider-user");
  }

  get available(): boolean {
    try {
      fs.accessSync(this.bin, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  #start(): ChildProcess {
    if (this.#child && this.#child.exitCode === null && !this.#child.killed) return this.#child;
    if (!this.available) throw new NativeUserError("PROVIDER_UNAVAILABLE", `native reader not installed (${this.bin})`);
    // Clean, fixed environment: nothing from the host process (proxies, model keys) reaches the native reader.
    const c = spawn(this.bin, ["serve"], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin" } });
    this.#buf = Buffer.alloc(0);
    c.stdout!.on("data", (chunk: Buffer) => this.#onData(chunk));
    c.on("exit", () => {
      if (this.#child === c) this.#child = null;
      for (const [, p] of this.#pending) {
        clearTimeout(p.timer);
        p.reject(new NativeUserError("PROVIDER_UNAVAILABLE", "native reader exited"));
      }
      this.#pending.clear();
    });
    this.#child = c;
    return c;
  }

  #onData(chunk: Buffer): void {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    for (;;) {
      if (this.#buf.length < 4) return;
      const len = this.#buf.readUInt32BE(0);
      if (this.#buf.length < 4 + len) return;
      const m = JSON.parse(this.#buf.subarray(4, 4 + len).toString("utf8")) as { id: number; ok: boolean; result?: unknown; error?: { code: string; message: string } };
      this.#buf = this.#buf.subarray(4 + len);
      const p = this.#pending.get(m.id);
      if (!p) continue;
      this.#pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(new NativeUserError(m.error?.code ?? "PROVIDER_UNAVAILABLE", m.error?.message ?? "native error"));
    }
  }

  request<T = unknown>(op: string, params: Record<string, unknown>, timeoutMs = 750): Promise<T> {
    let c: ChildProcess;
    try {
      c = this.#start();
    } catch (e) {
      return Promise.reject(e);
    }
    const id = ++this.#seq;
    const body = Buffer.from(JSON.stringify({ id, op, params }));
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new NativeUserError("PROVIDER_UNAVAILABLE", `native read ${op} exceeded ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      c.stdin!.write(Buffer.concat([head, body]));
    });
  }

  close(): void {
    this.#child?.kill();
    this.#child = null;
  }
}

/** The event watcher (inotify / D-Bus / udev) as a separate child; restarted with a new configuration. */
export class NativeWatcher {
  #child: ChildProcess | null = null;
  #buf: Buffer = Buffer.alloc(0);
  constructor(readonly bin: string, readonly onEvent: (e: Record<string, unknown>) => void, readonly onExit: () => void) {}

  start(config: { roots: { resourceId: string; path: string; identity: unknown }[]; units: { resourceId: string; unit: string }[] }): void {
    this.stop();
    if (!fs.existsSync(this.bin)) return;
    const c = spawn(this.bin, ["watch"], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin" } });
    this.#buf = Buffer.alloc(0);
    c.stdout!.on("data", (chunk: Buffer) => {
      this.#buf = Buffer.concat([this.#buf, chunk]);
      for (;;) {
        if (this.#buf.length < 4) return;
        const len = this.#buf.readUInt32BE(0);
        if (this.#buf.length < 4 + len) return;
        try {
          this.onEvent(JSON.parse(this.#buf.subarray(4, 4 + len).toString("utf8")));
        } catch {
          /* ignore malformed */
        }
        this.#buf = this.#buf.subarray(4 + len);
      }
    });
    c.on("exit", () => {
      if (this.#child === c) {
        this.#child = null;
        this.onExit();
      }
    });
    const body = Buffer.from(JSON.stringify(config));
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0);
    c.stdin!.write(Buffer.concat([head, body]));
    this.#child = c;
  }

  stop(): void {
    const c = this.#child;
    this.#child = null;
    if (c) {
      c.stdin?.end();
      c.kill();
    }
  }
}
