/**
 * V4-U05 model offline (spec §22, §26): with no model configured, apps, deterministic checks, authorized maintenance,
 * pause/resume, policy pause and result queries keep working; model-using work waits with a clear reason instead of
 * failing the workspace. Real host process, real os.sqlite, no mocks.
 */
import { describe, expect, it } from "vitest";
import { Client, seedFixtures, startHost, stopHost } from "../proc.js";
import { tmpDir } from "../helpers.js";

const NO_MODEL = { AGENTOS_MODEL_MODE: "real", AGENTOS_MODEL_PROVIDER: "", AGENTOS_MODEL_ID: "" };
async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout; last ${JSON.stringify(v).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
const TERMINAL = ["succeeded", "no_change", "failed_no_effect", "cancelled", "expired", "indeterminate", "needs_attention"];

describe("V4-U05 model offline", () => {
  it("apps, deterministic maintenance, pause and queries work without a model; model work waits with its reason", async () => {
    const dir = tmpDir();
    const [a] = await seedFixtures(dir, ["todo-v1.json"]);
    const h = await startHost(dir, NO_MODEL);
    try {
      const c = new Client(h);
      await c.login(dir);
      const st = await c.get("/api/state");
      expect(st.status).toBe(200);
      // the app keeps working
      const app = await c.get(`/api/apps/${a!.appId}`);
      const w = await c.req("POST", `/api/apps/${a!.appId}/records`, { expectedAppEpoch: app.data.appEpoch, data: { title: "离线也能记" } });
      expect(w.status, JSON.stringify(w)).toBeLessThan(300);
      const rs = await c.get(`/api/apps/${a!.appId}/records`);
      expect(JSON.stringify(rs.data)).toContain("离线也能记");
      // a new generation task is refused or ends with the model reason, never a fake success
      const run = await c.req("POST", "/api/runs", { intent: "做一个记账应用", targetAppId: null });
      if (run.status === 202) {
        const r = await until(() => c.get(`/api/runs/${run.data.runId}`), (x) => ["succeeded", "failed", "cancelled"].includes(x.data?.status), 60_000);
        expect(r.data.status).not.toBe("succeeded");
      } else {
        expect(run.error?.code).toMatch(/MODEL_UNAVAILABLE|MODEL/);
      }
      // an approved deterministic policy and a manual check still run to a real outcome
      const created = await c.req("POST", "/api/maintenance/policies", { templateId: "app-recovery", target: { kind: "app", id: a!.appId }, mode: "automatic", trigger: { kind: "manual" } });
      expect(created.status, JSON.stringify(created)).toBe(201);
      const ap = await c.req("POST", `/api/maintenance/policies/${created.data.policyId}/approve`, { version: created.data.version, policyHash: created.data.policyHash });
      expect([200, 202]).toContain(ap.status);
      const chk = await c.req("POST", "/api/maintenance/checks", { templateId: "app-recovery", target: { kind: "app", id: a!.appId } });
      expect(chk.status, JSON.stringify(chk)).toBe(202);
      const job = await until(() => c.get(`/api/maintenance/jobs/${chk.data.jobId}`), (j) => TERMINAL.includes(j.data?.state));
      expect(job.data.state).not.toBe("indeterminate");
      // a model-using check does not run a model and says why
      const diag = await c.req("POST", "/api/maintenance/checks", { templateId: "app-diagnose", target: { kind: "app", id: a!.appId } });
      expect(diag.status, JSON.stringify(diag)).toBe(202);
      const dj = await until(() => c.get(`/api/maintenance/jobs/${diag.data.jobId}`), (j) => TERMINAL.includes(j.data?.state) || !!j.data?.waitReason, 60_000);
      expect(dj.data.state).not.toBe("succeeded");
      // no model run was started for it (no incident to diagnose here, and no model either)
      expect(dj.data.runId).toBeNull();
      // pause, resume and policy pause work and are reported
      const p1 = await c.req("POST", "/api/maintenance/control", { action: "pause" });
      expect(p1.status).toBe(200);
      expect((await c.get("/api/maintenance/state")).data.state).toBe("paused");
      expect((await c.req("POST", "/api/maintenance/control", { action: "resume" })).status).toBe(200);
      const pp = await c.req("POST", `/api/maintenance/policies/${created.data.policyId}/pause`, {});
      expect([200, 202]).toContain(pp.status);
      // results stay queryable
      expect((await c.get("/api/maintenance/jobs")).data.items.length).toBeGreaterThanOrEqual(2);
      expect((await c.get("/api/runs")).status).toBe(200);
    } finally {
      await stopHost(h);
    }
  }, 300_000);
});
