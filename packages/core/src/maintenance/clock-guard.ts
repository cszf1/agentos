import fs from "node:fs";
import { V4_LIMITS } from "@agentos/contracts";
import { type Store } from "../persistence/store.js";

/** Monotonic milliseconds (process-local; persisted only together with the boot id it belongs to). */
export type MonoClock = () => number;
export const processMono: MonoClock = () => Number(process.hrtime.bigint() / 1_000_000n);

/** CLOCK_BOOTTIME-like milliseconds (includes system suspend): /proc/uptime on Linux; null elsewhere. */
export function bootTimeMs(): number | null {
  try {
    return Math.round(Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1000);
  } catch {
    return null;
  }
}

function bootId(): string {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return "unknown";
  }
}

/**
 * Wall vs monotonic clock supervision (spec §11.3, V4-J03). UTC is used for plans and audit, monotonic time for
 * in-process waits. A jump of the wall clock against the monotonic clock of more than 5 minutes, or a significant
 * rollback at start, puts the workspace into `clock_uncertain`: automatic side-effect steps stop, observation goes on,
 * and the user must recheck after correcting the clock. Occurrences are never repeated by a rollback, and a large
 * forward jump never fires every missed occurrence at once (the scheduler coalesces).
 */
export class ClockGuard {
  #lastWall: number | null = null;
  #lastMono: number | null = null;
  #lastBoot: number | null = null;
  /** test hook (CLOCK_BOOTTIME source) */
  bootTime: () => number | null = bootTimeMs;
  /** last observed suspend (for diagnostics) */
  lastSleep: { at: number; ms: number } | null = null;
  readonly boot = bootId();

  constructor(
    private readonly store: Store,
    private readonly mono: MonoClock = processMono,
  ) {}

  get state(): "ok" | "clock_uncertain" {
    return (this.store.get<{ s: string }>("SELECT clock_state AS s FROM meta WHERE id = 1")?.s ?? "ok") as "ok" | "clock_uncertain";
  }

  /** Startup check against the last persisted sample: a wall clock behind the last sample by > 5 min is a rollback. */
  startup(): "ok" | "clock_uncertain" {
    const m = this.store.get<{ w: number | null; b: string | null }>("SELECT clock_wall_ms AS w, clock_boot_id AS b FROM meta WHERE id = 1");
    const wall = this.store.clock.now();
    if (m?.w != null && wall < m.w - V4_LIMITS.clockJumpMs) this.#set("clock_uncertain", `wall clock went back ${Math.round((m.w - wall) / 1000)} s since the last run`);
    this.sample();
    return this.state;
  }

  /** Periodic sample (each scheduler tick). Returns the current state. */
  sample(): "ok" | "clock_uncertain" {
    const wall = this.store.clock.now();
    const mono = this.mono();
    const boot = this.bootTime();
    if (this.#lastWall !== null && this.#lastMono !== null) {
      const dw = wall - this.#lastWall;
      const dm = mono - this.#lastMono;
      const db = boot !== null && this.#lastBoot !== null ? boot - this.#lastBoot : null;
      if (Math.abs(dw - dm) > V4_LIMITS.clockJumpMs) {
        // A system suspend stops the monotonic clock but not CLOCK_BOOTTIME: the wall clock agrees with boottime, so this
        // is a sleep/wake. Re-sample (nothing ran while suspended) instead of declaring the clock uncertain.
        if (db !== null && Math.abs(dw - db) <= V4_LIMITS.clockJumpMs && db - dm > V4_LIMITS.clockJumpMs) {
          this.lastSleep = { at: wall, ms: db - dm };
          this.store.tx(() => this.store.event("clock.resumed_from_sleep", { sleptMs: db - dm }));
        } else {
          this.#set("clock_uncertain", `wall clock moved ${Math.round(dw / 1000)} s while ${Math.round(dm / 1000)} s passed (monotonic)`);
        }
      }
    }
    this.#lastWall = wall;
    this.#lastMono = mono;
    this.#lastBoot = boot;
    this.store.tx(() => this.store.run("UPDATE meta SET clock_wall_ms = MAX(COALESCE(clock_wall_ms, 0), ?), clock_mono_ms = ?, clock_boot_id = ? WHERE id = 1", wall, mono, this.boot));
    return this.state;
  }

  /** The user corrected the clock: re-sample and clear (spec §11.3 "校正后重查"). */
  recheck(): "ok" | "clock_uncertain" {
    this.#lastWall = null;
    this.#lastMono = null;
    this.#lastBoot = null;
    const wall = this.store.clock.now();
    this.store.tx(() => {
      this.store.run("UPDATE meta SET clock_state = 'ok', clock_wall_ms = ?, clock_mono_ms = ?, clock_boot_id = ? WHERE id = 1", wall, this.mono(), this.boot);
      this.store.event("clock.recheck", { at: wall });
    });
    this.sample();
    return this.state;
  }

  #set(state: "clock_uncertain", reason: string): void {
    this.store.tx(() => {
      const cur = this.state;
      this.store.run("UPDATE meta SET clock_state = ? WHERE id = 1", state);
      if (cur !== state) this.store.event("clock.uncertain", { reason });
    });
  }
}
