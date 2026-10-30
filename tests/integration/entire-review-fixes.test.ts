/**
 * Regressions for the Entire review of main@220f80e (2026-10-30, trail #2). Each case fails on 220f80e.
 * Real os.sqlite and real services; the broker is replaced by a scripted history only where noted.
 */
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openCore } from "@agentos/core";
import { historyAll } from "../../packages/host/src/backup-v3.js";
import { ManualClock } from "../agent-helpers.js";
import { ROOT, fixture, tmpDir } from "../helpers.js";

function rig() {
  const core = openCore(path.join(tmpDir("agentos-entire-"), "os.sqlite"), { clock: new ManualClock() });
  const b = fixture("todo-v1.json");
  const appId = randomUUID();
  (b.manifest as { appId: string }).appId = appId;
  core.apps.seedActivated(b);
  return { core, appId };
}

describe("entire H3: async system writes check the client epoch before doing any work", () => {
  it("admit rejects a stale epoch and accepts the current one", () => {
    const { core } = rig();
    const epoch = core.store.meta().client_epoch;
    const req = { principal: { kind: "user" as const }, operationKey: randomUUID(), requestHash: "h", clientEpoch: epoch + 1 };
    expect(() => core.gateway.admit("system.actions.plan", req as never)).toThrow(/older workspace state/);
    expect(() => core.gateway.admit("system.actions.plan", { ...req, clientEpoch: epoch } as never)).not.toThrow();
  });
  it("the system-action route admits before calling work()", () => {
    const src = fs.readFileSync(path.join(ROOT, "packages/host/src/http-system.ts"), "utf8");
    const body = src.slice(src.indexOf("const asyncWrite"), src.indexOf("// ---- catalog"));
    expect(body.indexOf("core.gateway.admit(")).toBeGreaterThan(0);
    expect(body.indexOf("core.gateway.admit(")).toBeLessThan(body.indexOf("await work()"));
  });
});

describe("entire H2: archiving a running code app drops its active instance pointer", () => {
  it("archive clears app_runtime.active_instance_id in the same transaction", () => {
    const { core, appId } = rig();
    const rev = core.store.get<{ active_revision_id: string }>("SELECT active_revision_id FROM apps WHERE id = ?", appId)!.active_revision_id;
    core.store.run("PRAGMA foreign_keys = OFF");
    core.store.tx(() => {
      core.store.run(
        "INSERT INTO runtime_instances (id, app_id, revision_id, artifact_id, role, generation, host_boot_id, container_name, desired_state, observed_state, lease_digest, created_at, updated_at) VALUES ('i1', ?, ?, 'art', 'active', 1, 'boot', 'agentos-i-i1', 'running', 'serving', '', 'x', 'x')",
        appId, rev,
      );
      core.store.run("INSERT INTO app_runtime (app_id, enabled, active_instance_id, generation, health, control_epoch, restart_count, updated_at) VALUES (?, 1, NULL, 1, 'ready', 1, 0, 'x')", appId);
      core.store.run("UPDATE app_runtime SET active_instance_id = 'i1' WHERE app_id = ?", appId);
    });
    core.store.run("PRAGMA foreign_keys = ON");
    core.lifecycle.archive(appId, "user");
    const ar = core.store.get<{ active_instance_id: string | null; enabled: number }>("SELECT active_instance_id, enabled FROM app_runtime WHERE app_id = ?", appId)!;
    expect(ar.enabled).toBe(0);
    expect(ar.active_instance_id).toBeNull();
  });
});

describe("entire M: backup history pages by the operations' own sequence, not the broker's global seq", () => {
  it("collects every operation across pages when lastSeq is global", async () => {
    const all = Array.from({ length: 450 }, (_, i) => ({ operationId: `op${i}`, updatedSeq: i + 1 }));
    const calls: number[] = [];
    const client = {
      historySync: async (_id: string, since: number, limit: number) => {
        calls.push(since);
        return { operations: all.filter((o) => o.updatedSeq > since).slice(0, limit), lastSeq: 9_999 };
      },
    };
    const h = await historyAll(client as never, "install");
    expect(h.ops.map((o) => o.operationId)).toEqual(all.map((o) => o.operationId));
    expect(calls).toEqual([0, 200, 400]);
  });
  it("a history that does not advance is an error, never a silent truncation", async () => {
    const page = Array.from({ length: 200 }, (_, i) => ({ operationId: `op${i}`, updatedSeq: 5 }));
    const client = { historySync: async () => ({ operations: page, lastSeq: 5 }) };
    await expect(historyAll(client as never, "install")).rejects.toThrow(/did not advance/);
  });
});

describe("entire M: the four-code-app limit counts v3 bundles", () => {
  it("enabledCodeApps counts formatVersion 2 and 3", () => {
    const src = fs.readFileSync(path.join(ROOT, "packages/core/src/runtime/app-runtime.ts"), "utf8");
    expect(src).toMatch(/enabledCodeApps[\s\S]{0,400}formatVersion'\) IN \(2, 3\)/);
  });
});

describe("entire H1: proposal reasons are a string", () => {
  it("MaintenanceCenter renders reasons without join()", () => {
    const src = fs.readFileSync(path.join(ROOT, "packages/web/src/MaintenanceCenter.tsx"), "utf8");
    expect(src).not.toMatch(/reasons!?\.join/);
    expect(fs.readFileSync(path.join(ROOT, "packages/web/src/api.ts"), "utf8")).toMatch(/reasons: string;/);
  });
});
