import { iso } from "../persistence/store.js";
import type { RuntimeContext } from "./context.js";
import type { AppRuntimeService, InstanceRow } from "./app-runtime.js";
import type { ContainerStatus } from "./driver.js";
import { RUNTIME_POLICY } from "./policy.js";

export interface ReconcileReport {
  engineReachable: boolean;
  removed: string[];
  started: string[];
  probesFailed: string[];
  unknown: string[];
}

/**
 * Compares the database's desired state with the engine's real objects (spec §14.3). Container events are only hints;
 * this loop is the source of convergence. It only touches objects labelled with this workspace's storeUUID and whose
 * labels match a registered row; a same-named object with another identity is reported, never force-replaced.
 */
export class Reconciler {
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<ReconcileReport> | null = null;
  lastReport: ReconcileReport | null = null;
  /** Hook for draining deployments' old instances and other periodic work. */
  extra: (() => Promise<void>) | null = null;

  constructor(private readonly ctx: RuntimeContext, private readonly runtime: AppRuntimeService) {}

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.runOnce().catch((e) => this.ctx.log("error", "reconcile failed", { error: (e as Error).message })), RUNTIME_POLICY.reconcileIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  runOnce(): Promise<ReconcileReport> {
    if (this.#running) return this.#running;
    this.#running = this.#run().finally(() => (this.#running = null));
    return this.#running;
  }

  async #run(): Promise<ReconcileReport> {
    const report: ReconcileReport = { engineReachable: true, removed: [], started: [], probesFailed: [], unknown: [] };
    const { driver, instances, store } = this.ctx;
    if (!driver || !instances) {
      report.engineReachable = false;
      this.lastReport = report;
      return report;
    }
    let containers: ContainerStatus[];
    try {
      containers = await driver.list(this.ctx.storeUUID);
      this.runtime.engineReachable = true;
    } catch (e) {
      // Engine unreachable: do not treat as deleted; pause new allocations (spec §15).
      this.runtime.engineReachable = false;
      report.engineReachable = false;
      this.ctx.log("warn", "container engine unreachable; runtime state unknown", { error: (e as Error).message });
      this.lastReport = report;
      return report;
    }
    const now = iso(store.clock.now());
    // 1. Every labelled container must match a row that wants it running in this boot, with a live handle.
    for (const c of containers) {
      const instanceId = c.labels["agentos.instance"] ?? "";
      const role = c.labels["agentos.role"];
      if (role === "build") {
        const job = store.get<{ status: string; host_boot_id: string | null; container_name: string }>("SELECT status, host_boot_id, container_name FROM build_jobs WHERE id = ?", instanceId);
        const keep = job && (job.status === "queued" || job.status === "building") && job.host_boot_id === this.ctx.bootId && job.container_name === c.name;
        if (!keep) {
          if (job && job.container_name !== c.name) {
            report.unknown.push(c.name);
            continue;
          }
          await driver.remove(c.id).catch(() => undefined);
          report.removed.push(c.name);
        }
        continue;
      }
      const row = store.get<InstanceRow>("SELECT * FROM runtime_instances WHERE id = ?", instanceId);
      if (!row) {
        // Labelled with our store but unregistered: created before its row was written? Rows are written first, so
        // this is a leftover of a removed row; it carries our store label, so it is ours to remove.
        await driver.remove(c.id).catch(() => undefined);
        report.removed.push(c.name);
        continue;
      }
      if (row.container_name !== c.name) {
        report.unknown.push(c.name);
        this.ctx.log("warn", "container identity mismatch; left in place for diagnosis", { container: c.name, instance: row.id });
        continue;
      }
      const live = instances.get(row.id);
      const wanted = row.desired_state === "running" && row.host_boot_id === this.ctx.bootId && live && !live.dead;
      if (!wanted) {
        if (live) await instances.destroy(live, "reconcile");
        else await driver.remove(c.id).catch(() => undefined);
        store.tx(() => store.run("UPDATE runtime_instances SET desired_state = 'removed', observed_state = CASE WHEN observed_state IN ('failed') THEN observed_state ELSE 'stopped' END, updated_at = ? WHERE id = ?", now, row.id));
        report.removed.push(c.name);
      } else if (c.state === "exited" && live) {
        live.bridge.close("container exited");
      }
    }
    // 2. Rows that think they are running but have no container or handle any more.
    const present = new Set(containers.map((c) => c.name));
    const stale = store.all<InstanceRow>("SELECT * FROM runtime_instances WHERE desired_state <> 'removed' OR observed_state IN ('starting','ready','serving','draining','unknown')");
    for (const row of stale) {
      const live = instances.get(row.id);
      if (row.observed_state === "starting" && row.host_boot_id === this.ctx.bootId && row.desired_state === "running") continue;
      if (!present.has(row.container_name) && (!live || live.dead)) {
        store.tx(() => store.run("UPDATE runtime_instances SET desired_state = 'removed', observed_state = CASE WHEN observed_state = 'failed' THEN 'failed' ELSE 'absent' END, updated_at = ? WHERE id = ?", now, row.id));
        const ar = this.runtime.row(row.app_id);
        if (ar?.active_instance_id === row.id && live) await this.runtime.onInstanceExit(live, "container disappeared");
        else if (ar?.active_instance_id === row.id) {
          store.tx(() => store.run("UPDATE app_runtime SET active_instance_id = NULL, health = CASE WHEN enabled = 1 THEN 'recovering' ELSE health END, updated_at = ? WHERE app_id = ?", now, row.app_id));
        }
      }
    }
    // 3. Draining old instances: removed after the drain window.
    for (const row of store.all<InstanceRow & { updated_at: string }>("SELECT * FROM runtime_instances WHERE observed_state = 'draining'")) {
      const live = instances.get(row.id);
      const age = store.clock.now() - Date.parse(row.updated_at);
      if (!live || !live.busy || age > RUNTIME_POLICY.drainMs) {
        if (live) await instances.destroy(live, "drained");
        else await driver.remove(row.container_name).catch(() => undefined);
        store.tx(() => store.run("UPDATE runtime_instances SET observed_state = 'stopped', updated_at = ? WHERE id = ?", now, row.id));
        report.removed.push(row.container_name);
      }
    }
    // 4. Probe idle active instances; a failed probe is a crash.
    for (const ar of store.all<{ app_id: string; active_instance_id: string }>("SELECT app_id, active_instance_id FROM app_runtime WHERE active_instance_id IS NOT NULL")) {
      const live = instances.get(ar.active_instance_id);
      if (!live) continue;
      const ok = await instances.probe(live);
      if (ok) store.tx(() => store.run("UPDATE runtime_instances SET last_probe_at = ? WHERE id = ?", iso(store.clock.now()), live.id));
      else if (!live.busy) {
        report.probesFailed.push(live.id);
        await instances.kill(live, "probe failed");
      }
    }
    // 5. Start what should run.
    const due = store.all<{ app_id: string }>(
      "SELECT app_id FROM app_runtime WHERE enabled = 1 AND active_instance_id IS NULL AND health = 'recovering' AND (next_restart_at IS NULL OR next_restart_at <= ?)",
      iso(store.clock.now()),
    );
    for (const d of due) {
      await this.runtime.startActive(d.app_id);
      report.started.push(d.app_id);
    }
    if (this.extra) await this.extra();
    this.lastReport = report;
    return report;
  }
}
