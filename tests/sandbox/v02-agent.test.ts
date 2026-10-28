import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppBundle } from "@agentos/contracts";
import { requestHash } from "@agentos/core";
import { startRig, submit, waitRun, waitFor, type AgentRig } from "../agent-helpers.js";

/**
 * V2-A01/A02/A04 and the generated main path (spec §16, §24): faux Pi drives the real tools against a real rootless
 * Podman sandbox. Runs where the engine socket exists (the sandbox project).
 */
const v1 = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../fixtures/todo-v1.json"), "utf8")) as AppBundle;
const TODO = v1.manifest.appId;

type Dep = { id: string; owner_run_id: string | null; status: string; error: { code?: string; stage?: string } | null; raw: string | null };
function deps(rig: AgentRig, appId: string): Dep[] {
  return rig.core.store
    .all<{ id: string; owner_run_id: string | null; status: string; error_json: string | null }>("SELECT id, owner_run_id, status, error_json FROM deployments WHERE app_id = ? ORDER BY created_at DESC", appId)
    .map((d) => ({ id: d.id, owner_run_id: d.owner_run_id, status: d.status, error: d.error_json ? JSON.parse(d.error_json) : null, raw: d.error_json }));
}
function stagesOf(rig: AgentRig, runId: string): number {
  return rig.core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM run_steps WHERE run_id = ? AND kind = 'stage'", runId)!.n;
}

async function tools(rig: AgentRig, runId: string): Promise<string[]> {
  const t = await rig.engine.transcript();
  const start = t.items.findLastIndex((i) => i.role === "user" && i.text.includes(runId));
  const items = t.items.slice(start + 1);
  const end = items.findIndex((i) => i.role === "user");
  return (end >= 0 ? items.slice(0, end) : items).filter((i) => i.toolName).map((i) => `${i.toolName}${i.isError ? "!" : ""}`);
}

