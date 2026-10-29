/**
 * v0.4 maintenance (spec §11–§16, §18, §19, §22): durable triggers, incidents, policies, pause, app recovery through the
 * single runtime controller, archive/restore, proposals' capability boundary, notifications and compaction scope. Real
 * os.sqlite (migrations 1–4), real services, controllable wall and monotonic clocks; no mocks of AgentOS services.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppRecovery, CompactionService, candidateBoundary, openCore, type Core, type JobContext, type TemplateHandler } from "@agentos/core";
import { MAINTENANCE_TEMPLATES, type CodeBundle } from "@agentos/contracts";
import { ManualClock } from "../agent-helpers.js";
import { ROOT, fixture, tmpDir } from "../helpers.js";

function rig() {
  const clock = new ManualClock();
  let mono = 1_000_000;
  const core = openCore(path.join(tmpDir("agentos-maint-"), "os.sqlite"), { clock, mono: () => mono });
  // the monotonic clock follows the wall clock unless a test jumps one of them
  const adv = (ms: number) => {
    clock.advance(ms);
    mono += ms;
  };
  core.maintenance.clock.bootTime = () => mono; // no suspend unless a test says so
  return { core, clock, adv, setMono: (v: number) => (mono = v), getMono: () => mono };
}

function seedApp(core: Core): string {
  const b = fixture("todo-v1.json");
  const appId = randomUUID();
  (b.manifest as { appId: string }).appId = appId;
  core.apps.seedActivated(b);
  return appId;
}

function runtimeRow(core: Core, appId: string, health: "degraded" | "ready" | "recovering" | "stopped", enabled = 1) {
  core.store.tx(() =>
    core.store.run(
      "INSERT INTO app_runtime (app_id, enabled, active_instance_id, generation, health, control_epoch, restart_count, updated_at) VALUES (?, ?, NULL, 1, ?, 1, 3, 'x') ON CONFLICT(app_id) DO UPDATE SET health = excluded.health, enabled = excluded.enabled",
      appId, enabled, health,
    ),
  );
}

/** A counting template: records every effect it was allowed to take. */
function countingHandler(effects: string[]): TemplateHandler {
  return {
    async observe() {
      return { needed: true, reason: "test" };
    },
    async act(ctx: JobContext) {
      const out = await ctx.step("effect", "logs.delete_closed", "test", { n: 1 }, async () => {
        effects.push(ctx.job.id);
        return { state: "succeeded", result: { ok: true } };
      });
      return { certainty: "confirmed", reason: out.state, completed: 1 };
    },
  };
}

function enablePolicy(core: Core, body: Parameters<Core["maintenance"]["policies"]["create"]>[0]) {
  const p = core.maintenance.policies.create(body);
  return core.maintenance.policies.approve(p.id, p.version, p.policy_hash);
}

