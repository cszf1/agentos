import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { BrokerClient, type BrokerOperation } from "@agentos/broker-client";
import { CAPABILITIES, canonicalJson, sha256Hex } from "@agentos/contracts";

/**
 * v0.3 coordinated backup/restore with the broker (spec §23). broker.sqlite is never part of a workspace backup and
 * never rolls back with one; the workspace gets a new incarnation on restore so old outbox entries can never replay.
 */
export interface V03BackupFacts {
  providerCatalogHash: string;
  policyVersion: string | null;
  checkpoint: { seq: number; machineInstallId: string; workspaceIncarnation: number; indeterminate: { operationId: string; resourceId: string }[]; acceptedNotAdmitted: string[] } | null;
  resources: { id: string; kind: string; generation: number; status: string; identityDigest: string | null }[];
  auditFile: string | null;
  managed: { root: string; files: Record<string, string> } | null;
  brokerAvailable: boolean;
}

const FINAL = "('succeeded','failed_no_effect','cancelled_no_effect','expired_no_effect','rejected')";

function v03Meta(osFile: string): { storeUUID: string; installId: string | null; incarnation: number | null; hasSystem: boolean } | null {
  const db = new DatabaseSync(osFile, { readOnly: true });
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'system_actions'").get();
    if (!has) return null;
    const m = db.prepare("SELECT store_uuid, broker_install_id, workspace_incarnation FROM meta WHERE id = 1").get() as { store_uuid: string; broker_install_id: string | null; workspace_incarnation: number | null };
    const any = !!db.prepare("SELECT 1 FROM system_actions LIMIT 1").get() || !!db.prepare("SELECT 1 FROM provider_grants WHERE sync_state <> 'local' LIMIT 1").get();
    return { storeUUID: m.store_uuid, installId: m.broker_install_id, incarnation: m.workspace_incarnation, hasSystem: any };
  } finally {
    db.close();
  }
}

