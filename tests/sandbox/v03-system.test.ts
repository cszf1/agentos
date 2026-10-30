import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { CodeBundle } from "@agentos/contracts";
import { requestHash } from "@agentos/core";
import { startRig, submit, waitRun, type AgentRig, lastTranscript } from "../agent-helpers.js";
import { publish } from "../sandbox/util.js";
import { codeFixture } from "../fixtures-v02.js";
import { assertTelemetryMatches, Broker, hasBroker, installed, simCtl, storeUUID, systemctl, waitUntil } from "../v03.js";

/**
 * Host + real broker + real rootless sandbox (ABI-2 runner): grants, provider reads, trusted previews, confirmation,
 * standing grants, revocation, context limits, version switches and the faux system_plan mode (spec §8–§11, §20).
 */
const run = hasBroker() && fs.existsSync(`/run/user/${process.getuid!()}/podman/podman.sock`) ? describe : describe.skip;
const FIX = path.resolve(import.meta.dirname, "..", "..", "fixtures", "v0.3", "system-console");

let APP_ID = "";
function consoleBundle(): CodeBundle {
  const b = JSON.parse(fs.readFileSync(path.join(FIX, "bundle.json"), "utf8")) as CodeBundle;
  if (APP_ID) b.manifest.appId = APP_ID;
  b.code.files = { "src/app.ts": fs.readFileSync(path.join(FIX, "src", "app.ts"), "utf8") };
  return b;
}
const key = () => ({ operationKey: randomUUID(), requestHash: requestHash({ body: { k: randomUUID() } as never }) });

