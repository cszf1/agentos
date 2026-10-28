#!/usr/bin/env node
// E01–E03 (spec §24): real-model generation on a real sandbox. Needs AGENTOS_MODEL_PROVIDER / AGENTOS_MODEL_ID / base URL
// (and a key, or a relay that holds it). Starts a fresh host, then (spec §24):
//   E01 real-model main path: create and modify a code app, keep its data, switch versions; record provider/model/usage
//   E02 real-model cooperation: two generated apps; after the user grants it the overview reads summary; revoked → fails
//   E03 CSV dependency sample: the approved parser handles bounded input; ≤100 rows commit as one batch or are refused whole
// Writes test-results/smoke-v02-real.json and exits 0 only if all three pass.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
if (!process.env.AGENTOS_MODEL_PROVIDER || !process.env.AGENTOS_MODEL_ID) {
  console.error("smoke:v0.2-real needs AGENTOS_MODEL_PROVIDER and AGENTOS_MODEL_ID");
  process.exit(2);
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-real-"));
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
// Code apps have no generic records API; read committed counts straight from os.sqlite (read-only).
async function dbCount(appId) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(dataDir, "os.sqlite"), { readOnly: true });
  try {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM records WHERE app_id = ?").get(appId).n);
  } finally {
    db.close();
  }
}