/** Copy the broker's facts for operations this workspace knows into its business copy (spec §23.2 step 3). */
export function applyBrokerFacts(osFile: string, ops: BrokerOperation[]): number {
  const db = new DatabaseSync(osFile);
  let n = 0;
  try {
    db.exec("BEGIN IMMEDIATE");
    const now = new Date().toISOString();
    for (const op of ops) {
      const a = db.prepare("SELECT id, state FROM system_actions WHERE operation_id = ?").get(op.operationId) as { id: string; state: string } | undefined;
      if (!a) continue;
      const finals = ["succeeded", "failed_no_effect", "cancelled_no_effect", "expired_no_effect", "rejected"];
      if (finals.includes(a.state) || a.state === "indeterminate") continue;
      const map: Record<string, string> = { accepted: "dispatching", running: "running", reconciling: "reconciling" };
      const next = map[op.state] ?? op.state;
      db.prepare(
        "UPDATE system_actions SET state = ?, completion_kind = ?, effect_certainty = ?, evidence_kind = ?, result_json = ?, evidence_json = ?, error_json = ?, broker_seq = ?, updated_at = ? WHERE id = ?",
      ).run(next, op.completionKind, op.effectCertainty, op.evidenceKind, op.result == null ? null : JSON.stringify(op.result), op.evidence == null ? null : JSON.stringify(op.evidence), op.error ? JSON.stringify(op.error) : null, op.updatedSeq, now, a.id);
      if (finals.includes(next) || next === "indeterminate") db.prepare("UPDATE system_outbox SET dispatch_state = 'final', updated_at = ? WHERE operation_id = ?").run(now, op.operationId);
      n++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    db.close();
  }
  return n;
}

async function historyAll(client: BrokerClient, installId: string): Promise<{ ops: BrokerOperation[]; lastSeq: number }> {
  let since = 0;
  const ops: BrokerOperation[] = [];
  for (let i = 0; i < 100; i++) {
    const h = await client.historySync(installId, since, 200);
    ops.push(...h.operations);
    if (h.operations.length < 200 || h.lastSeq <= since) return { ops, lastSeq: h.lastSeq };
    since = h.lastSeq;
  }
  return { ops, lastSeq: since };
}

function readPolicyManagedRoot(storeUUID: string): string | null {
  try {
    const p = JSON.parse(fs.readFileSync("/etc/agentos/broker/policy.json", "utf8")) as { managedRoots?: { storeUuid: string; path: string }[] };
    return p.managedRoots?.find((m) => m.storeUuid === storeUUID)?.path ?? null;
  } catch {
    return null;
  }
}

function sha256File(f: string): string {
  return createHash("sha256").update(fs.readFileSync(f)).digest("hex");
}

/**
 * Backup steps 2–4 of spec §23.2. Returns the facts for the manifest and a function that ends the quiesce, which the
 * caller runs after the backup is marked complete (or failed).
 */
export async function quiesceForBackup(osFile: string, out: string, socket?: string): Promise<{ facts: V03BackupFacts | null; release: () => Promise<void> }> {
  const meta = v03Meta(osFile);
  if (!meta) return { facts: null, release: async () => undefined };
  const facts: V03BackupFacts = { providerCatalogHash: `sha256:${sha256Hex(canonicalJson(CAPABILITIES))}`, policyVersion: null, checkpoint: null, resources: [], auditFile: null, managed: null, brokerAvailable: false };
  const db = new DatabaseSync(osFile, { readOnly: true });
  try {
    facts.resources = (db.prepare("SELECT id, kind, generation, status, identity_digest AS identityDigest FROM system_resources ORDER BY id").all() as never[]) ?? [];
    facts.policyVersion = (db.prepare("SELECT provider_policy_version AS v FROM meta WHERE id = 1").get() as { v: string | null }).v;
  } finally {
    db.close();
  }
  let client: BrokerClient | null = null;
  let identity: { machineInstallId: string; storeUuid: string; workspaceIncarnation: number } | null = null;
  if (meta.installId && meta.incarnation !== null) {
    client = new BrokerClient({ storeUuid: meta.storeUUID, socketPath: socket, timeoutMs: 70_000 });
    try {
      const hs = await client.handshake({ machineInstallId: meta.installId, workspaceIncarnation: meta.incarnation });
      if (hs.brokerReady && hs.machineInstallId === meta.installId && hs.workspaceIncarnation === meta.incarnation) {
        identity = { machineInstallId: meta.installId, storeUuid: meta.storeUUID, workspaceIncarnation: meta.incarnation };
      }
    } catch {
      client.close();
      client = null;
    }
  }
  if (!client || !identity) {
    if (meta.hasSystem) throw new Error("the broker is needed for a consistent backup of a workspace with system operations (quiesce + checkpoint); it is unavailable or its identity does not match");
    return { facts, release: async () => undefined };
  }
  facts.brokerAvailable = true;
  const q = await client.quiesce(identity, "workspace backup", 60_000).catch((e: Error) => {
    throw new Error(`broker quiesce did not complete (${e.message}); the workspace stays quiesced and no consistent backup was made`);
  });
  if (!q.fileWorkerIdle) throw new Error("the file worker is still writing managed files; no consistent backup was made");
  const release = async () => {
    try {
      await client!.resume(identity!);
    } finally {
      client!.close();
    }
  };
  try {
    const h = await historyAll(client, identity.machineInstallId);
    applyBrokerFacts(osFile, h.ops);
    facts.checkpoint = { seq: q.checkpointSeq, machineInstallId: q.machineInstallId, workspaceIncarnation: q.workspaceIncarnation, indeterminate: q.indeterminate, acceptedNotAdmitted: q.acceptedNotAdmitted };
    // Audit export: this workspace's system actions as recorded (no file content).
    fs.mkdirSync(path.join(out, "system"), { recursive: true, mode: 0o700 });
    const adb = new DatabaseSync(osFile, { readOnly: true });
    try {
      const rows = adb.prepare("SELECT id, origin, app_id, run_id, capability_id, resource_id, resource_generation, state, operation_id, completion_kind, effect_certainty, evidence_kind, error_json, resolution_json, created_at, updated_at FROM system_actions ORDER BY created_at").all();
      fs.writeFileSync(path.join(out, "system", "audit.json"), JSON.stringify({ checkpoint: facts.checkpoint, actions: rows, brokerOperations: h.ops.map((o) => ({ operationId: o.operationId, state: o.state, capabilityId: o.capabilityId, effectCertainty: o.effectCertainty, incarnation: o.incarnation })) }, null, 2), { mode: 0o600 });
    } finally {
      adb.close();
    }
    facts.auditFile = "system/audit.json";
    // Managed files: a content snapshot (only usable later as input to a new restore plan).
    const root = readPolicyManagedRoot(meta.storeUUID);
    if (root && fs.existsSync(root)) {
      const files: Record<string, string> = {};
      const dst = path.join(out, "managed");
      // an empty managed directory is still recorded (as an empty snapshot), so the manifest never names a missing path
      fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
      const walk = (rel: string) => {
        for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.name.startsWith(".aos-tmp-")) continue;
          if (e.isDirectory()) walk(r);
          else if (e.isFile()) {
            fs.mkdirSync(path.dirname(path.join(dst, r)), { recursive: true, mode: 0o700 });
            fs.copyFileSync(path.join(root, r), path.join(dst, r));
            files[r] = sha256File(path.join(dst, r));
          }
        }
      };
      walk("");
      facts.managed = { root: "managed", files };
    }
  } catch (e) {
    await release().catch(() => undefined);
    throw e;
  }
  return { facts, release };
}

