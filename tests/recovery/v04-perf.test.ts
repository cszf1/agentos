/**
 * V4-O05 foreground performance under background work (spec §27): the same machine and the same load measured twice,
 * first with no background work, then while background maintenance checks (cache-gc / log-cleanup / app-recovery),
 * a model-backed session compaction and repeated jobs run. The p95 of CRUD and list queries must stay within 1.25 ×
 * the baseline. The raw samples are written to $AGENTOS_PERF_OUT (default /tmp/agentos-perf-v04.json).
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { Client, seedFixtures, startHost, stopHost } from "../proc.js";
import { tmpDir } from "../helpers.js";

const OPS = Number(process.env.AGENTOS_PERF_OPS ?? 200); // per round
const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!;
};

async function measure(c: Client, appId: string, tag: string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < OPS; i++) {
    const epoch = (await c.get(`/api/apps/${appId}`)).data.appEpoch;
    const t0 = performance.now();
    if (i % 2 === 0) {
      const w = await c.req("POST", `/api/apps/${appId}/records`, { expectedAppEpoch: epoch, data: { title: `${tag}-${i}` } });
      if (w.status >= 300) throw new Error(`write ${w.status}`);
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
            const open = (await c.get("/api/maintenance/jobs?open=1")).data.items.length as number;
            if (open === 0) {
              for (const [t, target] of tpls) {
                const jb = await c.req("POST", "/api/maintenance/checks", { templateId: t, target }).catch(() => null);
                if (jb && jb.status === 202) bgJobs++;
              }
            }
          }
          await new Promise((res) => setTimeout(res, 500));
        }
      })();
      const ROUNDS = 6;
      const base: number[] = [];
      const load: number[] = [];
      for (let k = 0; k < ROUNDS; k++) {
        active = k % 2 === 1;
        if (active) await new Promise((res) => setTimeout(res, 300)); // let the batch start
        (active ? load : base).push(...(await measure(c, a!.appId, `r${k}`)));
        active = false;
      }
      stop = true;
      await bg;
      const res = {
        ops: OPS, node: process.version, platform: `${process.platform}/${process.arch}`, at: new Date().toISOString(), backgroundJobsSubmitted: bgJobs, compactedConversation: conv ?? null,
        baseline: { p50: base.sort((x, y) => x - y)[Math.floor(base.length / 2)], p95: p95(base) }, withBackground: { p50: load.sort((x, y) => x - y)[Math.floor(load.length / 2)], p95: p95(load) },
        ratio: p95(load) / p95(base), raw: { baseline: base, withBackground: load },
      };
      fs.writeFileSync(process.env.AGENTOS_PERF_OUT ?? "/tmp/agentos-perf-v04.json", JSON.stringify(res, null, 1));
      console.log(`O05 baseline p95 ${res.baseline.p95.toFixed(2)} ms, with background p95 ${res.withBackground.p95.toFixed(2)} ms, ratio ${res.ratio.toFixed(3)}, background jobs ${bgJobs}`);
      expect(bgJobs).toBeGreaterThan(0);
      expect(res.ratio).toBeLessThanOrEqual(1.25);
    } finally {
      await stopHost(h);
    }
  }, 600_000);
});
