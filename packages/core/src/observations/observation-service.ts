import { randomBytes } from "node:crypto";
import { AgentOsError, SYSTEM_LIMITS, type ObservationQuality } from "@agentos/contracts";
import type { TelemetryClient } from "@agentos/broker-client";
import { iso, type Store } from "../persistence/store.js";

export type ObservationScope =
  | { kind: "app_call"; callId: string; appId: string; revisionId: string }
  | { kind: "run"; runId: string; toolTaskId: string | null }
  | { kind: "user" }
  /** v0.4: the host's maintenance controller (never the user) */
  | { kind: "maintenance"; jobId: string | null };

export interface ObservationRow {
  id: string;
  scope_kind: "app_call" | "run" | "user" | "maintenance";
  call_id: string | null;
  run_id: string | null;
  tool_task_id: string | null;
  principal_key: string;
  resource_id: string;
  resource_generation: number;
  capability_id: string;
  version: string | null;
  observed_at: string;
  expires_at: string;
  quality: ObservationQuality;
  summary_json: string;
}

/** Observations used as plan evidence live for a short, explicit time (spec §10). */
export const OBSERVATION_TTL_MS = 120_000;

export interface TelemetryState {
  available: boolean;
  reason: string | null;
  sourceEpoch: string | null;
  lastSeq: number;
  kernelDrops: number;
  userDrops: number;
  gap: boolean;
  lastGapReason: string | null;
  workloads: { workloadKey: string; kind: string; generation: number }[];
  objectSha256: string | null;
  counts: Record<string, { exec: number; exit: number; lastExitCode: number | null }>;
}

/**
 * ObservationStore + event cursors (spec §10, §18.2). Observations record who read what, when, and a trusted summary —
 * never full file or serial content. Event sources (inotify, D-Bus, udev, eBPF) only invalidate caches: a gap or
 * reconnect sets the cursor to `gap` and asks for a full re-read; a missing event never implies success.
 */
export class ObservationService {
  /** Called with the resource ids whose cached state must be re-read (gap, overflow, reconnect, probe change). */
  onRefreshNeeded: ((resourceIds: string[] | "all", reason: string) => void) | null = null;
  telemetry: TelemetryState = { available: false, reason: "not connected", sourceEpoch: null, lastSeq: 0, kernelDrops: 0, userDrops: 0, gap: true, lastGapReason: "not connected", workloads: [], objectSha256: null, counts: {} };
  #stopTelemetry: (() => void) | null = null;
  #telemetryRetry: NodeJS.Timeout | null = null;
  #telemetryOff = false;

  constructor(readonly store: Store) {}

  record(scope: ObservationScope, resource: { id: string; generation: number }, capabilityId: string, version: string | null, quality: ObservationQuality, summary: unknown): ObservationRow {
    const id = `obs_${randomBytes(12).toString("hex")}`;
    const now = this.store.clock.now();
    const pk = scope.kind === "app_call" ? `app:${scope.appId}:${scope.revisionId}` : scope.kind === "run" ? `run:${scope.runId}` : scope.kind === "maintenance" ? `maintenance:${scope.jobId ?? "monitor"}` : "user:local";
    let text = JSON.stringify(summary ?? null);
    if (text.length > 16 * 1024) text = JSON.stringify({ truncated: true, bytes: text.length });
    this.store.tx(() =>
      this.store.run(
        "INSERT INTO resource_observations (id, scope_kind, call_id, run_id, tool_task_id, principal_key, resource_id, resource_generation, capability_id, version, observed_at, expires_at, quality, summary_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id, scope.kind, scope.kind === "app_call" ? scope.callId : null, scope.kind === "run" ? scope.runId : null, scope.kind === "run" ? scope.toolTaskId : null,
        pk, resource.id, resource.generation, capabilityId, version, iso(now), iso(now + OBSERVATION_TTL_MS), quality, text,
      ),
    );
    return this.store.get<ObservationRow>("SELECT * FROM resource_observations WHERE id = ?", id)!;
  }

  get(id: string): ObservationRow | undefined {
    return this.store.get<ObservationRow>("SELECT * FROM resource_observations WHERE id = ?", id);
  }

