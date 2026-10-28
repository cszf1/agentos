#!/usr/bin/env node
// pnpm smoke:v0.3-real — V3-E01..E03 with a REAL model on the real native stack (spec §26, §24.2).
//   E01 real-model workbench: generate + publish a formatVersion 3 app, the user connects its bindings, it reads real
//       state, writes a report into the managed directory and changes the demo service, all confirmed in the Shell
//   E02 real-model system plan: a natural-language request inside the chosen resources becomes ONE plan; nothing runs
//       until the user confirms; then the real provider executes and the result is verified
//   E03 model offline: the generated app, confirmations, native operations, revocation and queries keep working
// Needs AGENTOS_MODEL_PROVIDER / AGENTOS_MODEL_ID / AGENTOS_MODEL_BASE_URL (the base URL may be a key-less relay; the
// model key never has to exist on this machine). Writes test-results/smoke-v03-real.json; exit 0 only if all pass.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(import.meta.dirname, "..");
if (!process.env.AGENTOS_MODEL_PROVIDER || !process.env.AGENTOS_MODEL_ID) {
  console.error("smoke:v0.3-real needs AGENTOS_MODEL_PROVIDER and AGENTOS_MODEL_ID");
  process.exit(2);
}
const policy = JSON.parse(fs.readFileSync("/etc/agentos/broker/policy.json", "utf8"));
const store = policy.hosts.find((h) => h.uid === process.getuid()).storeUuid;
const unit = policy.units[0].unit;
const managed = policy.managedRoots.find((m) => m.storeUuid === store).path;
const cpuMax = () => fs.readFileSync(`/sys/fs/cgroup/system.slice/${unit}/cpu.max`, "utf8").trim();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-real3-"));
const port = 4700 + Math.floor(Math.random() * 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The workspace uses the store UUID the administrator registered for this host user.
const seed = spawnSync(path.join(ROOT, "bin", "agentos-admin"), ["seed", "--fixture", path.join(ROOT, "fixtures", "todo-v1.json")], { env: { ...process.env, NODE_ENV: "test", AGENTOS_DATA_DIR: dataDir }, encoding: "utf8" });
if (seed.status !== 0) throw new Error(seed.stderr);
{
  const db = new DatabaseSync(path.join(dataDir, "os.sqlite"));
  db.prepare("UPDATE meta SET store_uuid = ? WHERE id = 1").run(store);
  db.close();
}

let host = null;
let logs = [];
const base = `http://127.0.0.1:${port}`;
let cookie = "";
let epoch = 1;
function startHost(env) {
  logs = [];
  host = spawn(path.join(ROOT, "bin", "agentos-host"), [], { env: { ...process.env, AGENTOS_DATA_DIR: dataDir, AGENTOS_PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  host.stdout.on("data", (d) => logs.push(String(d)));
  host.stderr.on("data", (d) => logs.push(String(d)));
}
async function stopHost() {
  if (!host || host.exitCode !== null) return;
  host.kill("SIGTERM");
  await new Promise((r) => host.on("exit", r));
}
async function ready() {
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
  for (let i = 0; i < 100; i++) {
    const s = await req("GET", "/api/state");
    if (s.data?.brokerReady) return s.data;
    await sleep(200);
  }
  throw new Error("broker not ready");
}
async function req(method, url, body) {
  const headers = { cookie };
  if (method !== "GET") Object.assign(headers, { "content-type": "application/json", "idempotency-key": randomUUID(), "x-agentos-epoch": String(epoch) });
  const r = await fetch(base + url, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}
async function waitRun(id) {
  for (let i = 0; i < 1200; i++) {
    const r = await req("GET", `/api/runs/${id}`);
    if (["succeeded", "failed", "cancelled"].includes(r.data?.status)) return r.data;
    await sleep(1000);
  }
  throw new Error("run timeout");
}
async function waitAction(id, ms = 40_000) {
  const until = Date.now() + ms;
  for (;;) {
    const a = (await req("GET", `/api/system-actions/${id}`)).data;
    if (a && ["done", "no_effect", "unknown", "rejected"].includes(a.phase)) return a;
    if (Date.now() > until) return a;
    await sleep(400);
  }
}
async function waitHealth(appId) {
  for (let i = 0; i < 240; i++) {
    const r = await req("GET", `/api/apps/${appId}/runtime`);
    if (r.data?.health === "ready") return true;
    await sleep(1000);
  }
  return false;
}
async function tools(runId) {
  const t = await req("GET", `/api/runs/${runId}/transcript`);
  return { tools: (t.data?.items ?? []).filter((i) => i.toolName).map((i) => `${i.toolName}${i.isError ? "!" : ""}`), usage: t.data?.sessionUsage ?? null };
}
/** Fill a JSON-schema input with plausible values (a percentage, a file name, booleans). */
function inputFor(schema, hints = {}) {
  const out = {};
  for (const [k, s] of Object.entries(schema?.properties ?? {})) {
    if (hints[k] !== undefined) out[k] = hints[k];
    else if (s.enum) out[k] = s.enum[0];
    else if (s.type === "integer" || s.type === "number") out[k] = Math.min(Math.max(50, s.minimum ?? 0), s.maximum ?? 50);
    else if (s.type === "string") out[k] = /name|file|path/i.test(k) ? "status-report" : "AgentOS";
    else if (s.type === "boolean") out[k] = true;
  }
  return out;
}

const report = { provider: process.env.AGENTOS_MODEL_PROVIDER, model: process.env.AGENTOS_MODEL_ID, startedAt: new Date().toISOString(), store, unit, steps: [] };
let ok = false;
try {
  startHost({ AGENTOS_MODEL_MODE: "real" });
  const st = await ready();
  if (!st.modelAvailable) throw new Error(`model unavailable: ${st.agentDiagnostic}`);
  report.resolvedModel = st.model;
  const resources = (await req("GET", "/api/system-resources")).data.items;
  const byKind = (k) => resources.find((r) => r.kind === k);

  // ---------------- E01
  let t = Date.now();
  const intent =
    "做一个“系统工作台”应用（需要读取 Linux 资源，用 formatVersion 3）：显示演示服务的运行状态和当前 CPU 上限，以及受管目录里的文件数量；" +
    "提供两个系统动作按钮：一个把一份简短的状态报告写入受管目录的 status-report.txt（已存在就按当前版本替换），一个把演示服务的 CPU 上限设为输入的百分比（10 到 200）。" +
    "资源由我在 AgentOS 里连接，未连接时如实显示“需要连接资源”。";
  const r1 = await req("POST", "/api/runs", { intent, targetAppId: null });
  const run1 = await waitRun(r1.data.runId);
  const e01 = { step: "E01", status: run1.status, ms: Date.now() - t, modelRequests: run1.modelRequestCount, error: run1.error, ...(await tools(run1.runId)) };
  report.steps.push(e01);
  const appId = run1.targetAppId;
  const app = (await req("GET", `/api/apps/${appId}`)).data;
  e01.formatVersion = app?.bundle?.formatVersion;
  e01.runtime = app?.bundle?.manifest?.runtime;
  if (run1.status !== "succeeded" || app.bundle?.formatVersion !== 3) throw new Error("E01 did not publish a formatVersion 3 app");
  e01.health = (await waitHealth(appId)) ? "ready" : "not ready";
  const before = (await req("POST", `/api/apps/${appId}/queries/main`, { expectedAppEpoch: app.appEpoch, input: {} }));
  e01.beforeConnect = JSON.stringify(before.data?.output ?? before.error).slice(0, 300);
  const binds = (await req("GET", `/api/apps/${appId}/system-bindings`)).data;
  e01.bindings = binds.items.map((b) => `${b.alias}:${b.resourceKind}`);
  e01.actions = binds.actions.map((a) => `${a.handlerId}:${a.capabilityId}`);
  for (const b of binds.items) {
    const res = byKind(b.resourceKind);
    if (!res) continue;
    const g = await req("POST", "/api/provider-grants", { appId, bindingAlias: b.alias, resourceId: res.resourceId, confirmationPolicy: "per_plan" });
    if (g.status !== 202) throw new Error(`connect ${b.alias}: ${JSON.stringify(g.error)}`);
  }
  for (let i = 0; i < 60; i++) {
    const s = (await req("GET", `/api/apps/${appId}/system-bindings`)).data;
    if (s.items.every((b) => b.connected || !byKind(b.resourceKind))) break;
    await sleep(500);
  }
  const q = await req("POST", `/api/apps/${appId}/queries/main`, { expectedAppEpoch: app.appEpoch, input: {} });
  e01.afterConnect = JSON.stringify(q.data?.output ?? q.error).slice(0, 400);
  e01.mainQuery = q.status;
  const fileAct = binds.actions.find((a) => a.capabilityId === "file.write_text_atomic");
  const cpuAct = binds.actions.find((a) => a.capabilityId === "service.set_limit");
  e01.results = {};
  for (const [name, act, hints] of [["report", fileAct, {}], ["cpu", cpuAct, { percent: 50 }]]) {
    if (!act) {
      e01.results[name] = "no such action";
      continue;
    }
    const decl = app.bundle.system.actions[act.handlerId];
    const p = await req("POST", `/api/apps/${appId}/system-actions/${act.handlerId}`, { expectedAppEpoch: app.appEpoch, input: inputFor(decl.inputSchema, hints) });
    if (p.status !== 201) {
      e01.results[name] = { planError: p.error };
      continue;
    }
    const preview = p.data.preview;
    const c = await req("POST", `/api/system-actions/${p.data.actionId}/confirm`, { planHash: p.data.planHash });
    const f = await waitAction(p.data.actionId);
    e01.results[name] = { preview: `${preview.title} | ${preview.target} | ${JSON.stringify(preview.change)}`.slice(0, 300), confirm: c.status, phase: f.phase, effectCertainty: f.effectCertainty, evidenceKind: f.evidenceKind, error: f.error };
  }
  e01.cpuMax = cpuMax();
  e01.managedFiles = fs.readdirSync(managed).filter((n) => !n.startsWith(".")).slice(-10);
  e01.queryShowsRealState = /active|running|运行/.test(e01.afterConnect);
  if (e01.health !== "ready" || e01.results.report?.phase !== "done" || e01.results.cpu?.phase !== "done") throw new Error("E01 app does not complete its system actions");
  if (!e01.queryShowsRealState) throw new Error("E01 app does not show the connected service's real state");

  // ---------------- E02
  t = Date.now();
  const svc = byKind("service");
  const before2 = cpuMax();
  const r2 = await req("POST", "/api/runs", { intent: "把演示服务的 CPU 上限调到单个逻辑 CPU 的 40%。", targetAppId: null, mode: "system_plan", resourceIds: [svc.resourceId], capabilityScopes: ["service.set_limit"] });
  if (r2.status !== 202) throw new Error(`E02 submit: ${JSON.stringify(r2.error)}`);
  const run2 = await waitRun(r2.data.runId);
  const e02 = { step: "E02", status: run2.status, ms: Date.now() - t, modelRequests: run2.modelRequestCount, preparedActionId: run2.preparedActionId, error: run2.error, ...(await tools(run2.runId)) };
  report.steps.push(e02);
  if (run2.status !== "succeeded" || !run2.preparedActionId) throw new Error("E02 prepared no plan");
  const a2 = (await req("GET", `/api/system-actions/${run2.preparedActionId}`)).data;
  e02.preview = `${a2.preview.title} | ${a2.preview.target} | ${JSON.stringify(a2.preview.change)}`.slice(0, 300);
  e02.unchangedBeforeConfirm = cpuMax() === before2;
  await req("POST", `/api/system-actions/${a2.actionId}/confirm`, { planHash: a2.planHash });
  const f2 = await waitAction(a2.actionId);
  Object.assign(e02, { phase: f2.phase, effectCertainty: f2.effectCertainty, evidenceKind: f2.evidenceKind, cpuMax: cpuMax() });
  if (!e02.unchangedBeforeConfirm || f2.phase !== "done" || cpuMax() !== "40000 100000") throw new Error("E02 plan was not executed exactly once after confirmation");

  // ---------------- E03 (model offline)
  await stopHost();
  startHost({ AGENTOS_MODEL_MODE: "real", AGENTOS_MODEL_PROVIDER: "", AGENTOS_MODEL_ID: "", AGENTOS_MODEL_BASE_URL: "" });
  const st3 = await ready();
  const e03 = { step: "E03", modelAvailable: st3.modelAvailable };
  report.steps.push(e03);
  const app3 = (await req("GET", `/api/apps/${appId}`)).data;
  e03.health = (await waitHealth(appId)) ? "ready" : "not ready";
  const q3 = await req("POST", `/api/apps/${appId}/queries/main`, { expectedAppEpoch: app3.appEpoch, input: {} });
  e03.query = q3.status;
  if (cpuAct) {
    const decl = app3.bundle.system.actions[cpuAct.handlerId];
    const p = await req("POST", `/api/apps/${appId}/system-actions/${cpuAct.handlerId}`, { expectedAppEpoch: app3.appEpoch, input: inputFor(decl.inputSchema, { percent: 60 }) });
    if (p.status === 201) {
      await req("POST", `/api/system-actions/${p.data.actionId}/confirm`, { planHash: p.data.planHash });
      e03.offlineAction = (await waitAction(p.data.actionId)).phase;
    } else e03.offlineAction = p.error;
  }
  e03.cpuMax = cpuMax();
  const grants = (await req("GET", "/api/provider-grants")).data.items.filter((g) => g.principal.appId === appId && g.state === "active" && g.bindingAlias);
  const svcGrant = grants.find((g) => g.capabilityId === "service.describe" || g.capabilityId === "service.set_limit");
  if (svcGrant) e03.revoke = (await req("POST", `/api/provider-grants/${svcGrant.grantId}/revoke`, {})).status;
  await sleep(1500);
  const q4 = await req("POST", `/api/apps/${appId}/queries/main`, { expectedAppEpoch: app3.appEpoch, input: {} });
  e03.afterRevoke = JSON.stringify(q4.data?.output ?? q4.error).slice(0, 300);
  e03.operations = (await req("GET", "/api/system-operations")).data.items.length;
  if (st3.modelAvailable || e03.health !== "ready" || e03.query !== 200 || e03.offlineAction !== "done" || cpuMax() !== "60000 100000" || e03.revoke !== 202) throw new Error("E03 offline path failed");
  ok = true;
} catch (e) {
  report.error = String(e.message ?? e);
} finally {
  await stopHost().catch(() => undefined);
  report.finishedAt = new Date().toISOString();
  report.ok = ok;
  fs.mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "test-results", "smoke-v03-real.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(ok ? 0 : 1);
}
