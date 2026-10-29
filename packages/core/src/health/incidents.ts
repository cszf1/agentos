import { randomUUID } from "node:crypto";
import { V4_LIMITS, type IncidentState } from "@agentos/contracts";
import { iso, type Store } from "../persistence/store.js";

export type Quality = "fresh" | "stale" | "gap" | "unavailable";

export interface IncidentRow {
  id: string;
  target_kind: string;
  target_id: string;
  condition_key: string;
  episode_id: number;
  generation: number | null;
  quality: Quality;
  severity: "info" | "warning" | "critical";
  evidence_json: string;
  evidence_count: number;
  state: IncidentState;
  job_id: string | null;
  circuit: "closed" | "open";
  resolution_json: string | null;
  notified_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

export interface Sample {
  targetKind: string;
  targetId: string;
  condition: string;
  /** bad = condition holds; ok = healthy; unknown = could not tell */
  value: "bad" | "ok" | "unknown";
  quality: Quality;
  detail?: Record<string, unknown>;
  generation?: number | null;
}

const OPEN: IncidentState[] = ["open", "investigating", "mitigating", "needs_attention"];
const MAX_EVIDENCE = 20;

/**
 * Incidents (spec §12.2): one open episode per target + condition (unique index), evidence appended to it instead of
 * new incidents (event storms coalesce, V4-J04); resolution needs a NEW valid observation, kept apart from "the action
 * receipt succeeded". Samples are bounded (10 000 rows or 24 h); incidents, effects, approvals and cancels never age out.
 * Missing / unavailable / gap observations never count as "the resource stopped" (V4-H08).
 */
export class IncidentStore {
  /** notification hook (merged per incident, spec §22.2) */
  onNotify: ((kind: string, subject: string, severity: string, title: string, detail: string) => void) | null = null;

  constructor(private readonly store: Store) {}

  private now(): string {
    return iso(this.store.clock.now());
  }

  get(id: string): IncidentRow | undefined {
    return this.store.get<IncidentRow>("SELECT * FROM health_incidents WHERE id = ?", id);
  }

  open(kind: string, id: string, condition: string): IncidentRow | undefined {
    return this.store.get<IncidentRow>(`SELECT * FROM health_incidents WHERE target_kind = ? AND target_id = ? AND condition_key = ? AND state IN (${OPEN.map(() => "?").join(",")})`, kind, id, condition, ...OPEN);
  }

  list(opts: { open?: boolean; limit?: number } = {}): IncidentRow[] {
    return opts.open
      ? this.store.all<IncidentRow>(`SELECT * FROM health_incidents WHERE state IN (${OPEN.map(() => "?").join(",")}) ORDER BY last_seen_at DESC`, ...OPEN)
      : this.store.all<IncidentRow>(`SELECT * FROM health_incidents ORDER BY last_seen_at DESC LIMIT ${Math.min(opts.limit ?? 100, 500)}`);
  }

  /** Record one sample (bounded history). */
  sample(s: Sample): void {
    this.store.tx(() => {
      this.store.run(
        "INSERT INTO health_samples (target_kind, target_id, condition_key, value, quality, detail_json, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        s.targetKind, s.targetId, s.condition, s.value, s.quality, s.detail ? JSON.stringify(s.detail).slice(0, 2000) : null, this.now(),
      );
      const n = this.store.get<{ n: number; min: number }>("SELECT COUNT(*) AS n, MIN(seq) AS min FROM health_samples")!;
      if (n.n > V4_LIMITS.observationSamplesMax) this.store.run("DELETE FROM health_samples WHERE seq < ?", n.min + (n.n - V4_LIMITS.observationSamplesMax));
      this.store.run("DELETE FROM health_samples WHERE observed_at < ?", iso(this.store.clock.now() - V4_LIMITS.observationSamplesMs));
    });
  }

  /** The last `n` samples of a target/condition, newest first. */
  recent(kind: string, id: string, condition: string, n: number): { value: string; quality: Quality; observed_at: string; detail_json: string | null }[] {
    return this.store.all("SELECT value, quality, observed_at, detail_json FROM health_samples WHERE target_kind = ? AND target_id = ? AND condition_key = ? ORDER BY seq DESC LIMIT ?", kind, id, condition, n);
  }