  /**
   * Plan evidence (V3-C06): every id must exist, belong to the same scope (same top-level app callId, or the same
   * unfinished run), be unexpired and refer to the plan's resource at its current generation.
   */
  /**
   * Observations a plan rests on. Those of the target resource are its preconditions; observations of OTHER resources
   * (context the handler read in the same call, e.g. a service state written into a report) are accepted only from the
   * same call/run and the other resource's current generation, when `currentGeneration` can resolve it.
   */
  checkRefs(ids: string[], scope: ObservationScope, resource: { id: string; generation: number }, currentGeneration?: (resourceId: string) => number | undefined): ObservationRow[] {
    const out: ObservationRow[] = [];
    for (const id of ids) {
      const o = this.get(id);
      if (!o) throw new AgentOsError("INVALID_SYSTEM_PLAN", `observation ${id} does not exist`, { observationId: id });
      if (scope.kind === "app_call" && (o.scope_kind !== "app_call" || o.call_id !== scope.callId)) throw new AgentOsError("INVALID_SYSTEM_PLAN", `observation ${id} was not made in this call`, { observationId: id });
      if (scope.kind === "run" && (o.scope_kind !== "run" || o.run_id !== scope.runId)) throw new AgentOsError("INVALID_SYSTEM_PLAN", `observation ${id} does not belong to this run`, { observationId: id });
      if (scope.kind === "user" && o.scope_kind !== "user") throw new AgentOsError("INVALID_SYSTEM_PLAN", `observation ${id} is not a user observation`);
      if (Date.parse(o.expires_at) <= this.store.clock.now()) throw new AgentOsError("OBSERVATION_EXPIRED", `observation ${id} expired; read the resource again`, { observationId: id });
      const gen = o.resource_id === resource.id ? resource.generation : currentGeneration?.(o.resource_id);
      if (gen === undefined) throw new AgentOsError("INVALID_SYSTEM_PLAN", `observation ${id} is about another resource`, { observationId: id });
      if (o.resource_generation !== gen) throw new AgentOsError("RESOURCE_GENERATION_STALE", `observation ${id} is from an older resource generation`, { observationId: id });
      if (o.quality !== "fresh") throw new AgentOsError("OBSERVATION_GAP", `observation ${id} is ${o.quality}; read the resource again`, { observationId: id });
      out.push(o);
    }
    return out;
  }

  // ---------------------------------------------------------------- events & cursors

  cursor(source: string): { source: string; source_epoch: string | null; last_received_seq: number; drop_count: number; quality: ObservationQuality; last_refresh_at: string | null } | undefined {
    return this.store.get("SELECT * FROM provider_event_cursors WHERE source = ?", source);
  }

