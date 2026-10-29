import { AgentOsError } from "@agentos/contracts";
import { iso, type Store } from "../persistence/store.js";

export type TargetKind = "app" | "service" | "conversation" | "workspace" | "resource";
export type OwnerKind = "run" | "job" | "user" | "compaction" | "archive";

export interface LeaseRow {
  target_kind: TargetKind;
  target_id: string;
  owner_kind: OwnerKind;
  owner_id: string;
  lease_epoch: number;
  expected_version: number | null;
  state: "held" | "reclaiming" | "released" | "unknown";
  deadline_at: string;
}

/**
 * Durable target leases (spec §8.2). One conflicting holder per target (unique partial index). A lease that passed its
 * deadline only means "reclaim and check": it is never released by TTL alone, and a lease whose owner's external result
 * is unknown stays `unknown` until reconciled. Acquisition order is workspace barrier → target → execution resource.
 */
export class TargetLeases {
  constructor(private readonly store: Store) {}

  private now(): string {
    return iso(this.store.clock.now());
  }

  holder(kind: TargetKind, id: string): LeaseRow | undefined {
    return this.store.get<LeaseRow>("SELECT * FROM target_leases WHERE target_kind = ? AND target_id = ? AND state IN ('held','reclaiming','unknown')", kind, id);
  }

  /** Inside a tx: take the lease or report the current holder. Re-entrant for the same owner. */
  tryAcquire(kind: TargetKind, id: string, owner: { kind: OwnerKind; id: string }, ttlMs: number, expectedVersion: number | null = null): { ok: true; epoch: number } | { ok: false; holder: LeaseRow } {
    const cur = this.holder(kind, id);
    if (cur) {
      if (cur.owner_kind === owner.kind && cur.owner_id === owner.id) return { ok: true, epoch: cur.lease_epoch };
      return { ok: false, holder: cur };
    }
    const prev = this.store.get<{ e: number | null }>("SELECT MAX(lease_epoch) AS e FROM target_leases WHERE target_kind = ? AND target_id = ?", kind, id)?.e ?? 0;
    const epoch = prev + 1;
    const now = this.store.clock.now();
    this.store.run(
      `INSERT INTO target_leases (target_kind, target_id, owner_kind, owner_id, lease_epoch, expected_version, state, deadline_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'held', ?, ?, ?)
       ON CONFLICT (target_kind, target_id, owner_kind, owner_id) DO UPDATE SET lease_epoch = excluded.lease_epoch, expected_version = excluded.expected_version,
         state = 'held', deadline_at = excluded.deadline_at, updated_at = excluded.updated_at`,
      kind, id, owner.kind, owner.id, epoch, expectedVersion, iso(now + ttlMs), iso(now), iso(now),
    );
    return { ok: true, epoch };
  }

  acquireOrThrow(kind: TargetKind, id: string, owner: { kind: OwnerKind; id: string }, ttlMs: number, expectedVersion: number | null = null): number {
    const r = this.tryAcquire(kind, id, owner, ttlMs, expectedVersion);
    if (!r.ok) throw new AgentOsError("TARGET_BUSY", `${kind} ${id} is held by ${r.holder.owner_kind} ${r.holder.owner_id}`, { holder: { kind: r.holder.owner_kind, id: r.holder.owner_id } });
    return r.epoch;
  }

  release(kind: TargetKind, id: string, owner: { kind: OwnerKind; id: string }): void {
    this.store.run("UPDATE target_leases SET state = 'released', updated_at = ? WHERE target_kind = ? AND target_id = ? AND owner_kind = ? AND owner_id = ? AND state <> 'released'", this.now(), kind, id, owner.kind, owner.id);
  }

  releaseOwner(owner: { kind: OwnerKind; id: string }): void {
    this.store.run("UPDATE target_leases SET state = 'released', updated_at = ? WHERE owner_kind = ? AND owner_id = ? AND state <> 'released'", this.now(), owner.kind, owner.id);
  }

  /** The owner's outcome is unknown: keep the target fenced until reconciliation (never TTL-released). */
  markUnknown(owner: { kind: OwnerKind; id: string }): void {
    this.store.run("UPDATE target_leases SET state = 'unknown', updated_at = ? WHERE owner_kind = ? AND owner_id = ? AND state IN ('held','reclaiming')", this.now(), owner.kind, owner.id);
  }

  /** Expired leases become `reclaiming`; the owner's controller must confirm the old executor stopped before release. */
  expired(): LeaseRow[] {
    this.store.run("UPDATE target_leases SET state = 'reclaiming', updated_at = ? WHERE state = 'held' AND deadline_at <= ?", this.now(), this.now());
    return this.store.all<LeaseRow>("SELECT * FROM target_leases WHERE state = 'reclaiming'");
  }

  /** After a confirmed reclaim: release with a raised epoch so a late holder can never use the old one. */
  reclaim(kind: TargetKind, id: string): void {
    this.store.run("UPDATE target_leases SET state = 'released', lease_epoch = lease_epoch + 1, updated_at = ? WHERE target_kind = ? AND target_id = ? AND state = 'reclaiming'", this.now(), kind, id);
  }

  list(): LeaseRow[] {
    return this.store.all<LeaseRow>("SELECT * FROM target_leases WHERE state <> 'released' ORDER BY target_kind, target_id");
  }
}
