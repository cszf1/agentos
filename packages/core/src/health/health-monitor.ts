import { V4_LIMITS, type MaintenanceTemplateId } from "@agentos/contracts";
import { iso, type Store } from "../persistence/store.js";
import type { IncidentStore, Quality } from "./incidents.js";
import type { MaintenanceService } from "../maintenance/jobs.js";

export interface ServiceProbe {
  /** fresh read of a registered service through the provider; `unknown` when the provider cannot tell */
  (resourceId: string): Promise<{ state: "running" | "stopped" | "unknown"; quality: Quality; generation: number | null; identity: string | null; detail?: Record<string, unknown> }>;
}

/**
 * HealthMonitor (spec §12): turns existing observation sources (RuntimeManager rows, provider reads, cache statistics,
 * lifecycle usage) into bounded samples and incidents. Event sources (eBPF, D-Bus, inotify) only wake a check; a missing
 * event, a lost provider or `unknown` is never read as "stopped". It never acts: it raises incidents and hands an event
 * trigger to the maintenance scheduler, which re-reads the real state before anything happens.
 */
export class HealthMonitor {
  #timer: NodeJS.Timeout | undefined;
  #busy = false;
  #lastService = new Map<string, number>();
  #wakeTimer: NodeJS.Timeout | undefined;
  serviceProbe: ServiceProbe | null = null;
  cacheUsage: (() => { bytes: number; budget: number } | null) | null = null;
  log: (lvl: "info" | "warn" | "error", msg: string, f?: Record<string, unknown>) => void = () => {};

  constructor(
    private readonly store: Store,
    private readonly incidents: IncidentStore,
    private readonly maintenance: MaintenanceService,
  ) {}

  start(pollMs = 5000): void {
    this.#timer = setInterval(() => void this.tick(), pollMs);
    this.#timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#wakeTimer) clearTimeout(this.#wakeTimer);
    this.#timer = undefined;
  }

