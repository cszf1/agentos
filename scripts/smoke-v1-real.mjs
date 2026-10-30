#!/usr/bin/env node
// pnpm smoke:v1-real — HOST-LEVEL part of V1-O01 / V1-O02 with a REAL model (spec §30 smoke:v1-real).
//
// What this covers: two Host processes, each with its own data directory (= two workspaces: separate os.sqlite /
// agent.sqlite / Pi store / auth token), both driving the real Pi agent against a real provider AT THE SAME TIME.
//   A: create a todo app → add a record → "增加优先级和筛选" → switch back to the first revision → real compaction.
//   B: create a reading-list app → add a record (concurrently with A's create).
// Evidence: model_attempts rows of A and B overlap in wall-clock time (real concurrent provider requests, not UI
// queueing); A's database holds none of B's apps/intents and vice versa; per-Host usage is recorded separately.
//
// What this does NOT cover (stated in the acceptance report): the native Qt UI driving these steps, the root
// machined permit path (the Hosts run in development mode, not under per-workspace execution UIDs), candidate
// proposals (they need a code app and Podman). Needs AGENTOS_MODEL_PROVIDER / AGENTOS_MODEL_ID /
// AGENTOS_MODEL_BASE_URL (may be a key-less relay). Writes test-results/smoke-v1-real.json.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(import.meta.dirname, "..");
if (!process.env.AGENTOS_MODEL_PROVIDER || !process.env.AGENTOS_MODEL_ID) {
  console.error("smoke:v1-real needs AGENTOS_MODEL_PROVIDER and AGENTOS_MODEL_ID");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataRoot = process.env.SMOKE_DATA_ROOT ?? os.tmpdir();
fs.mkdirSync(dataRoot, { recursive: true });

class Ws {
  constructor(name) {
    this.name = name;
    this.dataDir = fs.mkdtempSync(path.join(dataRoot, `aos-v1real-${name}-`));
    this.port = 4900 + Math.floor(Math.random() * 90) + (name === "B" ? 100 : 0);
    this.base = `http://127.0.0.1:${this.port}`;
    this.logs = [];
  }
  async start() {
    this.host = spawn(path.join(ROOT, "bin", "agentos-host"), [], {
      env: { AGENTOS_COMPACTION_KEEP_RECENT_TOKENS: "2000", ...process.env, AGENTOS_DATA_DIR: this.dataDir, AGENTOS_PORT: String(this.port), AGENTOS_MODEL_MODE: "real" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.host.stdout.on("data", (d) => this.logs.push(String(d)));
    this.host.stderr.on("data", (d) => this.logs.push(String(d)));
    for (let i = 0; i < 600; i++) {
      if (this.host.exitCode !== null) throw new Error(`${this.name}: host exited: ${this.logs.join("").slice(-2000)}`);
      try {
        if ((await fetch(`${this.base}/health/ready`)).status === 200) break;
      } catch {}
      await sleep(200);
    }
    const token = fs.readFileSync(path.join(this.dataDir, "auth-token"), "utf8").trim();
    const login = await fetch(`${this.base}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    this.cookie = login.headers.get("set-cookie").split(";")[0];
    this.epoch = (await login.json()).data.clientEpoch;
  }
  async stop() {
    if (!this.host || this.host.exitCode !== null) return;
    this.host.kill("SIGTERM");
    await new Promise((r) => this.host.on("exit", r));
  }
  async req(method, url, body) {
    const headers = { cookie: this.cookie };
    if (method !== "GET") Object.assign(headers, { "content-type": "application/json", "idempotency-key": randomUUID(), "x-agentos-epoch": String(this.epoch) });
    const r = await fetch(this.base + url, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ...j };
  }
  q(sql, ...a) {
    const db = new DatabaseSync(path.join(this.dataDir, "os.sqlite"), { readOnly: true });
    try {
      return db.prepare(sql).all(...a);
    } finally {
      db.close();
    }
  }
  async until(f, ok, ms, what) {
    const end = Date.now() + ms;
    let last;
    for (;;) {
      last = await f();
      if (ok(last)) return last;
      if (Date.now() > end) throw new Error(`${this.name}: timeout waiting for ${what}: ${JSON.stringify(last).slice(0, 400)}`);
      await sleep(1500);
    }
  }
  waitRun(id) {
    return this.until(() => this.req("GET", `/api/runs/${id}`).then((r) => r.data), (d) => ["succeeded", "failed", "cancelled"].includes(d?.status), 1_500_000, `run ${id}`);
  }
  async create(intent, targetAppId = null, expectedAppEpoch) {
    const r = await this.req("POST", "/api/runs", { intent, targetAppId, ...(expectedAppEpoch ? { expectedAppEpoch } : {}) });
    if (r.status !== 202) throw new Error(`${this.name}: submit ${JSON.stringify(r).slice(0, 400)}`);
    const run = await this.waitRun(r.data.runId);
    const tr = await this.req("GET", `/api/runs/${r.data.runId}/transcript`);
    return { runId: r.data.runId, status: run.status, appId: run.targetAppId, error: run.error ?? null, modelRequests: run.modelRequestCount, usage: tr.data?.sessionUsage ?? tr.data?.usage ?? null, conversationId: tr.data?.conversationId ?? null };
  }
  async addRecord(appId, text) {
    const app = await this.req("GET", `/api/apps/${appId}`);
    const title = app.data.bundle.view?.titleField ?? Object.keys(app.data.bundle.data?.fields ?? {})[0];
    // start with the title only; fill exactly the fields the app says are missing (generated schemas differ)
    const fields = app.data.bundle.data?.fields ?? {};
    const val = (k, f) => {
      const t = f?.type;
      if (t === "enum") return f.values?.[0];
      if (t === "number" || t === "integer") return 1;
      if (t === "boolean") return false;
      if (t === "date" || /date|日期/.test(k)) return "2026-10-30";
      if (t === "datetime") return new Date().toISOString();
      return text.slice(0, f?.maxLength ?? 200);
    };
    const data = { [title]: val(title, fields[title]) };
    let r;
    for (let i = 0; i < 4; i++) {
      r = await this.req("POST", `/api/apps/${appId}/records`, { expectedAppEpoch: app.data.appEpoch, data });
      if (r.status !== 422) break;
      for (const is of r.error?.details?.issues ?? []) {
        const k = String(is.path ?? "").split("/").pop();
        if (k) data[k] = val(k, fields[k]);
      }
    }
    if (r.status !== 201) throw new Error(`${this.name}: record ${JSON.stringify(r).slice(0, 400)}`);
    return r.data.recordId ?? r.data.id ?? r.data.record?.id ?? null;
  }
  attempts() {
    return this.q("SELECT attempt_id, run_id, purpose, background, state, output_tokens, started_at, ended_at, usage_json FROM model_attempts ORDER BY started_at");
  }
}

const A = new Ws("A");
const B = new Ws("B");
const report = { model: { provider: process.env.AGENTOS_MODEL_PROVIDER, id: process.env.AGENTOS_MODEL_ID, reasoning: process.env.AGENTOS_MODEL_REASONING_EFFORT ?? null, baseUrl: (process.env.AGENTOS_MODEL_BASE_URL ?? "").replace(/\/\/[^@/]*@/, "//") }, level: "host (development mode, two Host processes, no native UI, no machined)", startedAt: new Date().toISOString(), steps: {} };
let ok = false;
try {
  await Promise.all([A.start(), B.start()]);
  for (const w of [A, B]) {
    const st = await w.req("GET", "/api/state");
    if (!st.data.modelAvailable) throw new Error(`${w.name}: model not available: ${st.data.agentDiagnostic}`);
  }
  // O02: both workspaces generate at the same time through the real provider
  const t0 = Date.now();
  const [ca, cb] = await Promise.all([A.create("做一个待办应用"), B.create("做一个读书清单应用：书名、作者、状态（想读/在读/读完）")]);
  report.steps.parallelCreate = { a: ca, b: cb, seconds: Math.round((Date.now() - t0) / 1000) };
  if (ca.status !== "succeeded" || cb.status !== "succeeded") throw new Error(`parallel create ${ca.status}/${cb.status}: ${JSON.stringify([ca.error, cb.error]).slice(0, 600)}`);
  const ia = A.attempts().filter((x) => x.run_id === ca.runId);
  const ib = B.attempts().filter((x) => x.run_id === cb.runId);
  const iv = (rows) => rows.map((r) => [Date.parse(r.started_at), Date.parse(r.ended_at ?? new Date().toISOString())]);
  const overlaps = [];
  for (const [s1, e1] of iv(ia)) for (const [s2, e2] of iv(ib)) if (s1 < e2 && s2 < e1) overlaps.push({ ms: Math.min(e1, e2) - Math.max(s1, s2) });
  report.steps.overlap = { attemptsA: ia.length, attemptsB: ib.length, overlappingPairs: overlaps.length, maxOverlapMs: Math.max(0, ...overlaps.map((o) => o.ms)) };
  if (overlaps.length === 0) throw new Error("no overlapping real model attempts between the two workspaces");

  const [ra, rb] = await Promise.all([A.addRecord(ca.appId, "买牛奶"), B.addRecord(cb.appId, "三体")]);
  // isolation: neither database knows the other's app, run or record text
  const isoA = A.q("SELECT COUNT(*) AS n FROM apps WHERE id = ?", cb.appId)[0].n + A.q("SELECT COUNT(*) AS n FROM runs WHERE id = ?", cb.runId)[0].n;
  const isoB = B.q("SELECT COUNT(*) AS n FROM apps WHERE id = ?", ca.appId)[0].n + B.q("SELECT COUNT(*) AS n FROM runs WHERE id = ?", ca.runId)[0].n;
  const leakA = fs.readFileSync(path.join(A.dataDir, "os.sqlite")).includes(Buffer.from("三体"));
  const leakB = fs.readFileSync(path.join(B.dataDir, "os.sqlite")).includes(Buffer.from("买牛奶"));
  report.steps.isolation = { recordA: ra, recordB: rb, aSeesB: isoA, bSeesA: isoB, textLeakAtoB: leakB, textLeakBtoA: leakA };
  if (isoA || isoB || leakA || leakB) throw new Error("cross-workspace leak");

  // O01 (Host level): upgrade, then switch back to the first revision; records survive
  const app1 = await A.req("GET", `/api/apps/${ca.appId}`);
  const rev1 = app1.data.activeRevisionId ?? app1.data.revisionId;
  // the first app may already carry a priority: ask for a field it certainly lacks, then require a new revision
  const up = await A.create("增加一个“标签”文本字段，并可以按标签筛选", ca.appId, app1.data.appEpoch);
  report.steps.upgrade = up;
  if (up.status !== "succeeded") throw new Error(`upgrade ${JSON.stringify(up.error).slice(0, 400)}`);
  const app2 = await A.req("GET", `/api/apps/${ca.appId}`);
  const f1 = Object.keys(app1.data.bundle.data?.fields ?? {});
  const prio = Object.entries(app2.data.bundle.data?.fields ?? {}).find(([k]) => !f1.includes(k));
  const back = await A.req("POST", `/api/apps/${ca.appId}/activate`, { revisionId: rev1, expectedAppEpoch: app2.data.appEpoch });
  const app3 = await A.req("GET", `/api/apps/${ca.appId}`);
  const recs = await A.req("GET", `/api/apps/${ca.appId}/records`);
  report.steps.versions = { rev1, rev2: app2.data.activeRevisionId ?? null, newField: prio?.[0] ?? null, switchBack: back.status, activeAfter: app3.data.activeRevisionId ?? null, records: recs.data?.items?.length ?? null };
  if (!prio || (app2.data.activeRevisionId ?? null) === rev1 || back.status >= 300 || (app3.data.activeRevisionId ?? null) !== rev1 || !(recs.data?.items?.length >= 1)) throw new Error("upgrade / switch back failed");

  // compaction of A's finished conversation with the real model
  const cj = await A.req("POST", `/api/conversations/${ca.conversationId}/compactions`, {});
  let comp = null;
  if (cj.status === 202) {
    comp = await A.until(() => A.req("GET", `/api/conversations/${ca.conversationId}/compactions`).then((r) => r.data.items[0]), (j) => j && ["placed", "summary_unplaced", "failed", "cancelled", "stale"].includes(j.state), 600_000, "compaction");
  }
  report.steps.compaction = { submit: cj.status, state: comp?.state ?? null, attempts: comp ? A.q("SELECT purpose, background, state, output_tokens FROM model_attempts WHERE compaction_job_id = ?", comp.compactionId) : [] };
  if (comp?.state !== "placed") throw new Error("compaction not placed");

  // budget/usage per workspace (never shared)
  for (const w of [A, B]) {
    const at = w.attempts();
    report.steps[`usage${w.name}`] = { attempts: at.length, states: at.reduce((m, x) => ((m[x.state] = (m[x.state] ?? 0) + 1), m), {}), outputTokens: at.reduce((n, x) => n + (x.output_tokens ?? 0), 0), unknown: at.filter((x) => x.state === "usage_unknown").length };
  }
  ok = true;
} catch (e) {
  report.error = String(e.message ?? e);
  report.hostTailA = A.logs.join("").slice(-2500);
  report.hostTailB = B.logs.join("").slice(-2500);
} finally {
  await Promise.all([A.stop().catch(() => undefined), B.stop().catch(() => undefined)]);
  report.finishedAt = new Date().toISOString();
  report.ok = ok;
  fs.mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "test-results", "smoke-v1-real.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok, error: report.error ?? null, steps: Object.keys(report.steps) }));
  process.exit(ok ? 0 : 1);
}