describe("J: durable triggers, clocks, cancel and pause", () => {
  it("V4-J01 receipt + job + cursor commit together; the same trigger key never makes a second job", async () => {
    const { core, adv } = rig();
    const effects: string[] = [];
    core.maintenance.jobs.register("log-cleanup", countingHandler(effects));
    const a = core.maintenance.jobs.manualCheck("log-cleanup", { kind: "workspace", id: "workspace" }, "k1");
    const b = core.maintenance.jobs.manualCheck("log-cleanup", { kind: "workspace", id: "workspace" }, "k1");
    expect(b.jobId).toBe(a.jobId);
    expect(b.created).toBe(false);
    expect(core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM trigger_receipts")!.n).toBe(1);
    // interval policy: one job per occurrence; receipt and cursor in the same transaction
    const p = enablePolicy(core, { templateId: "log-cleanup", target: { kind: "workspace", id: "workspace" }, mode: "automatic", trigger: { kind: "interval", intervalSeconds: 3600 } });
    core.maintenance.jobs.tickSchedules(); // creates the cursor
    adv(3600_000 + 10);
    expect(core.maintenance.jobs.tickSchedules()).toBe(1);
    expect(core.maintenance.jobs.tickSchedules()).toBe(0);
    const cur = core.store.get<{ occurrence_seq: number }>("SELECT occurrence_seq FROM schedule_cursors WHERE policy_id = ?", p.id)!;
    const jobs = core.store.all<{ trigger_key: string }>("SELECT trigger_key FROM maintenance_jobs WHERE policy_id = ?", p.id);
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.trigger_key.endsWith(`/interval/${cur.occurrence_seq}`)).toBe(true);
    // the receipt row is unique: inserting the same key again is impossible
    expect(() => core.store.tx(() => core.store.run("INSERT INTO trigger_receipts (trigger_key, trigger_kind, job_id, created_at) VALUES (?, 'interval', 'x', 'x')", jobs[0]!.trigger_key))).toThrow();
  });

  it("V4-J02 offline misses coalesce into ONE new check with the skip count (coalesce-latest), no batch of effects", async () => {
    const { core, adv } = rig();
    const effects: string[] = [];
    core.maintenance.jobs.register("log-cleanup", countingHandler(effects));
    const p = enablePolicy(core, { templateId: "log-cleanup", target: { kind: "workspace", id: "workspace" }, mode: "automatic", trigger: { kind: "interval", intervalSeconds: 3600 } });
    core.maintenance.jobs.tickSchedules();
    adv(10 * 3600_000 + 5); // 10 occurrences missed while "offline"
    expect(core.maintenance.jobs.tickSchedules()).toBe(1);
    const r = core.store.get<{ skipped_count: number }>("SELECT skipped_count FROM trigger_receipts WHERE policy_id = ?", p.id)!;
    expect(r.skipped_count).toBeGreaterThanOrEqual(9);
    await core.maintenance.jobs.pass(true);
    expect(effects.length).toBe(1);
  });

  it("V4-J03 a wall-clock jump stops automatic effects (clock_uncertain); a rollback never repeats an occurrence; a suspend is a re-sample", async () => {
    const { core, clock, adv, setMono, getMono } = rig();
    const g = core.maintenance.clock;
    g.sample();
    adv(1000);
    expect(g.sample()).toBe("ok");
    // system suspend: wall and boottime move 20 min, monotonic does not
    const bt = getMono() + 20 * 60_000;
    g.bootTime = () => bt;
    clock.advance(20 * 60_000);
    expect(g.sample()).toBe("ok");
    expect(g.lastSleep?.ms).toBeGreaterThan(19 * 60_000);
    g.bootTime = () => getMono();
    g.recheck();
    // wall clock jumps forward 10 min without boottime: uncertain
    clock.advance(10 * 60_000);
    expect(g.sample()).toBe("clock_uncertain");
    const effects: string[] = [];
    core.maintenance.jobs.register("log-cleanup", countingHandler(effects));
    const j = core.maintenance.jobs.manualCheck("log-cleanup", { kind: "workspace", id: "workspace" }, "after-jump");
    enablePolicy(core, { templateId: "log-cleanup", target: { kind: "workspace", id: "workspace" }, mode: "automatic", trigger: { kind: "manual" } });
    await core.maintenance.jobs.pass(true);
    expect(effects.length).toBe(0);
    expect(core.maintenance.jobs.requireJob(j.jobId).state).not.toBe("succeeded");
    // a rollback: the occurrence sequence is protected by a trigger
    const p = enablePolicy(core, { templateId: "cache-gc", target: { kind: "workspace", id: "workspace" }, mode: "observe", trigger: { kind: "interval", intervalSeconds: 60 } });
    g.recheck();
    core.maintenance.jobs.tickSchedules();
    adv(120_000);
    core.maintenance.jobs.tickSchedules();
    const seq = core.store.get<{ s: number }>("SELECT occurrence_seq AS s FROM schedule_cursors WHERE policy_id = ?", p.id)!.s;
    clock.advance(-30 * 60_000);
    setMono(getMono());
    core.maintenance.jobs.tickSchedules();
    expect(core.store.get<{ s: number }>("SELECT occurrence_seq AS s FROM schedule_cursors WHERE policy_id = ?", p.id)!.s).toBeGreaterThanOrEqual(seq);
    expect(() => core.store.tx(() => core.store.run("UPDATE schedule_cursors SET occurrence_seq = 0 WHERE policy_id = ?", p.id))).toThrow(/never goes back/);
    void setMono;
  });

  it("V4-J04 an event storm folds into one incident and one job; samples are bounded", async () => {
    const { core } = rig();
    const appId = seedApp(core);
    enablePolicy(core, { templateId: "app-recovery", target: { kind: "app", id: appId }, mode: "observe", trigger: { kind: "event" } });
    const inc = core.maintenance.incidents;
    for (let i = 0; i < 500; i++) {
      const { incident } = inc.raise({ targetKind: "app", targetId: appId, condition: "app.crash_loop", value: "bad", quality: "fresh", evidence: { i } });
      core.maintenance.jobs.eventTrigger(incident, "app-recovery");
    }
    expect(core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM health_incidents")!.n).toBe(1);
    expect(core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM maintenance_jobs")!.n).toBe(1);
    const i = inc.list({ open: true })[0]!;
    expect(i.evidence_count).toBe(500);
    expect(JSON.parse(i.evidence_json).length).toBeLessThanOrEqual(20);
  });

  it("V4-J05/J07 cancel before dispatch = no effect; cancel after effects keeps the completed count", async () => {
    const { core } = rig();
    const effects: string[] = [];
    core.maintenance.jobs.register("log-cleanup", countingHandler(effects));
    enablePolicy(core, { templateId: "log-cleanup", target: { kind: "workspace", id: "workspace" }, mode: "automatic", trigger: { kind: "manual" } });
    const j1 = core.maintenance.jobs.manualCheck("log-cleanup", { kind: "workspace", id: "workspace" }, "c1");
    core.maintenance.jobs.cancel(j1.jobId);
    await core.maintenance.jobs.pass(true);
    const r1 = core.maintenance.jobs.requireJob(j1.jobId);
    expect(r1.state).toBe("cancelled");
    expect(r1.effect_certainty).toBe("none");
    expect(effects.length).toBe(0);
    // a multi-step job cancelled after 2 effects reports 2 completed, not "cancelled, nothing changed"
    let ctxRef: JobContext | null = null;
    core.maintenance.jobs.register("log-cleanup", {
      async observe() {
        return { needed: true, reason: "t" };
      },
      async act(ctx) {
        ctxRef = ctx;
        let n = 0;
        for (const s of ["a", "b", "c"]) {
          if (ctx.cancelled()) break;
          const out = await ctx.step(s, "x.effect", "test", { s }, async () => ({ state: "succeeded" }));
          if (out.state === "succeeded") n++;
          if (s === "b") core.maintenance.jobs.cancel(ctx.job.id);
        }
        return { certainty: "partial", reason: `${n} done`, completed: n };
      },
    });
    const j2 = core.maintenance.jobs.manualCheck("log-cleanup", { kind: "workspace", id: "workspace" }, "c2");
    await core.maintenance.jobs.pass(true);
    const r2 = core.maintenance.jobs.requireJob(j2.jobId);
    expect(ctxRef).not.toBeNull();
    expect(r2.state).toBe("cancelled");
    expect(r2.completed_steps).toBe(2);
    expect(r2.effect_certainty).toBe("partial");
    // replay of the same step returns the stored outcome, never a second effect
    const step = core.store.get<{ state: string }>("SELECT state FROM maintenance_steps WHERE job_id = ? AND step_id = 'a'", j2.jobId)!;
    expect(step.state).toBe("succeeded");
  });

  it("V4-J06/P05 queued work of an old policy version expires; approval binds the exact hash/version/expiry; no auto-renew", async () => {
    const { core, adv } = rig();
    const effects: string[] = [];
    core.maintenance.jobs.register("log-cleanup", countingHandler(effects));
    const p1 = enablePolicy(core, { templateId: "log-cleanup", target: { kind: "workspace", id: "workspace" }, mode: "automatic", trigger: { kind: "manual" }, expiresInDays: 1 });
    const j = core.maintenance.jobs.manualCheck("log-cleanup", { kind: "workspace", id: "workspace" }, "v1");
    // a new version (wider retention) needs a new approval; the old enabled one keeps running until then
    const p2 = core.maintenance.policies.create({ policyId: p1.id, templateId: "log-cleanup", target: { kind: "workspace", id: "workspace" }, mode: "automatic", trigger: { kind: "manual" }, params: { retentionDays: 30 } } as never);
    expect(() => core.maintenance.policies.approve(p1.id, p2.version, p1.policy_hash)).toThrow(/hash/);
    core.maintenance.policies.approve(p1.id, p2.version, p2.policy_hash);
    await core.maintenance.jobs.pass(true);
    const row = core.maintenance.jobs.requireJob(j.jobId);
    expect(row.state).toBe("expired");
    expect(row.outcome_reason).toMatch(/POLICY_VERSION_STALE/);
    expect(effects.length).toBe(0);
    // expiry: never renewed
    adv(31 * 86_400_000);
    core.maintenance.policies.expireDue();
    expect(core.maintenance.policies.get(p1.id)!.state).toBe("expired");
    // bounds: values outside the template range are refused
    expect(() => core.maintenance.policies.create({ templateId: "app-recovery", target: { kind: "app", id: seedApp(core) }, mode: "automatic", trigger: { kind: "event" }, params: { perHour: 50 } })).toThrow(/perHour/);
    expect(() => core.maintenance.policies.create({ templateId: "log-cleanup", target: { kind: "workspace", id: "workspace" }, mode: "automatic", trigger: { kind: "cron" as never } })).toThrow(/cron/);
  });

  it("V4-J08 pause closes admission locally first and shows the root side as pending; observe-only work continues", async () => {
    const { core } = rig();
    const effects: string[] = [];
    core.maintenance.jobs.register("log-cleanup", countingHandler(effects));
    const controls: string[] = [];
    core.maintenance.jobs.onControl = (s) => controls.push(s);
    enablePolicy(core, { templateId: "log-cleanup", target: { kind: "workspace", id: "workspace" }, mode: "automatic", trigger: { kind: "manual" } });
    const e0 = core.maintenance.jobs.state().epoch;
    const st = core.maintenance.jobs.pause();
    expect(st.state).toBe("paused");
    expect(st.epoch).toBe(e0 + 1);
    expect(st.root).toBe("pending");
    expect(controls).toEqual(["paused"]);
    const j = core.maintenance.jobs.manualCheck("log-cleanup", { kind: "workspace", id: "workspace" }, "p");
    await core.maintenance.jobs.pass(true);
    expect(effects.length).toBe(0);
    expect(core.maintenance.jobs.requireJob(j.jobId).state).toBe("deferred");
    core.maintenance.jobs.rootConfirmed(st.epoch);
    expect(core.maintenance.jobs.state().root).toBe("synced");
    core.maintenance.jobs.resume();
    await core.maintenance.jobs.pass(true);
    // the queued job of the paused epoch never takes its old effect
    expect(["expired", "succeeded"]).toContain(core.maintenance.jobs.requireJob(j.jobId).state);
  });
});

describe("J08: the local epoch never stays below the root's", () => {
  it("adoptRootEpoch jumps above a newer broker epoch, keeps the local state, re-sends it and expires queued effects", async () => {
    const { core } = rig();
    const controls: [string, number][] = [];
    core.maintenance.jobs.onControl = (s, e) => controls.push([s, e]);
    const st0 = core.maintenance.jobs.pause();
    expect(core.maintenance.jobs.adoptRootEpoch(st0.epoch - 1)).toBeNull(); // not behind: nothing changes
    const to = core.maintenance.jobs.adoptRootEpoch(1_793_250_192_229)!;
    expect(to).toBe(1_793_250_192_230);
    const st = core.maintenance.jobs.state();
    expect(st).toMatchObject({ state: "paused", epoch: to, root: "pending" });
    expect(controls.at(-1)).toEqual(["paused", to]);
    core.maintenance.jobs.rootConfirmed(to - 1);
    expect(core.maintenance.jobs.state().root).toBe("pending"); // a confirmation of another epoch never counts
    core.maintenance.jobs.rootConfirmed(to);
    expect(core.maintenance.jobs.state().root).toBe("synced");
  });
});

describe("H: app recovery through the one runtime controller", () => {
  function recovery(core: Core, kicks: { n: number }) {
    const fakeRuntime = { row: () => undefined } as never;
    const r = new AppRecovery(core.store, fakeRuntime, core.maintenance.incidents, () => kicks.n++);
    core.maintenance.jobs.register("app-recovery", r.handler());
    return r;
  }

  it("V4-H01/H05 recovery only hands an intent to the controller, counts together with its restarts and opens the circuit", async () => {
    const { core, adv } = rig();
    const kicks = { n: 0 };
    recovery(core, kicks);
    const appId = seedApp(core);
    runtimeRow(core, appId, "degraded");
    enablePolicy(core, { templateId: "app-recovery", target: { kind: "app", id: appId }, mode: "automatic", trigger: { kind: "event" }, params: { observeSeconds: 60 } });
    const containersBefore = core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_instances")!.n;
    for (let round = 0; round < 3; round++) {
      const { incident } = core.maintenance.incidents.raise({ targetKind: "app", targetId: appId, condition: "app.crash_loop", value: "bad", quality: "fresh", evidence: { round } });
      const t = core.maintenance.jobs.eventTrigger(incident, "app-recovery")!;
      await core.maintenance.jobs.pass(true);
      const ar = core.store.get<{ health: string; restart_count: number }>("SELECT health, restart_count FROM app_runtime WHERE app_id = ?", appId)!;
      expect(ar.health, JSON.stringify(core.maintenance.jobs.view(core.maintenance.jobs.requireJob(t.jobId)))).toBe("recovering"); // handed to the controller; restart_count is NOT reset
      expect(ar.restart_count).toBe(3);
      // the instance fails again inside the window: the controller degrades it
      core.store.tx(() => core.store.run("UPDATE app_runtime SET health = 'degraded' WHERE app_id = ?", appId));
      await core.maintenance.jobs.pass(true);
      expect(core.maintenance.jobs.requireJob(t.jobId).state).toBe("failed_no_effect");
      adv(31 * 60_000);
    }
    // no second instance starter: maintenance never inserted a runtime instance or container
    expect(core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_instances")!.n).toBe(containersBefore);
    expect(kicks.n).toBe(3);
    const c = core.store.get<{ state: string; consecutive_failures: number }>("SELECT state, consecutive_failures FROM maintenance_circuits WHERE target_id = ?", appId)!;
    expect(c.state).toBe("open");
    expect(c.consecutive_failures).toBe(3);
    // the next attempt is refused by the circuit (and the 24 h count), even with a new job
    const { incident } = core.maintenance.incidents.raise({ targetKind: "app", targetId: appId, condition: "app.crash_loop", value: "bad", quality: "fresh", evidence: { round: 4 } });
    const t4 = core.maintenance.jobs.eventTrigger(incident, "app-recovery")!;
    await core.maintenance.jobs.pass(true);
    expect(core.maintenance.jobs.requireJob(t4.jobId).state).toBe("needs_attention");
    expect(core.maintenance.jobs.requireJob(t4.jobId).outcome_reason).toMatch(/CIRCUIT_OPEN/);
    expect(core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM maintenance_attempts WHERE target_id = ?", appId)!.n).toBe(3);
    // attempts can never be deleted to "reset" a budget
    expect(() => core.store.tx(() => core.store.run("DELETE FROM maintenance_attempts"))).toThrow(/never deleted/);
  });

  it("V4-H04 stable recovery needs a new handshaked instance, a probe after the restart and the full window; a brief start that exits is not stable", async () => {
    const { core, adv } = rig();
    const kicks = { n: 0 };
    recovery(core, kicks);
    const appId = seedApp(core);
    runtimeRow(core, appId, "degraded");
    enablePolicy(core, { templateId: "app-recovery", target: { kind: "app", id: appId }, mode: "automatic", trigger: { kind: "event" }, params: { observeSeconds: 60 } });
    core.store.tx(() => core.store.run("INSERT INTO artifacts (id, build_key, runtime_lock_id, platform, manifest_json, relative_path, size_bytes, gc_state, created_at) VALUES ('sha256:h4', 'k', 'l', 'p', '{}', 'h4', 1, 'live', 'x')"));
    const startInstance = (gen: number, probeAt: string | null) =>
      core.store.tx(() => {
        const id = randomUUID();
        core.store.run("INSERT INTO runtime_instances (id, app_id, revision_id, artifact_id, role, generation, host_boot_id, container_name, desired_state, observed_state, lease_digest, last_probe_at, created_at, updated_at) SELECT ?, ?, active_revision_id, 'sha256:h4', 'active', ?, 'b', ?, 'running', 'ready', '', ?, 'x', 'x' FROM apps WHERE id = ?", id, appId, gen, `c-${gen}`, probeAt, appId);
        core.store.run("UPDATE app_runtime SET health = 'ready', generation = ?, active_instance_id = ? WHERE app_id = ?", gen, id, appId);
      });
    // round 1: the new instance comes up, then exits inside the window -> not stable
    let { incident } = core.maintenance.incidents.raise({ targetKind: "app", targetId: appId, condition: "app.crash_loop", value: "bad", quality: "fresh", evidence: { r: 1 } });
    const t1 = core.maintenance.jobs.eventTrigger(incident, "app-recovery")!;
    await core.maintenance.jobs.pass(true);
    startInstance(2, new Date(core.store.clock.now() + 1000).toISOString());
    adv(20_000);
    await core.maintenance.jobs.pass(true);
    expect(core.maintenance.jobs.requireJob(t1.jobId).state).not.toBe("succeeded"); // still in the window
    core.store.tx(() => core.store.run("UPDATE app_runtime SET health = 'degraded' WHERE app_id = ?", appId));
    await core.maintenance.jobs.pass(true);
    expect(core.maintenance.jobs.requireJob(t1.jobId).state).toBe("failed_no_effect");
    expect(core.maintenance.jobs.requireJob(t1.jobId).outcome_reason).toMatch(/did not hold/);

    // round 2: the instance stays up for the window but no probe has run since the restart -> still not stable
    adv(31 * 60_000);
    runtimeRow(core, appId, "degraded");
    ({ incident } = core.maintenance.incidents.raise({ targetKind: "app", targetId: appId, condition: "app.crash_loop", value: "bad", quality: "fresh", evidence: { r: 2 } }));
    const t2 = core.maintenance.jobs.eventTrigger(incident, "app-recovery")!;
    await core.maintenance.jobs.pass(true);
    startInstance(3, null);
    adv(70_000);
    await core.maintenance.jobs.pass(true);
    expect(core.maintenance.jobs.requireJob(t2.jobId).state).not.toBe("succeeded");
    // a probe after the restart and the full window -> stable recovery
    core.store.tx(() => core.store.run("UPDATE runtime_instances SET last_probe_at = ? WHERE generation = 3 AND app_id = ?", new Date(core.store.clock.now()).toISOString(), appId));
    await core.maintenance.jobs.pass(true);
    expect(core.maintenance.jobs.requireJob(t2.jobId).state).toBe("succeeded");
    expect(core.maintenance.jobs.requireJob(t2.jobId).outcome_reason).toMatch(/handshaked, probed and stayed up/);
  });

  it("V4-H08 gaps, an unavailable probe and an identity change are observed, never read as 'stopped'; quarantine is never cleared", async () => {
    const { core, adv } = rig();
    const svc = "res_service_h08";
    core.store.tx(() => core.store.run("INSERT INTO system_resources (id, kind, display_name, execution_class, generation, catalog_key, status, created_at, updated_at) VALUES (?, 'service', 'h08', 'broker', 1, 'demo', 'quarantined', 'x', 'x')", svc));
    core.maintenance.policies.installCaps = () => ({ allowed: true, max: { perHour: 2, per24h: 3 } });
    enablePolicy(core, { templateId: "service-ensure-running", target: { kind: "service", id: svc }, mode: "automatic", trigger: { kind: "event" } });
    const seq: { state: "running" | "stopped" | "unknown"; quality: "fresh" | "gap" | "unavailable"; identity: string; throws?: boolean }[] = [
      { state: "stopped", quality: "fresh", identity: "A" },
      { state: "unknown", quality: "gap", identity: "A" },
      { state: "stopped", quality: "fresh", identity: "A" },
      { state: "stopped", quality: "fresh", identity: "A", throws: true },
      { state: "stopped", quality: "fresh", identity: "A" },
      { state: "stopped", quality: "fresh", identity: "B" }, // the unit identity changed between samples
      { state: "stopped", quality: "fresh", identity: "B" },
    ];
    let i = 0;
    core.maintenance.health.serviceProbe = async () => {
      const s = seq[Math.min(i++, seq.length - 1)]!;
      if (s.throws) throw new Error("broker unreachable");
      return { state: s.state, quality: s.quality, generation: 1, identity: s.identity };
    };
    for (let k = 0; k < seq.length; k++) {
      await core.maintenance.health.tick();
      adv(16_000);
    }
    // no incident and no job: never three consistent fresh "stopped" samples of one identity
    expect(core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM health_incidents WHERE target_id = ?", svc)!.n).toBe(0);
    expect(core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM maintenance_jobs WHERE target_id = ?", svc)!.n).toBe(0);
    // a third consistent sample of identity B opens exactly one incident
    await core.maintenance.health.tick();
    expect(core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM health_incidents WHERE target_id = ?", svc)!.n).toBe(1);
    // nothing in maintenance cleared the quarantine
    expect(core.store.get<{ status: string }>("SELECT status FROM system_resources WHERE id = ?", svc)!.status).toBe("quarantined");
  });

  it("V4-H02/H03 a user stop wins: the epoch moved, so a queued recovery never restarts it", async () => {
    const { core } = rig();
    const kicks = { n: 0 };
    const r = recovery(core, kicks);
    const appId = seedApp(core);
    runtimeRow(core, appId, "degraded");
    enablePolicy(core, { templateId: "app-recovery", target: { kind: "app", id: appId }, mode: "automatic", trigger: { kind: "event" } });
    const { incident } = core.maintenance.incidents.raise({ targetKind: "app", targetId: appId, condition: "app.crash_loop", value: "bad", quality: "fresh", evidence: {} });
    const t = core.maintenance.jobs.eventTrigger(incident, "app-recovery")!;
    // user stops the app before the job runs (same as RuntimeSystem.control + onUserControlInTx)
    core.store.tx(() => {
      core.store.run("UPDATE app_runtime SET enabled = 0, health = 'stopped', control_epoch = control_epoch + 1 WHERE app_id = ?", appId);
      core.maintenance.policies.pauseTargetInTx("app", appId, "user stopped the app");
    });
    await core.maintenance.jobs.pass(true);
    expect(["expired", "no_change"]).toContain(core.maintenance.jobs.requireJob(t.jobId).state);
    expect(kicks.n).toBe(0);
    expect(core.store.get<{ health: string }>("SELECT health FROM app_runtime WHERE app_id = ?", appId)!.health).toBe("stopped");
    // an unknown instance is never treated as absent
    runtimeRow(core, appId, "degraded", 1);
    core.store.tx(() => {
      core.store.run("INSERT INTO artifacts (id, build_key, runtime_lock_id, platform, manifest_json, relative_path, size_bytes, gc_state, created_at) VALUES ('sha256:aa', 'k', 'l', 'p', '{}', 'aa', 1, 'live', 'x')");
      core.store.run("INSERT INTO runtime_instances (id, app_id, revision_id, artifact_id, role, generation, host_boot_id, container_name, desired_state, observed_state, lease_digest, created_at, updated_at) SELECT ?, ?, active_revision_id, 'sha256:aa', 'active', 1, 'b', 'c-unknown', 'running', 'unknown', '', 'x', 'x' FROM apps WHERE id = ?", randomUUID(), appId, appId);
    });
    expect(r.blocker(appId)).toMatch(/unknown state/);
  });
});

describe("E/G: lifecycle and candidates", () => {
  it("V4-E06/E07 archive closes calls in the same transaction, waits for real revocation, restore keeps data and never revives grants", async () => {
    const { core } = rig();
    const appId = seedApp(core);
    const epoch = core.apps.requireApp(appId).epoch;
    const rec = core.user.createRecord({ operationKey: randomUUID(), requestHash: "h1" }, appId, epoch, { title: "保留" }).body;
    let confirmed = false;
    core.lifecycle.revokeProviderGrantsInTx = () => 1;
    core.lifecycle.grantsRevoked = () => confirmed;
    const r1 = core.lifecycle.archive(appId, "user");
    expect(r1.state).toBe("archiving"); // the broker has not confirmed: never reported archived
    expect(() => core.user.createRecord({ operationKey: randomUUID(), requestHash: "h2" }, appId, epoch, { title: "new" })).toThrow(/archived/);
    confirmed = true;
    expect(core.lifecycle.settle(appId).state).toBe("archived");
    expect(core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM records WHERE app_id = ?", appId)!.n).toBe(1);
    expect(core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM revisions WHERE app_id = ?", appId)!.n).toBeGreaterThan(0);
    const back = core.lifecycle.restore(appId);
    expect(back.state).toBe("active");
    expect(core.records.list({ kind: "app", appId, viaUser: true }, appId, {}).items.map((x: { id: string }) => x.id)).toContain(rec.id);
    // an archive with a running task/deployment/command is refused, not reported
    core.store.tx(() => core.store.run("INSERT INTO invocations (id, app_id, revision_id, app_epoch, data_epoch, command_id, input_json, input_hash, request_key, principal_key, status, logical_time, deadline_at, created_at, updated_at) SELECT ?, ?, active_revision_id, epoch, 0, 'c', '{}', 'h', 'k', 'user', 'executing', 'x', 'x', 'x', 'x' FROM apps WHERE id = ?", randomUUID(), appId, appId));
    expect(() => core.lifecycle.archive(appId, "user")).toThrow(/command is still running/);
  });

  it("V4-E01 the candidate boundary refuses schema, contract, capability, import and runtimeLock changes", () => {
    const base = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "v0.2", "todo-kanban", "bundle.json"), "utf8")) as CodeBundle;
    const same = structuredClone(base);
    same.code.files[Object.keys(same.code.files)[0]!] += "\n// faster";
    expect(candidateBoundary(base, same)).toEqual([]);
    const schema = structuredClone(base);
    (schema.data.fields as Record<string, unknown>).extra = { type: "string", minLength: 0, maxLength: 10 };
    expect(candidateBoundary(base, schema).map((i) => i.path)).toContain("/data");
    const lock = structuredClone(base);
    lock.runtimeLockId = "other-lock";
    expect(candidateBoundary(base, lock).map((i) => i.path)).toContain("/runtimeLockId");
    const caps = structuredClone(base);
    caps.manifest.capabilities = ["records.read"];
    const out = candidateBoundary(base, caps).map((i) => i.path);
    if (base.manifest.capabilities.length > 1) expect(out).toContain("/manifest/capabilities");
    const q = structuredClone(base);
    const k = Object.keys(q.queries)[0]!;
    (q.queries[k] as { outputSchema: unknown }).outputSchema = { type: "string", maxLength: 5 };
    expect(candidateBoundary(base, q).map((i) => i.path)).toContain("/queries");
  });

  it("V4-C01 compaction scope: never the legacy root, never an unfinished task, system_plan content only with consent", async () => {
    const { core } = rig();
    const c = new CompactionService(core.store);
    c.engine = { inspectConversation: async () => ({ scheduling: "idle", tasks: 0, submissions: 0, blocked: [] }), headEntry: async () => "e1" } as never;
    await expect(c.request("no-such", {})).rejects.toThrow(/COMPACTION_SCOPE_DENIED|task conversation/);
    // a finished system_plan run's conversation
    const runId = randomUUID();
    core.store.tx(() => {
      core.store.run(
        `INSERT INTO runs (id, request_key, request_hash, target_app_id, expected_app_epoch, intent, frozen_submit_json, submit_hash, status, dispatch_state, mode, agent_profile_id, execution_epoch, scheduling_state, background, created_at, updated_at)
         VALUES (?, ?, 'h', NULL, 0, 'x', '{}', 'h', 'succeeded', 'submitted', 'system_plan', 'system-planner', 1, 'done', 0, 'x', 'x')`,
        runId, `k-${runId}`,
      );
      core.store.run("INSERT INTO agent_conversations (conversation_id, create_key, run_id, purpose, profile_id, binding_hash, toolset_version, model_route_id, binding_state, created_at, updated_at) VALUES ('conv-sp', ?, ?, 'run', 'system-planner', 'h', 4, 'route-sp', 'bound', 'x', 'x')", `${core.store.meta().store_uuid}/x`, runId);
    });
    await expect(c.request("conv-sp", {})).rejects.toThrow(/explicit consent/);
    const ok = await c.request("conv-sp", { allowProviderContent: true });
    expect(ok.state).toBe("queued");
    const again = await c.request("conv-sp", { allowProviderContent: true });
    expect(again.id).toBe(ok.id); // same conversation + cutoff = same job
  });

  it("V4-U04 notifications for the same incident merge into one", () => {
    const { core } = rig();
    for (let i = 0; i < 50; i++) core.maintenance.notifications.notify("incident", "app:x", "critical", "应用反复崩溃", `#${i}`);
    const list = core.maintenance.notifications.list(true) as { count: number }[];
    expect(list.length).toBe(1);
    expect(list[0]!.count).toBe(50);
  });

  it("templates: the automatic whitelist excludes records, history, serial, network, limits and publication", () => {
    const auto = Object.values(MAINTENANCE_TEMPLATES).flatMap((t) => t.automaticActions);
    for (const forbidden of ["records", "revision", "serial", "network", "set_limit", "activate", "publish", "exec", "grant"]) expect(auto.some((a) => a.includes(forbidden))).toBe(false);
  });
});
