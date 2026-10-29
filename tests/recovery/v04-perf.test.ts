/**
 * V4-O05 foreground performance under background work (spec §27): the same machine and the same load measured twice,
 * first with no background work, then while background maintenance checks (cache-gc / log-cleanup / app-recovery),
 * a model-backed session compaction and repeated jobs run. The p95 of CRUD (create/delete) and list queries must stay within 1.25 ×
 * the baseline. The raw samples are written to $AGENTOS_PERF_OUT (default /tmp/agentos-perf-v04.json).
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { Client, seedFixtures, startHost, stopHost } from "../proc.js";
import { tmpDir } from "../helpers.js";

// Samples per round. Until 2026-10-29 the test ran 3 + 3 alternating rounds of 200 (A B A B A B): the first rounds of each
// side ran slower (warm-up), background jobs left over from a B round kept running into the next A round, and at 200
// samples the p95 of a ~1 ms request moved by ±0.2 ms between identical runs. Now: 12 rounds of 300 in ABBA order (each
// side gets the same mix of early and late positions), a longer warm-up, and every baseline round starts only after
// the background work has drained. The threshold (1.25) is unchanged.
const OPS = Number(process.env.AGENTOS_PERF_OPS ?? 300);
const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!;
};

const live: string[] = [];
async function measure(c: Client, appId: string, tag: string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < OPS; i++) {
    const epoch = (await c.get(`/api/apps/${appId}`)).data.appEpoch;
    const t0 = performance.now();
    if (i % 4 === 0 || (i % 4 === 2 && live.length === 0)) {
      const w = await c.req("POST", `/api/apps/${appId}/records`, { expectedAppEpoch: epoch, data: { title: `${tag}-${i}` } });
      if (w.status >= 300) throw new Error(`write ${w.status}`);
      live.push(w.data.id as string);
    } else if (i % 4 === 2) {
      // create and delete alternate so the app stays below its record limit however many samples are taken
      const w = await c.req("DELETE", `/api/apps/${appId}/records/${live.shift()}`, { expectedAppEpoch: epoch, expectedRecordVersion: 1 });
      if (w.status >= 300) throw new Error(`delete ${w.status}`);
    } else {
      const r = await c.get(`/api/apps/${appId}/records?limit=50`);
      if (r.status !== 200) throw new Error(`query ${r.status}`);
    }
    out.push(performance.now() - t0);
  }
  return out;
}

describe("V4-O05 foreground p95 with and without background work", () => {
  it("CRUD/query p95 under background work stays within 1.25 x the baseline", async () => {
    const dir = tmpDir();
    const [a] = await seedFixtures(dir, ["todo-v1.json"]);
    const h = await startHost(dir, { AGENTOS_MODEL_MODE: "faux" });
    try {
      const c = new Client(h);
      await c.login(dir);
      await c.req("POST", "/api/maintenance/settings", { backgroundModel: true, backgroundModelRequestsPer24h: 500, backgroundOutputTokensPer24h: 5_000_000 });
      // a finished task conversation to compact during the background phase
      const r = await c.req("POST", "/api/runs", { intent: "增加优先级", targetAppId: a!.appId, expectedAppEpoch: 1 });
      await c.waitRun(r.data.runId, 120_000);
      const conv = (await c.get(`/api/runs/${r.data.runId}/transcript`)).data.conversationId as string | undefined;
      await measure(c, a!.appId, "warm"); // warm-up, not recorded
      await measure(c, a!.appId, "warm2");
      // interleaved rounds (A = no background, B = background batch running) so table growth and drift hit both sides
      let active = false;
      let stop = false;
      let bgJobs = 0;
      const all: [string, { kind: string; id: string }][] = [["cache-gc", { kind: "workspace", id: "workspace" }], ["log-cleanup", { kind: "workspace", id: "workspace" }], ["app-recovery", { kind: "app", id: a!.appId }]];
      const only = process.env.AGENTOS_PERF_TEMPLATES?.split(",");
      const tpls = only ? all.filter(([t]) => only.includes(t)) : all;
      let compacted = false;
      const bg = (async () => {
        // the host runs the background batch itself; the client only refills it when the job queue drained
        while (!stop) {
          if (active) {
            if (conv && !compacted && process.env.AGENTOS_PERF_NO_COMPACTION !== "1") {
              compacted = true;
              await c.req("POST", `/api/conversations/${conv}/compactions`, {}).catch(() => undefined);
            }
            // A check that ends awaiting approval (log-cleanup proposes a deletion) stays open and would stop the refill
            // after the first batch, leaving later background rounds idle; it is cancelled here so jobs keep repeating.
            const items = (await c.get("/api/maintenance/jobs?open=1")).data.items as { jobId: string; state: string }[];
            for (const j of items.filter((x) => x.state === "awaiting_approval")) await c.req("POST", `/api/maintenance/jobs/${j.jobId}/cancel`, {}).catch(() => undefined);
            if (items.every((x) => x.state === "awaiting_approval")) {
              for (const [t, target] of tpls) {
                const jb = await c.req("POST", "/api/maintenance/checks", { templateId: t, target }).catch(() => null);
                if (jb && jb.status === 202) bgJobs++;
              }
            }
          }
          await new Promise((res) => setTimeout(res, 500));
        }
      })();
      const ROUNDS = 12;
      const base: number[] = [];
      const load: number[] = [];
      const drained = async () => {
        // a baseline round measures no background work: wait until open jobs (other than awaiting approval, cancelled
        // here) and compactions have ended
        for (let t = 0; t < 200; t++) {
          const items = (await c.get("/api/maintenance/jobs?open=1")).data.items as { jobId: string; state: string }[];
          for (const j of items.filter((x) => x.state === "awaiting_approval")) await c.req("POST", `/api/maintenance/jobs/${j.jobId}/cancel`, {}).catch(() => undefined);
          const cmp = conv ? ((await c.get(`/api/conversations/${conv}/compactions`).catch(() => null))?.data?.items ?? []) as { state: string }[] : [];
          if (items.every((x) => x.state === "awaiting_approval") && !cmp.some((x) => ["queued", "creating", "running"].includes(x.state))) return;
          await new Promise((res) => setTimeout(res, 100));
        }
        throw new Error("background work did not drain before a baseline round");
      };
      for (let k = 0; k < ROUNDS; k++) {
        const loaded = k % 4 === 1 || k % 4 === 2; // A B B A A B B A ...
        if (loaded) {
          active = true;
          await new Promise((res) => setTimeout(res, 300)); // let the batch start
        } else {
          active = false;
          await drained();
        }
        (loaded ? load : base).push(...(await measure(c, a!.appId, `r${k}`)));
      }
      active = false;
      stop = true;
      await bg;
      const res = {
        ops: OPS, node: process.version, platform: `${process.platform}/${process.arch}`, at: new Date().toISOString(), backgroundJobsSubmitted: bgJobs, compactedConversation: conv ?? null,
        baseline: { p50: [...base].sort((x, y) => x - y)[Math.floor(base.length / 2)], p95: p95(base) }, withBackground: { p50: [...load].sort((x, y) => x - y)[Math.floor(load.length / 2)], p95: p95(load) },
        order: "ABBA", roundsP95: Array.from({ length: ROUNDS / 2 }, (_, k) => ({ baseline: p95(base.slice(k * OPS, (k + 1) * OPS)), withBackground: p95(load.slice(k * OPS, (k + 1) * OPS)) })),
        ratio: p95(load) / p95(base), raw: { order: "measurement order, rounds concatenated", baseline: base, withBackground: load },
      };
      fs.writeFileSync(process.env.AGENTOS_PERF_OUT ?? "/tmp/agentos-perf-v04.json", JSON.stringify(res, null, 1));
      console.log(`O05 baseline p95 ${res.baseline.p95.toFixed(2)} ms, with background p95 ${res.withBackground.p95.toFixed(2)} ms, ratio ${res.ratio.toFixed(3)}, background jobs ${bgJobs}`);
      // background work was really running in every loaded round: more than one batch was submitted
      expect(bgJobs).toBeGreaterThan(tpls.length);
      expect(res.ratio).toBeLessThanOrEqual(1.25);
    } finally {
      await stopHost(h);
    }
  }, 600_000);
});
