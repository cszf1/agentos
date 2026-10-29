// Shared helpers for the v0.4 doctors: read-only views of os.sqlite and the broker socket. Never writes anything.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";

export const ROOT = path.resolve(import.meta.dirname, "..");
export function dataDir() {
  return process.env.AGENTOS_DATA_DIR || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "agentos");
}
export function openOs() {
  const f = path.join(dataDir(), "os.sqlite");
  if (!fs.existsSync(f)) return { db: null, error: `no os.sqlite at ${f} (set AGENTOS_DATA_DIR)` };
  return { db: new DatabaseSync(f, { readOnly: true }), file: f };
}
export function q(db, sql, ...a) {
  try {
    return db.prepare(sql).all(...a);
  } catch (e) {
    return [{ error: String(e.message).slice(0, 200) }];
  }
}
export function one(db, sql, ...a) {
  return q(db, sql, ...a)[0] ?? null;
}
function frame(obj) {
  const b = Buffer.from(JSON.stringify(obj));
  const h = Buffer.alloc(4);
  h.writeUInt32BE(b.length, 0);
  return Buffer.concat([h, b]);
}
export async function brokerAsk(obj, sock = "/run/agentos-broker/broker.sock", timeout = 3000) {
  return new Promise((resolve) => {
    const s = net.createConnection({ path: sock });
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => (s.destroy(), resolve({ ok: false, error: "timeout" })), timeout);
    s.on("error", (e) => (clearTimeout(t), resolve({ ok: false, error: e.message })));
    s.on("connect", () => s.write(frame(obj)));
    s.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        clearTimeout(t);
        s.destroy();
        resolve(JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0)).toString()));
      }
    });
  });
}
/** Print the report; exit 1 when any check failed (a warning alone never fails). */
export function report(name, checks) {
  const bad = checks.filter((c) => c.status === "fail");
  for (const c of checks) process.stdout.write(`${c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗"} ${c.name}: ${c.detail}\n`);
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify({ doctor: name, ok: bad.length === 0, checks })}\n`);
  process.exitCode = bad.length ? 1 : 0;
}
