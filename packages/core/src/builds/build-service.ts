import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AgentOsError,
  RUNNER_ABI_VERSION,
  canonicalJson,
  sha256Hex,
  type CodeBundle,
  type RuntimeLock,
  type ValidationIssue, isCodeBundle } from "@agentos/contracts";
import { iso, type Store } from "../persistence/store.js";
import { fault } from "../faults.js";
import { ArtifactStore } from "./artifact-store.js";
import { InstanceBridge } from "../runtime/bridge.js";
import type { RuntimeDriver } from "../runtime/driver.js";
import { RUNTIME_POLICY } from "../runtime/policy.js";
import type { RuntimeCatalogService } from "../runtime/catalog-service.js";

export interface BuildJobRow {
  id: string;
  app_id: string;
  revision_id: string;
  build_key: string;
  runtime_lock_id: string;
  status: "queued" | "building" | "succeeded" | "failed" | "cancelled";
  attempt: number;
  container_name: string;
  container_id: string | null;
  host_boot_id: string | null;
  artifact_id: string | null;
  deadline_at: string;
  error_json: string | null;
}

export interface BuildDiagnostic {
  stage: string;
  path: string;
  code: string;
  message: string;
}

export class BuildError extends Error {
  constructor(readonly code: "BUILD_FAILED" | "BUILD_TIMEOUT" | "BUILD_NONDETERMINISTIC" | "IMAGE_UNAVAILABLE" | "ARTIFACT_UNAVAILABLE" | "SANDBOX_UNAVAILABLE" | "DEPENDENCY_NOT_ALLOWED", message: string, readonly diagnostics: BuildDiagnostic[] = []) {
    super(message);
  }
}

export interface BuildContext {
  store: Store;
  artifacts: ArtifactStore;
  driver: RuntimeDriver | null;
  catalog: RuntimeCatalogService;
  storeUUID: () => string;
  bootId: () => string;
  workDir: string;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Cache budget (spec §12.3, default 10 GiB) and the collector run before refusing a build for space. */
  cacheBudgetBytes?: number;
  collect?: () => Promise<void>;
  /** Minimum free bytes on the data filesystem for a new build. */
  minFreeBytes?: number;
  /** Test hook: shorter compile limit than the policy's 60 s. */
  compileTimeoutMs?: number;
}

/** buildKey (spec §12.2 step 2): revision, runtime lock, platform, builder recipe, ABI and policy version. */
export function buildKey(revisionId: string, lock: RuntimeLock): string {
  return `sha256:${sha256Hex(
    canonicalJson({ revisionId, runtimeLockId: lock.id, platform: lock.platform, builder: lock.builderImage.recipeHash, abi: lock.abiVersion, policy: RUNTIME_POLICY.version }),
  )}`;
}

/**
 * Builds a code revision into an immutable artifact inside a no-network builder container (spec §12.2), with
 * single-flight per buildKey, cache verification, nondeterminism detection, and persistent job identity.
 */
export class BuildService {
  #inflight = new Map<string, Promise<string>>();
  constructor(private readonly ctx: BuildContext) {}

  private now(): string {
    return iso(this.ctx.store.clock.now());
  }

  /** Artifact already linked to the revision: intact, or missing/damaged (then it must be rebuilt to the same id). */
  linkedArtifact(appId: string, revisionId: string): { id: string; intact: boolean } | null {
    const row = this.ctx.store.get<{ artifact_id: string; gc_state: string }>(
      "SELECT ra.artifact_id, a.gc_state FROM revision_artifacts ra JOIN artifacts a ON a.id = ra.artifact_id WHERE ra.app_id = ? AND ra.revision_id = ?",
      appId,
      revisionId,
    );
    if (!row) return null;
    const problem = this.ctx.artifacts.verify(row.artifact_id);
    if (problem !== null) {
      if (row.gc_state !== "unavailable") this.ctx.store.tx(() => this.ctx.store.run("UPDATE artifacts SET gc_state = 'unavailable' WHERE id = ?", row.artifact_id));
      this.ctx.log?.("linked artifact unavailable; rebuilding from the fixed recipe", { artifactId: row.artifact_id, problem });
      return { id: row.artifact_id, intact: false };
    }
    if (row.gc_state === "unavailable") this.ctx.store.tx(() => this.ctx.store.run("UPDATE artifacts SET gc_state = 'live', verified_at = ? WHERE id = ?", this.now(), row.artifact_id));
    return { id: row.artifact_id, intact: true };
  }

