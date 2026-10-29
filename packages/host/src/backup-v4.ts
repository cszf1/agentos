import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256Hex } from "@agentos/contracts";
import { ArtifactStore, OnlineGc, openCore } from "@agentos/core";

/**
 * v0.4 additions to the coordinated cold backup and restore (spec §23.3, §23.4). The backup runs with the host stopped
 * (host.lock held), so no run, job, I/O worker or online GC can start; open delete intents are finished from their
 * persisted phases BEFORE the copy decides which artifacts it contains. Restore gives the workspace new scheduler /
 * maintenance / execution epochs and leaves nothing old able to act again.
 */
export interface V04BackupFacts {
  schedulerEpoch: number;
  maintenanceEpoch: number;
  maintenanceState: string;
  conversations: { total: number; byState: Record<string, number>; bindingsHash: string };
  policies: { id: string; version: number; state: string; policyHash: string; approvedHash: string | null }[];
  unfinishedJobs: { id: string; templateId: string; state: string }[];
  openDeleteIntents: number;
  heldPins: number;
  unknownEffects: { maintenanceSteps: number; systemActions: number };
  gcResumedBeforeCopy: number;
}

function has(db: DatabaseSync, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

/** Before copying: finish open delete intents offline so the artifact set is decided on real files. */
export async function settleGcBeforeBackup(dataDir: string): Promise<number> {
  const osFile = path.join(dataDir, "os.sqlite");
  const probe = new DatabaseSync(osFile, { readOnly: true });
  const v4 = has(probe, "gc_delete_intents");
  const open = v4 ? (probe.prepare("SELECT COUNT(*) AS n FROM gc_delete_intents WHERE phase IN ('marked','moved','deleted')").get() as { n: number }).n : 0;
  probe.close();
  if (!v4 || open === 0) return 0;
  const core = openCore(osFile);
  try {
    const gc = new OnlineGc(core.store, new ArtifactStore(path.join(dataDir, "artifacts")), path.join(dataDir, "logs"));
    const r = await gc.recover();
    await gc.worker.stop();
    return r.resumed;
  } finally {
    core.store.close();
  }
}

export function v04Facts(osFile: string, gcResumed: number): V04BackupFacts | null {
  const db = new DatabaseSync(osFile, { readOnly: true });
  try {
    if (!has(db, "maintenance_jobs")) return null;
    const m = db.prepare("SELECT scheduler_epoch AS s, maintenance_epoch AS e, maintenance_state AS st FROM meta WHERE id = 1").get() as { s: number; e: number; st: string };
    const convs = db.prepare("SELECT create_key, conversation_id, run_id, binding_hash, binding_state FROM agent_conversations ORDER BY create_key").all() as { binding_state: string }[];
    const byState: Record<string, number> = {};
    for (const c of convs) byState[c.binding_state] = (byState[c.binding_state] ?? 0) + 1;
    return {
      schedulerEpoch: m.s,
      maintenanceEpoch: m.e,
      maintenanceState: m.st,
      conversations: { total: convs.length, byState, bindingsHash: `sha256:${sha256Hex(canonicalJson(convs))}` },
      policies: db.prepare("SELECT id, version, state, policy_hash AS policyHash, approved_hash AS approvedHash FROM maintenance_policies WHERE state NOT IN ('superseded') ORDER BY id, version").all() as never,
      unfinishedJobs: db.prepare("SELECT id, template_id AS templateId, state FROM maintenance_jobs WHERE state NOT IN ('succeeded','no_change','failed_no_effect','cancelled','expired','indeterminate','needs_attention')").all() as never,
      openDeleteIntents: (db.prepare("SELECT COUNT(*) AS n FROM gc_delete_intents WHERE phase IN ('marked','moved','unknown')").get() as { n: number }).n,
      heldPins: (db.prepare("SELECT COUNT(*) AS n FROM artifact_pins WHERE state = 'held'").get() as { n: number }).n,
      unknownEffects: {
        maintenanceSteps: (db.prepare("SELECT COUNT(*) AS n FROM maintenance_steps WHERE state IN ('unknown','dispatched')").get() as { n: number }).n,
        systemActions: (db.prepare("SELECT COUNT(*) AS n FROM system_actions WHERE state = 'indeterminate'").get() as { n: number }).n,
      },
      gcResumedBeforeCopy: gcResumed,
    };
  } finally {
    db.close();
  }
}

/**
 * Restore (spec §23.4), inside the marker protocol before the marker is removed: new scheduler/maintenance epochs; every
 * policy needs review; old jobs/outboxes/triggers/delete intents never act; unfinished runs lose their write and model
 * routes BEFORE Pi resumes (a targeted abort follows through the normal cancel path); compactions are cancelled;
 * artifacts missing on disk are `unavailable` with a new generation (rebuilt from their recipe), never "live".
 */
export function applyV04Restore(dataDir: string, reason: string): Record<string, number> {
  const osFile = path.join(dataDir, "os.sqlite");
  const db = new DatabaseSync(osFile);
  const out: Record<string, number> = {};
  try {
    if (!has(db, "maintenance_jobs")) return out;
    const now = new Date().toISOString();
    const run = (k: string, sql: string, ...p: unknown[]) => {
      out[k] = Number(db.prepare(sql).run(...(p as never[])).changes);
    };
    db.exec("BEGIN IMMEDIATE");
    run("meta", "UPDATE meta SET scheduler_epoch = scheduler_epoch + 1, maintenance_epoch = maintenance_epoch + 1, maintenance_root_state = 'pending' WHERE id = 1");
    run("policies", "UPDATE maintenance_policies SET state = 'paused_needs_review', updated_at = ? WHERE state IN ('enabled','syncing','paused','pending_approval')", now);
    run("jobs", "UPDATE maintenance_jobs SET state = 'expired', outcome_reason = ?, ended_at = ?, updated_at = ? WHERE state NOT IN ('succeeded','no_change','failed_no_effect','cancelled','expired','indeterminate','needs_attention')", `workspace restored (${reason}): old maintenance work never resumes`, now, now);
    run("effectOutbox", "UPDATE maintenance_effect_outbox SET dispatch_state = 'fenced', updated_at = ? WHERE dispatch_state IN ('pending','sent','accepted')", now);
    run("rootOutbox", "UPDATE root_sync_outbox SET dispatch_state = 'failed', broker_result = 'fenced by restore', updated_at = ? WHERE dispatch_state IN ('pending','sent')", now);
    run("intents", "UPDATE gc_delete_intents SET phase = 'aborted', error = 'workspace restored', updated_at = ? WHERE phase IN ('marked','moved','unknown')", now);
    run("deleting", "UPDATE artifacts SET gc_state = 'unavailable', delete_intent_id = NULL, gc_generation = gc_generation + 1 WHERE gc_state IN ('deleting','marked')");
    run("pins", "UPDATE artifact_pins SET state = 'released', released_at = ? WHERE state = 'held' AND owner_kind IN ('reader','candidate_check','build','backup')", now);
    // runs: close the write fence and model route first; the coordinator then aborts the conversation as a cancel
    run("runs", "UPDATE runs SET status = 'cancel_requested', stop_reason = 'restore', execution_epoch = execution_epoch + 1, updated_at = ? WHERE status IN ('queued','running','blocked')", now);
    run("routes", "UPDATE agent_conversations SET route_purpose = 'closed', route_subject_id = NULL, maintenance_lock = NULL, updated_at = ? WHERE purpose IN ('run','compaction') AND (run_id IS NULL OR run_id IN (SELECT id FROM runs WHERE stop_reason = 'restore') OR route_purpose = 'compaction')", now);
    run("compactions", "UPDATE compaction_jobs SET state = 'cancelled', result_json = ?, updated_at = ? WHERE state IN ('queued','creating','running')", JSON.stringify({ reason: "workspace restored" }), now);
    run("attempts", "UPDATE model_attempts SET state = 'interrupted', ended_at = ? WHERE state IN ('waiting','running')", now);
    run("leases", "UPDATE target_leases SET state = 'released', updated_at = ? WHERE state IN ('held','reclaiming','unknown')", now);
    run("proposals", "UPDATE proposals SET state = 'needs_recheck', updated_at = ? WHERE state IN ('pending','publishing')", now);
    run("targetControls", "UPDATE target_controls SET root_state = 'pending', updated_at = ?", now);
    run("lifecycle", "UPDATE app_lifecycle SET state = CASE state WHEN 'archiving' THEN 'archived' WHEN 'restoring' THEN 'archived' ELSE state END, updated_at = ? WHERE state IN ('archiving','restoring')", now);
    // cache objects the old database says exist but the disk no longer has
    const store = new ArtifactStore(path.join(dataDir, "artifacts"));
    let missing = 0;
    for (const a of db.prepare("SELECT id FROM artifacts WHERE gc_state = 'live'").all() as { id: string }[]) {
      if (store.verify(a.id) !== null) {
        db.prepare("UPDATE artifacts SET gc_state = 'unavailable', gc_generation = gc_generation + 1 WHERE id = ?").run(a.id);
        missing++;
      }
    }
    out.missingArtifacts = missing;
    db.prepare("INSERT INTO events (kind, payload_json, created_at) VALUES ('workspace.v04_restored', ?, ?)").run(JSON.stringify(out), now);
    db.exec("COMMIT");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  } finally {
    db.close();
  }
  void fs;
  return out;
}
