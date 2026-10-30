import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll } from "vitest";
import { openCore, requestHash, type Core } from "@agentos/core";
import type { AppBundle } from "@agentos/contracts";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const fixture = (name: string): AppBundle => JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", name), "utf8"));

// Every test file removes the data directories it made. They used to stay behind: after a few full runs the
// box's 3.9 GiB /tmp tmpfs held 830 of them and every later Host died with ENOSPC (the "intermittent" recovery
// failures of V1-B01). AGENTOS_KEEP_TMP=1 keeps them for debugging.
const made: string[] = [];
afterAll(() => {
  if (process.env.AGENTOS_KEEP_TMP === "1") return;
  for (const d of made.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* a directory still held by a rootless-podman subuid file is left; it is reported by the caller's df */
    }
  }
});

export function tmpDir(prefix = "agentos-test-"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
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
