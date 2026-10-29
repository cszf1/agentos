import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { requestHash } from "@agentos/core";
import { startRig, submit, waitFor, waitRun, type AgentRig, lastTranscript } from "../agent-helpers.js";

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
    const accepted = rig.core.user.submitRun({ operationKey: randomUUID(), requestHash: requestHash(body) }, body).body;
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

describe("R12 compaction stays inside its run (v0.4: one conversation per run)", () => {
  it("a run whose own context grows compacts blocking only; the summary request counts against that run", async () => {
    // a small context window: one run's own tool results exceed it and force a blocking compaction inside the run
    rig = await startRig({ fauxContextWindow: 6000, compaction: { reserveTokens: 1000, keepRecentTokens: 600 } });
    const first = await waitRun(rig, (await submit(rig, "做一个待办应用")).runId);
    expect(first.status, first.error_json ?? "").toBe("succeeded");
    const appId = first.target_app_id!;
    let compactedRun: string | null = null;
    for (let i = 1; i < 4 && !compactedRun; i++) {
      const run = await waitRun(rig, (await submit(rig, `修改说明第${i}次 [faux:same]`, appId)).runId);
      expect(run.status, run.error_json ?? "").toBe("succeeded");
      const t = await rig.engine.transcript(run.conversation_id!);
      if (t.items.some((x) => x.kind === "pi.compaction")) compactedRun = run.id;
      // background compaction is disabled: nothing is left running between runs
      expect(await rig.engine.isIdle()).toBe(true);
    }
    expect(compactedRun, "a run compacted inside its own conversation").not.toBeNull();
    {
      const run = rig.core.runs.requireRun(compactedRun!);
      // the summary request was admitted on THIS run's route (more than the 5 tool-step requests)
      expect(run.model_request_count).toBeGreaterThan(5);
      expect(run.model_request_count).toBeLessThanOrEqual(12);
      const attempts = rig.core.store.all<{ run_id: string }>("SELECT run_id FROM model_attempts WHERE conversation_id = ?", run.conversation_id);
      expect(attempts.every((a) => a.run_id === compactedRun)).toBe(true);
    }
    // every attempt is attributed to the run of its conversation
    const mixed = rig.core.store.all("SELECT a.attempt_id FROM model_attempts a JOIN runs r ON r.id = a.run_id WHERE a.conversation_id <> r.conversation_id");
    expect(mixed).toHaveLength(0);

    // Cancel a run, then submit the next one on the same app: it is accepted (queued) and waits for the target until the
    // cancelled conversation fully converged; nothing from the cancelled run ever writes under the next run.
    const slow = await submit(rig, "修改说明取消 [faux:slow:1500]", appId);
    await waitFor(() => rig!.core.runs.requireRun(slow.runId).dispatch_state === "submitted");
    rig.core.user.cancelRun(meta(), slow.runId);
    const next = await submit(rig, "下一次修改 [faux:same]", appId);
    expect(next.status).toBe("queued");
    const cancelled = await waitRun(rig, slow.runId);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.applied_revision_id).toBeNull();
    const done = await waitRun(rig, next.runId);
    expect(done.status).toBe("succeeded");
    expect(Date.parse(done.started_at!)).toBeGreaterThanOrEqual(Date.parse(cancelled.updated_at) - 5);
    expect(rig.core.store.all("SELECT id FROM revisions WHERE created_by_run_id = ?", slow.runId)).toHaveLength(0);
  });
});
