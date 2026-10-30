import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyV04Restore } from "./backup-v4.js";

/** Written by `agentosctl clone` into a cloned workspace tree; consumed once by the next Host start. */
export const CLONE_RECONCILE = "clone-reconcile-pending";

export interface CloneInfo {
  workspaceId: string;
  sourceWorkspaceId: string;
  sourceMachineInstallId: string;
  setId: string;
}

/**
 * Cross-machine clone (spec §24.2, V1-R10), run by the Host of the NEW machine before it opens anything. The data
 * (apps, records, revisions, receipts, conversations) is kept byte for byte as history; nothing that carried
 * authority on the source machine acts here:
 * - the v1.0 restore rules (old jobs/outboxes/triggers/delete intents fenced, policies paused_needs_review, runs
 *   stopped, missing caches `unavailable`);
 * - service and provider grants revoked, their pending broker outbox failed (never dispatched to this broker), system
 *   resources/devices of the old machine quarantined;
 * - the membership mirror is emptied: the new machine's directory sends its own members (old user ids stay only in
 *   history rows as evidence); the workspace takes its new id, the broker binding starts unbound, the client epoch
 *   moves so no old session/token applies.
 */
export function applyClone(dataDir: string, info: CloneInfo): Record<string, number> {
  const fenced = applyV04Restore(dataDir, `clone from machine ${info.sourceMachineInstallId}`);
  const db = new DatabaseSync(path.join(dataDir, "os.sqlite"));
  const out: Record<string, number> = {};
  const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  try {
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    const run = (k: string, sql: string, ...p: unknown[]) => {
      out[k] = Number(db.prepare(sql).run(...(p as never[])).changes);
    };
    if (has("service_grants")) run("serviceGrants", "UPDATE service_grants SET revoked_at = ? WHERE revoked_at IS NULL", now);
    if (has("provider_grants")) {
      const c = cols("provider_grants");
      if (c.includes("revoked_at")) run("providerGrants", "UPDATE provider_grants SET revoked_at = ? WHERE revoked_at IS NULL", now);
      else if (c.includes("state")) run("providerGrants", "UPDATE provider_grants SET state = 'revoked' WHERE state <> 'revoked'");
    }
    if (has("provider_grant_outbox")) run("grantOutbox", "UPDATE provider_grant_outbox SET dispatch_state = 'failed', broker_result = 'cloned to another machine: never dispatched' WHERE dispatch_state IN ('pending','sent')");
    if (has("system_resources")) run("resources", "UPDATE system_resources SET status = 'quarantined' WHERE status <> 'gone'");
    if (has("membership_mirror")) run("members", "DELETE FROM membership_mirror");
    const mc = cols("meta");
    const sets = ["workspace_id = ?", "client_epoch = client_epoch + 1"];
    if (mc.includes("broker_install_id")) sets.push("broker_install_id = NULL");
    if (mc.includes("broker_binding_state")) sets.push("broker_binding_state = 'unbound'");
    if (mc.includes("instance_epoch")) sets.push("instance_epoch = instance_epoch + 1");
    run("meta", `UPDATE meta SET ${sets.join(", ")} WHERE id = 1`, info.workspaceId);
    db.prepare("INSERT INTO events (kind, payload_json, created_at) VALUES ('workspace.cloned', ?, ?)").run(
      JSON.stringify({ from: { machineInstallId: info.sourceMachineInstallId, workspaceId: info.sourceWorkspaceId, setId: info.setId }, fenced, ...out }),
      now,
    );
    db.exec("COMMIT");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* not in a transaction */
    }
    throw e;
  } finally {
    db.close();
  }
  return { ...fenced, ...out };
}

export function readCloneMarker(dataDir: string): CloneInfo | null {
  const f = path.join(dataDir, CLONE_RECONCILE);
  if (!fs.existsSync(f)) return null;
  const v = JSON.parse(fs.readFileSync(f, "utf8")) as Partial<CloneInfo>;
  for (const k of ["workspaceId", "sourceWorkspaceId", "sourceMachineInstallId", "setId"] as const) {
    if (typeof v[k] !== "string" || !v[k]) throw new Error(`clone marker lacks ${k}`);
  }
  return v as CloneInfo;
}
