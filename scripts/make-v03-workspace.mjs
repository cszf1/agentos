#!/usr/bin/env node
// Make a real v0.3 workspace with the real v0.3 host build (V4-B02 source). Usage:
//   node scripts/make-v03-workspace.mjs <v0.3 root> <data dir> [port]
// Starts the v0.3 host (formal faux model, NODE_ENV=test), builds a declarative app and a code app through real runs,
// writes records, then stops the host cleanly. Writes nothing outside <data dir>.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [root, dir, portArg] = process.argv.slice(2);
if (!root || !dir) throw new Error("usage: make-v03-workspace.mjs <v0.3 root> <data dir> [port]");
const port = Number(portArg ?? 4377);
fs.mkdirSync(dir, { recursive: true });
const host = spawn(path.join(root, "bin", "agentos-host"), [], {
  env: { ...process.env, NODE_ENV: "test", AGENTOS_DATA_DIR: dir, AGENTOS_PORT: String(port), AGENTOS_HOST: "127.0.0.1", AGENTOS_MODEL_MODE: "faux" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
host.stdout.on("data", (d) => (log += d));
host.stderr.on("data", (d) => (log += d));
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 120; i++) {
  try {
    if ((await fetch(`${base}/health/ready`)).ok) break;
  } catch {}
  await sleep(500);
}
const token = fs.readFileSync(path.join(dir, "auth-token"), "utf8").trim();
const s = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
const cookie = s.headers.get("set-cookie").split(";")[0];
let epoch = 1;
async function req(method, url, body) {
  const headers = { cookie };
  if (method !== "GET") Object.assign(headers, { "content-type": "application/json", "idempotency-key": crypto.randomUUID(), "x-agentos-epoch": String(epoch) });
  const r = await fetch(`${base}${url}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j.data, error: j.error };
}
async function run(intent, targetAppId = null, expectedAppEpoch) {
  const r = await req("POST", "/api/runs", expectedAppEpoch === undefined ? { intent, targetAppId } : { intent, targetAppId, expectedAppEpoch });
  if (r.status !== 202) throw new Error(`run ${intent}: ${JSON.stringify(r)}`);
  for (;;) {
    const g = await req("GET", `/api/runs/${r.data.runId}`);
    if (["succeeded", "failed", "cancelled"].includes(g.data.status)) {
      if (g.data.status !== "succeeded") throw new Error(`run ${intent} ${g.data.status}`);
      return r.data.targetAppId;
    }
    await sleep(300);
  }
}
try {
  const todo = await run("做一个待办应用");
  const kanban = await run("做一个看板应用");
  const t = await req("GET", `/api/apps/${todo}`);
  for (let i = 0; i < 3; i++) {
    const w = await req("POST", `/api/apps/${todo}/records`, { expectedAppEpoch: t.data.appEpoch, data: { title: `v0.3 记录 ${i}` } });
    if (w.status >= 300) throw new Error(`record ${JSON.stringify(w)}`);
  }
  // the code app writes through its own command (waits for its runtime to be ready)
  const k = await req("GET", `/api/apps/${kanban}`);
  for (let i = 0; i < 60; i++) {
    if ((await req("GET", `/api/apps/${kanban}/runtime`)).data?.health === "ready") break;
    await sleep(1000);
  }
  for (let i = 0; i < 2; i++) {
    const w = await req("POST", `/api/apps/${kanban}/commands/add`, { expectedAppEpoch: k.data.appEpoch, input: { title: `v0.3 看板 ${i}` } });
    if (w.status >= 300) throw new Error(`command ${JSON.stringify(w)}`);
  }
  const a = await req("GET", `/api/apps/${todo}`);
  await run("增加优先级", todo, a.data.appEpoch);
  console.log(JSON.stringify({ ok: true, todo, kanban }));
} catch (e) {
  console.error(String(e), log.slice(-2000));
  process.exitCode = 1;
} finally {
  host.kill("SIGTERM");
  await new Promise((r) => host.on("exit", r));
}
