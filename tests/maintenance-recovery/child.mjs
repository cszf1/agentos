// Child process for tests/maintenance-recovery: runs one maintenance scenario phase on a real os.sqlite with the BUILT
// core (packages/core/dist), so AGENTOS_FAULT_POINT can SIGKILL it at a fixed point (spec §26 R/F, V4-R01..R04).
// usage: node child.mjs <scenario> <phase> <dataDir>
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppRecovery, openCore } from "../../packages/core/dist/index.js";

const [scenario, phase, dir] = process.argv.slice(2);
const effects = path.join(dir, "effects.log");
const offset = Number(process.env.CLOCK_OFFSET_MS ?? 0);
const core = openCore(path.join(dir, "os.sqlite"), { clock: { now: () => Date.now() + offset } });
const effectCount = () => (fs.existsSync(effects) ? fs.readFileSync(effects, "utf8").split("\n").filter(Boolean).length : 0);
const target = { kind: "workspace", id: "workspace" };

function enable(body) {
  const p = core.maintenance.policies.create(body);
  return core.maintenance.policies.approve(p.id, p.version, p.policy_hash);
}

/** A cleanup-like template whose one effect is an append to effects.log keyed by the step's effect key. */
function handler(withReconcile) {
  return {
    async observe() {
      return { needed: true, reason: "test" };
    },
    async act(ctx) {
      const out = await ctx.step(
        "effect",
        "logs.delete_closed",
        "test",
        { n: 1 },
        async (effectKey) => {
          fs.appendFileSync(effects, `${effectKey}\n`);
          return { state: "succeeded", result: { effectKey } };
        },
        withReconcile
          ? async (s) => {
              // reconcile from the effect's own evidence: was this effect key applied?
              const seen = fs.existsSync(effects) && fs.readFileSync(effects, "utf8").split("\n").includes(s.effect_key);
              return seen ? { state: "succeeded", result: { reconciled: true } } : { state: "failed_no_effect", result: { reconciled: "absent" } };
            }
          : undefined,
      );
      return { certainty: out.state === "succeeded" ? "confirmed" : out.state === "unknown" ? "unknown" : "none", reason: out.state, completed: out.state === "succeeded" ? 1 : 0 };
    },
  };
}

async function main() {
  const out = {};
  if (scenario === "app") {
    const r = new AppRecovery(core.store, { row: () => undefined }, core.maintenance.incidents, () => fs.appendFileSync(effects, "kick\n"));
    core.maintenance.jobs.register("app-recovery", r.handler());
  } else {
    core.maintenance.jobs.register("log-cleanup", handler(scenario === "after_effect"));
  }
  if (phase === "setup") {
    if (scenario === "trigger") {
      const p = enable({ templateId: "log-cleanup", target, mode: "automatic", trigger: { kind: "interval", intervalSeconds: 60 } });
      core.maintenance.jobs.tickSchedules(); // creates the cursor at the approval anchor
      out.policyId = p.id;
    } else if (scenario === "app") {
      const b = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "fixtures", "todo-v1.json"), "utf8"));
      const appId = randomUUID();
      b.manifest.appId = appId;
      core.apps.seedActivated(b);
      core.store.tx(() =>
        core.store.run("INSERT INTO app_runtime (app_id, enabled, active_instance_id, generation, health, control_epoch, restart_count, updated_at) VALUES (?, 1, NULL, 1, 'degraded', 1, 3, 'x')", appId),
      );
      enable({ templateId: "app-recovery", target: { kind: "app", id: appId }, mode: "automatic", trigger: { kind: "manual" }, params: { observeSeconds: 60 } });
      out.jobId = core.maintenance.jobs.manualCheck("app-recovery", { kind: "app", id: appId }, "app-r").jobId;
      out.appId = appId;
    } else {
      enable({ templateId: "log-cleanup", target, mode: "automatic", trigger: { kind: "manual" } });
      out.jobId = core.maintenance.jobs.manualCheck("log-cleanup", target, `m-${scenario}`).jobId;
    }
  } else {
    if (scenario === "trigger") out.made = core.maintenance.jobs.tickSchedules();
    await core.maintenance.jobs.pass(true);
  }
  out.effects = effectCount();
  out.jobs = core.store.all("SELECT id, state, effect_certainty, trigger_key FROM maintenance_jobs");
  out.steps = core.store.all("SELECT job_id, step_id, state FROM maintenance_steps");
  out.attempts = core.store.get("SELECT COUNT(*) AS n FROM maintenance_attempts").n;
  process.stdout.write(`RESULT ${JSON.stringify(out)}\n`);
  core.store.close?.();
}
main().catch((e) => {
  process.stderr.write(`${e.stack}\n`);
  process.exit(2);
});
