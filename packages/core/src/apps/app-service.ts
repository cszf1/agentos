import { randomUUID } from "node:crypto";
import {
  AgentOsError,
  LIMITS,
  anyBundleHash,
  checkAnyCompatibility,
  checkAnySemantics,
  checkAnyStructure,
  growContract,
  normalizeAny,
  utf8Bytes,
  validateAnyBundle,
  type AnyBundle,
  type AppBundle,
  type ExtraBundleCheck,
  type AppDetail,
  type AppSummary,
  type DataContract,
  type RevisionSummary,
  type ValidationIssue, isCodeBundle } from "@agentos/contracts";
import { iso, type Store } from "../persistence/store.js";
import { fault } from "../faults.js";

export interface AppRow {
  id: string;
  active_revision_id: string | null;
  epoch: number;
  data_epoch: number;
  contract_json: string;
  created_at: string;
  updated_at: string;
}

export interface RevisionRow {
  app_id: string;
  id: string;
  bundle_json: string;
  created_by_run_id: string | null;
  created_at: string;
  first_activated_at: string | null;
}

export interface ActivateResult {
  appId: string;
  revisionId: string;
  appEpoch: number;
  changed: boolean;
}

/** Error code for a structurally invalid bundle of either format (spec §19.2). */
export function structuralErrorCode(input: unknown, issues: ValidationIssue[]): "INVALID_BUNDLE" | "INVALID_CODE_BUNDLE" | "SOURCE_PATH_INVALID" {
  const v2 = input !== null && typeof input === "object" && [2, 3].includes((input as { formatVersion?: unknown }).formatVersion as number);
  if (!v2) return "INVALID_BUNDLE";
  return issues.length > 0 && issues.every((i) => i.code === "SOURCE_PATH_INVALID") ? "SOURCE_PATH_INVALID" : "INVALID_CODE_BUNDLE";
}

export class AppService {
  /** Host-supplied checks for code bundles (runtime catalog and approved imports). */
  extraCheck: ExtraBundleCheck | undefined;
  constructor(private readonly store: Store, extraCheck?: ExtraBundleCheck) {
    this.extraCheck = extraCheck;
  }

  private now(): string {
    return iso(this.store.clock.now());
  }

  getAppRow(appId: string): AppRow | undefined {
    return this.store.get<AppRow>("SELECT * FROM apps WHERE id = ?", appId);
  }

  requireApp(appId: string): AppRow {
    const row = this.getAppRow(appId);
    if (!row) throw new AgentOsError("NOT_FOUND", "app not found", { appId });
    return row;
  }

  getRevisionRow(appId: string, revisionId: string): RevisionRow | undefined {
    return this.store.get<RevisionRow>("SELECT * FROM revisions WHERE app_id = ? AND id = ?", appId, revisionId);
  }

  contractOf(row: AppRow): DataContract {
    return JSON.parse(row.contract_json) as DataContract;
  }

  activeBundle(row: AppRow): AnyBundle | null {
    if (row.active_revision_id === null) return null;
    const rev = this.getRevisionRow(row.id, row.active_revision_id);
    return rev ? (JSON.parse(rev.bundle_json) as AnyBundle) : null;
  }

  revisionBundle(appId: string, revisionId: string): AnyBundle | null {
    const rev = this.getRevisionRow(appId, revisionId);
    return rev ? (JSON.parse(rev.bundle_json) as AnyBundle) : null;
  }

  /** Placeholder created when a run starts building a new app (epoch 0, empty contract). Inside a tx. */
  createPlaceholder(): string {
    // The hidden system_plan placeholder (runs.target_app_id) does not count as an app.
    const count = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM apps WHERE id <> '00000000-0000-4000-8000-0000000005a5'")!.n;
    if (count >= LIMITS.maxApps) throw new AgentOsError("LIMIT_EXCEEDED", `workspace holds at most ${LIMITS.maxApps} apps`);
    const id = randomUUID();
    const now = this.now();
    this.store.run(
      "INSERT INTO apps (id, active_revision_id, epoch, contract_json, created_at, updated_at) VALUES (?, NULL, 0, ?, ?, ?)",
      id,
      JSON.stringify({ fields: {} }),
      now,
      now,
    );
    this.store.event("app.created", { appId: id }, { appId: id });
    return id;
  }

  listApps(): AppSummary[] {
    const rows = this.store.all<AppRow>("SELECT * FROM apps WHERE active_revision_id IS NOT NULL ORDER BY created_at ASC, id ASC");
    return rows.map((r) => {
      const b = this.activeBundle(r);
      return { appId: r.id, title: b?.manifest.title ?? "(untitled)", appEpoch: r.epoch, activeRevisionId: r.active_revision_id, draft: false };
    });
  }

