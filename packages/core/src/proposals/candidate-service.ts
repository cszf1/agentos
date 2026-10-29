import { randomUUID } from "node:crypto";
import { AgentOsError, canonicalJson, isCodeBundle, sha256Hex, type CodeBundle } from "@agentos/contracts";
import { iso, type Store } from "../persistence/store.js";
import type { RuntimeSystem } from "../runtime/system.js";
import { RUNTIME_POLICY } from "../runtime/policy.js";
import type { OnlineGc } from "../builds/online-gc.js";
import { HOST_VERSION } from "@agentos/contracts";

export const FIXTURE_SET_VERSION = "preview-fixtures-v1";

interface CheckRow {
  id: string;
  run_id: string;
  app_id: string;
  revision_id: string;
  state: "queued" | "running" | "passed" | "failed" | "cancelled";
  result_json: string | null;
}

/**
 * Candidate validation (spec §19.2): a real build in the sandbox, a real preview container, the platform's fixed
 * fixtures (never real records), and — for a claimed improvement — the same timed fixture queries on the baseline and
 * the candidate (warm-up + repeated rounds, raw samples kept). It reuses BuildService, ArtifactStore and the deployment
 * fixture checks, but never creates a deployment, so it never holds the global Prepare slot; the container and the
 * build slot are released when the check ends. The candidate artifact stays pinned for the proposal's retention.
 */
export class CandidateService {
  constructor(
    private readonly store: Store,
    private readonly rt: RuntimeSystem,
    private readonly gc: OnlineGc | null,
  ) {}

  private now(): string {
    return iso(this.store.clock.now());
  }

  get(id: string): CheckRow | undefined {
    return this.store.get<CheckRow>("SELECT * FROM candidate_checks WHERE id = ?", id);
  }

  /** Register a check of the run's candidate and drive it in the background; returns the check id at once. */
  start(runId: string, appId: string, revisionId: string): { checkId: string; state: string } {
    const bundle = this.rt.core.apps.revisionBundle(appId, revisionId);
    if (!bundle || !isCodeBundle(bundle)) throw new AgentOsError("INVALID_REQUEST", "only a staged code revision can be checked");
    const app = this.rt.core.apps.requireApp(appId);
    const base = app.active_revision_id ? this.rt.core.apps.revisionBundle(appId, app.active_revision_id) : null;
    const { id, launch } = this.store.tx(() => {
      // A check already in flight is the same check. A passed check is reused only while the catalog it measured is
      // still the approved one; a catalog change needs a new check (spec §19.3 needs_recheck), and the old passed
      // result is not run again.
      const inflight = this.store.get<{ id: string }>("SELECT id FROM candidate_checks WHERE run_id = ? AND revision_id = ? AND state IN ('queued','running') ORDER BY created_at DESC LIMIT 1", runId, revisionId);
      if (inflight) return { id: inflight.id, launch: false };
      const passed = this.store.get<{ id: string }>("SELECT id FROM candidate_checks WHERE run_id = ? AND revision_id = ? AND state = 'passed' AND catalog_hash = ? ORDER BY created_at DESC LIMIT 1", runId, revisionId, this.rt.opts.catalog.hash);
      if (passed) return { id: passed.id, launch: false };
      const n = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM candidate_checks WHERE run_id = ?", runId)!.n;
      if (n >= 2) throw new AgentOsError("LIMIT_EXCEEDED", "at most 2 candidate checks per optimisation run");
      const cid = randomUUID();
      const lock = this.rt.opts.catalog.requireLock((bundle as CodeBundle).runtimeLockId);
      this.store.run(
        `INSERT INTO candidate_checks (id, run_id, app_id, revision_id, input_hash, fixture_set_version, runtime_lock_id, catalog_hash, tool_versions, limits_json, baseline_hash, candidate_hash, checker_identity, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        cid, runId, appId, revisionId, sha256Hex(canonicalJson({ appId, revisionId, base: app.active_revision_id })), FIXTURE_SET_VERSION, lock.id, this.rt.opts.catalog.hash,
        JSON.stringify({ host: HOST_VERSION, runtimeImage: lock.runtimeImage.name, builderImage: lock.builderImage.name, abi: lock.abiVersion }),
        JSON.stringify({ ...RUNTIME_POLICY.app, queryTimeoutMs: RUNTIME_POLICY.queryTimeoutMs }),
        base ? sha256Hex(canonicalJson(base)) : null, sha256Hex(canonicalJson(bundle)), `${lock.runtimeImage.name}#${lock.id}`, this.now(), this.now(),
      );
      return { id: cid, launch: true };
    });
    if (launch) void this.#run(id).catch((e) => this.#finish(id, "failed", { code: "CHECK_FAILED", message: (e as Error).message }));
    return { checkId: id, state: this.get(id)!.state };
  }