  /** Open a new episode or append evidence to the open one; returns the incident and whether it is new. */
  raise(s: Sample & { severity?: IncidentRow["severity"]; evidence: Record<string, unknown> }): { incident: IncidentRow; created: boolean } {
    return this.store.tx(() => {
      const cur = this.open(s.targetKind, s.targetId, s.condition);
      const ev = { at: this.now(), quality: s.quality, ...s.evidence };
      if (cur) {
        const list = (JSON.parse(cur.evidence_json) as unknown[]).concat([ev]).slice(-MAX_EVIDENCE);
        this.store.run(
          "UPDATE health_incidents SET evidence_json = ?, evidence_count = evidence_count + 1, last_seen_at = ?, quality = ?, generation = COALESCE(?, generation) WHERE id = ?",
          JSON.stringify(list), this.now(), s.quality, s.generation ?? null, cur.id,
        );
        return { incident: this.get(cur.id)!, created: false };
      }
      const episode = (this.store.get<{ e: number | null }>("SELECT MAX(episode_id) AS e FROM health_incidents WHERE target_kind = ? AND target_id = ? AND condition_key = ?", s.targetKind, s.targetId, s.condition)?.e ?? 0) + 1;
      const id = randomUUID();
      this.store.run(
        `INSERT INTO health_incidents (id, target_kind, target_id, condition_key, episode_id, generation, quality, severity, evidence_json, state, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        id, s.targetKind, s.targetId, s.condition, episode, s.generation ?? null, s.quality, s.severity ?? "warning", JSON.stringify([ev]), this.now(), this.now(),
      );
      this.store.event("health.incident_opened", { incidentId: id, target: `${s.targetKind}:${s.targetId}`, condition: s.condition, episode }, s.targetKind === "app" ? { appId: s.targetId } : {});
      return { incident: this.get(id)!, created: true };
    });
  }

  setState(id: string, state: IncidentState, patch: { jobId?: string | null; circuit?: "open" | "closed" } = {}): void {
    this.store.tx(() => {
      this.store.run(
        "UPDATE health_incidents SET state = ?, job_id = COALESCE(?, job_id), circuit = COALESCE(?, circuit), last_seen_at = ? WHERE id = ? AND state NOT IN ('resolved','suppressed')",
        state, patch.jobId ?? null, patch.circuit ?? null, this.now(), id,
      );
    });
    if (state === "needs_attention") {
      const i = this.get(id);
      if (i) this.onNotify?.("incident", i.id, "critical", `需要处理：${i.target_kind} ${i.target_id} ${i.condition_key}`, i.circuit === "open" ? "自动恢复已熔断" : "自动维护无法解决");
    }
  }

  /** Resolve only with a fresh, valid observation taken after `notBefore` (the last effect). */
  resolve(id: string, evidence: Record<string, unknown>, observedAt: number, notBefore = 0): boolean {
    if (observedAt < notBefore) return false;
    return this.store.tx(() => {
      const r = this.store.run(
        "UPDATE health_incidents SET state = 'resolved', resolution_json = ?, resolved_at = ?, last_seen_at = ? WHERE id = ? AND state NOT IN ('resolved','suppressed')",
        JSON.stringify({ ...evidence, observedAt: iso(observedAt) }), this.now(), this.now(), id,
      );
      if (r.changes) this.store.event("health.incident_resolved", { incidentId: id }, {});
      return r.changes === 1;
    });
  }

  view(i: IncidentRow) {
    return {
      incidentId: i.id,
      target: { kind: i.target_kind, id: i.target_id },
      condition: i.condition_key,
      episode: i.episode_id,
      generation: i.generation,
      quality: i.quality,
      severity: i.severity,
      state: i.state,
      circuit: i.circuit,
      evidence: JSON.parse(i.evidence_json),
      evidenceCount: i.evidence_count,
      jobId: i.job_id,
      resolution: i.resolution_json ? JSON.parse(i.resolution_json) : null,
      firstSeenAt: i.first_seen_at,
      lastSeenAt: i.last_seen_at,
      resolvedAt: i.resolved_at,
      relatedJobs: this.store.all<{ id: string; state: string; created_at: string }>("SELECT id, state, created_at FROM maintenance_jobs WHERE incident_id = ? ORDER BY created_at DESC LIMIT 10", i.id),
    };
  }
}

/** Merged notifications (spec §22.2, V4-U04): one open notification per kind+subject; repeats raise its count. */
export class Notifications {
  constructor(private readonly store: Store) {}

  notify(kind: string, subject: string, severity: string, title: string, detail: string): void {
    const now = iso(this.store.clock.now());
    this.store.tx(() => {
      const r = this.store.run("UPDATE notifications SET count = count + 1, detail = ?, severity = ?, updated_at = ? WHERE kind = ? AND subject = ? AND state = 'open'", detail, severity, now, kind, subject);
      if (r.changes === 0) {
        this.store.run(
          "INSERT INTO notifications (id, kind, subject, severity, title, detail, count, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 'open', ?, ?)",
          randomUUID(), kind, subject, severity, title, detail, now, now,
        );
      }
    });
  }

  list(open = true) {
    return this.store.all(`SELECT id, kind, subject, severity, title, detail, count, state, created_at AS createdAt, updated_at AS updatedAt FROM notifications ${open ? "WHERE state = 'open'" : ""} ORDER BY updated_at DESC LIMIT 100`);
  }

  markRead(id: string): void {
    this.store.tx(() => this.store.run("UPDATE notifications SET state = 'read', updated_at = ? WHERE id = ?", iso(this.store.clock.now()), id));
  }
}