/** Restore steps 2 and 4–6 of spec §23.3. */
export async function brokerRestore(dataDir: string, src: string, facts: V03BackupFacts | undefined, socket?: string): Promise<{ beforeMarkerRemoval: () => void; complete: () => Promise<void>; incarnation: number | null }> {
  const backupOs = path.join(src, "os.sqlite");
  const meta = fs.existsSync(backupOs) ? v03Meta(backupOs) : null;
  if (!meta) return { beforeMarkerRemoval: () => undefined, complete: async () => undefined, incarnation: null };
  const sidecar = path.join(dataDir, "restore-broker.json");
  let reqId: string;
  if (fs.existsSync(sidecar)) {
    const s = JSON.parse(fs.readFileSync(sidecar, "utf8")) as { backup: string; restoreRequestId: string };
    if (s.backup !== src) throw new Error(`an interrupted restore from ${s.backup} must be finished first`);
    reqId = s.restoreRequestId;
  } else {
    reqId = `rr_${randomBytes(12).toString("hex")}`;
    fs.writeFileSync(sidecar, JSON.stringify({ backup: src, restoreRequestId: reqId }), { mode: 0o600 });
  }
  const client = new BrokerClient({ storeUuid: meta.storeUUID, socketPath: socket, timeoutMs: 70_000 });
  let hs;
  try {
    hs = await client.handshake({ machineInstallId: null, workspaceIncarnation: null });
  } catch (e) {
    client.close();
    if (meta.hasSystem || (facts?.checkpoint ?? null)) throw new Error(`the broker is needed to fence the old workspace incarnation before restoring (${(e as Error).message})`);
    return { beforeMarkerRemoval: () => undefined, complete: async () => undefined, incarnation: null };
  }
  if (!hs.brokerReady) {
    client.close();
    if (meta.hasSystem) throw new Error("the broker log is unavailable; system history cannot be fenced, restore refused");
    return { beforeMarkerRemoval: () => undefined, complete: async () => undefined, incarnation: null };
  }
  const installId = hs.machineInstallId;
  // Idempotent per restoreRequestId: a re-run returns the same session and never advances again.
  const session = await client.restoreBegin(installId, reqId, meta.incarnation);
  const history = await historyAll(client, installId);
  const target = session.targetIncarnation;
  const beforeMarkerRemoval = () => {
    const osFile = path.join(dataDir, "os.sqlite");
    const known = new Map(history.ops.map((o) => [o.operationId, o]));
    const db = new DatabaseSync(osFile);
    try {
      db.exec("BEGIN IMMEDIATE");
      const now = new Date().toISOString();
      db.prepare("UPDATE meta SET broker_install_id = ?, workspace_incarnation = ?, broker_binding_state = 'bound' WHERE id = 1").run(installId, target);
      // Undispatched plans are void; they need a new plan and a new confirmation.
      db.prepare(`UPDATE system_actions SET state = 'expired_no_effect', effect_certainty = 'none', evidence_kind = 'restored_unconfirmed', error_json = ?, updated_at = ? WHERE state = 'awaiting_approval'`).run(JSON.stringify({ code: "WORKSPACE_FENCED", message: "restored from a backup: the plan must be made and confirmed again" }), now);
      const open = db.prepare(`SELECT id, operation_id, state FROM system_actions WHERE state NOT IN ${FINAL} AND state <> 'indeterminate' AND operation_id IS NOT NULL`).all() as { id: string; operation_id: string; state: string }[];
      for (const a of open) {
        const op = known.get(a.operation_id);
        if (op) {
          const map: Record<string, string> = { accepted: "cancelled_no_effect", running: "indeterminate", reconciling: "indeterminate" };
          const next = map[op.state] ?? op.state;
          db.prepare("UPDATE system_actions SET state = ?, completion_kind = ?, effect_certainty = ?, evidence_kind = ?, result_json = ?, evidence_json = ?, error_json = ?, broker_seq = ?, updated_at = ? WHERE id = ?").run(
            next, op.completionKind, op.effectCertainty ?? (next === "indeterminate" ? "unknown" : null), op.evidenceKind ?? "broker_history", op.result == null ? null : JSON.stringify(op.result), op.evidence == null ? null : JSON.stringify(op.evidence), op.error ? JSON.stringify(op.error) : null, op.updatedSeq, now, a.id,
          );
        } else {
          // The broker never accepted it, and the old incarnation is fenced: it can never execute.
          db.prepare("UPDATE system_actions SET state = 'cancelled_no_effect', effect_certainty = 'none', evidence_kind = 'fenced_by_restore', error_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ code: "WORKSPACE_FENCED", message: "the old incarnation was fenced by the restore before this was delivered" }), now, a.id);
        }
      }
      db.prepare("UPDATE system_actions SET state = 'expired_no_effect', effect_certainty = 'none', evidence_kind = 'fenced_by_restore', updated_at = ? WHERE state = 'ready' AND operation_id IS NULL").run(now);
      db.prepare("UPDATE system_outbox SET dispatch_state = 'fenced', updated_at = ? WHERE dispatch_state <> 'final'").run(now);
      // Provider grants are void by default after a restore; the user reconnects after re-checking resources.
      db.prepare("UPDATE provider_grants SET sync_state = 'revoked', revoked_at = COALESCE(revoked_at, ?) WHERE revoked_at IS NULL OR sync_state <> 'revoked'").run(now);
      db.prepare("UPDATE provider_grant_outbox SET dispatch_state = 'failed', broker_result = ?, updated_at = ? WHERE dispatch_state IN ('pending','sent')").run(JSON.stringify({ code: "WORKSPACE_FENCED" }), now);
      db.prepare("UPDATE provider_event_cursors SET quality = 'gap'").run();
      db.prepare("INSERT INTO events (kind, payload_json, created_at) VALUES ('workspace.restored', ?, ?)").run(JSON.stringify({ restoreRequestId: reqId, previousIncarnation: session.previousIncarnation, targetIncarnation: target, sourceIncarnation: meta.incarnation }), now);
      db.exec("COMMIT");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    } finally {
      db.close();
    }
  };
  const complete = async () => {
    try {
      await client.restoreComplete(installId, reqId);
      fs.rmSync(sidecar, { force: true });
    } finally {
      client.close();
    }
  };
  return { beforeMarkerRemoval, complete, incarnation: target };
}
