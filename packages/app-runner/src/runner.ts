/**
 * Trusted runner (spec §7.2, §11.2). Runs inside the app container as the only process the host starts. It loads the
 * compiled app module, answers the host handshake, and dispatches one host call at a time. Everything it reports is
 * checked by the host; it holds no authority of its own.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { connect, type Frame } from "./frames.js";

// ABI 2 (spec §9): queries, commands and systemActions; providers.read inside queries and system-plan calls only.
// ABI-1 images keep their frozen runner (runtime/frozen/abi1), so this file only serves ABI-2 locks.
const ABI_VERSION = 2;
const SOCKET = process.env.AGENTOS_SOCKET ?? "/run/agentos/host.sock";
const MAX_IN = 24 * 1024 * 1024;
const MAX_OUT = 1024 * 1024;
const LOG_BYTES_PER_MINUTE = 64 * 1024;

type Handler = (input: unknown, ctx: unknown) => unknown;

const conn = await connect(SOCKET, MAX_IN, MAX_OUT);
conn.sock.on("close", () => process.exit(0));

// Bounded diagnostics: console output goes to the host as log frames, at most 64 KiB per minute.
let logWindow = Date.now();
let logBytes = 0;
let logDropped = 0;
const emit = (level: string, args: unknown[]) => {
  const now = Date.now();
  if (now - logWindow > 60_000) {
    if (logDropped > 0) conn.send("log", { level: "warn", text: `dropped ${logDropped} log lines` });
    logWindow = now;
    logBytes = 0;
    logDropped = 0;
  }
  let text = args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ");
  if (text.length > 2048) text = `${text.slice(0, 2048)}…`;
  if (logBytes + text.length > LOG_BYTES_PER_MINUTE) {
    logDropped++;
    return;
  }
  logBytes += text.length;
  conn.send("log", { level, text });
};
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
globalThis.console.log = (...a: unknown[]) => emit("info", a);
globalThis.console.info = (...a: unknown[]) => emit("info", a);
globalThis.console.warn = (...a: unknown[]) => emit("warn", a);
globalThis.console.error = (...a: unknown[]) => emit("error", a);
globalThis.console.debug = () => {};

let queries: Record<string, Handler> = {};
let commands: Record<string, Handler> = {};
let systemActions: Record<string, Handler> = {};
const pendingProviders = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
let providerSeq = 0;
let ready = false;
let busy = false;
const pendingServices = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
let serviceSeq = 0;

function handlersOf(mod: Record<string, unknown>, name: string): Record<string, Handler> {
  const v = mod[name];
  if (v === undefined && (name === "commands" || name === "systemActions")) return {};
  if (v === null || typeof v !== "object") throw new Error(`module must export "${name}" as an object of functions`);
  const out: Record<string, Handler> = {};
  for (const [k, fn] of Object.entries(v as Record<string, unknown>)) {
    if (typeof fn !== "function") throw new Error(`${name}.${k} is not a function`);
    out[k] = fn as Handler;
  }
  return out;
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as object)) deepFreeze(x);
  }
  return v;
}

conn.onFrame(async (f: Frame) => {
  try {
    await onFrame(f);
  } catch (e) {
    emit("error", [`runner: ${(e as Error).message}`]);
  }
});

async function onFrame(f: Frame): Promise<void> {
  switch (f.type) {
    case "hello": {
      const p = f.payload as { challenge: string; instanceId: string; revisionId: string; artifactId: string };
      const manifestBytes = readFileSync("/app/manifest.json");
      const appBytes = readFileSync("/app/app.mjs");
      let mod: Record<string, unknown>;
      try {
        const appModule = "/app/app.mjs";
        mod = (await import(appModule)) as Record<string, unknown>;
        queries = handlersOf(mod, "queries");
        commands = handlersOf(mod, "commands");
        systemActions = handlersOf(mod, "systemActions");
      } catch (e) {
        conn.send("log", { level: "error", text: `module failed to load: ${(e as Error).message}`.slice(0, 2048) });
        setTimeout(() => process.exit(71), 50);
        return;
      }
      ready = true;
      conn.send(
        "ready",
        {
          abiVersion: ABI_VERSION,
          instanceId: process.env.AGENTOS_INSTANCE_ID ?? "",
          revisionId: process.env.AGENTOS_REVISION_ID ?? "",
          // Reported from the mounted files, not echoed: the host compares them with what it mounted.
          artifactId: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
          appSha256: createHash("sha256").update(appBytes).digest("hex"),
          challenge: p.challenge,
          handlers: { queries: Object.keys(queries), commands: Object.keys(commands), systemActions: Object.keys(systemActions) },
        },
        f.messageId,
      );
      return;
    }
    case "ping":
      conn.send("pong", { ready, busy }, f.messageId);
      return;
    case "shutdown":
      process.exit(0);
      return;
    case "serviceResult": {
      const p = f.payload as { callId: string; ok: boolean; output?: unknown; target?: unknown; error?: { code: string; message: string } };
      const w = pendingServices.get(p.callId);
      if (!w) return;
      pendingServices.delete(p.callId);
      if (p.ok) w.resolve(deepFreeze({ output: p.output, target: p.target }));
      else {
        const err = new Error(p.error?.message ?? "service call failed") as Error & { code?: string };
        err.code = p.error?.code;
        w.reject(err);
      }
      return;
    }
    case "providerResult": {
      const p = f.payload as { callId: string; ok: boolean; envelope?: unknown; error?: { code: string; message: string } };
      const w = pendingProviders.get(p.callId);
      if (!w) return;
      pendingProviders.delete(p.callId);
      if (p.ok) w.resolve(deepFreeze(p.envelope));
      else {
        const err = new Error(p.error?.message ?? "provider read failed") as Error & { code?: string };
        err.code = p.error?.code;
        w.reject(err);
      }
      return;
    }
    case "call": {
      const p = f.payload as { callId: string; kind: "query" | "command" | "systemPlan"; handlerId: string; input: unknown; context: Record<string, unknown> };
      if (!ready || busy) {
        conn.send("result", { callId: p.callId, ok: false, error: { code: "HANDLER_ERROR", message: "runner not ready or busy" } }, f.messageId);
        return;
      }
      const table = p.kind === "query" ? queries : p.kind === "systemPlan" ? systemActions : commands;
      const fn = Object.hasOwn(table, p.handlerId) ? table[p.handlerId] : undefined;
      if (!fn) {
        conn.send("result", { callId: p.callId, ok: false, error: { code: "UNKNOWN_HANDLER", message: `no ${p.kind} handler "${p.handlerId}"` } }, f.messageId);
        return;
      }
      busy = true;
      const parentCallId = p.callId;
      const ctx: Record<string, unknown> = { ...p.context };
      if (p.kind === "query" || p.kind === "systemPlan") {
        // The host checks every read against this call's declaration, grant and quota; the runner only forwards.
        ctx.providers = Object.freeze({
          read: (bindingAlias: string, capabilityId: string, params: unknown = {}) =>
            new Promise((resolve, reject) => {
              const callId = `${parentCallId}:prv:${++providerSeq}`;
              pendingProviders.set(callId, { resolve, reject });
              if (!conn.send("providerRead", { callId, parentCallId, bindingAlias, capabilityId, params })) {
                pendingProviders.delete(callId);
                reject(new Error("provider read input too large"));
              }
            }),
        });
      }
      if (p.kind === "query") {
        ctx.services = Object.freeze({
          call: (alias: string, input: unknown) =>
            new Promise((resolve, reject) => {
              const callId = `${parentCallId}:svc:${++serviceSeq}`;
              pendingServices.set(callId, { resolve, reject });
              if (!conn.send("serviceCall", { callId, parentCallId, alias, input })) {
                pendingServices.delete(callId);
                reject(new Error("service call input too large"));
              }
            }),
        });
      }
      deepFreeze(ctx.records);
      try {
        const out = await fn(deepFreeze(p.input), Object.freeze(ctx));
        let text: string | undefined;
        try {
          text = JSON.stringify(out);
        } catch {
          text = undefined;
        }
        if (text === undefined) {
          conn.send("result", { callId: p.callId, ok: false, error: { code: "BAD_OUTPUT", message: "handler output is not JSON" } }, f.messageId);
        } else if (!conn.send("result", { callId: p.callId, ok: true, output: JSON.parse(text) }, f.messageId)) {
          conn.send("result", { callId: p.callId, ok: false, error: { code: "BAD_OUTPUT", message: "handler output exceeds the frame limit" } }, f.messageId);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        conn.send("result", { callId: p.callId, ok: false, error: { code: "HANDLER_ERROR", message: msg.slice(0, 1024) } }, f.messageId);
      } finally {
        busy = false;
      }
      return;
    }
    default:
      return;
  }
}
