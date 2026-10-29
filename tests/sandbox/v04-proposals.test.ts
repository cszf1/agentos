/**
 * v0.4 optimisation candidates end to end (spec §19, V4-E02..E05, E08) through a real host process with the real code
 * runtime (rootless podman), the formal faux model (maintenance-refactor role), real os.sqlite and the formal
 * proposal_accept deployment. Fault points kill the host with SIGKILL (AGENTOS_FAULTS=1, NODE_ENV=test).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { Client, startHost, stopHost, type HostProc } from "../proc.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-v4-prop-"));
let host: HostProc | null = null;
afterAll(async () => {
  if (host) await stopHost(host).catch(() => undefined);
});

function q<T>(sql: string, ...a: unknown[]): T[] {
  const db = new DatabaseSync(path.join(dir, "os.sqlite"), { readOnly: true });
  try {
    return db.prepare(sql).all(...(a as never[])) as T[];
  } finally {
    db.close();
  }
}
async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  let last: T | undefined;
  for (;;) {
    last = await f();
    if (ok(last)) return last;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}; last ${JSON.stringify(last).slice(0, 600)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const app = (id: string) => q<{ epoch: number; active_revision_id: string }>("SELECT epoch, active_revision_id FROM apps WHERE id = ?", id)[0]!;
type Prop = { proposalId: string; appId: string; state: string; proposalHash: string; baseAppEpoch: number; candidateRevisionId: string; appliedRevisionId: string | null; deploymentId: string | null; check: { baselineHash: string | null; candidateHash: string | null; fixtureSetVersion: string; result: unknown } };

async function boot(env: Record<string, string> = {}) {
  if (host) await stopHost(host).catch(() => undefined); // a failed earlier test never leaves its host holding the lock
  host = await startHost(dir, { AGENTOS_MODEL_MODE: "faux", ...env });
  const c = new Client(host);
  await c.login(dir);
  return c;
}
async function optimise(c: Client, appId: string, known: string[]): Promise<Prop> {
  const r = await c.req("POST", "/api/maintenance/checks", { templateId: "app-optimize", target: { kind: "app", id: appId } });
  expect(r.status, JSON.stringify(r)).toBe(202);
  const list = await until(() => c.get("/api/proposals"), (l) => (l.data.items as Prop[]).some((p) => !known.includes(p.proposalId) && p.state === "pending"), 300_000, "a pending proposal");
  return (list.data.items as Prop[]).find((p) => !known.includes(p.proposalId) && p.state === "pending")!;
}

describe("v0.4 proposals through the formal deployment", () => {
  let appId = "";
  const seen: string[] = [];

  it("V4-E02/E04 a verified candidate is published only on the user's exact hash + epoch, through proposal_accept", async () => {
    const c = await boot();
    const s = await c.req("POST", "/api/maintenance/settings", { backgroundModel: true, backgroundModelRequestsPer24h: 200, backgroundOutputTokensPer24h: 5_000_000 });
    expect(s.status, JSON.stringify(s)).toBe(200);
    const r = await c.req("POST", "/api/runs", { intent: "做一个看板应用", targetAppId: null });
    expect(r.status).toBe(202);
    appId = r.data.targetAppId;
    expect((await c.waitRun(r.data.runId, 240_000)).status).toBe("succeeded");
    const before = app(appId);

    const p = await optimise(c, appId, seen);
    seen.push(p.proposalId);
    // E02: real check evidence pinned on the proposal (baseline and candidate hashes, fixture set), and the check ended
    expect(p.check.baselineHash).toBeTruthy();
    expect(p.check.candidateHash).toBeTruthy();
    expect(p.check.fixtureSetVersion).toBeTruthy();
    const chk = q<{ state: string }>("SELECT state FROM candidate_checks WHERE id = (SELECT candidate_check_id FROM proposals WHERE id = ?)", p.proposalId)[0]!;
    expect(chk.state).toBe("passed");
    // the candidate is not active: a background run cannot publish
    expect(app(appId).active_revision_id).toBe(before.active_revision_id);
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM deployments WHERE app_id = ? AND origin = 'proposal_accept'", appId)[0]!.n).toBe(0);
    // E08: the background run produced no install, no data merge, no activation
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM system_actions WHERE origin = 'maintenance'")[0]?.n ?? 0).toBe(0);

    // E04: a wrong hash or a wrong epoch is refused; the exact pair publishes through a formal deployment
    const bad = await c.req("POST", `/api/proposals/${p.proposalId}/accept`, { proposalHash: "sha256:00", expectedAppEpoch: before.epoch });
    expect(bad.status).toBe(409);
    expect(bad.error?.code).toBe("PROPOSAL_STALE");
    const badEpoch = await c.req("POST", `/api/proposals/${p.proposalId}/accept`, { proposalHash: p.proposalHash, expectedAppEpoch: before.epoch + 7 });
    expect(badEpoch.status).toBe(409);
    expect(badEpoch.error?.code).toBe("PROPOSAL_STALE");
    expect((await c.get("/api/proposals")).data.items.find((x: Prop) => x.proposalId === p.proposalId).state).toBe("stale");
    // the failed epoch marked it stale: it needs a new candidate, never the old confirmation
    const p2 = await optimise(c, appId, seen);
    seen.push(p2.proposalId);
    const ok = await c.req("POST", `/api/proposals/${p2.proposalId}/accept`, { proposalHash: p2.proposalHash, expectedAppEpoch: app(appId).epoch });
    expect(ok.status, JSON.stringify(ok)).toBe(202);
    const pub = await until(() => c.get("/api/proposals"), (l) => (l.data.items as Prop[]).find((x) => x.proposalId === p2.proposalId)?.state === "published", 240_000, "published");
    const done = (pub.data.items as Prop[]).find((x) => x.proposalId === p2.proposalId)!;
    expect(app(appId).active_revision_id).toBe(done.appliedRevisionId);
    expect(app(appId).epoch).toBeGreaterThan(before.epoch);
    const deps = q<{ origin: string; status: string }>("SELECT origin, status FROM deployments WHERE id = ?", done.deploymentId);
    expect(deps[0]).toMatchObject({ origin: "proposal_accept", status: "committed" });
    // replaying the same decision is the same publication, never a second deployment
    const replay = await c.req("POST", `/api/proposals/${p2.proposalId}/accept`, { proposalHash: p2.proposalHash, expectedAppEpoch: app(appId).epoch });
    expect([200, 202, 409]).toContain(replay.status);
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM deployments WHERE app_id = ? AND origin = 'proposal_accept'", appId)[0]!.n).toBe(1);
    await stopHost(host!);
    host = null;
  }, 900_000);

  it("V4-E05 the host dies inside the publication; restart completes the facts with exactly one activation", async () => {
    let c = await boot();
    const p = await optimise(c, appId, seen);
    seen.push(p.proposalId);
    const epoch = app(appId).epoch;
    await stopHost(host!);
    host = null;
    c = await boot({ AGENTOS_FAULTS: "1", AGENTOS_FAULT_POINT: "proposal.after_publish_projection" });
    await c.req("POST", `/api/proposals/${p.proposalId}/accept`, { proposalHash: p.proposalHash, expectedAppEpoch: epoch }).catch(() => undefined);
    // the host SIGKILLs itself at the fault point
    await until(async () => host!.proc.exitCode !== null || host!.proc.signalCode !== null, (v) => v, 240_000, "the host to die at the fault point");
    host = null;
    c = await boot();
    const pub = await until(() => c.get("/api/proposals"), (l) => (l.data.items as Prop[]).find((x) => x.proposalId === p.proposalId)?.state === "published", 240_000, "published after restart");
    const done = (pub.data.items as Prop[]).find((x) => x.proposalId === p.proposalId)!;
    expect(app(appId).active_revision_id).toBe(done.appliedRevisionId);
    const committed = q<{ n: number }>("SELECT COUNT(*) AS n FROM deployments WHERE app_id = ? AND origin = 'proposal_accept' AND status = 'committed'", appId)[0]!.n;
    expect(committed).toBe(2); // one per accepted proposal (E04 + this one), never a duplicate
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM deployments WHERE id = ?", done.deploymentId)[0]!.n).toBe(1);
    await stopHost(host!);
    host = null;
  }, 900_000);

  it("V4-E03 a foreground change makes a waiting proposal stale; it is never published over the user's version", async () => {
    const c = await boot();
    const p = await optimise(c, appId, seen);
    seen.push(p.proposalId);
    const fg = await c.req("POST", "/api/runs", { intent: "看板增加工时字段", targetAppId: appId, expectedAppEpoch: app(appId).epoch });
    expect(fg.status, JSON.stringify(fg)).toBe(202);
    expect((await c.waitRun(fg.data.runId, 240_000)).status).toBe("succeeded");
    const userRev = app(appId).active_revision_id;
    const st = await c.get("/api/proposals");
    expect((st.data.items as Prop[]).find((x) => x.proposalId === p.proposalId)!.state).toBe("stale");
    const acc = await c.req("POST", `/api/proposals/${p.proposalId}/accept`, { proposalHash: p.proposalHash, expectedAppEpoch: app(appId).epoch });
    expect(acc.status).toBe(409);
    expect(app(appId).active_revision_id).toBe(userRev);
    await stopHost(host!);
    host = null;
  }, 900_000);
});
