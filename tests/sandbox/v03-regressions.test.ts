import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { AppBundle } from "@agentos/contracts";
import { ManualClock, startRig, type AgentRig } from "../agent-helpers.js";

/** Review #1 (main@79377eb): an expired agent deployment must end failed and release its slot. */
const run = fs.existsSync(`/run/user/${process.getuid!()}/podman/podman.sock`) ? describe : describe.skip;

run("review #1: deployment expiry is persisted outside the rolled-back activate transaction", () => {
  let rig: AgentRig;
  afterAll(async () => rig?.close());
  it("PREPARE_EXPIRED leaves the deployment failed (not ready) and a new prepare is not DEPLOYMENT_BUSY", async () => {
    const clock = new ManualClock();
    rig = await startRig({ clock });
    const v1 = JSON.parse(fs.readFileSync(new URL("../../fixtures/todo-v1.json", import.meta.url), "utf8")) as AppBundle;
    rig.core.apps.seedActivated(v1);
    const appId = v1.manifest.appId;
    const b2 = structuredClone(v1);
    b2.manifest.description = "expiry candidate";
    const staged = rig.core.store.tx(() => rig.core.apps.stage(appId, b2, null));
    const app = rig.core.apps.requireApp(appId);
    const d = rig.core.store.tx(() => rig.sys.deployments.prepareInTx({ appId, revisionId: staged.revisionId, expectedAppEpoch: app.epoch, origin: "agent_prepare", ownerRunId: null, requestKey: randomUUID(), requestHash: "t" }));
    await rig.sys.deployments.drive(d.id);
    expect(rig.sys.deployments.require(d.id).status).toBe("ready");
    clock.advance(24 * 3600_000);
    // The activation inside the gateway's savepoint throws and rolls back whatever it wrote.
    expect(() => rig.core.gateway.write("apps.activate.history", { principal: { kind: "user" }, operationKey: randomUUID(), requestHash: "x" }, () => ({ status: 200, body: rig.sys.deployments.activateInTx(d.id, { runId: null }) }))).toThrow(/expired/);
    // The fix: the expiry is committed on its own.
    expect(rig.sys.deployments.expireIfDue(d.id)).toBe(true);
    const row = rig.sys.deployments.require(d.id);
    expect(row.status).toBe("failed");
    expect(JSON.parse(row.error_json!).code).toBe("PREPARE_EXPIRED");
    const b3 = structuredClone(v1);
    b3.manifest.description = "after expiry";
    const s3 = rig.core.store.tx(() => rig.core.apps.stage(appId, b3, null));
    expect(() => rig.core.store.tx(() => rig.sys.deployments.prepareInTx({ appId, revisionId: s3.revisionId, expectedAppEpoch: rig.core.apps.requireApp(appId).epoch, origin: "agent_prepare", ownerRunId: null, requestKey: randomUUID(), requestHash: "t2" }))).not.toThrow();
  });
});