  /**
   * Return a verified artifact for the revision, building it when needed. Linking a revision to an artifact is
   * permanent; a damaged linked artifact is reported, never silently replaced.
   */
  async ensureArtifact(appId: string, revisionId: string, deadlineMs: number, onStage?: (stage: string, buildJobId?: string) => void): Promise<{ artifactId: string; buildJobId: string | null; cacheHit: boolean }> {
    const linked = this.linkedArtifact(appId, revisionId);
    if (linked?.intact) return { artifactId: linked.id, buildJobId: null, cacheHit: true };
    const s = this.ctx.store;
    const raw = s.get<{ bundle_json: string }>("SELECT bundle_json FROM revisions WHERE app_id = ? AND id = ?", appId, revisionId);
    if (!raw) throw new AgentOsError("NOT_FOUND", "revision not found", { revisionId });
    const bundle = JSON.parse(raw.bundle_json) as CodeBundle;
    if (!isCodeBundle(bundle)) throw new AgentOsError("INVALID_REQUEST", "only code revisions are built");
    const lock = this.ctx.catalog.requireLock(bundle.runtimeLockId);
    const key = buildKey(revisionId, lock);

    // Cache: a verified artifact for the same buildKey (never for a revision whose linked artifact must be reproduced).
    const cached = linked ? [] : s.all<{ id: string }>("SELECT id FROM artifacts WHERE build_key = ? AND gc_state = 'live' ORDER BY created_at ASC", key);
    for (const c of cached) {
      if (this.ctx.artifacts.verify(c.id) === null) {
        try {
          s.tx(() => this.link(appId, revisionId, lock.id, c.id));
          return { artifactId: c.id, buildJobId: null, cacheHit: true };
        } catch (e) {
          if ((e as AgentOsError).code !== "ARTIFACT_GC_PENDING") throw e;
          continue; // GC won the race for this object: build a new physical generation instead
        }
      }
      s.tx(() => s.run("UPDATE artifacts SET gc_state = 'unavailable' WHERE id = ?", c.id));
    }

    const existing = this.#inflight.get(key);
    if (!existing) await this.#ensureSpace();
    if (existing) {
      const artifactId = await existing;
      return { artifactId, buildJobId: null, cacheHit: false };
    }
    const job = s.tx(() => {
      const open = s.get<BuildJobRow>("SELECT * FROM build_jobs WHERE build_key = ? AND status IN ('queued','building')", key);
      if (open) return open;
      const running = s.get<{ n: number }>("SELECT COUNT(*) AS n FROM build_jobs WHERE status IN ('queued','building')")!.n;
      if (running >= RUNTIME_POLICY.maxBuildConcurrency) throw new AgentOsError("DEPLOYMENT_BUSY", "another build is running; try again shortly");
      const id = randomUUID();
      const now = this.now();
      s.run(
        "INSERT INTO build_jobs (id, app_id, revision_id, build_key, runtime_lock_id, status, attempt, container_name, container_id, host_boot_id, artifact_id, deadline_at, error_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, NULL, ?, NULL, ?, ?)",
        id, appId, revisionId, key, lock.id, `agentos-b-${id.slice(0, 12)}`, iso(deadlineMs), now, now,
      );
      s.event("build.queued", { buildJobId: id, revisionId }, { appId });
      return s.get<BuildJobRow>("SELECT * FROM build_jobs WHERE id = ?", id)!;
    });
    onStage?.("building", job.id);
    const p = this.runJob(job, bundle, lock, deadlineMs, linked?.id ?? null);
    this.#inflight.set(key, p);
    try {
      const artifactId = await p;
      return { artifactId, buildJobId: job.id, cacheHit: false };
    } finally {
      this.#inflight.delete(key);
    }
  }

  /** Space admission (spec §12.3): collect unreferenced content first; still short → refuse with the reason. */
  async #ensureSpace(): Promise<void> {
    const budget = this.ctx.cacheBudgetBytes ?? RUNTIME_POLICY.cacheBudgetBytes;
    const minFree = this.ctx.minFreeBytes ?? 256 * 1024 * 1024;
    const free = () => {
      try {
        const st = statfsSync(this.ctx.artifacts.root);
        return Number(st.bavail) * Number(st.bsize);
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    };
    if (this.ctx.artifacts.sizeOnDisk() <= budget && free() >= minFree) return;
    await this.ctx.collect?.();
    if (this.ctx.artifacts.sizeOnDisk() > budget) throw new AgentOsError("APP_RESOURCE_LIMIT", `the build cache is over its ${Math.round(budget / 2 ** 20)} MiB budget even after cleanup; history is kept, so free space or raise the budget`);
    if (free() < minFree) throw new AgentOsError("APP_RESOURCE_LIMIT", `less than ${Math.round(minFree / 2 ** 20)} MiB free on the data disk; new builds are refused`);
  }

