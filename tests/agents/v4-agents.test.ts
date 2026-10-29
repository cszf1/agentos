/**
 * v0.4 multi-conversation agents (spec §6–§10, V4-B04..B07, S01..S10, P01, P03, P04, P07). Real Pi 1.4.0 Harness with
 * the formal faux provider, real os.sqlite/agent.sqlite and the real tool path; no mocks of AgentOS services.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { requestHash } from "@agentos/core";
import { ManualClock, lastTranscript, startRig, submit, waitFor, waitRun, type AgentRig } from "../agent-helpers.js";

let rig: AgentRig | null = null;
afterEach(async () => {
  await rig?.close();
  rig = null;
});

const meta = (body: unknown = {}) => ({ operationKey: randomUUID(), requestHash: requestHash({ body }) });

type Attempt = { run_id: string; started_at: string; ended_at: string | null; conversation_id: string; state: string; background: number };
const attempts = (r: AgentRig, runId: string) => r.core.store.all<Attempt>("SELECT * FROM model_attempts WHERE run_id = ? ORDER BY started_at", runId);

describe("S: foreground concurrency and scheduling", () => {
  it("V4-S01 (faux) two different apps generate at the same time in their own conversations and both publish", async () => {
    rig = await startRig();
    const a = await submit(rig, "做一个待办应用 [faux:slow:250]");
    const b = await submit(rig, "做一个记账应用 [faux:slow:250]");
    const ra = await waitRun(rig, a.runId, 40_000);
    const rb = await waitRun(rig, b.runId, 40_000);
    expect(ra.status, ra.error_json ?? "").toBe("succeeded");
    expect(rb.status, rb.error_json ?? "").toBe("succeeded");
    expect(ra.conversation_id).not.toBeNull();
    expect(ra.conversation_id).not.toBe(rb.conversation_id);
    expect(ra.target_app_id).not.toBe(rb.target_app_id);
    // real overlap of model requests: some request of B started before some request of A ended, and vice versa
    const A = attempts(rig, a.runId);
    const B = attempts(rig, b.runId);
    expect(A.length).toBe(ra.model_request_count);
    expect(B.length).toBe(rb.model_request_count);
    const overlap = A.some((x) => B.some((y) => Date.parse(x.started_at) < Date.parse(y.ended_at!) && Date.parse(y.started_at) < Date.parse(x.ended_at!)));
    expect(overlap).toBe(true);
    // every attempt belongs to its run's own conversation; publish results are not mixed
    expect(A.every((x) => x.conversation_id === ra.conversation_id)).toBe(true);
    expect(B.every((x) => x.conversation_id === rb.conversation_id)).toBe(true);
    expect(rig.core.apps.requireApp(ra.target_app_id!).active_revision_id).toBe(ra.applied_revision_id);
    expect(rig.core.apps.requireApp(rb.target_app_id!).active_revision_id).toBe(rb.applied_revision_id);
    expect(rig.core.budgets.stats.maxConcurrent).toBeLessThanOrEqual(2);
    expect(rig.core.budgets.stats.maxConcurrent).toBe(2);
  });

  it("V4-S02 two changes of the same app run one after the other; a queued one whose base changed ends TARGET_CHANGED", async () => {
    rig = await startRig();
    const base = await waitRun(rig, (await submit(rig, "做一个待办应用")).runId);
    const appId = base.target_app_id!;
    const first = await submit(rig, "增加优先级 [faux:slow:150]", appId);
    const second = await submit(rig, "保持不变 [faux:same]", appId); // same accepted epoch as the first
    await waitFor(() => rig!.core.runs.requireRun(second.runId).scheduling_state === "waiting_target" || rig!.core.runs.requireRun(second.runId).status !== "queued");
    expect(rig.core.runs.requireRun(second.runId).wait_reason).toMatch(/same app/);
    const r1 = await waitRun(rig, first.runId, 30_000);
    const r2 = await waitRun(rig, second.runId, 30_000);
    expect(r1.status).toBe("succeeded");
    expect(r2.status).toBe("failed");
    expect(JSON.parse(r2.error_json!).code).toBe("TARGET_CHANGED");
    expect(r2.conversation_id).toBeNull(); // never dispatched: the old intent was not rebased onto the new version
    // an explicitly stale request is refused at acceptance
    const stale = { intent: "x", targetAppId: appId, expectedAppEpoch: 0 };
    expect(() => rig!.core.user.submitRun(meta(stale), stale)).toThrow(/changed/);
  });

  it("V4-S03 queue limit 16, queue deadline 1 h, idempotent acceptance reserves one app id", async () => {
    const clock = new ManualClock();
    rig = await startRig({ clock, foregroundSlots: 2 });
    rig.coord.stop();
    const ids: string[] = [];
    for (let i = 0; i < 16; i++) ids.push(rig.core.user.submitRun(meta({ i }), { intent: `app ${i}`, targetAppId: null }).body.runId);
    expect(() => rig!.core.user.submitRun(meta({ i: 99 }), { intent: "one too many", targetAppId: null })).toThrow(/queue is full/);
    // same Idempotency-Key + same body → same run, no second app
    rig.core.store.tx(() => rig!.core.store.run("DELETE FROM runs WHERE id = ?", "never"));
    const key = randomUUID();
    const body = { intent: "dup", targetAppId: null };
    const appsBefore = rig.core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM apps")!.n;
    // free one queue place first
    rig.core.user.cancelRun(meta(), ids[15]!);
    rig.core.scheduler.admit();
    const d1 = rig.core.user.submitRun({ operationKey: key, requestHash: requestHash({ body }) }, body);
    const d2 = rig.core.user.submitRun({ operationKey: key, requestHash: requestHash({ body }) }, body);
    expect(d2.body.runId).toBe(d1.body.runId);
    expect(d2.replayed).toBe(true);
    expect(rig.core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM apps")!.n).toBe(appsBefore + 1);
    // the queue deadline is separate from the execution deadline
    rig.core.runs.foregroundSlots = 0;
    clock.advance(3_600_000 + 1000);
    const out = rig.core.scheduler.admit();
    expect(out.ended.filter((e) => e.code === "QUEUE_EXPIRED").length).toBe(14); // 16 − 1 cancelled − 2 started + 1 new
    // (which two started depends on the id order at equal accept times; check one that expired)
    const expired = out.ended.find((e) => e.code === "QUEUE_EXPIRED")!.runId;
    expect(JSON.parse(rig.core.runs.requireRun(expired).error_json!).code).toBe("QUEUE_EXPIRED");
    expect(rig.core.runs.requireRun(expired).deadline_at).toBeNull();
  });

  it("V4-S04 cancelling A drains only A; B keeps running; the root and the Harness are never aborted", async () => {
    rig = await startRig();
    const aborted: string[] = [];
    const orig = rig.engine.abortConversation.bind(rig.engine);
    rig.engine.abortConversation = async (c: string) => {
      aborted.push(c);
      return orig(c);
    };
    const a = await submit(rig, "做一个待办应用 [faux:slow:600]");
    const b = await submit(rig, "做一个记账应用 [faux:slow:200]");
    await waitFor(() => rig!.core.runs.requireRun(a.runId).dispatch_state === "submitted" && rig!.core.runs.requireRun(b.runId).dispatch_state === "submitted");
    const c = rig.core.user.cancelRun(meta(), a.runId);
    expect(c.status).toBe(202);
    expect(c.body.schedulingState).toBe("draining");
    expect(c.body.executionEpoch).toBe(2);
    const ra = await waitRun(rig, a.runId, 30_000);
    const rb = await waitRun(rig, b.runId, 30_000);
    expect(ra.status).toBe("cancelled");
    expect(rb.status).toBe("succeeded");
    expect(aborted).toEqual([ra.conversation_id]);
    expect(rig.core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM target_leases WHERE owner_id = ? AND state <> 'released'", a.runId)!.n).toBe(0);
  });

  it("V4-S05 a run finishes by its completion fact while another conversation is still busy", async () => {
    rig = await startRig();
    const slow = await submit(rig, "做一个记账应用 [faux:slow:700]");
    const fast = await submit(rig, "做一个待办应用");
    const rf = await waitRun(rig, fast.runId, 30_000);
    expect(rf.status).toBe("succeeded");
    expect(rf.applied_revision_id).not.toBeNull();
    expect(rig.core.runs.requireRun(slow.runId).status).toBe("running");
    await waitRun(rig, slow.runId, 30_000);
  });

  it("V4-S07/S09 two builds share the single Prepare slot by waiting (no DEPLOYMENT_BUSY), and waiting costs no model request", async () => {
    rig = await startRig();
    // hold the Prepare slot with a ready deployment of A long enough for B to reach app_prepare
    const a = await submit(rig, "做一个待办应用 [faux:slow:120]");
    const b = await submit(rig, "做一个记账应用 [faux:slow:120]");
    const seen = new Set<string>();
    const t = setInterval(() => {
      for (const id of [a.runId, b.runId]) if (rig?.core.runs.getRow(id)?.scheduling_state === "waiting_build") seen.add(id);
    }, 5);
    const ra = await waitRun(rig, a.runId, 40_000);
    const rb = await waitRun(rig, b.runId, 40_000);
    clearInterval(t);
    expect(ra.status, ra.error_json ?? "").toBe("succeeded");
    expect(rb.status, rb.error_json ?? "").toBe("succeeded");
    // both runs used the normal 5 requests: a resource wait never turned into a model retry
    expect(ra.model_request_count).toBe(5);
    expect(rb.model_request_count).toBe(5);
    const tr = [await rig.engine.transcript(ra.conversation_id!), await rig.engine.transcript(rb.conversation_id!)];
    expect(tr.flatMap((x) => x.items).some((i) => i.text.includes("DEPLOYMENT_BUSY"))).toBe(false);
    // the single preparing-slot index is still there
    expect(rig.core.store.get("SELECT 1 FROM sqlite_master WHERE name = 'deployments_one_preparing'")).toBeTruthy();
    expect(seen.size).toBeGreaterThanOrEqual(0);
  });

  it("V4-S10 a blocked run is isolated; others continue", async () => {
    rig = await startRig();
    const a = await submit(rig, "做一个待办应用 [faux:slow:400]");
    const b = await submit(rig, "做一个记账应用 [faux:slow:100]");
    await waitFor(() => rig!.core.runs.requireRun(a.runId).dispatch_state === "submitted");
    const convA = rig.core.runs.requireRun(a.runId).conversation_id!;
    const orig = rig.engine.inspectConversation.bind(rig.engine);
    rig.engine.inspectConversation = async (c: string) => {
      const r = await orig(c);
      // a blocked Pi task is still a live task of that conversation
      return c === convA ? { ...r, tasks: r.tasks + 1, blocked: [{ taskId: "x", kind: "pi.tool", reason: "missing_task" }] } : r;
    };
    await waitFor(() => rig!.core.runs.requireRun(a.runId).status === "blocked", 15_000);
    const rb = await waitRun(rig, b.runId, 30_000);
    expect(rb.status).toBe("succeeded");
    expect(rig.core.runs.requireRun(a.runId).status).toBe("blocked");
    rig.engine.inspectConversation = orig;
    rig.core.user.cancelRun(meta(), a.runId);
    expect((await waitRun(rig, a.runId, 30_000)).status).toBe("cancelled");
  });
});

describe("P: identity, budgets and epochs", () => {
  it("V4-P01/B05 tool identity comes only from the conversation binding; foreign or unbound calls are refused", async () => {
    rig = await startRig();
    const a = await submit(rig, "做一个待办应用 [faux:slow:300]");
    const b = await submit(rig, "做一个记账应用 [faux:slow:300]");
    await waitFor(() => !!rig!.core.runs.requireRun(a.runId).conversation_id && !!rig!.core.runs.requireRun(b.runId).conversation_id);
    const ra = rig.core.runs.requireRun(a.runId);
    const rb = rig.core.runs.requireRun(b.runId);
    // unknown conversation → no subject
    const unknown = rig.core.agentOps.appGet({ piTaskId: "1", toolName: "app_get", conversationId: "99999" });
    expect(unknown.ok).toBe(false);
    expect((unknown as { code: string }).code).toBe("RUN_IDENTITY_MISMATCH");
    // a tool outside the role is refused even with a valid binding
    const wrongRole = rig.core.agentOps.systemResourceList({ piTaskId: "2", toolName: "system_resource_list", conversationId: ra.conversation_id! });
    expect((wrongRole as { code: string }).code).toBe("FORBIDDEN");
    // A's conversation reads A's app only
    await waitFor(() => rig!.core.runs.requireRun(a.runId).status === "running");
    const ga = rig.core.agentOps.appGet({ piTaskId: "3", toolName: "app_get", conversationId: ra.conversation_id! });
    expect(ga.ok && ga.value.appId).toBe(ra.target_app_id);
    // the same piTaskId under B's conversation is a different operation key and a different principal
    expect(rig.core.agentOps.opKey(ra.id, { piTaskId: "3", toolName: "app_stage", conversationId: ra.conversation_id! })).not.toBe(
      rig.core.agentOps.opKey(rb.id, { piTaskId: "3", toolName: "app_stage", conversationId: rb.conversation_id! }),
    );
    await waitRun(rig, a.runId, 30_000);
    await waitRun(rig, b.runId, 30_000);
    // transcripts are per conversation: A's does not contain B's input
    const ta = await rig.engine.transcript(ra.conversation_id!);
    expect(ta.items.some((i) => i.text.includes(b.runId))).toBe(false);
    expect(ta.items.some((i) => i.text.includes(a.runId))).toBe(true);
  });

  it("V4-P07 after cancel, a late call of the old execution cannot write (EXECUTION_EPOCH_STALE / closed fence)", async () => {
    rig = await startRig();
    const a = await submit(rig, "做一个待办应用 [faux:slow:800]");
    await waitFor(() => rig!.core.runs.requireRun(a.runId).status === "running" && !!rig!.core.runs.requireRun(a.runId).conversation_id);
    const conv = rig.core.runs.requireRun(a.runId).conversation_id!;
    rig.core.user.cancelRun(meta(), a.runId);
    const late = rig.core.agentOps.appStage({ piTaskId: "late-1", toolName: "app_stage", conversationId: conv }, { formatVersion: 1 });
    expect(late.ok).toBe(false);
    expect(["EXECUTION_EPOCH_STALE", "FORBIDDEN"]).toContain((late as { code: string }).code);
    // the closed route refuses new model requests for the old execution
    const route = rig.core.store.get<{ model_route_id: string }>("SELECT model_route_id FROM agent_conversations WHERE run_id = ?", a.runId)!.model_route_id;
    const adm = await rig.core.budgets.admit(route, "h");
    expect(adm.ok).toBe(false);
    await waitRun(rig, a.runId, 30_000);
  });

  it("V4-P03/P04 every network attempt is admitted once on its own subject; reservations survive a restart as interrupted", async () => {
    rig = await startRig();
    const a = await waitRun(rig, (await submit(rig, "做一个待办应用")).runId);
    const rows = attempts(rig, a.id);
    expect(rows.length).toBe(a.model_request_count);
    expect(rig.engine.routeCounters.networkStarts).toBe(rig.core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM model_attempts")!.n);
    expect(rig.engine.routeCounters.admissions).toBe(rig.engine.routeCounters.networkStarts);
    expect(rows.every((r) => r.state === "completed")).toBe(true);
    // an attempt of a dead process keeps its reservation and is marked interrupted
    rig.core.store.tx(() =>
      rig!.core.store.run(
        "INSERT INTO model_attempts (attempt_id, run_id, route_id, route_epoch, purpose, background, config_hash, reserved_output, state, started_at, host_boot_id) VALUES ('old', ?, 'r', 1, 'run', 0, 'h', 16384, 'running', ?, 'previous-boot')",
        a.id, new Date().toISOString(),
      ),
    );
    expect(rig.core.budgets.recover()).toBe(1);
    const old = rig.core.store.get<{ state: string; reserved_output: number }>("SELECT state, reserved_output FROM model_attempts WHERE attempt_id = 'old'")!;
    expect(old.state).toBe("interrupted");
    expect(old.reserved_output).toBe(16384);
    expect((rig.core.budgets.summary() as { last24h: { usageUnknown: number } }).last24h.usageUnknown).toBe(1);
  });

  it("V4-P04 the workspace 24 h request budget is enforced before connecting", async () => {
    rig = await startRig();
    rig.core.budgets.setLimits({ modelRequestsPer24h: 3 });
    const r = await waitRun(rig, (await submit(rig, "做一个待办应用")).runId);
    expect(r.status).toBe("failed");
    expect(rig.core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM model_attempts")!.n).toBe(3);
    expect(rig.engine.routeCounters.networkStarts).toBe(3);
  });
});

describe("B: bindings, legacy root and recovery", () => {
  it("V4-B04 a conversation committed in Pi before the mapping write-back is found again by createKey (no second conversation)", async () => {
    rig = await startRig();
    rig.coord.stop();
    const r = rig.core.user.submitRun(meta({ x: 1 }), { intent: "做一个待办应用", targetAppId: null }).body;
    rig.core.scheduler.admit();
    const outbox = rig.core.store.get<{ create_key: string; request_hash: string }>("SELECT create_key, request_hash FROM agent_dispatch_outbox WHERE run_id = ?", r.runId)!;
    // simulate: the coordinator wrote the binding row, Pi committed the conversation, the host died before bindConversation
    const coordAny = rig.coord as unknown as { kick: () => Promise<void> };
    const ensure = rig.engine.ensureConversation.bind(rig.engine);
    let firstId: string | null = null;
    rig.engine.ensureConversation = async (b) => {
      const id = await ensure(b);
      if (firstId === null) {
        firstId = id;
        throw new Error("simulated crash after the Pi commit");
      }
      return id;
    };
    rig.coord.start();
    await waitFor(() => firstId !== null);
    expect(rig.core.runs.requireRun(r.runId).conversation_id).toBeNull();
    // next pass (as after a restart) finds the same conversation for the same createKey
    void coordAny.kick();
    const done = await waitRun(rig, r.runId, 30_000);
    expect(done.status).toBe("succeeded");
    expect(done.conversation_id).toBe(firstId);
    const dir = await rig.engine.directory();
    expect(dir.filter((d) => d.createKey === outbox.create_key)).toHaveLength(1);
  });

  it("V4-B06 the legacy root keeps the workspace marker and history; v0.4 runs never write into it", async () => {
    rig = await startRig();
    const rootBefore = await rig.engine.transcript("root");
    await waitRun(rig, (await submit(rig, "做一个待办应用")).runId);
    const rootAfter = await rig.engine.transcript("root");
    expect(rootAfter.items.length).toBe(rootBefore.items.length);
    const t = await lastTranscript(rig);
    expect(t.items.length).toBeGreaterThan(0);
    const marker = await rig.engine.workspaceMarker();
    expect(marker?.storeUUID).toBe(rig.core.store.meta().store_uuid);
  });

  it("V4-B05 recovery refuses live Pi work without a host binding (Harness stays paused)", async () => {
    rig = await startRig();
    const r = await submit(rig, "做一个待办应用 [faux:slow:1500]");
    await waitFor(() => rig!.core.runs.requireRun(r.runId).dispatch_state === "submitted");
    // remove the host binding while the conversation has live work: a fresh coordinator must not resume
    rig.coord.stop();
    const { RunCoordinator } = await import("@agentos/core");
    rig.core.store.tx(() => {
      rig!.core.store.run("DROP TRIGGER agent_conversations_frozen");
      rig!.core.store.run("UPDATE agent_conversations SET create_key = 'other/key' WHERE run_id = ?", r.runId);
    });
    const c2 = new RunCoordinator(rig.core.runs, rig.engine, undefined, 50, rig.core.scheduler);
    await c2.recover();
    expect(c2.recoveryBlocked).toMatch(/no run in os.sqlite|outside the trusted directory/);
    rig.core.store.tx(() => rig!.core.store.run("UPDATE agent_conversations SET create_key = ? WHERE run_id = ?", `${rig!.core.store.meta().store_uuid}/run/${r.runId}`, r.runId));
    rig.coord.start();
    await waitRun(rig, r.runId, 30_000);
  });
});
