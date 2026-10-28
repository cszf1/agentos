import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const ROOT = path.resolve(import.meta.dirname, "..");

export interface HostProc {
  proc: ChildProcess;
  port: number;
  dataDir: string;
  logs: string[];
  exit: Promise<number | null>;
}

let nextPort = 4400 + Math.floor(Math.random() * 400);

export function freshPort(): number {
  return nextPort++;
}

/** Start the real host as a Linux child process through bin/agentos-host (flock + --no-fork). */
export async function startHost(dataDir: string, env: Record<string, string> = {}, opts: { port?: number; waitReady?: boolean } = {}): Promise<HostProc> {
  const port = opts.port ?? freshPort();
  const logs: string[] = [];
  const proc = spawn(path.join(ROOT, "bin", "agentos-host"), [], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      AGENTOS_DATA_DIR: dataDir,
      AGENTOS_PORT: String(port),
      AGENTOS_HOST: "127.0.0.1",
      AGENTOS_LOG_LEVEL: "info",
      AGENTOS_MODEL_MODE: "faux",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout!.on("data", (d) => logs.push(String(d)));
  proc.stderr!.on("data", (d) => logs.push(String(d)));
  const exit = new Promise<number | null>((resolve) => proc.on("exit", (code, signal) => resolve(code ?? (signal ? -1 : null))));
  const h: HostProc = { proc, port, dataDir, logs, exit };
  if (opts.waitReady !== false) await waitHttp(h);
  return h;
}

export async function waitHttp(h: HostProc, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let exited = false;
  void h.exit.then(() => (exited = true));
  for (;;) {
    if (exited) throw new Error(`host exited early:\n${h.logs.join("")}`);
    try {
      const r = await fetch(`http://127.0.0.1:${h.port}/api/state`);
      if (r.status === 401 || r.status === 200) {
        // the shell is up; wait until startup phase finished
        const ready = await fetch(`http://127.0.0.1:${h.port}/health/ready`);
        if (ready.status === 200 || h.logs.join("").includes('"msg":"ready"') || h.logs.join("").includes("pairing failed") || h.logs.join("").includes("recovery blocked")) return;
      }
    } catch {
      /* not listening yet */
    }
    if (Date.now() > until) throw new Error(`host did not come up:\n${h.logs.join("")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function stopHost(h: HostProc, signal: NodeJS.Signals = "SIGTERM"): Promise<number | null> {
  if (h.proc.exitCode !== null || h.proc.signalCode !== null) return h.proc.exitCode;
  h.proc.kill(signal);
  return h.exit;
}

/** A small API client with a session cookie, like the shell. */
export class Client {
  cookie = "";
  epoch = 1;
  constructor(readonly h: { port: number }) {}
  get base() {
    return `http://127.0.0.1:${this.h.port}`;
  }
  async login(dataDir: string) {
    const token = fs.readFileSync(path.join(dataDir, "auth-token"), "utf8").trim();
    const r = await fetch(`${this.base}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    if (r.status !== 200) throw new Error(`login ${r.status}`);
    this.cookie = r.headers.get("set-cookie")!.split(";")[0]!;
    this.epoch = ((await r.json()) as { data: { clientEpoch: number } }).data.clientEpoch;
  }
  async req(method: string, url: string, body?: unknown, key: string = randomUUID(), extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { cookie: this.cookie, ...extra };
    if (method !== "GET") {
      headers["content-type"] = "application/json";
      headers["idempotency-key"] = key;
      headers["x-agentos-epoch"] = String(this.epoch);
    }
    Object.assign(headers, extra);
    const r = await fetch(`${this.base}${url}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
    const json = (await r.json().catch(() => ({}))) as { data?: any; error?: { code: string; message: string } };
    return { status: r.status, data: json.data, error: json.error };
  }
  get(url: string) {
    return this.req("GET", url);
  }
  async waitRun(runId: string, timeoutMs = 30_000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.get(`/api/runs/${runId}`);
      if (r.data && ["succeeded", "failed", "cancelled"].includes(r.data.status)) return r.data;
      if (Date.now() > until) throw new Error(`run still ${JSON.stringify(r.data ?? r.error)}`);
      await new Promise((res) => setTimeout(res, 100));
    }
  }
}

/** Spec §17 M2 internal test entry: seed hand-written fixtures into a stopped test workspace (NODE_ENV=test only). */
export async function seedFixtures(dataDir: string, fixtures: string[]): Promise<{ appId: string; revisionId: string; appEpoch: number }[]> {
  const args = ["seed", ...fixtures.flatMap((f) => ["--fixture", path.join(ROOT, "fixtures", f)])];
  const proc = spawn(path.join(ROOT, "bin", "agentos-admin"), args, {
    env: { ...process.env, NODE_ENV: "test", AGENTOS_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout!.on("data", (d) => (out += String(d)));
  proc.stderr!.on("data", (d) => (out += String(d)));
  const code = await new Promise<number | null>((r) => proc.on("exit", (c) => r(c)));
  if (code !== 0) throw new Error(`seed failed (${code}): ${out}`);
  return (JSON.parse(out.trim().split("\n").pop()!) as { seeded: { appId: string; revisionId: string; appEpoch: number }[] }).seeded;
}
