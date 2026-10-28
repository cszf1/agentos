import { iso, type Store } from "../persistence/store.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { RuntimeDriver } from "../runtime/driver.js";

export interface GcPlan {
  artifacts: { id: string; sizeBytes: number; onDisk: boolean }[];
  unregisteredDirs: string[];
  staging: string[];
  images: string[];
  bytes: number;
  kept: { artifacts: number; reason: Record<string, number> };
}

/**
 * Bounded cache collection (spec §12.3). Only unreferenced content of this workspace is removed: artifacts of revisions
 * that were never activated and are not used by an open deployment, a live instance, an in-flight build or a backup;
 * leftover staging directories; and agentos platform images the current catalog no longer names. Marking happens in a
 * database transaction; files are deleted outside it. Never a global prune.
 */
export class GcService {
  constructor(
    private readonly store: Store,
    private readonly artifacts: ArtifactStore,
    private readonly driver: RuntimeDriver | null,
    private readonly catalogImages: () => string[],
    /** Artifact ids pinned by an in-progress backup. */
    private readonly pinned: () => Set<string> = () => new Set(),
  ) {}

  /** Referenced artifact ids with the reason each is kept. */
  referenced(): Map<string, string> {
    const s = this.store;
    const keep = new Map<string, string>();
    const add = (rows: { id: string }[], why: string) => rows.forEach((r) => !keep.has(r.id) && keep.set(r.id, why));
    add(s.all("SELECT DISTINCT ra.artifact_id AS id FROM revision_artifacts ra JOIN revisions r ON r.app_id = ra.app_id AND r.id = ra.revision_id WHERE r.first_activated_at IS NOT NULL"), "history");
    add(s.all("SELECT DISTINCT ra.artifact_id AS id FROM revision_artifacts ra JOIN apps a ON a.id = ra.app_id AND a.active_revision_id = ra.revision_id"), "active");
    add(s.all("SELECT DISTINCT artifact_id AS id FROM deployments WHERE artifact_id IS NOT NULL AND status IN ('queued','preparing','ready')"), "deployment");
    add(s.all("SELECT DISTINCT ra.artifact_id AS id FROM deployments d JOIN revision_artifacts ra ON ra.app_id = d.app_id AND ra.revision_id = d.target_revision_id WHERE d.status IN ('queued','preparing','ready')"), "deployment");
    add(s.all("SELECT DISTINCT artifact_id AS id FROM runtime_instances WHERE desired_state <> 'removed' OR observed_state IN ('starting','ready','serving','draining','unknown')"), "instance");
    add(s.all("SELECT DISTINCT artifact_id AS id FROM build_jobs WHERE artifact_id IS NOT NULL AND status IN ('queued','building')"), "build");
    for (const id of this.pinned()) if (!keep.has(id)) keep.set(id, "backup");
    return keep;
  }

  async plan(): Promise<GcPlan> {
    const s = this.store;
    const keep = this.referenced();
    const rows = s.all<{ id: string; size_bytes: number }>("SELECT id, size_bytes FROM artifacts");
    const registered = new Set(rows.map((r) => r.id));
    const scan = this.artifacts.scan();
    const plan: GcPlan = { artifacts: [], unregisteredDirs: [], staging: scan.staging, images: [], bytes: 0, kept: { artifacts: 0, reason: {} } };
    for (const r of rows) {
      const why = keep.get(r.id);
      if (why) {
        plan.kept.artifacts++;
        plan.kept.reason[why] = (plan.kept.reason[why] ?? 0) + 1;
        continue;
      }
      const onDisk = scan.artifacts.includes(r.id);
      plan.artifacts.push({ id: r.id, sizeBytes: r.size_bytes, onDisk });
      plan.bytes += r.size_bytes;
    }
    // Published directories with no database row (a crash between rename and registration).
    for (const id of scan.artifacts) if (!registered.has(id) && !keep.has(id)) plan.unregisteredDirs.push(id);
    if (this.driver) {
      try {
        const wanted = new Set(this.catalogImages());
        const list = await this.driver.listPlatformImages();
        for (const name of list) if (!wanted.has(name)) plan.images.push(name);
      } catch {
        /* engine unreachable: images are left alone */
      }
    }
    return plan;
  }

  /** Execute: re-check references inside the marking transaction, delete files outside it, then drop rows. */
  async run(opts: { includeImages?: boolean } = {}): Promise<GcPlan> {
    const plan = await this.plan();
    const s = this.store;
    const marked = s.tx(() => {
      const keep = this.referenced();
      const ids = plan.artifacts.map((a) => a.id).filter((id) => !keep.has(id));
      for (const id of ids) s.run("UPDATE artifacts SET gc_state = 'marked' WHERE id = ? AND gc_state <> 'marked'", id);
      return ids;
    });
    for (const id of marked) this.artifacts.remove(id);
    for (const id of plan.unregisteredDirs) this.artifacts.remove(id);
    for (const st of plan.staging) this.artifacts.removeStaging(st);
    s.tx(() => {
      for (const id of marked) {
        s.run("DELETE FROM revision_artifacts WHERE artifact_id = ?", id);
        s.run("UPDATE build_jobs SET artifact_id = NULL WHERE artifact_id = ? AND status NOT IN ('queued','building')", id);
        s.run("UPDATE deployments SET artifact_id = NULL WHERE artifact_id = ? AND status NOT IN ('queued','preparing','ready')", id);
        if (!s.get("SELECT 1 FROM runtime_instances WHERE artifact_id = ?", id)) s.run("DELETE FROM artifacts WHERE id = ?", id);
        else s.run("UPDATE artifacts SET gc_state = 'unavailable' WHERE id = ?", id);
      }
      if (marked.length > 0) s.event("cache.collected", { artifacts: marked.length, at: iso(s.clock.now()) }, {});
    });
    if (opts.includeImages && this.driver) {
      for (const name of plan.images) await this.driver.removeImage(name).catch(() => undefined);
    }
    return plan;
  }
}
