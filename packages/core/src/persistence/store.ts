import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { AgentOsError } from "@agentos/contracts";
import { MIGRATIONS, type StructuralMigration } from "./migrations.js";
import { fault } from "../faults.js";

export type Row = Record<string, unknown>;

/** A new workspace normally gets a random storeUUID; installers may fix it (AGENTOS_STORE_UUID) so the root broker
 * registration names this workspace. Only read when os.sqlite is created. */
function initialStoreUUID(): string {
  const v = process.env.AGENTOS_STORE_UUID;
  if (v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) return v;
  return randomUUID();
}

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
      const m = MIGRATIONS[v - 1]!;
      if (typeof m !== "string") {
        this.#structural(v, m);
        continue;
      }
      this.tx(() => {
        this.db.exec(m);
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v, iso(this.clock.now()));
        if (v === 1) {
          this.db
            .prepare("INSERT INTO meta (id, schema_version, store_uuid, client_epoch, agent_binding_state, created_at) VALUES (1, ?, ?, 1, 'pending', ?)")
            .run(v, initialStoreUUID(), iso(this.clock.now()));
        } else {
          this.db.prepare("UPDATE meta SET schema_version = ? WHERE id = 1").run(v);
        }
        fault(`store.migration.${v}.before_commit`); // V1-B07: a crash here must leave the previous schema intact
      });
    }
    const ic = this.db.prepare("PRAGMA quick_check").get() as Row;
    if (Object.values(ic)[0] !== "ok") throw new AgentOsError("STORE_UNAVAILABLE", "os.sqlite failed quick_check");
  }

  /**
   * v0.4 structural migration (spec §21.1): table rebuilds with foreign keys off (a PRAGMA that cannot change inside a
   * transaction), every row, index and trigger kept except the listed replacements, then foreign_key_check before commit.
   */
  #structural(v: number, m: StructuralMigration): void {
    if (m.precondition) {
      const hit = this.db.prepare(m.precondition.sql).get();
      if (hit) throw new AgentOsError("STORE_UNAVAILABLE", `os.sqlite migration ${v} refused: ${m.precondition.message}`);
    }
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.tx(() => {
        for (const r of m.rebuild) {
          const t = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(r.table) as { sql: string } | undefined;
          if (!t) throw new AgentOsError("STORE_UNAVAILABLE", `migration ${v}: table ${r.table} missing`);
          const extras = this.db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL").all(r.table) as { type: string; name: string; sql: string }[];
          let sql = t.sql;
          for (const [from, to] of r.replace) {
            if (!sql.includes(from)) throw new AgentOsError("STORE_UNAVAILABLE", `migration ${v}: ${r.table} definition lacks "${from}"`);
            sql = sql.replace(from, to);
          }
          const tmp = `${r.table}__v${v}`;
          const createTmp = sql.replace(/^CREATE TABLE\s+("?)(\w+)\1/i, `CREATE TABLE ${tmp}`);
          this.db.exec(createTmp);
          const cols = (this.db.prepare(`PRAGMA table_info(${r.table})`).all() as { name: string }[]).map((c) => `"${c.name}"`).join(", ");
          this.db.exec(`INSERT INTO ${tmp} (${cols}) SELECT ${cols} FROM ${r.table}`);
          const before = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${r.table}`).get() as { n: number }).n;
          this.db.exec(`DROP TABLE ${r.table}`);
          this.db.exec(`ALTER TABLE ${tmp} RENAME TO ${r.table}`);
          const after = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${r.table}`).get() as { n: number }).n;
          if (before !== after) throw new AgentOsError("STORE_UNAVAILABLE", `migration ${v}: ${r.table} lost rows`);
          for (const e of extras) {
            if (e.type === "index" && r.dropIndexes?.includes(e.name)) continue;
            if (e.type === "trigger" && r.dropTriggers?.includes(e.name)) continue;
            this.db.exec(e.sql);
          }
        }
        this.db.exec(m.sql);
        const fk = this.db.prepare("PRAGMA foreign_key_check").all();
        if (fk.length > 0) throw new AgentOsError("STORE_UNAVAILABLE", `migration ${v}: foreign key check failed (${JSON.stringify(fk.slice(0, 3))})`);
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v, iso(this.clock.now()));
        this.db.prepare("UPDATE meta SET schema_version = ? WHERE id = 1").run(v);
        fault(`store.migration.${v}.before_commit`);
      });
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
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