  /** An event hint: coalesced into one check within the 5 s window (spec §24.1). */
  wake(): void {
    if (this.#wakeTimer) return;
    this.#wakeTimer = setTimeout(() => {
      this.#wakeTimer = undefined;
      void this.tick();
    }, V4_LIMITS.eventCoalesceMs);
    this.#wakeTimer.unref?.();
  }

  #trigger(templateId: MaintenanceTemplateId, incidentId: string): void {
    const inc = this.incidents.get(incidentId);
    if (!inc) return;
    const r = this.maintenance.eventTrigger(inc, templateId);
    if (r?.created) void this.maintenance.kick();
  }

  async tick(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      this.#apps();
      await this.#services();
      this.#cache();
      this.#idle();
    } catch (e) {
      this.log("error", "health tick failed", { error: (e as Error).message });
    } finally {
      this.#busy = false;
    }
  }

  /** Code apps: a restart budget exhausted (degraded) while enabled, not stopped by the user, not draining a deployment. */
  #apps(): void {
    const rows = this.store.all<{ app_id: string; enabled: number; health: string; restart_count: number; generation: number; last_error_json: string | null; control_epoch: number; lc_state: string | null; recovery_paused: number | null; deploying: number }>(
      `SELECT ar.app_id, ar.enabled, ar.health, ar.restart_count, ar.generation, ar.last_error_json, ar.control_epoch, lc.state AS lc_state, lc.recovery_paused,
              (SELECT COUNT(*) FROM deployments d WHERE d.app_id = ar.app_id AND d.status IN ('queued','preparing','ready')) AS deploying
         FROM app_runtime ar LEFT JOIN app_lifecycle lc ON lc.app_id = ar.app_id`,
    );
    for (const r of rows) {
      if (r.enabled !== 1 || (r.lc_state && r.lc_state !== "active") || r.deploying > 0) continue;
      if (r.health === "degraded") {
        this.incidents.sample({ targetKind: "app", targetId: r.app_id, condition: "app.crash_loop", value: "bad", quality: "fresh", detail: { restartCount: r.restart_count } });
        const { incident, created } = this.incidents.raise({
          targetKind: "app", targetId: r.app_id, condition: "app.crash_loop", value: "bad", quality: "fresh", generation: r.generation, severity: "critical",
          evidence: { health: r.health, restartCount: r.restart_count, controlEpoch: r.control_epoch, lastError: r.last_error_json ? JSON.parse(r.last_error_json) : null },
        });
        if (created || incident.state === "open") this.#trigger("app-recovery", incident.id);
      } else if (r.health === "recovering" && r.restart_count > 0) {
        // the existing controller is restarting it: evidence only (no maintenance action while it works)
        this.incidents.sample({ targetKind: "app", targetId: r.app_id, condition: "app.exit", value: "bad", quality: "fresh", detail: { restartCount: r.restart_count } });
      } else if (r.health === "ready") {
        this.incidents.sample({ targetKind: "app", targetId: r.app_id, condition: "app.crash_loop", value: "ok", quality: "fresh" });
      }
    }
  }

  /** Registered services with a policy: 3 fresh "stopped" samples 15 s apart open ONE incident (spec §12.1). */
  async #services(): Promise<void> {
    if (!this.serviceProbe) return;
    const targets = this.store.all<{ target_id: string }>(
      "SELECT DISTINCT target_id FROM maintenance_policies WHERE template_id = 'service-ensure-running' AND state IN ('enabled','syncing')",
    );
    const now = this.store.clock.now();
    for (const t of targets) {
      const p = this.store.get<{ bounds_json: string }>("SELECT bounds_json FROM maintenance_policies WHERE template_id = 'service-ensure-running' AND target_id = ? AND state IN ('enabled','syncing') LIMIT 1", t.target_id);
      const bounds = p ? (JSON.parse(p.bounds_json) as Record<string, number>) : {};
      const every = (bounds.sampleSeconds ?? 15) * 1000;
      if (now - (this.#lastService.get(t.target_id) ?? 0) < every) continue;
      this.#lastService.set(t.target_id, now);
      let r;
      try {
        r = await this.serviceProbe(t.target_id);
      } catch (e) {
        r = { state: "unknown" as const, quality: "unavailable" as const, generation: null, identity: null, detail: { error: (e as Error).message } };
      }
      const value = r.state === "stopped" ? "bad" : r.state === "running" ? "ok" : "unknown";
      this.incidents.sample({ targetKind: "service", targetId: t.target_id, condition: "service.down", value, quality: r.quality, detail: { ...r.detail, generation: r.generation, identity: r.identity } });
      const need = bounds.samples ?? V4_LIMITS.serviceFreshSamples;
      const recent = this.incidents.recent("service", t.target_id, "service.down", need);
      const allBad = recent.length >= need && recent.every((s) => s.value === "bad" && s.quality === "fresh");
      if (allBad) {
        const { incident } = this.incidents.raise({ targetKind: "service", targetId: t.target_id, condition: "service.down", value: "bad", quality: "fresh", generation: r.generation, severity: "warning", evidence: { samples: recent.length, identity: r.identity, generation: r.generation } });
        this.#trigger("service-ensure-running", incident.id);
      }
    }
  }

  /** Cache pressure: two valid snapshots above 80 % of the budget, hysteresis down to 60 % (spec §12.1). */
  #cache(): void {
    const u = this.cacheUsage?.();
    if (!u || u.budget <= 0) return;
    const pct = u.bytes / u.budget;
    const value = pct >= V4_LIMITS.cacheTriggerRatio ? "bad" : "ok";
    this.incidents.sample({ targetKind: "workspace", targetId: "workspace", condition: "cache.pressure", value, quality: "fresh", detail: { bytes: u.bytes, budget: u.budget } });
    const recent = this.incidents.recent("workspace", "workspace", "cache.pressure", 2);
    if (recent.length === 2 && recent.every((s) => s.value === "bad")) {
      const { incident } = this.incidents.raise({ targetKind: "workspace", targetId: "workspace", condition: "cache.pressure", value: "bad", quality: "fresh", severity: "warning", evidence: { bytes: u.bytes, budget: u.budget, percent: Math.round(pct * 100) } });
      this.#trigger("cache-gc", incident.id);
    }
  }

  /** Apps unused for the policy's idle days, with an archive policy (spec §12.1, §18). */
  #idle(): void {
    const ps = this.store.all<{ target_id: string; bounds_json: string }>("SELECT target_id, bounds_json FROM maintenance_policies WHERE template_id = 'app-archive' AND state = 'enabled'");
    for (const p of ps) {
      const days = (JSON.parse(p.bounds_json) as Record<string, number>).idleDays ?? V4_LIMITS.archiveIdleDays;
      const lc = this.store.get<{ last_used_at: string | null; state: string }>("SELECT last_used_at, state FROM app_lifecycle WHERE app_id = ?", p.target_id);
      if (!lc || lc.state !== "active" || !lc.last_used_at) continue;
      if (this.store.clock.now() - Date.parse(lc.last_used_at) < days * 86_400_000) continue;
      const { incident } = this.incidents.raise({ targetKind: "app", targetId: p.target_id, condition: "app.idle", value: "bad", quality: "fresh", severity: "info", evidence: { lastUsedAt: lc.last_used_at, idleDays: days } });
      this.#trigger("app-archive", incident.id);
    }
  }

  /** for diagnostics */
  lastSampleAt(): string | null {
    return this.store.get<{ t: string | null }>("SELECT MAX(observed_at) AS t FROM health_samples")?.t ?? null;
  }

  now(): string {
    return iso(this.store.clock.now());
  }
}
