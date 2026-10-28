#!/usr/bin/env node
// E01: real-model smoke test. Requires AGENTOS_MODEL_PROVIDER / AGENTOS_MODEL_ID (and the provider's key)
// to be configured by the user. Creates a fresh data dir, builds and upgrades a todo app, exits 0 on success.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
if (!process.env.AGENTOS_MODEL_PROVIDER || !process.env.AGENTOS_MODEL_ID) {
  console.error("smoke:real needs AGENTOS_MODEL_PROVIDER and AGENTOS_MODEL_ID (E01 not run)");
  process.exit(2);
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-smoke-"));
const port = 4700 + Math.floor(Math.random() * 200);
const logs = [];
const host = spawn(path.join(ROOT, "bin", "agentos-host"), [], {
  env: { ...process.env, AGENTOS_DATA_DIR: dataDir, AGENTOS_PORT: String(port), AGENTOS_MODEL_MODE: "real" },
  stdio: ["ignore", "pipe", "pipe"],
});
host.stdout.on("data", (d) => logs.push(String(d)));
host.stderr.on("data", (d) => logs.push(String(d)));
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = "";
let epoch = 1;
async function req(method, url, body) {
  const headers = { cookie };
  if (method !== "GET") Object.assign(headers, { "content-type": "application/json", "idempotency-key": randomUUID(), "x-agentos-epoch": String(epoch) });
  const r = await fetch(base + url, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}
async function waitRun(id) {
  for (let i = 0; i < 400; i++) {
    const r = await req("GET", `/api/runs/${id}`);
    if (["succeeded", "failed", "cancelled"].includes(r.data?.status)) return r.data;
    await sleep(1000);
  }
  throw new Error("run timeout");
}
const report = { provider: process.env.AGENTOS_MODEL_PROVIDER, model: process.env.AGENTOS_MODEL_ID, steps: [] };
let ok = false;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health/ready`)).status === 200) break;
    } catch {}
    await sleep(200);
  }
  const token = fs.readFileSync(path.join(dataDir, "auth-token"), "utf8").trim();
  const login = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  cookie = login.headers.get("set-cookie").split(";")[0];
  const st = await req("GET", "/api/state");
  if (!st.data.modelAvailable) throw new Error(`model unavailable: ${st.data.agentDiagnostic}`);
  report.resolvedModel = st.data.model;
  const t0 = Date.now();
  const r1 = await req("POST", "/api/runs", { intent: "做一个待办应用", targetAppId: null });
  const run1 = await waitRun(r1.data.runId);
  report.steps.push({ step: "create", status: run1.status, modelRequests: run1.modelRequestCount, stageAttempts: run1.progress.stageAttempts, seconds: (Date.now() - t0) / 1000, error: run1.error });
  if (run1.status !== "succeeded") throw new Error(`create failed: ${JSON.stringify(run1.error ?? run1.lastValidation)}`);
  const appId = run1.targetAppId;
  let app = await req("GET", `/api/apps/${appId}`);
  report.createdApp = { title: app.data.bundle.manifest.title, fields: Object.keys(app.data.bundle.data.fields), filters: app.data.bundle.view.filters };
  const titleField = app.data.bundle.view.titleField;
  const rec = await req("POST", `/api/apps/${appId}/records`, { expectedAppEpoch: app.data.appEpoch, data: { [titleField]: "买牛奶" } });
  if (rec.status !== 201) throw new Error(`record create failed: ${JSON.stringify(rec.error)}`);
  const t1 = Date.now();
  const r2 = await req("POST", "/api/runs", { intent: "增加优先级和优先级筛选", targetAppId: appId, expectedAppEpoch: app.data.appEpoch });
  const run2 = await waitRun(r2.data.runId);
  report.steps.push({ step: "upgrade", status: run2.status, modelRequests: run2.modelRequestCount, stageAttempts: run2.progress.stageAttempts, seconds: (Date.now() - t1) / 1000, error: run2.error });
  if (run2.status !== "succeeded") throw new Error(`upgrade failed: ${JSON.stringify(run2.error ?? run2.lastValidation)}`);
  app = await req("GET", `/api/apps/${appId}`);
  report.upgradedApp = { title: app.data.bundle.manifest.title, fields: Object.keys(app.data.bundle.data.fields), filters: app.data.bundle.view.filters };
  const recs = await req("GET", `/api/apps/${appId}/records`);
  report.recordAfterUpgrade = recs.data.items[0].data;
  const tr = await req("GET", `/api/runs/${r2.data.runId}/transcript`);
  report.usage = tr.data.sessionUsage;
  const prio = Object.entries(app.data.bundle.data.fields).find(([, f]) => f.type === "enum");
  if (!prio) throw new Error("upgrade did not add an enum priority field");
  if (!app.data.bundle.view.filters.includes(prio[0])) throw new Error("priority is not a filter");
  ok = true;
} catch (e) {
  report.error = e.message;
  report.hostLogTail = logs.join("").split("\n").slice(-15);
} finally {
  host.kill("SIGTERM");
  await new Promise((r) => host.on("exit", r));
}
report.result = ok ? "PASS" : "FAIL";
console.log(JSON.stringify(report, null, 2));
process.exit(ok ? 0 : 1);