async function req(method, url, body) {
  const headers = { cookie };
  if (method !== "GET") Object.assign(headers, { "content-type": "application/json", "idempotency-key": randomUUID(), "x-agentos-epoch": String(epoch) });
  const r = await fetch(base + url, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}
async function waitRun(id) {
  for (let i = 0; i < 1000; i++) {
    const r = await req("GET", `/api/runs/${id}`);
    if (["succeeded", "failed", "cancelled"].includes(r.data?.status)) return r.data;
    await sleep(1000);
  }
  throw new Error("run timeout");
}
async function waitHealth(appId) {
  for (let i = 0; i < 180; i++) {
    const r = await req("GET", `/api/apps/${appId}/runtime`);
    if (r.data?.health === "ready") return true;
    await sleep(1000);
  }
  return false;
}
async function command(appId, appEpoch, id, input) {
  const a = await req("POST", `/api/apps/${appId}/commands/${id}`, { expectedAppEpoch: appEpoch, input });
  if (a.status !== 202) return { status: "rejected", error: a.error };
  for (let i = 0; i < 60; i++) {
    const g = await req("GET", `/api/invocations/${a.data.invocationId}`);
    if (g.data && (g.data.status === "succeeded" || g.data.status === "failed")) return g.data;
    await sleep(500);
  }
  return { status: "timeout" };
}
async function transcriptTools(runId) {
  const t = await req("GET", `/api/runs/${runId}/transcript`);
  return (t.data?.items ?? []).filter((i) => i.toolName).map((i) => `${i.toolName}${i.isError ? "!" : ""}`);
}
const report = { provider: process.env.AGENTOS_MODEL_PROVIDER, model: process.env.AGENTOS_MODEL_ID, startedAt: new Date().toISOString(), steps: [] };
let ok = false;
try {
  for (let i = 0; i < 600; i++) {
    if (host.exitCode !== null) throw new Error(`host exited: ${logs.join("").slice(-2000)}`);
    try {
      if ((await fetch(`${base}/health/ready`)).status === 200 && fs.existsSync(path.join(dataDir, "auth-token"))) break;
    } catch {}
    await sleep(200);
  }
  const token = fs.readFileSync(path.join(dataDir, "auth-token"), "utf8").trim();
  const login = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  cookie = login.headers.get("set-cookie").split(";")[0];
  const st = await req("GET", "/api/state");
  if (!st.data.modelAvailable) throw new Error(`model unavailable: ${st.data.agentDiagnostic}`);
  if (!st.data.runtimeReady) throw new Error(`code runtime unavailable: ${st.data.runtimeProblems}`);
  report.resolvedModel = st.data.model;

  // E01
  let t = Date.now();
  const r1 = await req("POST", "/api/runs", { intent: "做一个待办看板应用：任务按“未完成/已完成”分两列显示，顶部显示各优先级（高/普通/低）的未完成数量，可以勾选多条任务一次批量完成，也能新建任务（标题和优先级）。", targetAppId: null });
  const run1 = await waitRun(r1.data.runId);
  const appId = run1.targetAppId;
  const app1 = (await req("GET", `/api/apps/${appId}`)).data;
  const e01 = { step: "E01", status: run1.status, ms: Date.now() - t, modelRequests: run1.modelRequestCount, stageAttempts: run1.progress?.stageAttempts, tools: await transcriptTools(run1.runId), error: run1.error, runtime: app1?.bundle?.manifest?.runtime };
  if (run1.status !== "succeeded" || app1.bundle?.formatVersion !== 2) throw Object.assign(new Error("E01 did not publish a code app"), { e01 });
  e01.health = (await waitHealth(appId)) ? "ready" : "not ready";
  const cmds = Object.keys(app1.bundle.commands);
  e01.commands = cmds;
  const create = cmds.find((c) => app1.bundle.commands[c].operations.includes("create"));
  const batch = cmds.find((c) => app1.bundle.commands[c].operations.includes("update"));
  const createInputs = (title) => {
    const props = app1.bundle.commands[create].inputSchema.properties ?? {};
    const input = {};
    for (const [k, s] of Object.entries(props)) if (s.type === "string" && !s.enum && (k.includes("title") || k === "name" || k === "text")) input[k] = title;
    for (const k of app1.bundle.commands[create].inputSchema.required ?? []) if (input[k] === undefined) input[k] = props[k]?.enum?.[0] ?? title;
    return input;
  };
  e01.created = [];
  for (const title of ["买牛奶", "写周报", "订机票"]) e01.created.push((await command(appId, app1.appEpoch, create, createInputs(title))).status);
  const q1 = await req("POST", `/api/apps/${appId}/queries/main`, { expectedAppEpoch: app1.appEpoch, input: {} });
  e01.mainQuery = q1.status;
  e01.mainSample = JSON.stringify(q1.data?.output ?? q1.error).slice(0, 300);
  if (batch) {
    const ids = [];
    const walk = (v) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        if (typeof v.id === "string") ids.push(v.id);
        Object.values(v).forEach(walk);
      }
    };
    walk(q1.data?.output);
    const props = app1.bundle.commands[batch].inputSchema.properties ?? {};
    const arrKey = Object.keys(props).find((k) => props[k].type === "array");
    if (arrKey) e01.batch = (await command(appId, app1.appEpoch, batch, { [arrKey]: [...new Set(ids)].slice(0, 2) })).status;
  }
  e01.usage = (await req("GET", `/api/runs/${run1.runId}/transcript`)).data?.sessionUsage ?? null;
  report.steps.push(e01);
  if (e01.health !== "ready" || e01.created.some((s) => s !== "succeeded") || e01.mainQuery !== 200) throw new Error("E01 app does not work");

  // E02
  t = Date.now();
  const r2 = await req("POST", "/api/runs", { intent: "增加“预计工时（分钟）”字段，默认 0；显示所有任务的预计工时总和与未完成任务的剩余工时；再对外提供一个只读统计服务 summary，返回任务总数 total、未完成数 open 和剩余工时 remainingMinutes（都是整数）。", targetAppId: appId, expectedAppEpoch: app1.appEpoch });
  const run2 = await waitRun(r2.data.runId);
  const app2 = (await req("GET", `/api/apps/${appId}`)).data;
  const fields = Object.entries(app2.bundle?.data?.fields ?? {});
  const hours = fields.find(([, f]) => f.type === "integer" && f.default === 0);
  const e02 = { step: "E01b", status: run2.status, ms: Date.now() - t, modelRequests: run2.modelRequestCount, stageAttempts: run2.progress?.stageAttempts, tools: await transcriptTools(run2.runId), error: run2.error, hoursField: hours?.[0] ?? null, exports: app2.bundle?.exports ?? [] };
  e02.health = (await waitHealth(appId)) ? "ready" : "not ready";
  const recs = await req("POST", `/api/apps/${appId}/queries/main`, { expectedAppEpoch: app2.appEpoch, input: {} });
  e02.mainQuery = recs.status;
  e02.mainSample = JSON.stringify(recs.data?.output ?? recs.error).slice(0, 300);
  e02.recordsKept = await dbCount(appId);
  e02.usage = (await req("GET", `/api/runs/${run2.runId}/transcript`)).data?.sessionUsage ?? null;
  // version switch: back to the first code version, then forward again; records stay
  const revs = (await req("GET", `/api/apps/${appId}/revisions`)).data.items;
  const first = revs.find((r) => r.revisionId === app1.activeRevisionId);
  const sw = await req("POST", `/api/apps/${appId}/deployments`, { revisionId: first.revisionId, expectedAppEpoch: app2.appEpoch });
  let swOk = sw.status === 202 || sw.status === 200;
  for (let i = 0; swOk && i < 180; i++) {
    const a = (await req("GET", `/api/apps/${appId}`)).data;
    if (a.activeRevisionId === first.revisionId) break;
    await sleep(1000);
  }
  const back = (await req("GET", `/api/apps/${appId}`)).data;
  e02.switchedBack = back.activeRevisionId === first.revisionId && (await waitHealth(appId));
  e02.recordsAfterSwitch = await dbCount(appId);
  const fwd = await req("POST", `/api/apps/${appId}/deployments`, { revisionId: app2.activeRevisionId, expectedAppEpoch: back.appEpoch });
  for (let i = 0; (fwd.status === 202 || fwd.status === 200) && i < 180; i++) {
    if ((await req("GET", `/api/apps/${appId}`)).data.activeRevisionId === app2.activeRevisionId) break;
    await sleep(1000);
  }
  const cur = (await req("GET", `/api/apps/${appId}`)).data;
  e02.switchedForward = cur.activeRevisionId === app2.activeRevisionId && (await waitHealth(appId));
  e02.step = "E01b";
  report.steps.push(e02);
  if (run2.status !== "succeeded" || !hours || e02.health !== "ready" || !(app2.bundle.exports ?? []).length) throw new Error("E01 modify did not publish the hours version with a service");
  if (!e02.switchedBack || !e02.switchedForward || e02.recordsAfterSwitch !== e02.recordsKept || e02.recordsKept < 3) throw new Error("E01 version switch or data retention failed");
  const appEpochNow = cur.appEpoch;

  // E02
  t = Date.now();
  const r3 = await req("POST", "/api/runs", { intent: "做一个“工作概览”应用：读取待办应用对外提供的统计服务，显示任务总数和剩余工时；如果服务还没连接或不可用，要明确提示，不能编造数字。", targetAppId: null });
  const run3 = await waitRun(r3.data.runId);
  const ovId = run3.targetAppId;
  const app3 = (await req("GET", `/api/apps/${ovId}`)).data;
  const e03 = { step: "E02", status: run3.status, ms: Date.now() - t, modelRequests: run3.modelRequestCount, stageAttempts: run3.progress?.stageAttempts, tools: await transcriptTools(run3.runId), error: run3.error, imports: app3?.bundle?.imports?.map((i) => i.alias) ?? [] };
  if (run3.status !== "succeeded" || !(app3.bundle?.imports ?? []).length) throw Object.assign(new Error("E02 overview did not declare an import"), { e03 });
  e03.usedServiceCatalog = e03.tools.includes("service_catalog");
  e03.health = (await waitHealth(ovId)) ? "ready" : "not ready";
  const before = await req("POST", `/api/apps/${ovId}/queries/main`, { expectedAppEpoch: app3.appEpoch, input: {} });
  e03.beforeGrant = JSON.stringify(before.data?.output ?? before.error).slice(0, 300);
  const svc = (await req("GET", "/api/services")).data.items.find((s) => s.appId === appId);
  const imp = app3.bundle.imports[0];
  const g = await req("POST", "/api/service-grants", { sourceAppId: ovId, sourceRevisionId: app3.activeRevisionId, alias: imp.alias, targetAppId: appId, targetRevisionId: svc.revisionId, exportName: svc.exportName, contractHash: svc.contractHash });
  e03.grant = g.status === 201 ? "created" : g.error;
  const after = await req("POST", `/api/apps/${ovId}/queries/main`, { expectedAppEpoch: app3.appEpoch, input: {} });
  e03.afterGrant = JSON.stringify(after.data?.output ?? after.error).slice(0, 300);
  const target = await req("POST", `/api/apps/${appId}/queries/${svc.queryId ?? "summary"}`, { expectedAppEpoch: appEpochNow, input: {} });
  e03.serviceTruth = JSON.stringify(target.data?.output ?? target.error).slice(0, 200);
  // the overview may not show the service numbers before the grant
  const nums = (s) => (s.match(/\d+/g) ?? []).map(Number);
  const truth = target.data?.output ?? {};
  e03.honestBeforeGrant = !(truth.total > 0 && nums(e03.beforeGrant).includes(truth.total) && nums(e03.beforeGrant).includes(truth.remainingMinutes ?? -1));
  e03.showsTotalsAfterGrant = after.status === 200 && nums(e03.afterGrant).includes(truth.total ?? -1);
  // revoke: the overview no longer gets results
  const rv = await req("POST", `/api/service-grants/${g.data.grantId}/revoke`, {});
  const revoked = await req("POST", `/api/apps/${ovId}/queries/main`, { expectedAppEpoch: app3.appEpoch, input: {} });
  e03.afterRevoke = JSON.stringify(revoked.data?.output ?? revoked.error).slice(0, 300);
  e03.revokeStatus = rv.status;
  e03.failsAfterRevoke = rv.status === 200 && !(revoked.status === 200 && nums(e03.afterRevoke).includes(truth.total ?? -1) && truth.total > 0);
  report.steps.push(e03);
  if (g.status !== 201 || !e03.honestBeforeGrant || !e03.showsTotalsAfterGrant || !e03.failsAfterRevoke) throw new Error("E02 cooperation is not correct");

  // E03
  t = Date.now();
  const r4 = await req("POST", "/api/runs", { intent: "做一个 CSV 导入应用：用户粘贴 CSV 文本（两列：标题,优先级，优先级是 高/普通/低），用批准的 CSV 解析库解析；最多 100 行，全部合法时一次批量导入为记录，只要有一行不合法或超过 100 行就整体拒绝并说明原因；页面显示已导入的记录。", targetAppId: null });
  const run4 = await waitRun(r4.data.runId);
  const csvId = run4.targetAppId;
  const app4 = (await req("GET", `/api/apps/${csvId}`)).data;
  const src = Object.values(app4?.bundle?.code?.files ?? {}).join("\n");
  const e04 = { step: "E03", status: run4.status, ms: Date.now() - t, modelRequests: run4.modelRequestCount, stageAttempts: run4.progress?.stageAttempts, tools: await transcriptTools(run4.runId), error: run4.error, lock: app4?.bundle?.runtimeLockId, usesApprovedParser: /from\s+["']papaparse["']/.test(src) };
  if (run4.status !== "succeeded" || app4.bundle?.formatVersion !== 2) throw Object.assign(new Error("E03 did not publish"), { e04 });
  e04.health = (await waitHealth(csvId)) ? "ready" : "not ready";
  const imp4 = Object.entries(app4.bundle.commands).find(([, c]) => c.operations.includes("create"));
  const strKey = Object.entries(imp4?.[1].inputSchema.properties ?? {}).find(([, p]) => p.type === "string")?.[0];
  const count = async () => dbCount(csvId);
  const rows = (n) => ["标题,优先级", ...Array.from({ length: n }, (_, i) => `任务${i + 1},${["高", "普通", "低"][i % 3]}`)].join("\n");
  e04.good = (await command(csvId, app4.appEpoch, imp4[0], { [strKey]: rows(3) })).status;
  e04.afterGood = await count();
  e04.badRow = (await command(csvId, app4.appEpoch, imp4[0], { [strKey]: `${rows(2)}\n坏行,紧急` })).status;
  e04.afterBad = await count();
  e04.tooMany = (await command(csvId, app4.appEpoch, imp4[0], { [strKey]: rows(101) })).status;
  e04.afterTooMany = await count();
  e04.hundred = (await command(csvId, app4.appEpoch, imp4[0], { [strKey]: rows(100) })).status;
  e04.afterHundred = await count();
  e04.usage = (await req("GET", `/api/runs/${run4.runId}/transcript`)).data?.sessionUsage ?? null;
  report.steps.push(e04);
  if (!e04.usesApprovedParser || e04.lock !== "data-v1@1" || e04.good !== "succeeded" || e04.afterGood !== 3 || e04.afterBad !== 3 || e04.afterTooMany !== 3 || e04.hundred !== "succeeded" || e04.afterHundred !== 103) throw new Error("E03 CSV import is not correct");
  ok = true;
} catch (e) {
  report.error = e.message;
  for (const k of ["e01", "e03", "e04"]) if (e[k]) report.steps.push(e[k]);
  report.hostLogTail = logs.join("").split("\n").filter((l) => /"level":"(warn|error)"/.test(l)).slice(-30);
} finally {
  report.ok = ok;
  report.finishedAt = new Date().toISOString();
  host.kill("SIGTERM");
  await sleep(3000);
  fs.mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "test-results", "smoke-v02-real.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(ok ? 0 : 1);
}
