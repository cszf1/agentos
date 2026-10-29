import { randomUUID } from "node:crypto";
import { statfsSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { AgentOsError, V4_LIMITS } from "@agentos/contracts";
import { iso, type Store } from "../persistence/store.js";
import type { ArtifactStore } from "./artifact-store.js";
import { fault } from "../faults.js";

/**
 * The maintenance I/O worker (spec §17.3): fixed trusted code on a worker_thread. It only receives an admitted
 * deleteIntentId, a registered root and the object's name/identity; it never receives SQL or generated text and never
 * touches a database. Every path is resolved under the registered root, symlinks are never followed, and a different
 * device (a mount) or identity is refused.
 */
const WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
function inside(root, name) {
  if (typeof name !== "string" || name.length === 0 || name.includes("/") || name.includes("\0") || name === "." || name === "..") throw new Error("PATH_REFUSED: object name must be a single path component");
  const rootReal = fs.realpathSync(root);
  const p = path.join(rootReal, name);
  if (path.dirname(p) !== rootReal) throw new Error("PATH_REFUSED: outside the registered root");
  return { rootReal, p, rootDev: fs.lstatSync(rootReal).dev };
}
function ident(st) { return st.dev + ":" + st.ino; }
function mountPoints() {
  try {
    return new Set(fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n").filter(Boolean).map((l) => l.split(" ")[4].replace(/\\040/g, " ")));
  } catch { return new Set(); }
}
/** a bind mount or another filesystem under the root: refused (directories also by device; overlayfs gives files the lower device) */
function foreign(p, st, rootDev) {
  if (mountPoints().has(p)) return true;
  return st.isDirectory() && st.dev !== rootDev;
}
function size(p) {
  let total = 0;
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return st.size;
  if (!st.isDirectory()) return st.size;
  for (const e of fs.readdirSync(p)) total += size(path.join(p, e));
  return total;
}
parentPort.on("message", (m) => {
  const reply = (r) => parentPort.postMessage({ id: m.id, ...r });
  try {
    if (m.op === "inspect") {
      const { p, rootDev } = inside(m.root, m.name);
      let st;
      try { st = fs.lstatSync(p); } catch (e) { if (e.code === "ENOENT") return reply({ ok: true, exists: false }); throw e; }
      if (st.isSymbolicLink()) return reply({ ok: false, error: "PATH_REFUSED: symlink" });
      if (foreign(p, st, rootDev)) return reply({ ok: false, error: "PATH_REFUSED: another filesystem (mount)" });
      return reply({ ok: true, exists: true, identity: ident(st), dir: st.isDirectory(), bytes: size(p), mtimeMs: st.mtimeMs });
    }
    if (m.op === "move") {
      const src = inside(m.root, m.name);
      const trashRoot = path.join(src.rootReal, ".trash");
      fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
      const dst = inside(trashRoot, m.trashName);
      let st;
      try { st = fs.lstatSync(src.p); } catch (e) { if (e.code === "ENOENT") return reply({ ok: true, moved: false, missing: true }); throw e; }
      if (st.isSymbolicLink() || foreign(src.p, st, src.rootDev)) return reply({ ok: false, error: "PATH_REFUSED: symlink or mount" });
      if (m.expectIdentity && ident(st) !== m.expectIdentity) return reply({ ok: false, error: "IDENTITY_CHANGED: the object is not the one that was marked" });
      fs.renameSync(src.p, dst.p);
      return reply({ ok: true, moved: true, trash: dst.p });
    }
    if (m.op === "remove") {
      const trashRoot = path.join(fs.realpathSync(m.root), ".trash");
      const t = inside(trashRoot, m.trashName);
      let st;
      try { st = fs.lstatSync(t.p); } catch (e) { if (e.code === "ENOENT") return reply({ ok: true, removed: false, bytes: 0 }); throw e; }
      if (st.isSymbolicLink()) { fs.unlinkSync(t.p); return reply({ ok: true, removed: true, bytes: 0 }); }
      const bytes = size(t.p);
      fs.rmSync(t.p, { recursive: true, force: true });
      return reply({ ok: true, removed: true, bytes });
    }
    if (m.op === "unlink-file") {
      const { p, rootDev } = inside(m.root, m.name);
      let st;
      try { st = fs.lstatSync(p); } catch (e) { if (e.code === "ENOENT") return reply({ ok: true, removed: false, bytes: 0 }); throw e; }
      if (!st.isFile() || foreign(p, st, rootDev)) return reply({ ok: false, error: "PATH_REFUSED: not a regular file on this filesystem" });
      if (m.expectIdentity && ident(st) !== m.expectIdentity) return reply({ ok: false, error: "IDENTITY_CHANGED" });
      fs.unlinkSync(p);
      return reply({ ok: true, removed: true, bytes: st.size });
    }
    if (m.op === "list") {
      const rootReal = fs.realpathSync(m.root);
      const out = [];
      for (const name of fs.readdirSync(rootReal)) {
        if (out.length >= 10000) break;
        try {
          const st = fs.lstatSync(path.join(rootReal, name));
          out.push({ name, identity: ident(st), dir: st.isDirectory(), symlink: st.isSymbolicLink(), file: st.isFile(), bytes: st.isDirectory() ? -1 : st.size, mtimeMs: st.mtimeMs });
        } catch { /* raced away */ }
      }
      return reply({ ok: true, entries: out });
    }
    if (m.op === "sleep") { setTimeout(() => reply({ ok: true }), m.ms); return; }
    reply({ ok: false, error: "unknown op" });
  } catch (e) {
    reply({ ok: false, error: String(e && e.message || e) });
  }
});
`;

export class IoWorker {
  #w: Worker | null = null;
  #seq = 0;
  #pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  #inflight = 0;
  /** bounded queue (spec §24.1) */
  static readonly MAX_QUEUE = 64;

  #ensure(): Worker {
    if (!this.#w) {
      this.#w = new Worker(WORKER_SOURCE, { eval: true });
      this.#w.unref();
      this.#w.on("message", (m: { id: number } & Record<string, unknown>) => {
        const p = this.#pending.get(m.id);
        if (!p) return;
        this.#pending.delete(m.id);
        this.#inflight--;
        p.resolve(m);
      });
      this.#w.on("error", (e) => this.#failAll(e));
      this.#w.on("exit", () => {
        this.#failAll(new Error("io worker exited"));
        this.#w = null;
      });
    }
    return this.#w;
  }

  #failAll(e: Error): void {
    for (const [, p] of this.#pending) p.reject(e);
    this.#pending.clear();
    this.#inflight = 0;
  }

  call(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.#inflight >= IoWorker.MAX_QUEUE) return Promise.reject(new AgentOsError("RESOURCE_BUSY", "maintenance I/O queue is full"));
    const id = ++this.#seq;
    this.#inflight++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ensure().postMessage({ id, ...msg });
    });
  }

  get busy(): number {
    return this.#inflight;
  }

  /** Stop-write: terminate and wait for the worker thread to be gone (shutdown, backup, takeover). */
  async stop(): Promise<void> {
    const w = this.#w;
    this.#w = null;
    if (w) await w.terminate();
    this.#failAll(new Error("io worker stopped"));
  }
}

export interface IntentRow {
  id: string;
  job_id: string | null;
  step_id: string | null;
  object_kind: "artifact" | "staging" | "log";
  object_id: string;
  gc_generation: number;
  source_path: string;
  source_identity: string | null;
  trash_path: string | null;
  phase: "marked" | "moved" | "deleted" | "recorded" | "aborted" | "unknown";
  logical_bytes: number;
  unlinked_bytes: number | null;
  error: string | null;
}

export interface GcReport {
  objects: number;
  bytesUnlinked: number;
  logicalBytes: number;
  freeBefore: number | null;
  freeAfter: number | null;
  protectedBytes: number;
  protectedObjects: number;
  reportedOnly: { name: string; reason: string }[];
  yielded: boolean;
  remaining: number;
  unknown: number;
  noReclaimable: boolean;
}

/**
 * Online cache collection (spec §17): candidate scan → per-object mark transaction (re-check every persistent
 * reference and pin, live → deleting, delete intent) → I/O worker move to trash → delete → record. From `deleting` on,
 * no new reference or pin can be taken (ARTIFACT_GC_PENDING). Every object has its own intent and resumes from its
 * phase after a crash; an unknown identity stops that object, never widens to a parent directory. Activated history,
 * active revisions, deployments, instances, builds, backups, proposals and candidate checks are never candidates.
 */
export class OnlineGc {
  readonly worker = new IoWorker();
  /** host load signal: true → yield between batches (foreground runs waiting, deployment preparing, user traffic) */
  busy: () => boolean = () => false;
  stopped = false;

  constructor(
    private readonly store: Store,
    private readonly artifacts: ArtifactStore,
    private readonly logDir: string | null = null,
  ) {}

  private now(): string {
    return iso(this.store.clock.now());
  }

  // ------------------------------------------------------------------ pins (spec §17.1)

  /** Take a pin in the caller's transaction. Refused when the object is being deleted. */
  pinInTx(objectKind: "artifact" | "staging" | "build", objectId: string, ownerKind: string, ownerId: string): void {
    let gen = 1;
    if (objectKind === "artifact") {
      const a = this.store.get<{ gc_state: string; gc_generation: number }>("SELECT gc_state, gc_generation FROM artifacts WHERE id = ?", objectId);
      if (!a) throw new AgentOsError("NOT_FOUND", "artifact not found", { artifactId: objectId });
      if (a.gc_state === "deleting" || a.gc_state === "marked") throw new AgentOsError("ARTIFACT_GC_PENDING", "the artifact is being cleaned up; it will be rebuilt", { artifactId: objectId });
      gen = a.gc_generation;
    }
    this.store.run(
      `INSERT INTO artifact_pins (id, object_kind, object_id, gc_generation, owner_kind, owner_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'held', ?)
       ON CONFLICT (object_kind, object_id, owner_kind, owner_id) DO UPDATE SET state = 'held', gc_generation = excluded.gc_generation, released_at = NULL`,
      `pin_${randomUUID()}`, objectKind, objectId, gen, ownerKind, ownerId, this.now(),
    );
  }

  pin(objectKind: "artifact" | "staging" | "build", objectId: string, ownerKind: string, ownerId: string): void {
    this.store.tx(() => this.pinInTx(objectKind, objectId, ownerKind, ownerId));
  }

  /** Release follows the owner's real end (never a timer). */
  releaseOwner(ownerKind: string, ownerId: string): number {
    return this.store.tx(() => this.store.run("UPDATE artifact_pins SET state = 'released', released_at = ? WHERE owner_kind = ? AND owner_id = ? AND state = 'held'", this.now(), ownerKind, ownerId).changes);
  }

  /** Inside a tx that creates a new reference: refuse an object in deletion. */
  requireLiveInTx(artifactId: string): void {
    const a = this.store.get<{ gc_state: string }>("SELECT gc_state FROM artifacts WHERE id = ?", artifactId);
    if (a && (a.gc_state === "deleting" || a.gc_state === "marked")) throw new AgentOsError("ARTIFACT_GC_PENDING", "the artifact is being cleaned up; wait and rebuild", { artifactId });
  }

  /** Persistent references with the reason each is kept (online version of the v0.2 reference set). */
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
    add(s.all("SELECT DISTINCT ra.artifact_id AS id FROM proposals p JOIN revision_artifacts ra ON ra.app_id = p.app_id AND ra.revision_id = p.candidate_revision_id WHERE p.state IN ('pending','accepted','publishing','published','needs_recheck')"), "proposal");
    add(s.all("SELECT DISTINCT ra.artifact_id AS id FROM candidate_checks c JOIN revision_artifacts ra ON ra.app_id = c.app_id AND ra.revision_id = c.revision_id WHERE c.state IN ('queued','running')"), "candidate_check");
    add(s.all("SELECT DISTINCT object_id AS id FROM artifact_pins WHERE object_kind = 'artifact' AND state = 'held'"), "pin");
    return keep;
  }

  #free(): number | null {
    try {
      const st = statfsSync(this.artifacts.root);
      return Number(st.bavail) * Number(st.bsize);
    } catch {
      return null;
    }
  }

  usage(): { bytes: number; budget: number } {
    return { bytes: this.artifacts.sizeOnDisk(), budget: V4_LIMITS.cacheBudgetBytes };
  }

  // ------------------------------------------------------------------ mark (one short transaction per object)

  #markArtifact(id: string, jobId: string | null, stepId: string | null): IntentRow | null {
    return this.store.tx(() => {
      const a = this.store.get<{ gc_state: string; gc_generation: number; size_bytes: number; relative_path: string }>("SELECT gc_state, gc_generation, size_bytes, relative_path FROM artifacts WHERE id = ?", id);
      if (!a || a.gc_state !== "live" && a.gc_state !== "unavailable") return null;
      if (this.referenced().has(id)) return null; // a reference appeared since the scan: the reference wins
      const intentId = `gci_${randomUUID()}`;
      this.store.run(
        "INSERT INTO gc_delete_intents (id, job_id, step_id, object_kind, object_id, gc_generation, source_path, phase, logical_bytes, created_at, updated_at) VALUES (?, ?, ?, 'artifact', ?, ?, ?, 'marked', ?, ?, ?)",
        intentId, jobId, stepId, id, a.gc_generation, a.relative_path, a.size_bytes, this.now(), this.now(),
      );
      this.store.run("UPDATE artifacts SET gc_state = 'deleting', delete_intent_id = ? WHERE id = ?", intentId, id);
      return this.store.get<IntentRow>("SELECT * FROM gc_delete_intents WHERE id = ?", intentId)!;
    });
  }

  #markDir(kind: "staging" | "log", name: string, bytes: number, identity: string, jobId: string | null, stepId: string | null): IntentRow | null {
    return this.store.tx(() => {
      if (this.store.get("SELECT 1 FROM gc_delete_intents WHERE object_kind = ? AND object_id = ? AND phase IN ('marked','moved','unknown')", kind, name)) return null;
      if (kind === "staging") {
        const o = this.store.get<{ state: string; owner_id: string }>("SELECT state, owner_id FROM staging_owners WHERE path_key = ?", name);
        if (!o) return null;
        if (o.state === "open") {
          const b = this.store.get<{ status: string }>("SELECT status FROM build_jobs WHERE id = ?", o.owner_id);
          if (!b || b.status === "queued" || b.status === "building") return null;
        }
        if (this.store.get("SELECT 1 FROM artifact_pins WHERE object_kind = 'staging' AND object_id = ? AND state = 'held'", name)) return null;
      }
      const intentId = `gci_${randomUUID()}`;
      this.store.run(
        "INSERT INTO gc_delete_intents (id, job_id, step_id, object_kind, object_id, gc_generation, source_path, source_identity, phase, logical_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'marked', ?, ?, ?)",
        intentId, jobId, stepId, kind, name, name, identity, bytes, this.now(), this.now(),
      );
      return this.store.get<IntentRow>("SELECT * FROM gc_delete_intents WHERE id = ?", intentId)!;
    });
  }

  #phase(id: string, phase: IntentRow["phase"], f: Partial<Pick<IntentRow, "source_identity" | "trash_path" | "unlinked_bytes" | "error">> = {}): void {
    this.store.tx(() =>
      this.store.run(
        "UPDATE gc_delete_intents SET phase = ?, source_identity = COALESCE(?, source_identity), trash_path = COALESCE(?, trash_path), unlinked_bytes = COALESCE(?, unlinked_bytes), error = COALESCE(?, error), updated_at = ? WHERE id = ?",
        phase, f.source_identity ?? null, f.trash_path ?? null, f.unlinked_bytes ?? null, f.error ?? null, this.now(), id,
      ),
    );
  }

  #rootFor(i: IntentRow): string {
    return i.object_kind === "log" ? this.logDir! : this.artifacts.root;
  }

  #nameFor(i: IntentRow): string {
    return i.object_kind === "artifact" ? i.source_path : i.object_id;
  }

  /** Advance one intent from its phase to `recorded` (or `unknown`). Idempotent: used for new work and for recovery. */
  async advance(i: IntentRow): Promise<{ bytes: number; state: "recorded" | "unknown" | "aborted" }> {
    const root = this.#rootFor(i);
    const name = this.#nameFor(i);
    let cur = i;
    if (cur.phase === "marked") {
      if (cur.object_kind === "artifact") {
        const a = this.store.get<{ gc_generation: number; delete_intent_id: string | null; gc_state: string }>("SELECT gc_generation, delete_intent_id, gc_state FROM artifacts WHERE id = ?", cur.object_id);
        // a newer physical generation never belongs to an old intent
        if (a && (a.delete_intent_id !== cur.id || a.gc_generation !== cur.gc_generation)) {
          this.#phase(cur.id, "aborted", { error: "the object has a newer generation" });
          return { bytes: 0, state: "aborted" };
        }
      }
      if (cur.object_kind === "log") {
        const r = await this.worker.call({ op: "unlink-file", root, name, expectIdentity: cur.source_identity });
        if (!r.ok) {
          this.#phase(cur.id, "unknown", { error: String(r.error) });
          return { bytes: 0, state: "unknown" };
        }
        this.#phase(cur.id, "deleted", { unlinked_bytes: Number(r.bytes ?? 0) });
        this.#phase(cur.id, "recorded");
        return { bytes: Number(r.bytes ?? 0), state: "recorded" };
      }
      const ins = await this.worker.call({ op: "inspect", root, name });
      if (!ins.ok) {
        this.#phase(cur.id, "unknown", { error: String(ins.error) });
        return { bytes: 0, state: "unknown" };
      }
      if (cur.source_identity && ins.exists && ins.identity !== cur.source_identity) {
        this.#phase(cur.id, "unknown", { error: "IDENTITY_CHANGED" });
        return { bytes: 0, state: "unknown" };
      }
      const trashName = cur.id;
      const mv = await this.worker.call({ op: "move", root, name, trashName, expectIdentity: cur.source_identity ?? (ins.exists ? ins.identity : null) });
      fault("gc.after_move");
      if (!mv.ok) {
        this.#phase(cur.id, "unknown", { error: String(mv.error) });
        return { bytes: 0, state: "unknown" };
      }
      this.#phase(cur.id, "moved", { source_identity: (ins.identity as string) ?? null, trash_path: trashName });
      cur = this.store.get<IntentRow>("SELECT * FROM gc_delete_intents WHERE id = ?", cur.id)!;
    }
    if (cur.phase === "moved") {
      const rm = await this.worker.call({ op: "remove", root, trashName: cur.trash_path ?? cur.id });
      fault("gc.after_remove");
      if (!rm.ok) {
        this.#phase(cur.id, "unknown", { error: String(rm.error) });
        return { bytes: 0, state: "unknown" };
      }
      this.#phase(cur.id, "deleted", { unlinked_bytes: Number(rm.bytes ?? 0) });
      cur = this.store.get<IntentRow>("SELECT * FROM gc_delete_intents WHERE id = ?", cur.id)!;
    }
    if (cur.phase === "deleted") {
      this.store.tx(() => {
        if (cur.object_kind === "artifact") {
          const id = cur.object_id;
          // links of never-activated revisions go; histories, receipts and deployment facts stay (the row is kept as
          // `unavailable` when anything still names it)
          this.store.run("DELETE FROM revision_artifacts WHERE artifact_id = ? AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.app_id = revision_artifacts.app_id AND r.id = revision_artifacts.revision_id AND r.first_activated_at IS NOT NULL)", id);
          const named = this.store.get("SELECT 1 FROM runtime_instances WHERE artifact_id = ?", id) || this.store.get("SELECT 1 FROM deployments WHERE artifact_id = ?", id) || this.store.get("SELECT 1 FROM build_jobs WHERE artifact_id = ?", id) || this.store.get("SELECT 1 FROM revision_artifacts WHERE artifact_id = ?", id);
          if (named) this.store.run("UPDATE artifacts SET gc_state = 'unavailable', delete_intent_id = NULL, gc_generation = gc_generation + 1 WHERE id = ? AND delete_intent_id = ?", id, cur.id);
          else this.store.run("DELETE FROM artifacts WHERE id = ? AND delete_intent_id = ?", id, cur.id);
          this.store.run("UPDATE artifact_pins SET state = 'released', released_at = ? WHERE object_kind = 'artifact' AND object_id = ? AND state = 'held'", this.now(), id);
        }
        if (cur.object_kind === "staging") this.store.run("DELETE FROM staging_owners WHERE path_key = ?", cur.object_id);
        this.store.run("UPDATE gc_delete_intents SET phase = 'recorded', updated_at = ? WHERE id = ?", this.now(), cur.id);
      });
      fault("gc.after_record");
      return { bytes: cur.unlinked_bytes ?? 0, state: "recorded" };
    }
    return { bytes: 0, state: cur.phase === "recorded" ? "recorded" : "unknown" };
  }

  /** Startup: finish every intent from its persisted phase (before online GC opens again). */
  async recover(): Promise<{ resumed: number; unknown: number }> {
    const open = this.store.all<IntentRow>("SELECT * FROM gc_delete_intents WHERE phase IN ('marked','moved','deleted') ORDER BY created_at");
    let unknown = 0;
    for (const i of open) {
      const r = await this.advance(i).catch((e) => {
        this.#phase(i.id, "unknown", { error: (e as Error).message });
        return { state: "unknown" as const, bytes: 0 };
      });
      if (r.state === "unknown") unknown++;
    }
    return { resumed: open.length, unknown };
  }

  /** Restore (spec §23.4): intents of the old database never touch the new physical objects. */
  invalidateForRestoreInTx(): void {
    this.store.run("UPDATE gc_delete_intents SET phase = 'aborted', error = 'workspace restored', updated_at = ? WHERE phase IN ('marked','moved','unknown')", this.now());
    this.store.run("UPDATE artifacts SET gc_state = 'unavailable', delete_intent_id = NULL, gc_generation = gc_generation + 1 WHERE gc_state IN ('deleting','marked')");
  }

  /** Plan (read-only): candidates, protected bytes and report-only directories. */
  async plan(): Promise<{ artifacts: { id: string; bytes: number }[]; staging: { name: string; bytes: number; identity: string }[]; protectedBytes: number; protectedObjects: number; reportedOnly: { name: string; reason: string }[] }> {
    const keep = this.referenced();
    const rows = this.store.all<{ id: string; size_bytes: number; gc_state: string }>("SELECT id, size_bytes, gc_state FROM artifacts WHERE gc_state IN ('live','unavailable')");
    const out = { artifacts: [] as { id: string; bytes: number }[], staging: [] as { name: string; bytes: number; identity: string }[], protectedBytes: 0, protectedObjects: 0, reportedOnly: [] as { name: string; reason: string }[] };
    for (const r of rows) {
      if (keep.has(r.id)) {
        out.protectedBytes += r.size_bytes;
        out.protectedObjects++;
      } else if (r.gc_state === "live") out.artifacts.push({ id: r.id, bytes: r.size_bytes });
    }
    const list = await this.worker.call({ op: "list", root: this.artifacts.root });
    const registered = new Set(this.store.all<{ id: string }>("SELECT id FROM artifacts").map((r) => r.id.replace(/^sha256:/, "")));
    const now = this.store.clock.now();
    for (const e of (list.entries ?? []) as { name: string; identity: string; dir: boolean; symlink: boolean; mtimeMs: number }[]) {
      if (e.name === ".trash") continue;
      if (e.symlink) {
        out.reportedOnly.push({ name: e.name, reason: "symlink (never followed)" });
        continue;
      }
      if (/^[0-9a-f]{64}$/.test(e.name)) {
        if (!registered.has(e.name)) out.reportedOnly.push({ name: e.name, reason: "published directory without a database row (source cannot be verified)" });
        continue;
      }
      if (e.name.startsWith(".staging-")) {
        const o = this.store.get<{ state: string; owner_id: string; created_at: string }>("SELECT state, owner_id, created_at FROM staging_owners WHERE path_key = ?", e.name);
        if (!o) {
          out.reportedOnly.push({ name: e.name, reason: "staging directory without a registered owner" });
          continue;
        }
        const b = this.store.get<{ status: string; updated_at: string }>("SELECT status, updated_at FROM build_jobs WHERE id = ?", o.owner_id);
        const ended = !b || !["queued", "building"].includes(b.status);
        const endedAt = b ? Date.parse(b.updated_at) : Date.parse(o.created_at);
        if (ended && now - endedAt >= V4_LIMITS.stagingGraceMs) {
          const ins = await this.worker.call({ op: "inspect", root: this.artifacts.root, name: e.name });
          if (ins.ok && ins.exists) out.staging.push({ name: e.name, bytes: Number(ins.bytes ?? 0), identity: String(ins.identity) });
        }
        continue;
      }
      out.reportedOnly.push({ name: e.name, reason: "unknown entry in the cache root" });
    }
    return out;
  }

  /**
   * Run one bounded collection (batches of ≤100 objects / 256 MiB / 10 s; yields between batches when the host is
   * busy). `targetBytes`: stop once the cache is at or below it. `cancelled` is checked before each object.
   */
  async collect(opts: { jobId?: string | null; stepId?: string | null; targetBytes?: number; cancelled?: () => boolean; maxBatches?: number } = {}): Promise<GcReport> {
    const freeBefore = this.#free();
    const p = await this.plan();
    const rep: GcReport = { objects: 0, bytesUnlinked: 0, logicalBytes: 0, freeBefore, freeAfter: null, protectedBytes: p.protectedBytes, protectedObjects: p.protectedObjects, reportedOnly: p.reportedOnly, yielded: false, remaining: 0, unknown: 0, noReclaimable: false };
    const queue: ({ kind: "artifact"; id: string; bytes: number } | { kind: "staging"; name: string; bytes: number; identity: string })[] = [
      ...p.staging.map((s) => ({ kind: "staging" as const, ...s })),
      ...p.artifacts.map((a) => ({ kind: "artifact" as const, ...a })),
    ];
    if (queue.length === 0) {
      rep.noReclaimable = true;
      rep.freeAfter = this.#free();
      return rep;
    }
    let batches = 0;
    while (queue.length > 0 && !this.stopped) {
      if (opts.targetBytes !== undefined && this.artifacts.sizeOnDisk() <= opts.targetBytes) break;
      const started = Date.now();
      let n = 0;
      let bytes = 0;
      while (queue.length > 0 && n < V4_LIMITS.gcBatchObjects && bytes < V4_LIMITS.gcBatchBytes && Date.now() - started < V4_LIMITS.gcBatchMs) {
        if (opts.cancelled?.() || this.stopped) {
          rep.remaining = queue.length;
          rep.freeAfter = this.#free();
          return rep;
        }
        const o = queue.shift()!;
        const intent = o.kind === "artifact" ? this.#markArtifact(o.id, opts.jobId ?? null, opts.stepId ?? null) : this.#markDir("staging", o.name, o.bytes, o.identity, opts.jobId ?? null, opts.stepId ?? null);
        if (!intent) continue;
        fault("gc.after_mark");
        const r = await this.advance(intent);
        n++;
        bytes += intent.logical_bytes;
        if (r.state === "recorded") {
          rep.objects++;
          rep.bytesUnlinked += r.bytes;
          rep.logicalBytes += intent.logical_bytes;
        } else if (r.state === "unknown") rep.unknown++;
      }
      batches++;
      if (opts.maxBatches !== undefined && batches >= opts.maxBatches) {
        rep.remaining = queue.length;
        rep.yielded = queue.length > 0;
        break;
      }
      if (queue.length > 0) {
        rep.yielded = true;
        // yield to the event loop and to foreground work; re-check references in the next batch's mark transactions
        await new Promise((r) => setTimeout(r, this.busy() ? 500 : 10));
      }
    }
    rep.remaining = queue.length;
    rep.freeAfter = this.#free();
    if (rep.objects === 0 && rep.unknown === 0) rep.noReclaimable = true;
    return rep;
  }

  // ------------------------------------------------------------------ closed log cleanup (spec §17.4)

  /** Only rotated, closed `host.log.<stamp>` files of this workspace; host.log (the active file) is never touched. */
  async cleanLogs(opts: { retentionMs: number; retentionBytes: number; jobId?: string | null; stepId?: string | null; cancelled?: () => boolean }): Promise<{ removed: number; bytes: number; kept: number; unknown: number }> {
    if (!this.logDir) return { removed: 0, bytes: 0, kept: 0, unknown: 0 };
    const list = await this.worker.call({ op: "list", root: this.logDir });
    const closed = ((list.entries ?? []) as { name: string; identity: string; file: boolean; bytes: number; mtimeMs: number }[])
      .filter((e) => e.file && /^host\.log\.\d{8}T\d{6}(\.\d{1,4})?Z$/.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name)); // oldest first
    let total = closed.reduce((s, e) => s + e.bytes, 0);
    const now = Date.now();
    const out = { removed: 0, bytes: 0, kept: 0, unknown: 0 };
    for (const e of closed) {
      if (opts.cancelled?.()) break;
      const old = now - e.mtimeMs > opts.retentionMs;
      const over = total > opts.retentionBytes;
      if (!old && !over) {
        out.kept++;
        continue;
      }
      const intent = this.#markDir("log", e.name, e.bytes, e.identity, opts.jobId ?? null, opts.stepId ?? null);
      if (!intent) continue;
      const r = await this.advance(intent);
      if (r.state === "recorded") {
        out.removed++;
        out.bytes += r.bytes;
        total -= e.bytes;
      } else out.unknown++;
    }
    return out;
  }

  metrics(): Record<string, unknown> {
    return {
      pinsHeld: this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM artifact_pins WHERE state = 'held'")!.n,
      intentsOpen: this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM gc_delete_intents WHERE phase IN ('marked','moved','deleted')")!.n,
      intentsUnknown: this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM gc_delete_intents WHERE phase = 'unknown'")!.n,
      ioQueue: this.worker.busy,
    };
  }
}

export const trashDirOf = (root: string) => path.join(root, ".trash");
