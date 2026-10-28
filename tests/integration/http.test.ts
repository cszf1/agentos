import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client, startHost, stopHost, type HostProc } from "../proc.js";
import { tmpDir } from "../helpers.js";

function rawRequest(port: number, opts: { method: string; path: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: opts.method, path: opts.path, headers: opts.headers }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe("HTTP host (real process, faux model)", () => {
  let dir: string;
  let host: HostProc;
  let c: Client;
  beforeAll(async () => {
    dir = tmpDir();
    host = await startHost(dir);
    c = new Client(host);
    await c.login(dir);
  });
  afterAll(async () => {
    await stopHost(host);
  });

  it("health endpoints and data dir permissions", async () => {
    expect((await fetch(`http://127.0.0.1:${host.port}/health/live`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${host.port}/health/ready`)).status).toBe(200);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, "auth-token")).mode & 0o777).toBe(0o600);
  });

  it("U03 no session, wrong Host, cross-origin and non-JSON writes are refused", async () => {
    const anon = new Client(host);
    expect((await anon.get("/api/state")).status).toBe(401);
    expect((await anon.req("POST", "/api/runs", { intent: "x", targetAppId: null })).status).toBe(401);
    const badHost = await rawRequest(host.port, { method: "GET", path: "/api/state", headers: { host: "evil.example:80", cookie: c.cookie } });
    expect(badHost.status).toBe(403);
    const cross = await rawRequest(host.port, {
      method: "POST",
      path: "/api/runs",
      headers: { host: `127.0.0.1:${host.port}`, cookie: c.cookie, origin: "http://evil.example", "content-type": "application/json", "idempotency-key": randomUUID(), "x-agentos-epoch": "1" },
      body: JSON.stringify({ intent: "x", targetAppId: null }),
    });
    expect(cross.status).toBe(403);
    const form = await rawRequest(host.port, {
      method: "POST",
      path: "/api/runs",
      headers: { host: `127.0.0.1:${host.port}`, cookie: c.cookie, "content-type": "text/plain", "idempotency-key": randomUUID(), "x-agentos-epoch": "1" },
      body: JSON.stringify({ intent: "x", targetAppId: null }),
    });
    expect(form.status).toBe(415);
    const badToken = await fetch(`http://127.0.0.1:${host.port}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "nope" }) });
    expect(badToken.status).toBe(401);
  });

  it("L01 system.info comes from real system APIs", async () => {
    const s = await c.get("/api/system");
    expect(s.status).toBe(200);
    expect(s.data.platform).toBe("linux");
    expect(s.data.memory.totalBytes).toBeGreaterThan(0);
    expect(typeof s.data.uptimeSeconds).toBe("number");
    expect(s.data.hostVersion).toBe("0.1.0");
  });

  it("full HTTP CRUD with idempotency, CAS, unknown fields and stale epochs", async () => {
    const run = await c.req("POST", "/api/runs", { intent: "做一个待办应用", targetAppId: null });
    expect(run.status).toBe(202);
    const busy = await c.req("POST", "/api/runs", { intent: "again", targetAppId: null });
    expect(busy.error?.code).toBe("RUN_BUSY");
    const done = await c.waitRun(run.data.runId);
    expect(done.status).toBe("succeeded");
    const appId = run.data.targetAppId;
    const app = await c.get(`/api/apps/${appId}`);
    expect(app.data.bundle.manifest.title).toBe("待办清单");
    const key = randomUUID();
    const r1 = await c.req("POST", `/api/apps/${appId}/records`, { expectedAppEpoch: app.data.appEpoch, data: { title: "买牛奶" } }, key);
    const r2 = await c.req("POST", `/api/apps/${appId}/records`, { expectedAppEpoch: app.data.appEpoch, data: { title: "买牛奶" } }, key);
    expect(r1.status).toBe(201);
    expect(r2.data.id).toBe(r1.data.id);
    const conflict = await c.req("POST", `/api/apps/${appId}/records`, { expectedAppEpoch: app.data.appEpoch, data: { title: "别的" } }, key);
    expect(conflict.error?.code).toBe("REQUEST_CONFLICT");
    const extra = await c.req("POST", `/api/apps/${appId}/records`, { expectedAppEpoch: app.data.appEpoch, data: { title: "x" }, id: "client-id" });
    expect(extra.error?.code).toBe("INVALID_REQUEST");
    const patched = await c.req("PATCH", `/api/apps/${appId}/records/${r1.data.id}`, { expectedAppEpoch: app.data.appEpoch, expectedRecordVersion: 1, changes: { done: true } });
    expect(patched.data.recordVersion).toBe(2);
    const stale = await c.req("PATCH", `/api/apps/${appId}/records/${r1.data.id}`, { expectedAppEpoch: app.data.appEpoch, expectedRecordVersion: 1, changes: { done: false } });
    expect(stale.error?.code).toBe("RECORD_VERSION_STALE");
    const list = await c.get(`/api/apps/${appId}/records?filters=${encodeURIComponent(JSON.stringify({ done: true }))}`);
    expect(list.data.total).toBe(1);
    const badFilter = await c.get(`/api/apps/${appId}/records?filters=${encodeURIComponent(JSON.stringify({ title: "x" }))}`);
    expect(badFilter.error?.code).toBe("INVALID_REQUEST");
    // upgrade, then an old form's write is stale
    const up = await c.req("POST", "/api/runs", { intent: "增加优先级和优先级筛选", targetAppId: appId, expectedAppEpoch: app.data.appEpoch });
    expect((await c.waitRun(up.data.runId)).status).toBe("succeeded");
    const old = await c.req("POST", `/api/apps/${appId}/records`, { expectedAppEpoch: app.data.appEpoch, data: { title: "旧表单" } });
    expect(old.status).toBe(409);
    expect(old.error?.code).toBe("APP_EPOCH_STALE");
    const revs = await c.get(`/api/apps/${appId}/revisions`);
    expect(revs.data.items).toHaveLength(2);
    const cur = await c.get(`/api/apps/${appId}`);
    const back = await c.req("POST", `/api/apps/${appId}/activate`, { revisionId: revs.data.items[0].revisionId, expectedAppEpoch: cur.data.appEpoch });
    expect(back.status).toBe(200);
    const del = await c.req("DELETE", `/api/apps/${appId}/records/${r1.data.id}`, { expectedAppEpoch: back.data.appEpoch, expectedRecordVersion: 3 });
    expect(del.data).toEqual({ deleted: true, id: r1.data.id });
    const tr = await c.get(`/api/runs/${up.data.runId}/transcript`);
    expect(tr.data.final).toBe(true);
    expect(tr.data.items.some((i: { toolName?: string }) => i.toolName === "app_activate")).toBe(true);
    // cancel after publish is ALREADY_APPLIED
    const late = await c.req("POST", `/api/runs/${up.data.runId}/cancel`, {});
    expect(late.error?.code).toBe("ALREADY_APPLIED");
  });

  it("writes need Idempotency-Key and the client epoch", async () => {
    const noKey = await rawRequest(host.port, {
      method: "POST",
      path: "/api/runs",
      headers: { host: `127.0.0.1:${host.port}`, cookie: c.cookie, "content-type": "application/json", "x-agentos-epoch": "1" },
      body: JSON.stringify({ intent: "x", targetAppId: null }),
    });
    expect(noKey.status).toBe(422);
    const staleEpoch = await c.req("POST", "/api/runs", { intent: "x", targetAppId: null }, randomUUID(), { "x-agentos-epoch": "0" });
    expect(staleEpoch.error?.code).toBe("CLIENT_EPOCH_STALE");
  });
});

describe("O02 no model configured", () => {
  it("apps keep working, generation is MODEL_UNAVAILABLE", async () => {
    const dir = tmpDir();
    let host = await startHost(dir);
    const c = new Client(host);
    await c.login(dir);
    const run = await c.req("POST", "/api/runs", { intent: "做一个待办应用", targetAppId: null });
    const appId = run.data.targetAppId;
    await c.waitRun(run.data.runId);
    await stopHost(host);
    host = await startHost(dir, { AGENTOS_MODEL_MODE: "real", AGENTOS_MODEL_PROVIDER: "", AGENTOS_MODEL_ID: "" });
    const c2 = new Client(host);
    await c2.login(dir);
    const st = await c2.get("/api/state");
    expect(st.data.modelAvailable).toBe(false);
    expect((await c2.req("POST", "/api/runs", { intent: "y", targetAppId: null })).error?.code).toBe("MODEL_UNAVAILABLE");
    const app = await c2.get(`/api/apps/${appId}`);
    const rec = await c2.req("POST", `/api/apps/${appId}/records`, { expectedAppEpoch: app.data.appEpoch, data: { title: "离线" } });
    expect(rec.status).toBe(201);
    expect((await c2.get(`/api/apps/${appId}/records`)).data.total).toBe(1);
    await stopHost(host);
    // a provider without credentials is also unavailable, not silently replaced
    host = await startHost(dir, { AGENTOS_MODEL_MODE: "real", AGENTOS_MODEL_PROVIDER: "openai-compatible", AGENTOS_MODEL_ID: "m", AGENTOS_MODEL_BASE_URL: "http://127.0.0.1:9/v1", AGENTOS_MODEL_API_KEY: "" });
    const c3 = new Client(host);
    await c3.login(dir);
    expect((await c3.get("/api/state")).data.modelAvailable).toBe(false);
    await stopHost(host);
  });
});
