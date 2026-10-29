/**
 * v0.4 asynchronous session compaction (spec §20, V4-C01..C06). Real Pi 1.4.0 Harness with the formal faux provider,
 * real os.sqlite/agent.sqlite, the real budget gate and the real CompactionService; no mocks of AgentOS services.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startRig, submit, waitFor, waitRun, type AgentRig } from "../agent-helpers.js";

let rig: AgentRig | null = null;
afterEach(async () => {
  await rig?.close();
  rig = null;
});

async function compactRig(): Promise<AgentRig> {
  // keep only a little recent context so the faux conversation has something to summarize
  const r = await startRig({ compaction: { reserveTokens: 256, keepRecentTokens: 64 } });
  r.core.compactions.engine = r.engine;
  r.core.compactions.attachRoute = (id) => r.engine.attachCompactionRoute(id);
  return r;
}
async function endedRun(r: AgentRig, intent = "做一个待办应用") {
  const s = await submit(r, intent);
  const row = await waitRun(r, s.runId, 60_000);
  expect(row.status).toBe("succeeded");
  const conv = r.core.store.get<{ conversation_id: string }>("SELECT conversation_id FROM agent_conversations WHERE run_id = ?", s.runId)!;
  return { runId: s.runId, conversationId: conv.conversation_id };
}
async function settle(r: AgentRig, id: string, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await r.core.compactions.tick();
    const j = r.core.compactions.get(id)!;
    if (!["queued", "creating", "running"].includes(j.state)) return j;
    if (Date.now() > until) throw new Error(`compaction still ${j.state}`);
    await new Promise((res) => setTimeout(res, 50));
  }
}
const attemptsOf = (r: AgentRig, jobId: string) => r.core.store.all<{ purpose: string; background: number; run_id: string | null; state: string }>("SELECT purpose, background, run_id, state FROM model_attempts WHERE compaction_job_id = ?", jobId);

describe("compaction", () => {
  it("V4-C01 only an ended task conversation; the legacy root, running tasks and provider content without consent are refused", async () => {
    rig = await compactRig();
    const a = await endedRun(rig);
    const root = rig.core.store.get<{ conversation_id: string }>("SELECT conversation_id FROM agent_conversations WHERE purpose = 'legacy_root'");
    if (root) await expect(rig.core.compactions.request(root.conversation_id, {})).rejects.toMatchObject({ code: "COMPACTION_SCOPE_DENIED" });
    await expect(rig.core.compactions.request("conv-that-does-not-exist", {})).rejects.toMatchObject({ code: "COMPACTION_SCOPE_DENIED" });
    // (the provider-content consent gate for system_plan conversations runs against the real broker: sandbox suite)
    const ok = await rig.core.compactions.request(a.conversationId, {});
    const scope = JSON.parse(ok.input_scope);
    expect(scope).toMatchObject({ conversationId: a.conversationId, runId: a.runId, mode: "build", providerContentConsent: false, crossConversation: false });
    // a task that has not ended cannot be compacted
    const s = await submit(rig, "做一个记账应用 [faux:slow:400]");
    await waitFor(() => !!rig!.core.store.get("SELECT 1 FROM agent_conversations WHERE run_id = ?", s.runId), 20_000);
    const conv = rig.core.store.get<{ conversation_id: string }>("SELECT conversation_id FROM agent_conversations WHERE run_id = ?", s.runId)!;
    await expect(rig.core.compactions.request(conv.conversation_id, {})).rejects.toMatchObject({ code: "COMPACTION_SCOPE_DENIED" });
    await waitRun(rig, s.runId, 60_000);
  });

  it("V4-C02/C06 one background request on the job's own route; the run's budget is untouched; original entries stay", async () => {
    rig = await compactRig();
    const a = await endedRun(rig);
    const runAttempts = rig.core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM model_attempts WHERE run_id = ?", a.runId)!.n;
    const before = (await rig.engine.transcript(a.conversationId)).items.length;
    const j = await rig.core.compactions.request(a.conversationId, {});
    const done = await settle(rig, j.id);
    expect(["placed", "summary_unplaced"], JSON.stringify(done)).toContain(done.state);
    const at = attemptsOf(rig, j.id);
    expect(at.length).toBe(1);
    expect(at[0]).toMatchObject({ purpose: "compaction", background: 1 });
    expect(rig.core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM model_attempts WHERE run_id = ? AND compaction_job_id IS NULL", a.runId)!.n).toBe(runAttempts);
    expect(done.budget_route_epoch).toBeGreaterThan(0);
    // the original entries are still there (a summary adds, never replaces)
    expect((await rig.engine.transcript(a.conversationId)).items.length).toBeGreaterThanOrEqual(before);
    // after the job the route is closed: the ended build never gets its write route (or a new request) back
    const b = rig.core.store.get<{ route_purpose: string; maintenance_lock: string | null }>("SELECT route_purpose, maintenance_lock FROM agent_conversations WHERE conversation_id = ?", a.conversationId)!;
    expect(b).toMatchObject({ route_purpose: "closed", maintenance_lock: null });
    // the scope comes from the trusted database, never from the summary
    expect(JSON.parse(done.input_scope).runId).toBe(a.runId);
  });

  it("V4-C03 create/bind is idempotent: the same key finds the same Pi task; a replayed 'creating' makes no second summary", async () => {
    rig = await compactRig();
    const a = await endedRun(rig);
    const j = await rig.core.compactions.request(a.conversationId, {});
    // the same request (same conversation + cutoff) is the same job
    const again = await rig.core.compactions.request(a.conversationId, {});
    expect(again.id).toBe(j.id);
    const done = await settle(rig, j.id);
    const taskId = done.pi_task_id;
    expect(taskId).toBeTruthy();
    // read-before-create in one Pi commit: starting the same key again returns the same task
    expect(await rig.engine.startCompaction({ compactionKey: done.compaction_key, conversationId: a.conversationId })).toBe(taskId);
    expect(attemptsOf(rig, j.id).length).toBe(1);
  });

  it("V4-C04 placed, unplaced, stale, failed and cancelled are different states; an old cutoff never makes a second summary", async () => {
    rig = await compactRig();
    const a = await endedRun(rig);
    const j1 = await rig.core.compactions.request(a.conversationId, {});
    const d1 = await settle(rig, j1.id);
    const v = rig.core.compactions.view(d1);
    expect(v.label).toMatch(d1.state === "placed" ? /已生成并放置/ : /未放置/);
    // a new request after the summary is on a newer cutoff (a new job); the old cutoff's job stays as it was
    const j2 = await rig.core.compactions.request(a.conversationId, {}).catch((e) => e);
    if (!(j2 instanceof Error)) {
      if (j2.id !== j1.id) expect(j2.cutoff_entry_id).not.toBe(d1.cutoff_entry_id);
      await settle(rig, j2.id);
    }
    expect(rig.core.compactions.get(j1.id)!.state).toBe(d1.state);
    expect(attemptsOf(rig, j1.id).length).toBe(1);
    const labels = new Set(["placed", "summary_unplaced", "stale", "failed", "cancelled"].map((s) => rig!.core.compactions.view({ ...d1, state: s as never }).label));
    expect(labels.size).toBe(5);
  });

  it("V4-C05 another task runs while a conversation is compacted; cancelling the compaction does not touch it", async () => {
    rig = await compactRig();
    const a = await endedRun(rig);
    const j = await rig.core.compactions.request(a.conversationId, {});
    const b = await submit(rig, "做一个读书应用 [faux:slow:100]");
    const cancelled = await rig.core.compactions.cancel(j.id);
    expect(cancelled.state).toBe("cancelled");
    expect(attemptsOf(rig, j.id).length).toBeLessThanOrEqual(1);
    const rb = await waitRun(rig, b.runId, 60_000);
    expect(rb.status).toBe("succeeded");
    // the compacted conversation's route is closed again; it accepts no new business tool or request
    const row = rig.core.store.get<{ route_purpose: string }>("SELECT route_purpose FROM agent_conversations WHERE conversation_id = ?", a.conversationId)!;
    expect(row.route_purpose).toBe("closed");
    // a fresh compaction of the same conversation + cutoff is the same (cancelled) job: never a hidden re-run
    expect((await rig.core.compactions.request(a.conversationId, {})).id).toBe(j.id);
  });
});
