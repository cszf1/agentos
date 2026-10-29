#!/usr/bin/env node
// pnpm smoke:v0.4-real — V4-O01 and V4-O03 with a REAL model (spec §27).
//   O01: two foreground apps generated in parallel (separate conversations, both through the real Pi/provider); a
//        background optimisation produces a checked candidate the user publishes with its exact hash + epoch; a
//        background diagnosis of a real crash-looping container submits a structured report.
//   O03: a real-model compaction of a finished task conversation is generated and placed; budget and source recorded.
// Needs AGENTOS_MODEL_PROVIDER / AGENTOS_MODEL_ID / AGENTOS_MODEL_BASE_URL (may be a key-less relay). Writes
// test-results/smoke-v04-real.json; exit 0 only if every step passed. Each step records the model id it used.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(import.meta.dirname, "..");
if (!process.env.AGENTOS_MODEL_PROVIDER || !process.env.AGENTOS_MODEL_ID) {
  console.error("smoke:v0.4-real needs AGENTOS_MODEL_PROVIDER and AGENTOS_MODEL_ID");
  process.exit(2);
}
const dataRoot = process.env.SMOKE_DATA_ROOT ?? os.tmpdir();
fs.mkdirSync(dataRoot, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(dataRoot, "aos-real4-"));
const port = 4700 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let host = null;
let logs = [];
let cookie = "";
let epoch = 1;
const report = { dataDir, model: { provider: process.env.AGENTOS_MODEL_PROVIDER, id: process.env.AGENTOS_MODEL_ID, baseUrl: (process.env.AGENTOS_MODEL_BASE_URL ?? "").replace(/\/\/[^@/]*@/, "//") }, startedAt: new Date().toISOString(), steps: {} };
const q = (sql, ...a) => {
  const db = new DatabaseSync(path.join(dataDir, "os.sqlite"), { readOnly: true });
  try {
    return db.prepare(sql).all(...a);
  } finally {
    db.close();
  }
};