  status(id: string): { checkId: string; state: string; result: unknown } {
    const c = this.get(id);
    if (!c) throw new AgentOsError("NOT_FOUND", "check not found");
    return { checkId: c.id, state: c.state, result: c.result_json ? JSON.parse(c.result_json) : null };
  }

  #finish(id: string, state: "passed" | "failed" | "cancelled", result: Record<string, unknown>): void {
    this.store.tx(() => this.store.run("UPDATE candidate_checks SET state = ?, result_json = ?, updated_at = ? WHERE id = ? AND state IN ('queued','running')", state, JSON.stringify(result), this.now(), id));
    this.gc?.releaseOwner("candidate_check", id);
  }

  async #run(id: string): Promise<void> {
    const claimed = this.store.tx(() => this.store.run("UPDATE candidate_checks SET state = 'running', updated_at = ? WHERE id = ? AND state = 'queued'", this.now(), id).changes);
    if (claimed !== 1) return;
    const c = this.get(id)!;
    const apps = this.rt.core.apps;
    const app = apps.requireApp(c.app_id);
    const cand = apps.revisionBundle(c.app_id, c.revision_id) as CodeBundle;
    const v = apps.validate(c.app_id, c.revision_id);
    if (!v.valid) return this.#finish(id, "failed", { stage: "validate", issues: v.issues.slice(0, 20) });
    const deadline = this.store.clock.now() + RUNTIME_POLICY.prepareTimeoutMs;
    // build (the single build slot; waits instead of failing when another build runs)
    let artifactId: string;
    for (let i = 0; ; i++) {
      try {
        artifactId = (await this.rt.builds.ensureArtifact(c.app_id, c.revision_id, deadline)).artifactId;
        break;
      } catch (e) {
        const code = (e as AgentOsError).code;
        if ((code === "DEPLOYMENT_BUSY" || code === "ARTIFACT_GC_PENDING") && i < 120 && this.store.clock.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        return this.#finish(id, "failed", { stage: "build", code, message: (e as Error).message, diagnostics: (e as { diagnostics?: unknown }).diagnostics });
      }
    }
    this.gc?.pin("artifact", artifactId, "candidate_check", id);
    const cRes = await this.#measure(c.app_id, c.revision_id, app.epoch, cand, artifactId!, true);
    if (!cRes.ok) return this.#finish(id, "failed", { stage: "fixtures", ...cRes.problem });
    // baseline on the same fixtures, same limits, same procedure
    let baseline: { ok: true; samples: number[] } | { ok: false; problem: Record<string, unknown> } | null = null;
    if (app.active_revision_id) {
      const bb = apps.revisionBundle(c.app_id, app.active_revision_id);
      const link = this.store.get<{ artifact_id: string }>("SELECT artifact_id FROM revision_artifacts WHERE app_id = ? AND revision_id = ?", c.app_id, app.active_revision_id);
      if (bb && isCodeBundle(bb) && link) baseline = await this.#measure(c.app_id, app.active_revision_id, app.epoch, bb, link.artifact_id, false);
    }
    const summary = (ms: number[]) => {
      if (ms.length === 0) return null;
      const s = [...ms].sort((a, b) => a - b);
      const mean = s.reduce((x, y) => x + y, 0) / s.length;
      const sd = Math.sqrt(s.reduce((x, y) => x + (y - mean) ** 2, 0) / s.length);
      return { n: s.length, mean: +mean.toFixed(3), p50: +s[Math.floor(s.length / 2)]!.toFixed(3), p95: +s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!.toFixed(3), sd: +sd.toFixed(3) };
    };
    this.#finish(id, "passed", {
      fixtureSetVersion: FIXTURE_SET_VERSION,
      artifactId: artifactId!,
      fixtures: "platform preview fixtures only (empty + default collection); never real records",
      timing: {
        method: "main data-source queries on the default fixture; 3 warm-up rounds, 15 measured rounds; same container limits",
        candidate: { samplesMs: cRes.ok ? cRes.samples : [], summary: summary(cRes.ok ? cRes.samples : []) },
        baseline: baseline && baseline.ok ? { samplesMs: baseline.samples, summary: summary(baseline.samples) } : null,
        note: "a fixture timing is evidence for this fixture only, not a general claim",
      },
    });
  }

  /** One preview instance: launch, fixture checks, timed rounds, always destroyed. */
  async #measure(appId: string, revisionId: string, appEpoch: number, bundle: CodeBundle, artifactId: string, checks: boolean): Promise<{ ok: true; samples: number[] } | { ok: false; problem: Record<string, unknown> }> {
    const host = this.rt.ctx.instances;
    if (!host) return { ok: false, problem: { code: "SANDBOX_UNAVAILABLE", message: "no code runtime on this host" } };
    const s = this.store;
    const instanceId = randomUUID();
    const containerName = `agentos-c-${instanceId.slice(0, 12)}`;
    const admitted = s.tx(() => {
      if (this.rt.runtime.containerCount() >= RUNTIME_POLICY.maxContainers) return false;
      s.run(
        "INSERT INTO runtime_instances (id, app_id, revision_id, artifact_id, deployment_id, role, generation, host_boot_id, container_name, container_id, desired_state, observed_state, lease_digest, last_probe_at, exit_reason, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 'preview', 0, ?, ?, NULL, 'running', 'starting', '', NULL, NULL, ?, ?)",
        instanceId, appId, revisionId, artifactId, this.rt.bootId, containerName, this.now(), this.now(),
      );
      return true;
    });
    if (!admitted) return { ok: false, problem: { code: "APP_RESOURCE_LIMIT", message: "the container quota is full" } };
    let live;
    try {
      live = await host.launch({
        id: instanceId, appId, revisionId, artifactId, generation: 0, bootId: this.rt.bootId, containerName, role: "preview", bundle,
        lock: this.rt.opts.catalog.requireLock(bundle.runtimeLockId), storeUUID: this.rt.ctx.storeUUID,
      });
    } catch (e) {
      s.tx(() => s.run("UPDATE runtime_instances SET desired_state = 'removed', observed_state = 'failed', exit_reason = ?, updated_at = ? WHERE id = ?", (e as Error).message.slice(0, 300), this.now(), instanceId));
      return { ok: false, problem: { code: (e as AgentOsError).code ?? "PREPARE_FAILED", message: (e as Error).message } };
    }
    try {
      s.tx(() => s.run("UPDATE runtime_instances SET observed_state = 'ready', lease_digest = ?, updated_at = ? WHERE id = ?", live.leaseDigest, this.now(), instanceId));
      if (checks) {
        const problem = await this.rt.deployments.fixtureChecks(live, appId, revisionId, appEpoch, bundle);
        if (problem) return { ok: false, problem: problem as unknown as Record<string, unknown> };
      }
      const { previewRecords } = await import("../deployments/preview.js");
      const contract = this.rt.core.apps.contractOf(this.rt.core.apps.requireApp(appId));
      const records = previewRecords(bundle, contract, 2);
      const samples: number[] = [];
      const src = Object.values(bundle.view.dataSources)[0];
      if (src) {
        for (let round = 0; round < 18; round++) {
          const t0 = performance.now();
          await host.call(live, "query", src.queryId, src.input ?? {}, {
            callId: `check-${randomUUID()}`, appId, revisionId, appEpoch, dataEpoch: 0, logicalTime: this.now(), deadline: iso(this.store.clock.now() + RUNTIME_POLICY.queryTimeoutMs), records: records as never,
          } as never, RUNTIME_POLICY.queryTimeoutMs);
          if (round >= 3) samples.push(performance.now() - t0);
        }
      }
      return { ok: true, samples: samples.map((x) => +x.toFixed(3)) };
    } catch (e) {
      return { ok: false, problem: { code: (e as AgentOsError).code ?? "PREPARE_FAILED", message: (e as Error).message } };
    } finally {
      await host.destroy(live, "candidate check finished");
      s.tx(() => s.run("UPDATE runtime_instances SET desired_state = 'removed', observed_state = 'stopped', updated_at = ? WHERE id = ?", this.now(), instanceId));
    }
  }

  /** Startup: checks of an earlier boot never finished; they end failed (their containers were removed by the reconciler). */
  recover(): void {
    this.store.tx(() => this.store.run("UPDATE candidate_checks SET state = 'failed', result_json = ?, updated_at = ? WHERE state IN ('queued','running')", JSON.stringify({ code: "HOST_RESTARTED", message: "the host stopped during this check" }), this.now()));
    this.store.tx(() => this.store.run("UPDATE artifact_pins SET state = 'released', released_at = ? WHERE owner_kind = 'candidate_check' AND state = 'held'", this.now()));
  }
}
