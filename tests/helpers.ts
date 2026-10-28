import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openCore, requestHash, type Core } from "@agentos/core";
import type { AppBundle } from "@agentos/contracts";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const fixture = (name: string): AppBundle => JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", name), "utf8"));

export function tmpDir(prefix = "agentos-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function newCore(dir = tmpDir()): Core & { dir: string } {
  return Object.assign(openCore(path.join(dir, "os.sqlite")), { dir });
}

export const meta = (body: unknown, key: string = randomUUID()) => ({ operationKey: key, requestHash: requestHash({ body }) });

export function createRecord(core: Core, appId: string, data: Record<string, unknown>, key?: string) {
  const epoch = core.apps.requireApp(appId).epoch;
  return core.user.createRecord(meta({ appId, epoch, data }, key), appId, epoch, data).body;
}

export function activateHistory(core: Core, appId: string, revisionId: string) {
  const epoch = core.apps.requireApp(appId).epoch;
  return core.user.activateHistorical(meta({ appId, revisionId, epoch }), appId, revisionId, epoch).body;
}

/** Stage + activate a candidate as an agent would, without Pi (M1 fixture path). */
export function publishCandidate(core: Core, bundle: AppBundle) {
  return core.store.tx(() => {
    const appId = bundle.manifest.appId;
    if (!core.apps.getAppRow(appId)) {
      core.store.run("INSERT INTO apps (id, active_revision_id, epoch, contract_json, created_at, updated_at) VALUES (?, NULL, 0, '{\"fields\":{}}', 'x', 'x')", appId);
    }
    const { revisionId, issues } = core.apps.stage(appId, bundle, null);
    if (issues.length) throw new Error(JSON.stringify(issues));
    return core.apps.activateInTx(appId, revisionId, core.apps.requireApp(appId).epoch, { historicalOnly: false, runId: null });
  });
}