async function start() {
  logs = [];
  host = spawn(path.join(ROOT, "bin", "agentos-host"), [], { env: { AGENTOS_COMPACTION_KEEP_RECENT_TOKENS: "2000", ...process.env, AGENTOS_DATA_DIR: dataDir, AGENTOS_PORT: String(port), AGENTOS_MODEL_MODE: "real" }, stdio: ["ignore", "pipe", "pipe"] });
  host.stdout.on("data", (d) => logs.push(String(d)));
  host.stderr.on("data", (d) => logs.push(String(d)));
  for (let i = 0; i < 600; i++) {
    if (host.exitCode !== null) throw new Error(`host exited: ${logs.join("").slice(-2000)}`);
    try {
      if ((await fetch(`${base}/health/ready`)).status === 200) break;
    } catch {}
    await sleep(200);
  }
  const token = fs.readFileSync(path.join(dataDir, "auth-token"), "utf8").trim();
  const login = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  cookie = login.headers.get("set-cookie").split(";")[0];
  epoch = (await login.json()).data.clientEpoch;
}
async function stop() {
  if (!host || host.exitCode !== null) return;
  host.kill("SIGTERM");
  await new Promise((r) => host.on("exit", r));
}
async function req(method, url, body) {
  const headers = { cookie };
  if (method !== "GET") Object.assign(headers, { "content-type": "application/json", "idempotency-key": randomUUID(), "x-agentos-epoch": String(epoch) });
  const r = await fetch(base + url, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}
async function until(f, ok, ms, what) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    last = await f();
    if (ok(last)) return last;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}: ${JSON.stringify(last).slice(0, 400)}`);
    await sleep(1500);
  }
}
const waitRun = (id) => until(() => req("GET", `/api/runs/${id}`).then((r) => r.data), (d) => ["succeeded", "failed", "cancelled"].includes(d?.status), 1_200_000, `run ${id}`);
async function runFacts(runId) {
  const t = await req("GET", `/api/runs/${runId}/transcript`);
  const attempts = q("SELECT purpose, background, state, output_tokens, route_id FROM model_attempts WHERE run_id = ?", runId);
  const errors = (t.data?.items ?? []).filter((i) => i.toolName && i.isError).map((i) => `${i.toolName}: ${JSON.stringify(i.content ?? i.text ?? i.result ?? "").slice(0, 400)}`);
  return { conversationId: t.data?.conversationId ?? null, errors, tools: (t.data?.items ?? []).filter((i) => i.toolName).map((i) => `${i.toolName}${i.isError ? "!" : ""}`), usage: t.data?.usage ?? null, model: process.env.AGENTOS_MODEL_ID, attempts: attempts.length, background: attempts.some((a) => a.background === 1), outputTokens: attempts.reduce((n, a) => n + (a.output_tokens ?? 0), 0) };
}

let ok = false;
try {
  await start();
  const st = await req("GET", "/api/state");
  if (!st.data.modelAvailable) throw new Error("model not available");
  const set = await req("POST", "/api/maintenance/settings", { backgroundModel: true, backgroundModelRequestsPer24h: 40, backgroundOutputTokensPer24h: 400_000 });
  if (set.status !== 200) throw new Error(`settings ${JSON.stringify(set)}`);

  // O01-a: two foreground generations in parallel
  const t0 = Date.now();
  const [ra, rb] = await Promise.all([
    req("POST", "/api/runs", { intent: "做一个读书清单应用：书名、作者、状态（想读/在读/读完）、评分，可按状态筛选", targetAppId: null }),
    req("POST", "/api/runs", { intent: process.env.SMOKE_CODE_INTENT ?? "做一个看板应用", targetAppId: null }),
  ]);
  if (ra.status !== 202 || rb.status !== 202) throw new Error(`submit ${ra.status}/${rb.status}`);
  const [fa, fb] = await Promise.all([waitRun(ra.data.runId), waitRun(rb.data.runId)]);
  const A = await runFacts(ra.data.runId);
  const B = await runFacts(rb.data.runId);
  const overlap = q("SELECT COUNT(*) AS n FROM runs a JOIN runs b ON a.id = ? AND b.id = ? WHERE a.started_at < b.updated_at AND b.started_at < a.updated_at", ra.data.runId, rb.data.runId)[0].n === 1;
  report.steps.parallel = { a: { status: fa.status, appId: ra.data.targetAppId, ...A }, b: { status: fb.status, appId: rb.data.targetAppId, ...B }, overlapped: overlap, seconds: Math.round((Date.now() - t0) / 1000) };
  if (fa.status !== "succeeded" || fb.status !== "succeeded" || !A.conversationId || A.conversationId === B.conversationId) throw new Error("O01 parallel generation failed");

  const codeApp = [ra.data.targetAppId, rb.data.targetAppId].find((id) => {
    const r = q("SELECT r.bundle_json FROM apps a JOIN revisions r ON r.app_id = a.id AND r.id = a.active_revision_id WHERE a.id = ?", id)[0];
    return r && JSON.parse(r.bundle_json).formatVersion >= 2;
  });
  report.steps.codeApp = codeApp ?? null;

  // O03: real-model compaction of the first task conversation
  const cj = await req("POST", `/api/conversations/${A.conversationId}/compactions`, {});
  if (cj.status !== 202) throw new Error(`compaction ${JSON.stringify(cj)}`);
  const comp = await until(() => req("GET", `/api/conversations/${A.conversationId}/compactions`).then((r) => r.data.items[0]), (j) => j && ["placed", "summary_unplaced", "failed", "cancelled", "stale"].includes(j.state), 600_000, "compaction");
  const compAttempts = q("SELECT purpose, background, state, output_tokens, usage_json, route_id FROM model_attempts WHERE compaction_job_id = ?", comp.compactionId);
  report.steps.compaction = { state: comp.state, label: comp.label, result: comp.result, scope: comp.scope, keepRecentTokens: Number(process.env.AGENTOS_COMPACTION_KEEP_RECENT_TOKENS ?? 2000), attempts: compAttempts };
  if (comp.state !== "placed") throw new Error("O03 compaction not placed");

  if (!codeApp) throw new Error("no code app was generated; the background candidate needs one");
  // O01-b: background optimisation → checked candidate → the user publishes it with its exact hash + epoch
  const oc = await req("POST", "/api/maintenance/checks", { templateId: "app-optimize", target: { kind: "app", id: codeApp } });
  if (oc.status !== 202) throw new Error(`optimize ${JSON.stringify(oc)}`);
  const job = await until(() => req("GET", `/api/maintenance/jobs/${oc.data.jobId}`).then((r) => r.data), (j) => ["awaiting_approval", "succeeded", "no_change", "failed_no_effect", "needs_attention", "expired"].includes(j.state), 1_200_000, "optimisation");
  const props = (await req("GET", "/api/proposals")).data.items.filter((p) => p.appId === codeApp && p.state === "pending");
  const optRun = q("SELECT id FROM runs WHERE mode = 'maintenance_refactor' ORDER BY created_at DESC LIMIT 1")[0];
  report.steps.optimise = { job: { state: job.state, outcome: job.outcomeReason ?? job.outcome_reason ?? null }, run: optRun ? await runFacts(optRun.id) : null, proposals: props.map((p) => ({ id: p.proposalId, check: p.check })) };
  if (props.length === 0) throw new Error("O01 no checked candidate");
  const p = props[0];
  const before = q("SELECT epoch, active_revision_id FROM apps WHERE id = ?", codeApp)[0];
  const acc = await req("POST", `/api/proposals/${p.proposalId}/accept`, { proposalHash: p.proposalHash, expectedAppEpoch: before.epoch });
  const after = q("SELECT epoch, active_revision_id FROM apps WHERE id = ?", codeApp)[0];
  const dep = q("SELECT status, origin FROM deployments WHERE app_id = ? ORDER BY created_at DESC LIMIT 1", codeApp)[0];
  report.steps.publish = { accept: acc.status, before, after, deployment: dep };
  if (acc.status >= 300 || after.active_revision_id !== p.candidateRevisionId || dep?.origin !== "proposal_accept") throw new Error("O01 publication failed");

  // O01-c: a real crash loop → background diagnosis report
  const rt = () => q("SELECT ar.health, ri.container_id FROM app_runtime ar LEFT JOIN runtime_instances ri ON ri.id = ar.active_instance_id WHERE ar.app_id = ?", codeApp)[0];
  await until(async () => rt(), (x) => x && x.health === "ready" && x.container_id, 180_000, "runtime ready");
  for (let i = 0; i < 6 && rt().health !== "degraded"; i++) {
    const cur = await until(async () => rt(), (x) => x.container_id || x.health === "degraded", 60_000, "container");
    if (cur.health === "degraded") break;
    try {
      execFileSync("podman", ["kill", cur.container_id]);
    } catch {}
    await until(async () => rt(), (x) => x.container_id !== cur.container_id || x.health === "degraded", 60_000, "controller");
  }
  await until(async () => rt(), (x) => x.health === "degraded", 120_000, "degraded");
  await sleep(12_000); // the health monitor opens the incident
  const dc = await req("POST", "/api/maintenance/checks", { templateId: "app-diagnose", target: { kind: "app", id: codeApp } });
  if (dc.status !== 202) throw new Error(`diagnose ${JSON.stringify(dc)}`);
  const dj = await until(() => req("GET", `/api/maintenance/jobs/${dc.data.jobId}`).then((r) => r.data), (j) => ["succeeded", "no_change", "failed_no_effect", "needs_attention", "expired"].includes(j.state), 900_000, "diagnosis");
  const reports = (await req("GET", "/api/maintenance/reports")).data.items;
  const diagRun = q("SELECT id FROM runs WHERE mode = 'maintenance_diagnose' ORDER BY created_at DESC LIMIT 1")[0];
  report.steps.diagnose = { job: dj.state, run: diagRun ? await runFacts(diagRun.id) : null, report: reports[0] ?? null };
  if (!reports.length) throw new Error("O01 no diagnosis report");
  ok = true;
} catch (e) {
  report.error = String(e.message ?? e);
  report.hostTail = logs.join("").slice(-3000);
} finally {
  await stop().catch(() => undefined);
  report.finishedAt = new Date().toISOString();
  report.ok = ok;
  fs.mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "test-results", "smoke-v04-real.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok, error: report.error ?? null, steps: Object.keys(report.steps) }));
  process.exit(ok ? 0 : 1);
}
