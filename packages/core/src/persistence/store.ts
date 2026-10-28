import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { AgentOsError } from "@agentos/contracts";
import { MIGRATIONS } from "./migrations.js";

export type Row = Record<string, unknown>;

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };
export const iso = (ms: number) => new Date(ms).toISOString();

export interface MetaRow {
  schema_version: number;
  store_uuid: string;
  client_epoch: number;
  agent_binding_state: "pending" | "bound";
  created_at: string;
}

/**
 * os.sqlite: the single source of truth for apps, revisions, records, runs and receipts.
 * node:sqlite is synchronous, so a transaction never spans an await: no network, model or file I/O can run inside it.
 */
export class Store {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  #depth = 0;
  #sp = 0;
  /** Spec §15: slow business transactions are logged with their duration. */
  slowTransactionMs = 100;
  onSlowTransaction: ((info: { kind: "write" | "read"; durationMs: number }) => void) | null = null;

  private constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  static open(file: string, clock: Clock = systemClock): Store {
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA synchronous = FULL");
    const store = new Store(db, clock);
    store.migrate();
    return store;
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const row = this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
    const current = row.v ?? 0;
    if (current > MIGRATIONS.length) {
      throw new AgentOsError("STORE_UNAVAILABLE", `os.sqlite schema ${current} is newer than this host (${MIGRATIONS.length}); downgrade is not supported`);
    }
    for (let v = current + 1; v <= MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v - 1]!);
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v, iso(this.clock.now()));
        if (v === 1) {
          this.db
            .prepare("INSERT INTO meta (id, schema_version, store_uuid, client_epoch, agent_binding_state, created_at) VALUES (1, ?, ?, 1, 'pending', ?)")
            .run(v, randomUUID(), iso(this.clock.now()));
        } else {
          this.db.prepare("UPDATE meta SET schema_version = ? WHERE id = 1").run(v);
        }
      });
    }
    const ic = this.db.prepare("PRAGMA quick_check").get() as Row;
    if (Object.values(ic)[0] !== "ok") throw new AgentOsError("STORE_UNAVAILABLE", "os.sqlite failed quick_check");
  }

  meta(): MetaRow {
    return this.db.prepare("SELECT schema_version, store_uuid, client_epoch, agent_binding_state, created_at FROM meta WHERE id = 1").get() as unknown as MetaRow;
  }

  get schemaVersion(): number {
    return MIGRATIONS.length;
  }

  /** Synchronous write transaction (BEGIN IMMEDIATE). Nested calls run inline. */
  tx<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    const started = performance.now();
    this.db.exec("BEGIN IMMEDIATE");
    this.#depth++;
    try {
      const out = fn();
      if (out instanceof Promise) throw new Error("transaction callback must be synchronous");
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.#depth--;
      this.#timed("write", started);
    }
  }

  /** Consistent read snapshot (deferred transaction). */
  read<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    const started = performance.now();
    this.db.exec("BEGIN DEFERRED");
    this.#depth++;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.#depth--;
      this.#timed("read", started);
    }
  }

  #timed(kind: "write" | "read", started: number): void {
    const durationMs = Math.round(performance.now() - started);
    if (durationMs >= this.slowTransactionMs && this.onSlowTransaction) {
      try {
        this.onSlowTransaction({ kind, durationMs });
      } catch {
        /* logging must never affect a transaction */
      }
    }
  }

  /** Savepoint inside a transaction: on throw, roll back only its own writes and rethrow. */
  savepoint<T>(fn: () => T): T {
    const name = `sp${++this.#sp}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      this.db.exec(`RELEASE ${name}`);
      return out;
    } catch (e) {
      this.db.exec(`ROLLBACK TO ${name}`);
      this.db.exec(`RELEASE ${name}`);
      throw e;
    }
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }
  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }
  run(sql: string, ...params: unknown[]): { changes: number } {
    const r = this.db.prepare(sql).run(...(params as never[]));
    return { changes: Number(r.changes) };
  }

  event(kind: string, payload: Record<string, unknown>, ids: { appId?: string | null; runId?: string | null } = {}): void {
    this.run(
      "INSERT INTO events (kind, app_id, run_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      kind,
      ids.appId ?? null,
      ids.runId ?? null,
      JSON.stringify(payload),
      iso(this.clock.now()),
    );
  }

  eventSeq(): number {
    const r = this.get<{ s: number | null }>("SELECT MAX(seq) AS s FROM events");
    return r?.s ?? 0;
  }
}
