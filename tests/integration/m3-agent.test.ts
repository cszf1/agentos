import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { AgentOsError } from "@agentos/contracts";
import { requestHash } from "@agentos/core";
import { startRig, submit, waitFor, waitRun, type AgentRig } from "../agent-helpers.js";
import { createRecord } from "../helpers.js";

let rig: AgentRig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

describe("A: Pi Durable generation loop (faux model, real Durable + SQLite + tools)", () => {
  it("A01 creates and then modifies an app through the formal adapter", async () => {
    rig = await startRig();
    const r1 = await submit(rig, "做一个待办应用");
    const run1 = await waitRun(rig, r1.runId);
    expect(run1.status).toBe("succeeded");
    expect(run1.applied_revision_id).toMatch(/^sha256:/);
    const app = rig.core.apps.getApp(r1.targetAppId);
    expect(app.bundle?.manifest.title).toBe("待办清单");
    expect(app.activeRevisionId).toBe(run1.applied_revision_id);
    expect(rig.core.runs.view(run1).progress.stageAttempts).toBe(1);
    expect(run1.model_request_count).toBe(4);

    createRecord(rig.core, r1.targetAppId, { title: "买牛奶" });
    const r2 = await submit(rig, "增加优先级和优先级筛选", r1.targetAppId);
    const run2 = await waitRun(rig, r2.runId);
    expect(run2.status).toBe("succeeded");
    const app2 = rig.core.apps.getApp(r1.targetAppId);
    expect(app2.bundle?.view.filters).toEqual(["done", "priority"]);
    const recs = rig.core.records.list({ kind: "app", appId: r1.targetAppId, viaUser: true }, r1.targetAppId, {});
    expect(recs.items[0]!.data).toEqual({ title: "买牛奶", done: false, priority: "normal" });
    expect(rig.core.apps.listRevisions(r1.targetAppId)).toHaveLength(2);
    const t = await rig.engine.transcript();
    expect(t.items.some((i) => i.toolName === "app_activate")).toBe(true);
  });

  it("A01b an invalid bundle is repaired within the stage budget", async () => {
    rig = await startRig();
    const r = await submit(rig, "做一个待办应用 [faux:invalid-once]");
    const run = await waitRun(rig, r.runId);
    expect(run.status).toBe("succeeded");
    expect(rig.core.runs.view(run).progress.stageAttempts).toBe(2);
  });

  it("A02 three invalid bundles fail the run and the old version keeps working", async () => {
    rig = await startRig();
    const ok = await waitRun(rig, (await submit(rig, "做一个待办应用")).runId);
    const appId = ok.target_app_id;
    const before = rig.core.apps.getApp(appId);
    const r = await submit(rig, "增加优先级 [faux:invalid]", appId);
    const run = await waitRun(rig, r.runId);
    expect(run.status).toBe("failed");
    expect(JSON.parse(run.error_json!).code).toBe("BUDGET_EXCEEDED");
    expect(rig.core.runs.view(run).progress.stageAttempts).toBe(3);
    expect(run.model_request_count).toBe(6);
    expect(rig.core.apps.getApp(appId)).toEqual(before);
    createRecord(rig.core, appId, { title: "still works" });
    expect(JSON.parse(run.last_validation_json!).issues.length).toBeGreaterThan(0);
  });

  it("A02b model request budget and deadline end the run without publishing", async () => {
    rig = await startRig({ runSettings: { maxModelRequests: 2 } });
    const run = await waitRun(rig, (await submit(rig, "做一个待办应用")).runId);
    expect(run.status).toBe("failed");
    expect(JSON.parse(run.error_json!).code).toBe("BUDGET_EXCEEDED");
    expect(run.model_request_count).toBe(2);
    await rig.close();
    rig = await startRig({ runSettings: { deadlineMs: 300 } });
    const run2 = await waitRun(rig, (await submit(rig, "做一个待办应用 [faux:slow:600]")).runId);
    expect(run2.status).toBe("failed");
    expect(JSON.parse(run2.error_json!).code).toBe("DEADLINE_EXCEEDED");
    expect(run2.applied_revision_id).toBeNull();
  });

  it("A03 a second generation request is RUN_BUSY", async () => {
    rig = await startRig();
    const r = await submit(rig, "做一个待办应用 [faux:slow:400]");
    let code = "";
    try {
      await submit(rig, "再做一个");
    } catch (e) {
      code = (e as AgentOsError).code;
    }
    expect(code).toBe("RUN_BUSY");
    expect(rig.core.store.all("SELECT id FROM runs")).toHaveLength(1);
    await waitRun(rig, r.runId);
  });

  it("A04 a write after publishing in the same round is refused; appliedRevision stays", async () => {
    rig = await startRig();
    const run = await waitRun(rig, (await submit(rig, "做一个待办应用 [faux:post-write]")).runId);
    expect(run.status).toBe("succeeded");
    const t = await rig.engine.transcript();
    const stageResults = t.items.filter((i) => i.toolName === "app_stage");
    expect(stageResults.at(-1)!.isError).toBe(true);
    expect(stageResults.at(-1)!.text).toContain("FORBIDDEN");
    expect(rig.core.apps.getApp(run.target_app_id).activeRevisionId).toBe(run.applied_revision_id);
    expect(rig.core.store.all("SELECT id FROM revisions WHERE app_id = ?", run.target_app_id)).toHaveLength(1);
  });

  it("A05 activating the current revision is a recorded no-op", async () => {
    rig = await startRig();
    const first = await waitRun(rig, (await submit(rig, "做一个待办应用")).runId);
    const epoch = rig.core.apps.requireApp(first.target_app_id).epoch;
    const run = await waitRun(rig, (await submit(rig, "保持不变 [faux:same]", first.target_app_id)).runId);
    expect(run.status).toBe("succeeded");
    expect(run.applied_revision_id).toBe(first.applied_revision_id);
    expect(rig.core.apps.requireApp(first.target_app_id).epoch).toBe(epoch);
    const t = await rig.engine.transcript();
    expect(t.items.at(-1)!.toolName).toBe("app_activate");
    expect(JSON.parse(t.items.at(-1)!.text).changed).toBe(false);
  });

  it("cancel before publish: cancelled, no revision; model error is reported", async () => {
    rig = await startRig();
    const r = await submit(rig, "做一个待办应用 [faux:slow:800]");
    await waitFor(() => rig!.core.runs.getRow(r.runId)!.dispatch_state === "submitted");
    const res = rig.core.user.cancelRun({ operationKey: randomUUID(), requestHash: requestHash({ c: 1 }) }, r.runId);
    expect(res.status).toBe(202);
    void rig.coord.kick();
    const run = await waitRun(rig, r.runId);
    expect(run.status).toBe("cancelled");
    expect(run.applied_revision_id).toBeNull();
    expect(await rig.engine.isIdle()).toBe(true);
    const r2 = await waitRun(rig, (await submit(rig, "做一个待办应用 [faux:model-error]")).runId);
    expect(r2.status).toBe("failed");
    expect(JSON.parse(r2.error_json!).code).toMatch(/MODEL_ERROR|NO_APPLICATION_PUBLISHED/);
  });
});
