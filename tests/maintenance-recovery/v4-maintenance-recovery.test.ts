import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { tmpDir } from "../helpers.js";

/**
 * Process-level maintenance recovery (spec §26 R, V4-R01..R04, V4-J07, V4-H01): a real child process runs one phase of a
 * maintenance job on a real os.sqlite with the BUILT core and is SIGKILLed at a fixed fault point
 * (AGENTOS_FAULT_POINT); a fresh process then resumes from the database alone. Effects are appended to a log keyed by
 * the step's effect key, so a repeated effect is visible. Needs `pnpm build` (packages/core/dist).
 */
const CHILD = path.join(import.meta.dirname, "child.mjs");
interface Out {
  effects: number;
  made?: number;
  jobId?: string;
  appId?: string;
  jobs: { id: string; state: string; effect_certainty: string; trigger_key: string }[];
  steps: { job_id: string; step_id: string; state: string }[];
  attempts: number;
}
function child(scenario: string, phase: "setup" | "run", dir: string, fault?: string, offsetMs = 0): { killed: boolean; out: Out | null; log: string } {
  const r = spawnSync(process.execPath, [CHILD, scenario, phase, dir], {
    env: { ...process.env, NODE_ENV: "test", AGENTOS_FAULTS: fault ? "1" : "0", AGENTOS_FAULT_POINT: fault ?? "", CLOCK_OFFSET_MS: String(offsetMs) },
    encoding: "utf8",
    timeout: 60_000,
  });
  const line = r.stdout.split("\n").find((l) => l.startsWith("RESULT "));
  const log = `${r.stdout}\n${r.stderr}`;
  if (!fault && r.status !== 0) throw new Error(`child ${scenario}/${phase} failed:\n${log}`);
  return { killed: r.signal === "SIGKILL", out: line ? (JSON.parse(line.slice(7)) as Out) : null, log };
}

describe("maintenance recovery with real SIGKILL at fault points", () => {
  it("V4-R01/J01 killed inside the trigger transaction: no half job; the restart creates exactly one job for that occurrence", () => {
    const dir = tmpDir("agentos-mr-");
    child("trigger", "setup", dir);
    const k = child("trigger", "run", dir, "maintenance.trigger.before_commit", 130_000);
    expect(k.killed, k.log).toBe(true);
    expect(k.log).toContain("[fault] maintenance.trigger.before_commit");
    const a = child("trigger", "run", dir, undefined, 130_000).out!;
    expect(a.made).toBe(1);
    expect(a.jobs.length).toBe(1);
    expect(a.effects).toBe(1);
    // a third process sees the same occurrence as already handled: no second job, no second effect
    const b = child("trigger", "run", dir, undefined, 130_000).out!;
    expect(b.made).toBe(0);
    expect(b.jobs.length).toBe(1);
    expect(b.effects).toBe(1);
  });

  it("V4-R02/J07 killed after the step was admitted but before dispatch: never executed blindly after restart", () => {
    const dir = tmpDir("agentos-mr-");
    child("before_dispatch", "setup", dir);
    const k = child("before_dispatch", "run", dir, "maintenance.step.before_dispatch");
    expect(k.killed, k.log).toBe(true);
    const r = child("before_dispatch", "run", dir).out!;
    expect(r.effects).toBe(0);
    expect(r.steps[0]!.state).toBe("unknown");
    expect(r.jobs[0]!.state).toBe("indeterminate");
    expect(r.jobs[0]!.effect_certainty).toBe("unknown");
    // and a further restart does not retry it either
    expect(child("before_dispatch", "run", dir).out!.effects).toBe(0);
  });

  it("V4-R03 killed after the effect but before its step log: reconciled from the effect's own evidence, exactly one effect", () => {
    const dir = tmpDir("agentos-mr-");
    child("after_effect", "setup", dir);
    const k = child("after_effect", "run", dir, "maintenance.step.after_effect");
    expect(k.killed, k.log).toBe(true);
    const r = child("after_effect", "run", dir).out!;
    expect(r.effects).toBe(1);
    expect(r.steps[0]!.state).toBe("succeeded");
    expect(r.jobs[0]!.state).toBe("succeeded");
  });

  it("V4-R04/H01 app recovery killed after the intent committed: the restart finds the intent; one attempt, no second reservation", () => {
    const dir = tmpDir("agentos-mr-");
    child("app", "setup", dir);
    const k = child("app", "run", dir, "maintenance.app.after_intent");
    expect(k.killed, k.log).toBe(true);
    const r = child("app", "run", dir).out!;
    expect(r.attempts).toBe(1);
    expect(r.steps.find((s) => s.step_id === "converge")!.state).toBe("succeeded");
    // the job is now verifying the controller's work (handshake/probe/window) or settled from it; never a second intent
    expect(["verifying", "succeeded", "failed_no_effect"]).toContain(r.jobs[0]!.state);
    const again = child("app", "run", dir).out!;
    expect(again.attempts).toBe(1);
  });
});