  private link(appId: string, revisionId: string, lockId: string, artifactId: string): void {
    const s = this.ctx.store;
    const g = s.get<{ gc_state: string }>("SELECT gc_state FROM artifacts WHERE id = ?", artifactId);
    if (g && (g.gc_state === "deleting" || g.gc_state === "marked")) throw new AgentOsError("ARTIFACT_GC_PENDING", "the cached artifact is being cleaned up", { artifactId });
    const prior = s.get<{ artifact_id: string }>("SELECT artifact_id FROM revision_artifacts WHERE app_id = ? AND revision_id = ?", appId, revisionId);
    if (prior) {
      if (prior.artifact_id !== artifactId) throw new BuildError("BUILD_NONDETERMINISTIC", `revision already points at ${prior.artifact_id}`);
      return;
    }
    s.run("INSERT INTO revision_artifacts (app_id, revision_id, runtime_lock_id, artifact_id, created_at) VALUES (?, ?, ?, ?, ?)", appId, revisionId, lockId, artifactId, this.now());
  }

  private finishJob(id: string, status: "succeeded" | "failed" | "cancelled", fields: { artifactId?: string; error?: unknown }): void {
    const s = this.ctx.store;
    s.run(
      "UPDATE build_jobs SET status = ?, artifact_id = COALESCE(?, artifact_id), error_json = ?, updated_at = ? WHERE id = ? AND status IN ('queued','building')",
      status, fields.artifactId ?? null, fields.error === undefined ? null : JSON.stringify(fields.error), this.now(), id,
    );
    s.event(`build.${status}`, { buildJobId: id, artifactId: fields.artifactId ?? null }, {});
  }

