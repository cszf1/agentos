import { randomUUID } from "node:crypto";
import { requestHash, type Core, type RuntimeSystem } from "@agentos/core";
import type { AppBundle } from "@agentos/contracts";

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 60_000, stepMs = 100): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function opMeta(body: unknown, clientEpoch?: number) {
  const k = randomUUID();
  return { operationKey: k, requestHash: requestHash({ k, body: body as never }), ...(clientEpoch !== undefined ? { clientEpoch } : {}) };
}

/** Publish a code (or declarative) bundle without a model: agent_prepare with no owning run (test seeding path). */
export async function publish(sys: RuntimeSystem, core: Core, bundle: unknown): Promise<{ status: string; deploymentId: string; revisionId: string; error: unknown }> {
  const appId = (bundle as AppBundle).manifest.appId;
  const staged = core.store.tx(() => core.apps.stage(appId, bundle, null));
  const app = core.apps.requireApp(appId);
  const d = core.store.tx(() =>
    sys.deployments.prepareInTx({ appId, revisionId: staged.revisionId, expectedAppEpoch: app.epoch, origin: "agent_prepare", ownerRunId: null, requestKey: randomUUID(), requestHash: "t" }),
  );
  await sys.deployments.drive(d.id);
  await sys.beforeActivate?.(appId);
  let row = sys.deployments.require(d.id);
  if (row.status !== "ready") return { status: row.status, deploymentId: d.id, revisionId: staged.revisionId, error: row.error_json ? JSON.parse(row.error_json) : null };
  await sys.deployments.freshProbe(row);
  core.store.tx(() => sys.deployments.activateInTx(d.id, { runId: null }));
  await sys.deployments.afterCommit(d.id);
  row = sys.deployments.require(d.id);
  return { status: row.status, deploymentId: d.id, revisionId: staged.revisionId, error: null };
}

