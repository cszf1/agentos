import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { requestHash } from "@agentos/core";
import { startRig, submit, waitFor, waitRun, type AgentRig } from "../agent-helpers.js";

let rig: AgentRig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const meta = () => ({ operationKey: randomUUID(), requestHash: requestHash({ n: randomUUID() }) });

describe("R10 cancel semantics", () => {
  it("cancelling an old terminal run changes nothing and does not touch the new run", async () => {
    rig = await startRig();
    const failed = await waitRun(rig, (await submit(rig, "做一个待办应用 [faux:refuse]")).runId);
    expect(failed.status).toBe("failed");
    expect(JSON.parse(failed.error_json!).code).toBe("NO_APPLICATION_PUBLISHED");
    const live = await submit(rig, "做一个待办应用 [faux:slow:500]");
    const again = rig.core.user.cancelRun(meta(), failed.id);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("failed");
    expect(rig.core.runs.getRow(live.runId)!.status).not.toBe("cancel_requested");
    expect((await waitRun(rig, live.runId)).status).toBe("succeeded");
  });

  it("cancel that commits before dispatch wins: Pi never sees the run", async () => {
    rig = await startRig();
    const body = { intent: "做一个待办应用", targetAppId: null };
    // accept and cancel in the same synchronous turn, before the coordinator can dispatch
    const accepted = rig.core.user.submitRun({ operationKey: randomUUID(), requestHash: requestHash(body) }, body, true).body;
    const c = rig.core.user.cancelRun(meta(), accepted.runId);
    expect(c.status).toBe(202);
    expect(rig.core.runs.beginDispatch(accepted.runId)).toBe(false);
    const run = await waitRun(rig, accepted.runId);
    expect(run.status).toBe("cancelled");
    expect(run.dispatch_state).toBe("pending");
    const db = new DatabaseSync(path.join(rig.dir, "agent.sqlite"), { readOnly: true });
    expect(db.prepare("SELECT id FROM submissions WHERE request_id = ?").all(JSON.stringify(accepted.runId))).toHaveLength(0);
    db.close();
  });
});

describe("R12 compaction stays inside its run", () => {
  it("a long conversation compacts blocking only, and the summary request counts against the run", async () => {
    rig = await startRig({ fauxContextWindow: 16000, compaction: { reserveTokens: 1000, keepRecentTokens: 600 } });
    const counts: number[] = [];
    let appId: string | null = null;
    for (let i = 0; i < 12; i++) {
      const r = await submit(rig, i === 0 ? "做一个待办应用" : `修改说明第${i}次 [faux:same]`, appId);
      const run = await waitRun(rig, r.runId);
      expect(run.status, run.error_json ?? "").toBe("succeeded");
      appId = run.target_app_id;
      counts.push(run.model_request_count);
      // background compaction is disabled: nothing is left running between runs
      expect(await rig.engine.isIdle()).toBe(true);
    }
    const t = await rig.engine.transcript();
    const compacted = t.items.some((i) => i.kind === "pi.compaction");
    expect(compacted).toBe(true);
    // v0.2 runs without compaction need 5 admitted requests (get, stage, validate, prepare, activate); a run that
    // compacted paid more, inside its own budget
    expect(counts).toContain(5);
    expect(Math.max(...counts)).toBeGreaterThan(5);
    expect(Math.max(...counts)).toBeLessThanOrEqual(12);

    // Cancel a run on the compacted conversation, then start the next one: until Pi has fully converged the slot
    // stays taken (RUN_BUSY), and nothing from the cancelled run ever writes under the next run.
    const slow = await submit(rig, "修改说明取消 [faux:slow:1500]", appId);
    await waitFor(() => rig!.core.runs.requireRun(slow.runId).dispatch_state === "submitted");
    rig.core.user.cancelRun(meta(), slow.runId);
    let busy = "";
    try {
      await submit(rig, "下一次修改 [faux:same]", appId);
    } catch (e) {
      busy = (e as { code?: string }).code ?? "";
    }
    expect(busy).toBe("RUN_BUSY");
    const cancelled = await waitRun(rig, slow.runId);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.applied_revision_id).toBeNull();
    expect(await rig.engine.isIdle()).toBe(true);
    const next = await waitRun(rig, (await submit(rig, "下一次修改 [faux:same]", appId)).runId);
    expect(next.status).toBe("succeeded");
    expect(next.model_request_count).toBeLessThanOrEqual(6);
    expect(rig.core.store.all("SELECT id FROM revisions WHERE created_by_run_id = ?", slow.runId)).toHaveLength(0);
  });
});