describe("V2-A: Pi code generation on the real sandbox", () => {
  let rig: AgentRig;
  beforeAll(async () => {
    rig = await startRig();
    expect(rig.sys.runtimeReady).toBe(true);
    rig.core.apps.seedActivated(v1);
    const user = { kind: "app" as const, appId: TODO, viaUser: true };
    for (const title of ["买牛奶", "写周报"]) rig.core.store.tx(() => rig.core.records.create(user, TODO, 1, { title }));
  });
  afterAll(async () => {
    await rig.close();
  });

  it("V2-A01 tools in order: app_get, runtime_catalog, stage, validate, prepare, activate; data kept; status visible", async () => {
    const r = await submit(rig, "改成看板，支持批量完成", TODO);
    const run = await waitRun(rig, r.runId, 180_000);
    expect(run.status, run.error_json ?? "").toBe("succeeded");
    const seq = await tools(rig, r.runId);
    expect(seq.slice(0, 6)).toEqual(["app_get", "runtime_catalog", "app_stage", "app_validate", "app_prepare", "app_activate"]);
    const app = rig.core.apps.requireApp(TODO);
    expect(rig.core.apps.activeBundle(app)!.formatVersion).toBe(2);
    expect(rig.core.store.all("SELECT * FROM records WHERE app_id = ?", TODO)).toHaveLength(2);
    expect(deps(rig, TODO).at(0)?.status).toBe("committed");
    expect(run.model_request_count).toBeLessThanOrEqual(12);
  });

  it("V2-A01 an importing app reads service_catalog before staging; the generated service pair is wired by the user", async () => {
    const r = await submit(rig, "增加预计工时（分钟），显示剩余工时，并提供统计服务", TODO);
    expect((await waitRun(rig, r.runId, 180_000)).status).toBe("succeeded");
    const ov = await submit(rig, "做一个工作概览应用，读取待办的统计服务");
    const run = await waitRun(rig, ov.runId, 180_000);
    expect(run.status, run.error_json ?? "").toBe("succeeded");
    const seq = await tools(rig, ov.runId);
    expect(seq.indexOf("service_catalog")).toBeGreaterThan(seq.indexOf("runtime_catalog"));
    expect(seq.indexOf("service_catalog")).toBeLessThan(seq.indexOf("app_stage"));
    const ovApp = rig.core.apps.requireApp(run.target_app_id!);
    const b = rig.core.apps.activeBundle(ovApp)!;
    expect(b.formatVersion === 2 && b.imports.map((i) => i.alias)).toEqual(["todo"]);
    // Pi never creates the grant: the overview stays "未连接" until the user connects it
    expect(rig.sys.interApp.list().filter((g) => g.state === "active")).toEqual([]);
    const q = await rig.sys.invocations.query(ovApp.id, "main", {}, ovApp.epoch);
    expect((q.output as { connected: boolean }).connected).toBe(false);
  });

  it("V2-A02 a compile error and a failing health check are fed back and repaired within the budget", async () => {
    for (const m of ["compile-error-once", "health-fail-once"]) {
      const r = await submit(rig, `[faux:${m}] 改成看板，支持批量完成`, TODO);
      const run = await waitRun(rig, r.runId, 240_000);
      expect(run.status, `${m}: ${run.error_json}`).toBe("succeeded");
      expect(stagesOf(rig, r.runId)).toBe(2);
      const seq = await tools(rig, r.runId);
      expect(seq.filter((t) => t === "app_prepare" || t === "app_prepare!").length + seq.filter((t) => t.startsWith("app_prepare_status")).length).toBeGreaterThanOrEqual(2);
      const failed = deps(rig, TODO).find((d) => d.owner_run_id === r.runId && d.status === "failed");
      expect(failed?.error).toMatchObject(m === "compile-error-once" ? { stage: "build", code: "BUILD_FAILED" } : { stage: "health" });
      expect(String(failed?.raw)).toMatch(m === "compile-error-once" ? /src\/app\.ts:\d+/ : /main|outputSchema|schema/i);
    }
  });

  it("V2-A04 budgets end exactly: stage/candidate budget, publish fence, cancel during prepare publishes nothing", async () => {
    const before = rig.core.apps.requireApp(TODO);
    const r = await submit(rig, "[faux:compile-error] 改成看板，支持批量完成", TODO);
    const run = await waitRun(rig, r.runId, 300_000);
    expect(run.status).toBe("failed");
    expect(stagesOf(rig, r.runId)).toBe(3);
    const mine = deps(rig, TODO).filter((d) => d.owner_run_id === r.runId);
    expect(mine.length).toBeLessThanOrEqual(3);
    expect(mine.every((d) => d.status === "failed" || d.status === "superseded")).toBe(true);
    expect(rig.core.apps.requireApp(TODO)).toEqual(before);
    // publish fence: a second write after activation in the same round is refused
    const pw = await submit(rig, "[faux:post-write] 改成看板，支持批量完成", TODO);
    const pwRun = await waitRun(rig, pw.runId, 180_000);
    expect(pwRun.status).toBe("succeeded");
    expect(await tools(rig, pw.runId)).toContain("app_stage!");
    // cancel while the candidate is being prepared: the deployment is cancelled and nothing is published
    const now = rig.core.apps.requireApp(TODO);
    const c = await submit(rig, "增加预计工时（分钟），显示剩余工时", TODO);
    await waitFor(() => deps(rig, TODO).some((d) => d.owner_run_id === c.runId && (d.status === "queued" || d.status === "preparing")), 120_000);
    rig.core.user.cancelRun({ operationKey: randomUUID(), requestHash: requestHash({ c: c.runId }) }, c.runId);
    const cr = await waitRun(rig, c.runId, 120_000);
    expect(cr.status).toBe("cancelled");
    expect(deps(rig, TODO).find((d) => d.owner_run_id === c.runId)!.status).toBe("cancelled");
    expect(rig.core.apps.requireApp(TODO).active_revision_id).toBe(now.active_revision_id);
    expect(rig.core.apps.requireApp(TODO).epoch).toBe(now.epoch);
  });

  it("V2-P10 the same revision again: no-op deployment, no epoch change, the run still records its published result", async () => {
    const before = rig.core.apps.requireApp(TODO);
    const r = await submit(rig, "[faux:same] 保持现状", TODO);
    const run = await waitRun(rig, r.runId, 120_000);
    expect(run.status, run.error_json ?? "").toBe("succeeded");
    const after = rig.core.apps.requireApp(TODO);
    expect(after.epoch).toBe(before.epoch);
    expect(after.active_revision_id).toBe(before.active_revision_id);
    expect(run.applied_revision_id).toBe(before.active_revision_id);
    const d = rig.core.store.get<{ no_op: number; status: string }>("SELECT no_op, status FROM deployments WHERE owner_run_id = ?", r.runId)!;
    expect(d).toEqual({ no_op: 1, status: "committed" });
  });

  it("V2-P09 cancel and publish race: publish committed first → the late cancel answers ALREADY_APPLIED", async () => {
    const before = rig.core.apps.requireApp(TODO);
    const r = await submit(rig, "[faux:slow:1500] 增加预计工时（分钟），显示剩余工时", TODO);
    await waitFor(() => rig.core.apps.requireApp(TODO).epoch > before.epoch, 180_000);
    let code = "OK";
    try {
      rig.core.user.cancelRun({ operationKey: randomUUID(), requestHash: requestHash({ late: r.runId }) }, r.runId);
    } catch (e) {
      code = (e as { code: string }).code;
    }
    expect(code).toBe("ALREADY_APPLIED");
    const run = await waitRun(rig, r.runId, 60_000);
    expect(run.status).toBe("succeeded");
  });
});