  getApp(appId: string): AppDetail {
    return this.store.read(() => {
      const row = this.requireApp(appId);
      const bundle = this.activeBundle(row);
      return {
        appId,
        appEpoch: row.epoch,
        activeRevisionId: row.active_revision_id,
        draft: row.active_revision_id === null,
        bundle,
        contract: this.contractOf(row),
      };
    });
  }

  listRevisions(appId: string): RevisionSummary[] {
    return this.store.read(() => {
      const app = this.requireApp(appId);
      const rows = this.store.all<RevisionRow>(
        "SELECT * FROM revisions WHERE app_id = ? AND first_activated_at IS NOT NULL ORDER BY first_activated_at ASC, id ASC LIMIT ?",
        appId,
        LIMITS.maxRevisionsPerApp,
      );
      return rows.map((r) => ({
        revisionId: r.id,
        title: (JSON.parse(r.bundle_json) as AnyBundle).manifest.title,
        runtime: (JSON.parse(r.bundle_json) as AnyBundle).manifest.runtime,
        createdAt: r.created_at,
        firstActivatedAt: r.first_activated_at!,
        isActive: app.active_revision_id === r.id,
      }));
    });
  }

  /**
   * Store an immutable candidate (inside a tx). Structural problems are not stored.
   * Returns the revision id and the semantic/compat issues found now.
   */
  stage(appId: string, input: unknown, runId: string | null): { revisionId: string; issues: ValidationIssue[] } {
    const app = this.requireApp(appId);
    const s = checkAnyStructure(input);
    if (!s.ok) throw new AgentOsError(structuralErrorCode(input, s.issues), "bundle failed schema validation", { issues: s.issues });
    const bundle = normalizeAny(s.bundle);
    if (bundle.manifest.appId !== appId) {
      throw new AgentOsError(isCodeBundle(bundle) ? "INVALID_CODE_BUNDLE" : "INVALID_BUNDLE", "manifest.appId must equal the bound target app", {
        issues: [{ path: "/manifest/appId", code: "APP_ID_MISMATCH", message: `expected ${appId}` }],
      });
    }
    const revisionId = anyBundleHash(bundle);
    const existing = this.getRevisionRow(appId, revisionId);
    if (!existing) {
      const n = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM revisions WHERE app_id = ?", appId)!.n;
      if (n >= LIMITS.maxRevisionsPerApp) throw new AgentOsError("LIMIT_EXCEEDED", `at most ${LIMITS.maxRevisionsPerApp} revisions per app`);
      this.store.run(
        "INSERT INTO revisions (app_id, id, bundle_json, created_by_run_id, created_at, first_activated_at) VALUES (?, ?, ?, ?, ?, NULL)",
        appId,
        revisionId,
        JSON.stringify(bundle),
        runId,
        this.now(),
      );
      this.store.event("revision.staged", { appId, revisionId }, { appId, runId });
    }
    const mode = existing?.first_activated_at ? "historical" : "candidate";
    const issues = [...checkAnySemantics(bundle, appId, this.extraCheck), ...checkAnyCompatibility(bundle, this.contractOrNull(app), mode)];
    return { revisionId, issues };
  }

  /** Re-check a stored revision against the current contract (no state change). */
  validate(appId: string, revisionId: string): { valid: boolean; issues: ValidationIssue[]; mode: "candidate" | "historical" } {
    const app = this.requireApp(appId);
    const rev = this.getRevisionRow(appId, revisionId);
    if (!rev) throw new AgentOsError("NOT_FOUND", "revision not found", { revisionId });
    const mode = rev.first_activated_at ? "historical" : "candidate";
    const r = validateAnyBundle(JSON.parse(rev.bundle_json), appId, this.contractOrNull(app), mode, this.extraCheck);
    return { valid: r.issues.length === 0, issues: r.issues, mode };
  }

  private contractOrNull(app: AppRow): DataContract | null {
    const c = this.contractOf(app);
    return Object.keys(c.fields).length === 0 ? null : c;
  }

  /**
   * Activation body (spec §8). Must run inside the caller's transaction, after the caller checked
   * identity, receipt and fences. Throws on any failure so the whole transaction rolls back.
   */
  /** Set by the system-capabilities layer; throws when the app may not change version right now. */
  activationGate: ((appId: string) => void) | null = null;