  /** Ingest one event from a source. Gaps and epoch changes mark the cursor and request a full re-read. */
  ingest(source: string, e: Record<string, unknown>): void {
    const epoch = typeof e.sourceEpoch === "string" ? e.sourceEpoch : null;
    const seq = typeof e.sourceSeq === "number" ? e.sourceSeq : 0;
    const gap = e.gap === true || e.type === "gap";
    const resourceId = typeof e.resourceId === "string" ? e.resourceId : null;
    const now = iso(this.store.clock.now());
    let refresh: { ids: string[] | "all"; reason: string } | null = null;
    this.store.tx(() => {
      const c = this.cursor(source);
      const epochChanged = !c || c.source_epoch !== epoch;
      const skipped = !epochChanged && c && seq > c.last_received_seq + 1;
      const quality: ObservationQuality = gap || epochChanged || skipped ? "gap" : "fresh";
      const drops = (c?.drop_count ?? 0) + (skipped ? seq - (c!.last_received_seq + 1) : 0);
      this.store.run(
        "INSERT INTO provider_event_cursors (source, source_epoch, last_received_seq, drop_count, quality, last_refresh_at) VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT(source) DO UPDATE SET source_epoch = excluded.source_epoch, last_received_seq = excluded.last_received_seq, drop_count = excluded.drop_count, quality = CASE WHEN excluded.quality = 'gap' THEN 'gap' ELSE provider_event_cursors.quality END",
        source, epoch, seq, drops, quality,
      );
      const payload = { ...e };
      delete payload.content;
      let text = JSON.stringify(payload);
      if (text.length > 2048) text = JSON.stringify({ kind: e.kind, truncated: true });
      const kind = String(e.kind ?? e.reason ?? e.type ?? "event");
      this.store.run(
        "INSERT INTO provider_events (source, source_epoch, resource_id, resource_generation, kind, bounded_payload, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        source, epoch, resourceId, null, gap ? `gap:${kind}` : kind, text, now,
      );
      if (quality === "gap") {
        refresh = { ids: resourceId ? [resourceId] : "all", reason: `${source}:${epochChanged ? "epoch" : skipped ? "sequence_gap" : kind}` };
        // Cached observations of the affected resources stop being usable as plan evidence.
        if (resourceId) this.store.run("UPDATE resource_observations SET quality = 'gap' WHERE resource_id = ? AND quality = 'fresh'", resourceId);
        else if (source === "telemetry") this.store.run("UPDATE resource_observations SET quality = 'gap' WHERE capability_id LIKE 'telemetry.%' AND quality = 'fresh'");
      } else if (resourceId) {
        // A change event invalidates cached state of that resource (never extends an observation's validity).
        this.store.run("UPDATE resource_observations SET quality = 'stale' WHERE resource_id = ? AND quality = 'fresh' AND capability_id NOT LIKE 'telemetry.%'", resourceId);
      }
    });
    if (refresh) this.onRefreshNeeded?.((refresh as { ids: string[] | "all" }).ids, (refresh as { reason: string }).reason);
    this.prune();
  }

  /** After a full re-read the cursor is fresh again. */
  markRefreshed(source: string): void {
    this.store.tx(() => this.store.run("UPDATE provider_event_cursors SET quality = 'fresh', last_refresh_at = ? WHERE source = ?", iso(this.store.clock.now()), source));
  }

