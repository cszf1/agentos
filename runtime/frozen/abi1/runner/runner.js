/**
 * Trusted runner (spec §7.2, §11.2). Runs inside the app container as the only process the host starts. It loads the
 * compiled app module, answers the host handshake, and dispatches one host call at a time. Everything it reports is
 * checked by the host; it holds no authority of its own.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { connect } from "./frames.js";
const ABI_VERSION = 1;
const SOCKET = process.env.AGENTOS_SOCKET ?? "/run/agentos/host.sock";
const MAX_IN = 24 * 1024 * 1024;
const MAX_OUT = 1024 * 1024;
const LOG_BYTES_PER_MINUTE = 64 * 1024;
const conn = await connect(SOCKET, MAX_IN, MAX_OUT);
conn.sock.on("close", () => process.exit(0));
// Bounded diagnostics: console output goes to the host as log frames, at most 64 KiB per minute.
let logWindow = Date.now();
let logBytes = 0;
let logDropped = 0;
const emit = (level, args) => {
    const now = Date.now();
    if (now - logWindow > 60_000) {
        if (logDropped > 0)
            conn.send("log", { level: "warn", text: `dropped ${logDropped} log lines` });
        logWindow = now;
        logBytes = 0;
        logDropped = 0;
    }
    let text = args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ");
    if (text.length > 2048)
        text = `${text.slice(0, 2048)}…`;
    if (logBytes + text.length > LOG_BYTES_PER_MINUTE) {
        logDropped++;
        return;
    }
    logBytes += text.length;
    conn.send("log", { level, text });
};
function safeJson(v) {
    try {
        return JSON.stringify(v) ?? String(v);
    }
    catch {
        return String(v);
    }
}
globalThis.console.log = (...a) => emit("info", a);
globalThis.console.info = (...a) => emit("info", a);
globalThis.console.warn = (...a) => emit("warn", a);
globalThis.console.error = (...a) => emit("error", a);
globalThis.console.debug = () => { };
let queries = {};
let commands = {};
let ready = false;
let busy = false;
const pendingServices = new Map();
let serviceSeq = 0;
function handlersOf(mod, name) {
    const v = mod[name];
    if (v === undefined && name === "commands")
        return {};
    if (v === null || typeof v !== "object")
        throw new Error(`module must export "${name}" as an object of functions`);
    const out = {};
    for (const [k, fn] of Object.entries(v)) {
        if (typeof fn !== "function")
            throw new Error(`${name}.${k} is not a function`);
        out[k] = fn;
    }
    return out;
}
function deepFreeze(v) {
    if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
        Object.freeze(v);
        for (const x of Object.values(v))
            deepFreeze(x);
    }
    return v;
}
conn.onFrame(async (f) => {
    try {
        await onFrame(f);
    }
    catch (e) {
        emit("error", [`runner: ${e.message}`]);
    }
});
async function onFrame(f) {
    switch (f.type) {
        case "hello": {
            const p = f.payload;
            const manifestBytes = readFileSync("/app/manifest.json");
            const appBytes = readFileSync("/app/app.mjs");
            let mod;
            try {
                const appModule = "/app/app.mjs";
                mod = (await import(appModule));
                queries = handlersOf(mod, "queries");
                commands = handlersOf(mod, "commands");
            }
            catch (e) {
                conn.send("log", { level: "error", text: `module failed to load: ${e.message}`.slice(0, 2048) });
                setTimeout(() => process.exit(71), 50);
                return;
            }
            ready = true;
            conn.send("ready", {
                abiVersion: ABI_VERSION,
                instanceId: process.env.AGENTOS_INSTANCE_ID ?? "",
                revisionId: process.env.AGENTOS_REVISION_ID ?? "",
                // Reported from the mounted files, not echoed: the host compares them with what it mounted.
                artifactId: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
                appSha256: createHash("sha256").update(appBytes).digest("hex"),
                challenge: p.challenge,
                handlers: { queries: Object.keys(queries), commands: Object.keys(commands) },
            }, f.messageId);
            return;
        }
        case "ping":
            conn.send("pong", { ready, busy }, f.messageId);
            return;
        case "shutdown":
            process.exit(0);
            return;
        case "serviceResult": {
            const p = f.payload;
            const w = pendingServices.get(p.callId);
            if (!w)
                return;
            pendingServices.delete(p.callId);
            if (p.ok)
                w.resolve(deepFreeze({ output: p.output, target: p.target }));
            else {
                const err = new Error(p.error?.message ?? "service call failed");
                err.code = p.error?.code;
                w.reject(err);
            }
            return;
        }
        case "call": {
            const p = f.payload;
            if (!ready || busy) {
                conn.send("result", { callId: p.callId, ok: false, error: { code: "HANDLER_ERROR", message: "runner not ready or busy" } }, f.messageId);
                return;
            }
            const table = p.kind === "query" ? queries : commands;
            const fn = Object.hasOwn(table, p.handlerId) ? table[p.handlerId] : undefined;
            if (!fn) {
                conn.send("result", { callId: p.callId, ok: false, error: { code: "UNKNOWN_HANDLER", message: `no ${p.kind} handler "${p.handlerId}"` } }, f.messageId);
                return;
            }
            busy = true;
            const parentCallId = p.callId;
            const ctx = { ...p.context };
            if (p.kind === "query") {
                ctx.services = Object.freeze({
                    call: (alias, input) => new Promise((resolve, reject) => {
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
                let text;
                try {
                    text = JSON.stringify(out);
                }
                catch {
                    text = undefined;
                }
                if (text === undefined) {
                    conn.send("result", { callId: p.callId, ok: false, error: { code: "BAD_OUTPUT", message: "handler output is not JSON" } }, f.messageId);
                }
                else if (!conn.send("result", { callId: p.callId, ok: true, output: JSON.parse(text) }, f.messageId)) {
                    conn.send("result", { callId: p.callId, ok: false, error: { code: "BAD_OUTPUT", message: "handler output exceeds the frame limit" } }, f.messageId);
                }
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                conn.send("result", { callId: p.callId, ok: false, error: { code: "HANDLER_ERROR", message: msg.slice(0, 1024) } }, f.messageId);
            }
            finally {
                busy = false;
            }
            return;
        }
        default:
            return;
    }
}