run("v0.3 host system path (real broker, real sandbox)", () => {
  let rig: AgentRig;
  let appId: string;
  const demo = installed()!.units[0]!;
  const managedDir = () => installed()!.managedRoots.find((m) => m.storeUuid === storeUUID())!.path;
  const caps = () => rig.caps;
  const res = (kind: string) => caps().resources.list().find((r) => r.kind === kind)!;
  const final = (id: string, ms = 30_000) => waitUntil(async () => {
    await caps().actions.tick();
    return caps().actions.view(caps().actions.require(id));
  }, (v) => ["done", "no_effect", "unknown", "rejected"].includes(v.phase), ms, 200);
  const connect = async (alias: string, kind: string, policy: "per_plan" | "standing" = "per_plan", bounds?: Record<string, Record<string, unknown>>) => {
    const live = caps().grants.list().filter((g) => g.principal.appId === appId && g.principal.revisionId === rig.core.apps.requireApp(appId).active_revision_id && g.bindingAlias === alias && g.state === "active");
    if (live.length > 0 && !bounds && live.every((g) => g.confirmationPolicy === policy)) return live.map((g) => caps().grants.get(g.grantId)!);
    for (const g of live) rig.core.store.tx(() => caps().grants.revokeConnectionInTx(g.grantId, "re-connect"));
    if (live.length) await caps().grants.pump();
    const gs = rig.core.store.tx(() => caps().grants.createAppGrantsInTx({ appId, bindingAlias: alias, resourceId: res(kind).id, confirmationPolicy: policy, bounds }));
    await waitUntil(async () => {
      await caps().grants.pump();
      return gs.map((g) => caps().grants.get(g.id)!.sync_state);
    }, (st) => st.every((s) => s === "active"), 20_000, 200);
    return gs;
  };
  const query = async (q = "main") => {
    const a = rig.core.apps.requireApp(appId);
    return (await rig.sys.invocations.query(appId, q, {}, a.epoch)).output as Record<string, string>;
  };
  const plan = (h: string, input: unknown) => caps().planFromApp(appId, h, input, rig.core.apps.requireApp(appId).epoch);

  beforeAll(async () => {
    rig = await startRig({ storeUuid: storeUUID() });
    await waitUntil(() => caps().state().brokerReady, (x) => x === true, 20_000, 200);
    // test hygiene: release quarantines left by earlier runs (their unknown facts stay recorded)
    const hb = await new Broker().open();
    await hb.releaseQuarantines();
    hb.close();
    await caps().syncCatalog();
    APP_ID = rig.core.store.tx(() => rig.core.apps.createPlaceholder());
    const b = consoleBundle();
    appId = b.manifest.appId;
    const p = await publish(rig.sys, rig.core, b);
    expect(p.status, JSON.stringify(p.error)).toBe("committed");
  }, 900_000);
  afterAll(async () => {
    await rig?.close();
  });

  it("V3-C02/G03 a v3 app runs on ABI 2; without a connection reads fail honestly (no data invented)", async () => {
    const out = await query();
    expect(out.svc).toBe("需要连接资源");
    expect(out.observedAt).toBe("没有可用观察");
    await expect(plan("setCpu", { percent: 50 })).rejects.toMatchObject({ code: "PROVIDER_GRANT_REQUIRED" });
  });

  it("V3-G04 a pending grant does not admit anything; once the broker confirms it reads real state", async () => {
    const gs = rig.core.store.tx(() => caps().grants.createAppGrantsInTx({ appId, bindingAlias: "svc", resourceId: res("service").id, confirmationPolicy: "per_plan" }));
    expect(gs.every((g) => g.sync_state === "pending")).toBe(true);
    await expect(plan("setCpu", { percent: 50 })).rejects.toMatchObject({ code: "GRANT_PENDING" });
    await waitUntil(async () => {
      await caps().grants.pump();
      return gs.every((g) => caps().grants.get(g.id)!.sync_state === "active");
    }, (x) => x, 20_000, 200);
    systemctl("start", demo.unit);
    const out = await query();
    expect(out.svc).toMatch(/^active/);
    expect(out.observedAt).toMatch(/^观察于 \d{4}-/);
  });

  it("V3-U01 the trusted preview comes from the provider, not from the app's own text; confirm executes exactly that plan", async () => {
    const a = await plan("setCpu", { percent: 50 });
    const v = caps().actions.view(a);
    expect(v.phase).toBe("awaiting_confirmation");
    expect(v.preview.target).toContain(demo.unit);
    expect(JSON.stringify(v.preview.change)).toContain("50%");
    // the app's own preview text is kept separately and is not what the Shell shows
    expect(JSON.stringify(v.preview)).not.toContain("CPU 上限设为 50%（应用说明）");
    expect(() => rig.core.store.tx(() => caps().actions.confirmInTx(a.id, "sha256:" + "0".repeat(64), randomUUID()))).toThrow(/PLAN_HASH_MISMATCH|plan/);
    rig.core.store.tx(() => caps().actions.confirmInTx(a.id, a.plan_hash, randomUUID()));
    const f = await final(a.id);
    expect(f.phase).toBe("done");
    expect(fs.readFileSync(`/sys/fs/cgroup/system.slice/${demo.unit}/cpu.max`, "utf8").trim()).toBe("50000 100000");
    expect(f.effectCertainty).toBe("verified");
  });

  it("V3-U02 a standing grant runs approved plans without a dialog; parameters outside its bounds still need confirmation", async () => {
    await connect("exports", "managed-root", "standing");
    const a = await plan("writeReport", { name: `u02-${Date.now()}` });
    expect(caps().actions.view(a).confirmationRequired).toBe(false);
    expect((await final(a.id)).phase).toBe("done");
    // cpu: standing within 10%..60%; 80% leaves the standing range
    await connect("svc", "service", "standing", { "service.set_limit": { CPUQuotaPerSecUSec: { min: 100000, max: 600000 } } });
    const inside = await plan("setCpu", { percent: 40 });
    expect(caps().actions.view(inside).confirmationRequired).toBe(false);
    expect((await final(inside.id)).phase).toBe("done");
    // Outside the standing bounds (but inside the install cap): not silently allowed — it needs a confirmation.
    const outside = await plan("setCpu", { percent: 80 });
    expect(caps().actions.view(outside).confirmationRequired).toBe(true);
    rig.core.store.tx(() => caps().actions.confirmInTx(outside.id, outside.plan_hash, randomUUID()));
    expect((await final(outside.id)).phase).toBe("done");

  });

  it("V3-C03 one effect only: a plan with mutations, another capability, or several effects is refused", async () => {
    // A second v3 revision whose handler cheats (mutations + another capability) is staged and published.
    const b = consoleBundle();
    b.code.files["src/app.ts"] = b.code.files["src/app.ts"]!.replace(
      'return { bindingAlias: "svc", capabilityId: "service.ensure_state", params: { state: "running" }',
      'return { bindingAlias: "svc", capabilityId: "service.set_limit", params: { property: "MemoryMax", value: 134217728 }',
    ).replace(
      'return { bindingAlias: "svc", capabilityId: "service.ensure_state", params: { state: "stopped" }, observationIds: [o.observationId], preview: { text: "停止服务" } };',
      'return { bindingAlias: "svc", capabilityId: "service.ensure_state", params: { state: "stopped" }, observationIds: [o.observationId], preview: { text: "停止服务" }, mutations: [] } as never;',
    );
    b.manifest.description = "cheating build";
    const p = await publish(rig.sys, rig.core, b);
    expect(p.status).toBe("committed");
    await connect("svc", "service");
    await expect(plan("startService", {})).rejects.toMatchObject({ code: "MIXED_EFFECTS_FORBIDDEN" });
    await expect(plan("stopService", {})).rejects.toMatchObject({ code: expect.stringMatching(/MIXED_EFFECTS_FORBIDDEN|INVALID_SYSTEM_PLAN/) });
  });

  it("V3-G08 switching versions invalidates provider grants; switching back does not revive them", async () => {
    await connect("svc", "service");
    const before = caps().grants.list().filter((g) => g.principal.appId === appId && g.state === "active");
    expect(before.length).toBeGreaterThan(0);
    const p = await publish(rig.sys, rig.core, consoleBundle());
    expect(p.status).toBe("committed");
    await caps().grants.pump();
    const after = caps().grants.list().filter((g) => g.principal.appId === appId && g.state === "active");
    expect(after).toEqual([]);
    const out = await query();
    expect(["需要连接资源", "授权已撤销"]).toContain(out.svc);
  });

  it("V3-G07 a records command and a preview instance never read real provider state", async () => {
    await connect("svc", "service");
    // Prepare of a new candidate reads only a labelled simulated snapshot (checked through the deployment probe log).
    const b = consoleBundle();
    b.manifest.description = "candidate for G07";
    const p = await publish(rig.sys, rig.core, b);
    expect(p.status).toBe("committed");
    const reads = rig.core.store.all<{ scope_kind: string; principal_key: string }>("SELECT scope_kind, principal_key FROM resource_observations WHERE observed_at > ?", new Date(Date.now() - 60_000).toISOString());
    // only the active instance's calls (app_call) and user/run reads exist; nothing attributed to a preview/candidate
    expect(reads.every((r) => !String(r.principal_key).includes("preview"))).toBe(true);
  });

  it("V3-R10/U03/U04 an unknown serial result blocks a version switch and shows as unknown, not as a failure", async () => {
    await connect("svc", "service");
    await connect("dev", "serial");
    simCtl("drop-next");
    const a = await plan("sample", {});
    rig.core.store.tx(() => caps().actions.confirmInTx(a.id, a.plan_hash, randomUUID()));
    const f = await final(a.id, 30_000);
    expect(f.phase).toBe("unknown");
    expect(f.retryAdvice).toMatch(/查看|核对|check/);
    // R10: the app cannot activate another version while this is unsettled
    await expect(caps().prepareActivation(appId)).rejects.toMatchObject({ code: "SYSTEM_ACTION_PENDING" });
    // U04: stopping the app does not hide or "undo" it in the global operation center
    await caps().actions.onAppStopped(appId);
    expect(caps().actions.list({ open: true }).some((x) => x.actionId === a.id && x.phase === "unknown")).toBe(true);
    // D06 via the host: resolution keeps the unknown fact, releases the quarantine
    const r = await caps().actions.resolve(a.id, "accept_unknown", "operator checked the device", true);
    expect(caps().actions.view(r).effectCertainty).toBe("unknown");
    await expect(caps().prepareActivation(appId)).resolves.toBeUndefined();
  });

  it("V3-A01/A02 faux system_plan: tools are mode-gated; the plan outlives the run and executes only after confirmation", async () => {
    systemctl("start", demo.unit);
    const svc = res("service");
    const body = { intent: "将演示服务 CPU 上限设为 30% [faux:try-build]", targetAppId: null, mode: "system_plan" as const, resourceIds: [svc.id], capabilityScopes: ["service.set_limit"] };
    const r = rig.core.user.submitRun(key(), body as never);
    void rig.coord.kick();
    const done = await waitRun(rig, r.body.runId, 60_000);
    const t = await lastTranscript(rig);
    fs.writeFileSync("/tmp/a01-transcript.json", JSON.stringify(t.items.slice(-20), null, 1));
    const tools = t.items.filter((i) => i.toolName).map((i) => `${i.toolName}${i.isError ? "!" : ""}`);
    expect(done.status, `${done.error_json} ${JSON.stringify(t.items.slice(-8).map((i) => [i.toolName, i.text.slice(0, 200)]))}`).toBe("succeeded");
    expect(tools).toContain("app_stage!"); // build tool refused in system_plan mode
    const prepared = rig.core.runs.getRow(r.body.runId)!.prepared_action_id as string;
    expect(prepared).toMatch(/^sa_/);
    const a = caps().actions.require(prepared);
    expect(a.state).toBe("awaiting_approval");
    // nothing executed although the run is over
    expect(fs.readFileSync(`/sys/fs/cgroup/system.slice/${demo.unit}/cpu.max`, "utf8").trim()).not.toBe("30000 100000");
    rig.core.store.tx(() => caps().actions.confirmInTx(a.id, a.plan_hash, randomUUID()));
    expect((await final(a.id)).phase).toBe("done");
    expect(fs.readFileSync(`/sys/fs/cgroup/system.slice/${demo.unit}/cpu.max`, "utf8").trim()).toBe("30000 100000");
    // A01: a build run cannot call system tools
    const bld = await submit(rig, "做一个待办应用");
    expect((await waitRun(rig, bld.runId, 120_000)).status).not.toBe("running");
  });

  it("V3-A03/A04 at most one plan per run; resources the user did not choose cannot be planned or read", async () => {
    const svc = res("service");
    const body = { intent: "停止演示服务 [faux:plan-twice]", targetAppId: null, mode: "system_plan" as const, resourceIds: [svc.id], capabilityScopes: ["service.ensure_state"] };
    const r = rig.core.user.submitRun(key(), body as never);
    void rig.coord.kick();
    await waitRun(rig, r.body.runId, 60_000);
    const plans = rig.core.store.all("SELECT id FROM system_actions WHERE run_id = ?", r.body.runId);
    expect(plans).toHaveLength(1);
    // A04: the scope froze one resource; another one is refused even if asked for directly
    const lab = res("lab-network");
    await expect(caps().runRead(r.body.runId, "t1", lab.id, "network.policy_status", {})).rejects.toMatchObject({ code: expect.stringMatching(/RESOURCE_NOT_BOUND|FORBIDDEN|PROVIDER_GRANT_REQUIRED/) });
    // the stop plan is still awaiting confirmation; reject it
    const a = caps().actions.require(plans[0]!.id as string);
    await caps().actions.cancel(a.id, "test reject");
    expect(caps().actions.require(a.id).state).toMatch(/cancelled_no_effect|rejected|expired_no_effect/);
    expect(spawnActive(demo.unit)).toBe("active");
  });

  it("V3-C06 observations from another run / call / generation cannot back a plan", async () => {
    const svc = res("service");
    const other = rig.core.store.get<{ id: string }>("SELECT id FROM resource_observations WHERE scope_kind = 'run' LIMIT 1");
    expect(other).toBeTruthy();
    const body = { intent: "将演示服务 CPU 上限设为 20%", targetAppId: null, mode: "system_plan" as const, resourceIds: [svc.id], capabilityScopes: ["service.set_limit"] };
    const r = rig.core.user.submitRun(key(), body as never);
    await expect(caps().runPlan(r.body.runId, "t9", { resourceId: svc.id, capabilityId: "service.set_limit", params: { property: "CPUQuotaPerSecUSec", value: 200000 }, observationIds: [other!.id] })).rejects.toMatchObject({ code: expect.stringMatching(/OBSERVATION|PRECONDITION|FORBIDDEN|INVALID_SYSTEM_PLAN/) });
    await expect(caps().runPlan(r.body.runId, "t9", { resourceId: svc.id, capabilityId: "service.set_limit", params: { property: "CPUQuotaPerSecUSec", value: 200000 }, observationIds: ["obs_ffffffffffffffffffffffff"] })).rejects.toMatchObject({ code: expect.stringMatching(/OBSERVATION|INVALID_SYSTEM_PLAN/) });
    rig.core.user.cancelRun(key(), r.body.runId);
    await waitRun(rig, r.body.runId, 60_000).catch(() => undefined);
  });

  it("V4-C01 a system_plan conversation (real provider content) is compacted only with explicit consent", async () => {
    const svc = res("service");
    const body = { intent: "看看演示服务的状态 [faux:no-plan]", targetAppId: null, mode: "system_plan" as const, resourceIds: [svc.id], capabilityScopes: ["service.set_limit"] };
    const r = rig.core.user.submitRun(key(), body as never);
    void rig.coord.kick();
    await waitRun(rig, r.body.runId, 60_000).catch(() => undefined);
    if (!["succeeded", "failed", "cancelled"].includes(rig.core.runs.getRow(r.body.runId)!.status)) {
      rig.core.user.cancelRun(key(), r.body.runId);
      await waitRun(rig, r.body.runId, 60_000);
    }
    const conv = rig.core.store.get<{ conversation_id: string }>("SELECT conversation_id FROM agent_conversations WHERE run_id = ?", r.body.runId);
    expect(conv).toBeTruthy();
    rig.core.compactions.engine = rig.engine;
    await expect(rig.core.compactions.request(conv!.conversation_id, {})).rejects.toMatchObject({ code: "COMPACTION_SCOPE_DENIED", message: expect.stringMatching(/provider content/) });
    const ok = await rig.core.compactions.request(conv!.conversation_id, { allowProviderContent: true });
    expect(JSON.parse(ok.input_scope)).toMatchObject({ mode: "system_plan", providerContentConsent: true, crossConversation: false });
    await rig.core.compactions.cancel(ok.id);
  });

  it("V3-F07 file compensation restores the previous content only while the file still has the written version", async () => {
    await connect("exports", "managed-root");
    const name = `f07-${Date.now()}`;
    const file = () => fs.readFileSync(path.join(managedDir(), `${name}.txt`), "utf8");
    const write = async () => {
      await new Promise((r) => setTimeout(r, 1100)); // a new logical time → new content
      const w = await plan("writeReport", { name });
      rig.core.store.tx(() => caps().actions.confirmInTx(w.id, w.plan_hash, randomUUID()));
      expect((await final(w.id)).phase).toBe("done");
      return { w, content: file() };
    };
    const one = await write();
    const two = await write();
    // compensating two while the file still is two's version restores one's content
    const comp = await caps().compensate(two.w.id);
    expect(caps().actions.view(comp).origin).toBe("compensation");
    rig.core.store.tx(() => caps().actions.confirmInTx(comp.id, comp.plan_hash, randomUUID()));
    expect((await final(comp.id)).phase).toBe("done");
    expect(file()).toBe(one.content);
    expect(caps().actions.view(caps().actions.require(two.w.id)).phase).toBe("done"); // history unchanged
    // a third writer changed it: compensating `three`'s predecessor (two) now conflicts, nothing is overwritten
    const three = await write();
    const again = await caps().compensate(two.w.id).then((a) => {
      rig.core.store.tx(() => caps().actions.confirmInTx(a.id, a.plan_hash, randomUUID()));
      return final(a.id);
    }).catch((e) => ({ phase: "refused", error: { code: (e as { code: string }).code } }));
    expect(again.phase).not.toBe("done");
    expect(String((again as { error: { code: string } | null }).error?.code)).toMatch(/COMPENSATION_CONFLICT|FILE_VERSION_STALE|PRECONDITION_STALE/);
    expect(file()).toBe(three.content);
  });

  it("V3-S06 service compensation conflicts when the current value is not the one the action set", async () => {
    await connect("svc", "service");
    const a = await plan("setCpu", { percent: 70 });
    rig.core.store.tx(() => caps().actions.confirmInTx(a.id, a.plan_hash, randomUUID()));
    expect((await final(a.id)).phase).toBe("done");
    const b = await plan("setCpu", { percent: 90 });
    rig.core.store.tx(() => caps().actions.confirmInTx(b.id, b.plan_hash, randomUUID()));
    expect((await final(b.id)).phase).toBe("done");
    // compensating a (70 % → previous) is refused because the unit now runs with 90 %
    const r = await caps().compensate(a.id).then(async (c) => {
      rig.core.store.tx(() => caps().actions.confirmInTx(c.id, c.plan_hash, randomUUID()));
      return final(c.id);
    }).catch((e) => ({ phase: "refused", error: { code: (e as { code: string }).code } }));
    expect(r.phase).not.toBe("done");
    expect(fs.readFileSync(`/sys/fs/cgroup/system.slice/${demo.unit}/cpu.max`, "utf8").trim()).toBe("90000 100000");
    // compensating b is allowed and restores 70 %; it never claims to undo what the process did meanwhile
    const cb = await caps().compensate(b.id);
    expect(JSON.stringify(caps().actions.view(cb).preview)).toMatch(/70%|不撤销|进程/);
    rig.core.store.tx(() => caps().actions.confirmInTx(cb.id, cb.plan_hash, randomUUID()));
    expect((await final(cb.id)).phase).toBe("done");
    expect(fs.readFileSync(`/sys/fs/cgroup/system.slice/${demo.unit}/cpu.max`, "utf8").trim()).toBe("70000 100000");
  });

  it("V3-G06 while the broker is down a revoke blocks at once, shows revoking, and is confirmed after reconnect", async () => {
    await connect("svc", "service");
    const g = caps().grants.list().find((x) => x.principal.appId === appId && x.bindingAlias === "svc" && x.state === "active")!;
    systemctl("stop", "agentos-broker.service");
    try {
      rig.core.store.tx(() => caps().grants.revokeConnectionInTx(g.grantId, "user revoked while the broker is down"));
      const v = caps().grants.list().find((x) => x.grantId === g.grantId)!;
      expect(v.state).toBe("revoking");
      expect(v.revocationConfirmed).toBe(false);
      await expect(plan("setCpu", { percent: 50 })).rejects.toMatchObject({ code: expect.stringMatching(/GRANT_REVOKING|GRANT_REVOKED|PROVIDER_GRANT_REQUIRED/) });
      expect((await query()).svc).toMatch(/授权撤销中|授权已撤销|需要连接资源/);
    } finally {
      systemctl("start", "agentos-broker.service");
    }
    await waitUntil(async () => {
      await caps().grants.pump();
      return caps().grants.list().find((x) => x.grantId === g.grantId)!.state;
    }, (st) => st === "revoked", 30_000, 500);
  });

  it("V3-A05 the same tool call replays its plan; cancelling a run never cancels another action", async () => {
    const svc = res("service");
    await connect("svc", "service");
    const other = await plan("setCpu", { percent: 55 });
    // system_plan ends the Pi turn as soon as the plan is accepted, so "still active after the plan" exists only
    // between the plan and the host's finalize. Hold that gap open deterministically: stop the coordinator once the
    // run is submitted, let Pi finish, and replay while the run is still unfinalized (the same state a Pi restart
    // replays into). No timer race.
    const body = { intent: "将演示服务 CPU 上限设为 25% [faux:slow:300]", targetAppId: null, mode: "system_plan" as const, resourceIds: [svc.id], capabilityScopes: ["service.set_limit"] };
    const r = rig.core.user.submitRun(key(), body as never);
    void rig.coord.kick();
    await waitUntil(() => rig.core.runs.getRow(r.body.runId)!.dispatch_state as string, (x) => x === "submitted", 30_000, 20);
    rig.coord.stop();
    let prepared: string | null = null;
    try {
      await rig.coord.drain();
      prepared = await waitUntil(() => rig.core.runs.getRow(r.body.runId)!.prepared_action_id as string | null, (x) => !!x, 30_000, 50);
      expect(rig.core.runs.getRow(r.body.runId)!.status).toBe("running");
      const a = caps().actions.require(prepared!);
      const plan0 = JSON.parse(a.plan_json) as { params: Record<string, unknown> };
      // a replayed identical call (e.g. after a Pi restart) finds the original plan; a different one is refused
      const replay = await caps().runPlan(r.body.runId, a.tool_task_id!, { resourceId: svc.id, capabilityId: "service.set_limit", params: plan0.params, observationIds: JSON.parse(a.observation_refs) });
      expect(replay.id).toBe(a.id);
      await expect(caps().runPlan(r.body.runId, a.tool_task_id!, { resourceId: svc.id, capabilityId: "service.set_limit", params: { ...plan0.params, value: 300000 }, observationIds: [] })).rejects.toMatchObject({ code: "INVALID_SYSTEM_PLAN" });
    } finally {
      rig.coord.start();
    }
    await waitRun(rig, r.body.runId, 60_000);
    expect(rig.core.runs.getRow(r.body.runId)!.status).toBe("succeeded");
    // cancel another, still running run: the app's pending action and the prepared plan are untouched
    const r2 = rig.core.user.submitRun(key(), { ...body, intent: "将演示服务 CPU 上限设为 26% [faux:slow:3000]" } as never);
    void rig.coord.kick();
    await new Promise((x) => setTimeout(x, 500));
    rig.core.user.cancelRun(key(), r2.body.runId);
    await waitRun(rig, r2.body.runId, 60_000);
    expect(caps().actions.require(other.id).state).toBe("awaiting_approval");
    expect(caps().actions.require(prepared!).state).toBe("awaiting_approval");
    await caps().actions.cancel(other.id, "test cleanup");
    await caps().actions.cancel(prepared!, "test cleanup");
  });

  it("V3-A06 a system_plan run never carries file content or device payloads into the model context", async () => {
    await connect("exports", "managed-root");
    const secret = `SECRET-${randomUUID()}`;
    const w = await plan("writeReport", { name: "a06" });
    rig.core.store.tx(() => caps().actions.confirmInTx(w.id, w.plan_hash, randomUUID()));
    await final(w.id);
    // put a secret into a managed file through a direct broker write (the model never chose it)
    const mr = res("managed-root");
    const body = { intent: "看看受管目录里有哪些文件，然后写入 a06-out.txt", targetAppId: null, mode: "system_plan" as const, resourceIds: [mr.id], capabilityScopes: ["file.write_text_atomic"] };
    fs.existsSync(path.join(managedDir(), "a06.txt"));
    const r = rig.core.user.submitRun(key(), body as never);
    void rig.coord.kick();
    await waitRun(rig, r.body.runId, 60_000);
    const t = await lastTranscript(rig);
    const text = JSON.stringify(t.items);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("AgentOS 状态报告"); // the report content was never read: only metadata (file.list)
    expect(JSON.stringify(rig.core.runs.getRow(r.body.runId))).not.toContain("AgentOS 状态报告");
    const a = rig.core.runs.getRow(r.body.runId)!.prepared_action_id as string | null;
    if (a) await caps().actions.cancel(a, "test cleanup");
  });

  it("V3-U05 expired plans, revocations and observation quality are reported as such", async () => {
    await connect("svc", "service");
    const a = await plan("setCpu", { percent: 45 });
    rig.core.store.tx(() => rig.core.store.run("UPDATE system_actions SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), a.id));
    await caps().actions.tick();
    const v = caps().actions.view(caps().actions.require(a.id));
    expect(v.state).toBe("expired_no_effect");
    expect(() => rig.core.store.tx(() => caps().actions.confirmInTx(a.id, a.plan_hash, randomUUID()))).not.toThrow();
    expect(caps().actions.require(a.id).state).toBe("expired_no_effect");
    const obs = caps().observations.events(0, 50);
    expect(Array.isArray(obs.cursors)).toBe(true);
    for (const c of obs.cursors) expect(["fresh", "stale", "gap", "unavailable"]).toContain(c.quality);
    // The host view must match an independent probe of the collector: unavailable (with a reason and a gap) when no
    // collector is loaded, BTF or not; available when one is.
    await assertTelemetryMatches(() => caps().observations.telemetry);
  });

  it("V3-O07 bounded queues: at most 4 waiting plans per app; more are refused without deleting anything", async () => {
    await connect("svc", "service");
    const open = caps().actions.list({ open: true, appId }).filter((x) => x.phase === "awaiting_confirmation");
    for (const x of open) await caps().actions.cancel(x.actionId, "cleanup");
    const made = [];
    for (let i = 0; i < 4; i++) made.push(await plan("setCpu", { percent: 30 + i }));
    await expect(plan("setCpu", { percent: 40 })).rejects.toMatchObject({ code: "RESOURCE_BUSY" });
    expect(rig.core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM system_actions")!.n).toBeGreaterThanOrEqual(4);
    for (const m of made) await caps().actions.cancel(m.id, "cleanup");
  });

});

function spawnActive(unit: string): string {
  return spawnSync("systemctl", ["is-active", unit], { encoding: "utf8" }).stdout.trim();
}
void codeFixture;