  activateInTx(appId: string, revisionId: string, expectedAppEpoch: number, opts: { historicalOnly: boolean; runId: string | null }): ActivateResult {
    const s = this.store;
    const app = this.requireApp(appId);
    if (app.epoch !== expectedAppEpoch) {
      throw new AgentOsError("APP_EPOCH_STALE", "the app changed since this request was prepared", { appEpoch: app.epoch });
    }
    const rev = this.getRevisionRow(appId, revisionId);
    if (!rev) throw new AgentOsError("NOT_FOUND", "revision not found", { revisionId });
    const historical = rev.first_activated_at !== null;
    if (opts.historicalOnly && !historical) {
      throw new AgentOsError("NOT_FOUND", "only previously activated revisions can be switched to", { revisionId });
    }
    if (app.active_revision_id === revisionId) {
      return { appId, revisionId, appEpoch: app.epoch, changed: false };
    }
    // v0.3 (spec §8.3, §11.4): pending system operations and unconfirmed provider-grant revocations block a switch.
    this.activationGate?.(appId);
    const mode = historical ? "historical" : "candidate";
    const raw = JSON.parse(rev.bundle_json) as unknown;
    const checked = validateAnyBundle(raw, appId, this.contractOrNull(app), mode, this.extraCheck);
    if (!checked.structural) throw new AgentOsError(structuralErrorCode(raw, checked.issues), "stored revision failed schema validation", { issues: checked.issues });
    if (checked.issues.length > 0) {
      const incompatible = checked.issues.some((i) => i.code === "SCHEMA_INCOMPATIBLE");
      const code = incompatible ? "SCHEMA_INCOMPATIBLE" : (checked.bundle && isCodeBundle(checked.bundle)) ? "INVALID_CODE_BUNDLE" : "INVALID_BUNDLE";
      throw new AgentOsError(code, "revision is not valid for this app", { issues: checked.issues });
    }
    const bundle = checked.bundle!;
    const now = this.now();
    let contract = this.contractOf(app);
    if (!historical) {
      const grown = growContract(this.contractOrNull(app), bundle as AppBundle);
      contract = grown.contract;
      let backfilled = false;
      if (grown.added.length > 0 && app.active_revision_id !== null) {
        const rows = s.all<{ id: string; version: number; data_json: string }>("SELECT id, version, data_json FROM records WHERE app_id = ?", appId);
        if (rows.length > LIMITS.maxRecordsPerApp) throw new AgentOsError("LIMIT_EXCEEDED", "too many records");
        for (const r of rows) {
          const data = JSON.parse(r.data_json) as Record<string, unknown>;
          let changed = false;
          for (const k of grown.added) {
            if (!Object.hasOwn(data, k)) {
              data[k] = contract.fields[k]!.default;
              changed = true;
            }
          }
          if (!changed) continue;
          const text = JSON.stringify(data);
          if (utf8Bytes(text) > LIMITS.maxRecordBytes) {
            throw new AgentOsError("LIMIT_EXCEEDED", `record ${r.id} would exceed ${LIMITS.maxRecordBytes} bytes`, { recordId: r.id });
          }
          s.run("UPDATE records SET data_json = ?, version = version + 1, updated_at = ? WHERE app_id = ? AND id = ?", text, now, appId, r.id);
          backfilled = true;
        }
      }
      // Spec §8: a default-value backfill that really changed records bumps data_epoch once.
      if (backfilled) s.run("UPDATE apps SET data_epoch = data_epoch + 1 WHERE id = ?", appId);
    }
    const newEpoch = app.epoch + 1;
    s.run(
      "UPDATE apps SET contract_json = ?, active_revision_id = ?, epoch = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(contract),
      revisionId,
      newEpoch,
      now,
      appId,
    );
    if (!historical) s.run("UPDATE revisions SET first_activated_at = ? WHERE app_id = ? AND id = ?", now, appId, revisionId);
    fault("activate.before_commit");
    s.event("app.activated", { appId, revisionId, appEpoch: newEpoch, from: app.active_revision_id }, { appId, runId: opts.runId });
    return { appId, revisionId, appEpoch: newEpoch, changed: true };
  }

  /** Test-only seeding entry (not exposed over HTTP in production). */
  seedActivated(bundle: AnyBundle): ActivateResult {
    return this.store.tx(() => {
      const appId = bundle.manifest.appId;
      if (!this.getAppRow(appId)) {
        const now = this.now();
        this.store.run(
          "INSERT INTO apps (id, active_revision_id, epoch, contract_json, created_at, updated_at) VALUES (?, NULL, 0, ?, ?, ?)",
          appId,
          JSON.stringify({ fields: {} }),
          now,
          now,
        );
      }
      const { revisionId } = this.stage(appId, bundle, null);
      const app = this.requireApp(appId);
      return this.activateInTx(appId, revisionId, app.epoch, { historicalOnly: false, runId: null });
    });
  }
}