  #pruneCounter = 0;
  prune(): void {
    if (++this.#pruneCounter % 200 !== 0) return;
    this.pruneNow();
  }

  /** Retention: at most 10000 events or 24 hours, whichever comes first (spec §24.1). */
  pruneNow(): void {
    const cutoff = iso(this.store.clock.now() - SYSTEM_LIMITS.observationRetentionMs);
    this.store.tx(() => {
      this.store.run("DELETE FROM provider_events WHERE observed_at < ?", cutoff);
      const n = this.store.get<{ n: number; minseq: number }>("SELECT count(*) AS n, MAX(seq) AS minseq FROM provider_events")!;
      if (n.n > SYSTEM_LIMITS.observationEvents) this.store.run("DELETE FROM provider_events WHERE seq <= ?", n.minseq - SYSTEM_LIMITS.observationEvents);
      this.store.run("DELETE FROM resource_observations WHERE expires_at < ?", iso(this.store.clock.now() - 3600 * 1000));
    });
  }

  events(sinceSeq: number, limit: number): { events: Record<string, unknown>[]; cursors: Record<string, unknown>[]; lastSeq: number; requiresFullReread: boolean } {
    const ev = this.store.all<{ seq: number; source: string; source_epoch: string | null; resource_id: string | null; kind: string; bounded_payload: string; observed_at: string }>(
      "SELECT * FROM provider_events WHERE seq > ? ORDER BY seq LIMIT ?", sinceSeq, Math.min(Math.max(limit, 1), 500),
    );
    const oldest = this.store.get<{ s: number | null }>("SELECT MIN(seq) AS s FROM provider_events")!.s ?? 0;
    const cursors = this.store.all<Record<string, unknown>>("SELECT * FROM provider_event_cursors ORDER BY source");
    const last = this.store.get<{ s: number | null }>("SELECT MAX(seq) AS s FROM provider_events")!.s ?? 0;
    return {
      events: ev.map((e) => ({ seq: e.seq, source: e.source, sourceEpoch: e.source_epoch, resourceId: e.resource_id, kind: e.kind, payload: JSON.parse(e.bounded_payload), observedAt: e.observed_at })),
      cursors,
      lastSeq: last,
      // The client asked from before the retained window or a cursor is in gap: drop deltas, re-read snapshots.
      requiresFullReread: (sinceSeq > 0 && sinceSeq + 1 < oldest) || cursors.some((c) => c.quality === "gap"),
    };
  }

  // ---------------------------------------------------------------- telemetry

  connectTelemetry(client: TelemetryClient, registerWorkloads: () => Promise<void>): void {
    if (this.#telemetryRetry) clearTimeout(this.#telemetryRetry);
    this.#telemetryOff = false;
    const start = async () => {
      if (this.#telemetryOff) return;
      try {
        const st = await client.status();
        if (this.#telemetryOff) return;
        this.#applyStatus(st);
        await registerWorkloads().catch(() => undefined);
      } catch (e) {
        this.telemetry = { ...this.telemetry, available: false, reason: (e as Error).message, gap: true, lastGapReason: "collector unreachable" };
        if (!this.#telemetryOff) this.#telemetryRetry = setTimeout(start, 10_000);
        return;
      }
      const c = this.cursor("telemetry");
      this.#stopTelemetry = client.subscribe(
        { sourceEpoch: c?.source_epoch ?? null, sinceSeq: c?.last_received_seq ?? 0 },
        (f) => this.#onTelemetry(f),
        (why) => {
          if (this.#telemetryOff) return;
          this.telemetry = { ...this.telemetry, available: false, reason: `subscription ended: ${why}`, gap: true, lastGapReason: "disconnected" };
          this.ingest("telemetry", { type: "gap", reason: "disconnected", sourceEpoch: this.telemetry.sourceEpoch, sourceSeq: this.telemetry.lastSeq });
          this.#telemetryRetry = setTimeout(start, 3000);
        },
      );
    };
    void start();
  }

  stopTelemetry(): void {
    this.#telemetryOff = true;
    if (this.#telemetryRetry) clearTimeout(this.#telemetryRetry);
    this.#telemetryRetry = null;
    const s = this.#stopTelemetry;
    this.#stopTelemetry = null;
    s?.();
  }

  #applyStatus(st: { available: boolean; reason: string; sourceEpoch: string; lastSeq: number; kernelDrops: number; userDrops: number; objectSha256?: string; workloads?: { workloadKey: string; kind: string; generation: number }[] }): void {
    this.telemetry = {
      ...this.telemetry,
      available: st.available,
      reason: st.available ? null : st.reason,
      sourceEpoch: st.sourceEpoch,
      kernelDrops: st.kernelDrops,
      userDrops: st.userDrops,
      objectSha256: st.objectSha256 ?? this.telemetry.objectSha256,
      workloads: st.workloads ?? this.telemetry.workloads,
      gap: this.telemetry.gap || !st.available,
    };
  }

  #onTelemetry(f: Record<string, unknown>): void {
    if (f.type === "status") {
      this.#applyStatus(f.status as never);
      return;
    }
    this.telemetry.lastSeq = Number(f.sourceSeq ?? this.telemetry.lastSeq);
    if (f.type === "gap") {
      this.telemetry.gap = true;
      this.telemetry.lastGapReason = String(f.reason ?? "gap");
      if (typeof f.kernelDrops === "number") this.telemetry.kernelDrops = f.kernelDrops;
      if (typeof f.userDrops === "number") this.telemetry.userDrops = f.userDrops;
    } else if (f.type === "event") {
      const k = String(f.workloadKey);
      const c = (this.telemetry.counts[k] ??= { exec: 0, exit: 0, lastExitCode: null });
      if (f.kind === "exec") c.exec++;
      else {
        c.exit++;
        c.lastExitCode = typeof f.exitCode === "number" ? f.exitCode : null;
      }
    }
    this.ingest("telemetry", { ...f, resourceId: typeof f.workloadKey === "string" && f.workloadKey.startsWith("res_") ? f.workloadKey : undefined });
  }

  /** After the refresh triggered by a gap completed. */
  telemetryRefreshed(): void {
    this.telemetry.gap = false;
    this.markRefreshed("telemetry");
  }
}