  private async runJob(job: BuildJobRow, bundle: CodeBundle, lock: RuntimeLock, deadlineMs: number, expectId: string | null = null): Promise<string> {
    const s = this.ctx.store;
    const driver = this.ctx.driver;
    const fail = (e: BuildError): never => {
      s.tx(() => this.finishJob(job.id, e.code === "BUILD_TIMEOUT" ? "failed" : "failed", { error: { code: e.code, message: e.message, diagnostics: e.diagnostics } }));
      throw e;
    };
    if (!driver) fail(new BuildError("SANDBOX_UNAVAILABLE", "the container runtime is not available"));
    const workDir = path.join(this.ctx.workDir, `b-${job.id.slice(0, 12)}`);
    const srcDir = path.join(workDir, "src");
    const bridgeDir = path.join(workDir, "bridge");
    let output: { files: Record<string, string> } | null = null;
    let failure: { stage: string; diagnostics: BuildDiagnostic[] } | null = null;
    const bridge = new InstanceBridge(
      bridgeDir,
      {
        onBuild: (f) => {
          if (f.type === "buildOutput") output = f.payload as { files: Record<string, string> };
          else failure = f.payload as { stage: string; diagnostics: BuildDiagnostic[] };
        },
      },
      4 * 1024 * 1024,
    );
    try {
      try {
        await driver!.ensureImage({ ...lock.builderImage, role: "builder", profileId: lock.profileId }, { allowBuild: true });
      } catch (e) {
        fail(new BuildError("IMAGE_UNAVAILABLE", `builder image for ${lock.id} is not available: ${(e as Error).message}`));
      }
      // Source tree: only this candidate's files.
      rmSync(workDir, { recursive: true, force: true });
      mkdirSync(srcDir, { recursive: true, mode: 0o700 });
      for (const [p, text] of Object.entries(bundle.code.files)) {
        const full = path.join(srcDir, p);
        if (!full.startsWith(`${srcDir}/src/`)) fail(new BuildError("BUILD_FAILED", `bad source path ${p}`));
        mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
        writeFileSync(full, text, { mode: 0o400 });
      }
      await bridge.listen();
      s.tx(() =>
        s.run("UPDATE build_jobs SET status = 'building', attempt = attempt + 1, host_boot_id = ?, updated_at = ? WHERE id = ?", this.ctx.bootId(), this.now(), job.id),
      );
      fault("build.before_container_create");
      const { id: containerId } = await driver!.create({
        name: job.container_name,
        image: lock.builderImage.name,
        role: "build",
        labels: {
          "agentos.store": this.ctx.storeUUID(),
          "agentos.role": "build",
          "agentos.app": job.app_id,
          "agentos.revision": job.revision_id,
          "agentos.instance": job.id,
          "agentos.boot": this.ctx.bootId(),
        },
        readOnlyMount: { hostPath: srcDir, containerPath: "/src" },
        bridgeDir,
        command: ["node", "/opt/agentos/builder/build.js"],
        env: { AGENTOS_SOCKET: "/run/agentos/host.sock", TZ: "UTC", NODE_OPTIONS: "--max-old-space-size=768" },
        limits: { memoryBytes: RUNTIME_POLICY.build.memoryBytes, cpus: RUNTIME_POLICY.build.cpus, pids: RUNTIME_POLICY.build.pids, tmpfsBytes: RUNTIME_POLICY.build.tmpfsBytes },
      });
      fault("build.after_container_create");
      s.tx(() => s.run("UPDATE build_jobs SET container_id = ?, updated_at = ? WHERE id = ?", containerId, this.now(), job.id));
      await driver!.start(containerId);
      const budget = Math.min(this.ctx.compileTimeoutMs ?? RUNTIME_POLICY.build.compileTimeoutMs, deadlineMs - this.ctx.store.clock.now());
      if (budget <= 0) fail(new BuildError("BUILD_TIMEOUT", "the build deadline passed before compilation started"));
      const until = Date.now() + budget;
      while (output === null && failure === null && Date.now() < until) {
        const st = await driver!.inspect(containerId);
        if (st.state === "exited" || st.state === "absent") {
          await new Promise((r) => setTimeout(r, 150)); // let the last frame arrive
          if (output === null && failure === null) {
            const tail = await driver!.diagnostics(containerId, 2048).catch(() => "");
            fail(new BuildError("BUILD_FAILED", st.oomKilled ? "the build ran out of memory" : `the builder exited (${st.exitCode ?? "?"}) without output`, [{ stage: "internal", path: "/", code: "BUILD_FAILED", message: tail.slice(-500) }]));
          }
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (output === null && failure === null) fail(new BuildError("BUILD_TIMEOUT", `compilation exceeded ${Math.round(budget / 1000)} s`));
      if (failure !== null) {
        const f = failure as { stage: string; diagnostics: BuildDiagnostic[] };
        const diags = (Array.isArray(f.diagnostics) ? f.diagnostics : []).slice(0, 20).map((d) => ({
          stage: String(f.stage).slice(0, 32),
          path: String(d.path ?? "/").slice(0, 300),
          code: String(d.code ?? "BUILD_FAILED").slice(0, 64),
          message: String(d.message ?? "").slice(0, 500),
        }));
        const dep = diags.some((d) => d.code === "DEPENDENCY_NOT_ALLOWED");
        fail(new BuildError(dep ? "DEPENDENCY_NOT_ALLOWED" : "BUILD_FAILED", `build failed at ${f.stage}`, diags));
      }
      // Validate the exported bytes: exactly app.mjs, bounded, plain text.
      const out = output as unknown as { files: Record<string, unknown> };
      const names = Object.keys(out.files ?? {});
      if (names.length !== 1 || names[0] !== "app.mjs" || typeof out.files["app.mjs"] !== "string") {
        fail(new BuildError("BUILD_FAILED", "builder returned unexpected files"));
      }
      const bytes = Buffer.from(out.files["app.mjs"] as string, "base64");
      fault("build.before_artifact_write");
      // A damaged copy of the artifact this revision is bound to is replaced only by byte-identical output.
      if (expectId !== null && this.ctx.artifacts.verify(expectId) !== null) this.ctx.artifacts.remove(expectId);
      let put: ReturnType<ArtifactStore["put"]>;
      try {
        put = this.ctx.artifacts.put({ "app.mjs": bytes }, { runtimeLockId: lock.id, platform: lock.platform, abiVersion: RUNNER_ABI_VERSION }, {
          beforeStaging: (name) => s.tx(() => s.run("INSERT INTO staging_owners (path_key, owner_kind, owner_id, state, created_at) VALUES (?, 'build', ?, 'open', ?)", name, job.id, this.now())),
          afterPublish: (name) => s.tx(() => s.run("UPDATE staging_owners SET state = 'closed', closed_at = ? WHERE path_key = ?", this.now(), name)),
        });
      } catch (e) {
        fail(new BuildError("BUILD_FAILED", `artifact rejected: ${(e as Error).message}`));
      }
      fault("build.after_artifact_write");
      const artifactId = put!.artifactId;
      s.tx(() => {
        // Same recipe, different output: stop, never overwrite (spec §12.2).
        if (expectId !== null && expectId !== artifactId) {
          throw new BuildError("BUILD_NONDETERMINISTIC", `rebuild of ${job.build_key} produced ${artifactId}, the revision is bound to ${expectId}`);
        }
        const other = s.get<{ id: string }>("SELECT id FROM artifacts WHERE build_key = ? AND id <> ? AND gc_state = 'live'", job.build_key, artifactId);
        if (other) throw new BuildError("BUILD_NONDETERMINISTIC", `rebuild of ${job.build_key} produced ${artifactId}, earlier ${other.id}`);
        // v0.4 (spec §17.2): an object in deletion never takes a new reference; the build waits and is retried.
        const cur = s.get<{ gc_state: string }>("SELECT gc_state FROM artifacts WHERE id = ?", artifactId);
        if (cur && (cur.gc_state === "deleting" || cur.gc_state === "marked")) throw new AgentOsError("ARTIFACT_GC_PENDING", "the same artifact is being cleaned up; the build is retried after it", { artifactId });
        if (expectId !== null || cur?.gc_state === "unavailable") s.run("UPDATE artifacts SET gc_state = 'live', verified_at = ? WHERE id = ?", this.now(), artifactId);
        if (!s.get("SELECT 1 FROM artifacts WHERE id = ?", artifactId)) {
          s.run(
            // a re-created object gets a new physical generation; an old delete intent never matches it (spec §17.2)
            "INSERT INTO artifacts (id, build_key, runtime_lock_id, platform, manifest_json, relative_path, size_bytes, verified_at, gc_state, created_at, gc_generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, (SELECT COALESCE(MAX(gc_generation), 0) + 1 FROM gc_delete_intents WHERE object_kind = 'artifact' AND object_id = ?))",
            artifactId, job.build_key, lock.id, lock.platform, put!.manifestBytes.toString("utf8"), this.ctx.artifacts.relativePath(artifactId), put!.sizeBytes, this.now(), this.now(), artifactId,
          );
        }
        this.link(job.app_id, job.revision_id, lock.id, artifactId);
        this.finishJob(job.id, "succeeded", { artifactId });
      });
      return artifactId;
    } catch (e) {
      if (e instanceof BuildError) {
        if (e.code === "BUILD_NONDETERMINISTIC") s.tx(() => this.finishJob(job.id, "failed", { error: { code: e.code, message: e.message } }));
        throw e;
      }
      s.tx(() => this.finishJob(job.id, "failed", { error: { code: "BUILD_FAILED", message: (e as Error).message } }));
      throw new BuildError("BUILD_FAILED", (e as Error).message);
    } finally {
      bridge.dispose();
      const name = job.container_name;
      await driver?.remove(name).catch((err) => this.ctx.log?.("build container cleanup failed; the reconciler will retry", { name, error: (err as Error).message }));
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  /**
   * Startup recovery (spec §15): build jobs of an earlier boot are finished as failed (their containers are removed
   * by the reconciler); a deployment that still needs the artifact starts a new job within its own budget.
   */
  recoverAfterBoot(): number {
    const s = this.ctx.store;
    return s.tx(() => {
      const open = s.all<BuildJobRow>("SELECT * FROM build_jobs WHERE status IN ('queued','building')");
      for (const j of open) this.finishJob(j.id, "failed", { error: { code: "BUILD_FAILED", message: "the host stopped during this build" } });
      return open.length;
    });
  }

  /** Diagnostics for a job (bounded). */
  jobError(id: string): { code: string; message: string; diagnostics?: ValidationIssue[] } | null {
    const r = this.ctx.store.get<{ error_json: string | null }>("SELECT error_json FROM build_jobs WHERE id = ?", id);
    return r?.error_json ? (JSON.parse(r.error_json) as { code: string; message: string }) : null;
  }
}
