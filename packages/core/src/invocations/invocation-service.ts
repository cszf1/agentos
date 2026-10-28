import { randomUUID } from "node:crypto";
import {
  AgentOsError,
  CODE_LIMITS,
  canonicalJson,
  checkMutationPlan,
  rpcValueIssue,
  sha256Hex,
  utf8Bytes,
  type AnyBundle,
  type CodeBundle,
  type FieldValue,
  type HandlerContext,
  type RecordEnvelopeV2, isCodeBundle } from "@agentos/contracts";
import { iso } from "../persistence/store.js";
import { fault } from "../faults.js";
import type { RuntimeContext } from "../runtime/context.js";
import type { AppRuntimeService } from "../runtime/app-runtime.js";
import { RUNTIME_POLICY } from "../runtime/policy.js";
import { commitMutations, type CommitResult } from "../records/mutations.js";
import { principalKey, type Principal } from "../capabilities/gateway.js";

export interface InvocationRow {
  id: string;
  app_id: string;
  revision_id: string;
  app_epoch: number;
  data_epoch: number;
  command_id: string;
  input_json: string;
  input_hash: string;
  request_key: string;
  principal_key: string;
  status: "accepted" | "executing" | "succeeded" | "failed";
  instance_id: string | null;
  generation: number | null;
  attempt: number;
  logical_time: string;
  deadline_at: string;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvocationDto {
  invocationId: string;
  appId: string;
  commandId: string;
  status: InvocationRow["status"];
  revisionId: string;
  appEpoch: number;
  dataEpoch: number;
  attempt: number;
  deadlineAt: string;
  result: unknown;
  commit: { created: Record<string, string>; updated: string[]; deleted: string[]; dataEpoch: number } | null;
  error: { code: string; message: string; details?: unknown } | null;
}

export interface QueryResult {
  output: unknown;
  revisionId: string;
  appEpoch: number;
  dataEpoch: number;
  runtimeGeneration: number;
}

/** A query or command bound to one revision snapshot. */
interface Snapshot {
  bundle: CodeBundle;
  revisionId: string;
  appEpoch: number;
  dataEpoch: number;
  records: RecordEnvelopeV2[];
}

/**
 * Daily path for code apps (spec §10): synchronous read-only queries and accepted commands whose mutation plans the
 * host validates and commits at most once per invocation.
 */
export class InvocationService {
  /** Set by the inter-app service: answers a running query's service calls. */
  #dispatching = new Set<string>();

  constructor(private readonly ctx: RuntimeContext, private readonly runtime: AppRuntimeService) {}

  private now(): string {
    return iso(this.ctx.store.clock.now());
  }

  /** Inside a read tx: the active code revision and its full visible record snapshot (spec §10.1). */
  snapshot(appId: string): Snapshot {
    const s = this.ctx.store;
    const app = s.get<{ active_revision_id: string | null; epoch: number; data_epoch: number }>("SELECT active_revision_id, epoch, data_epoch FROM apps WHERE id = ?", appId);
    if (!app) throw new AgentOsError("NOT_FOUND", "app not found");
    if (!app.active_revision_id) throw new AgentOsError("NOT_FOUND", "app has no active version yet");
    const bundle = this.ctx.apps.revisionBundle(appId, app.active_revision_id) as AnyBundle;
    if (!isCodeBundle(bundle)) throw new AgentOsError("INVALID_REQUEST", "this app version has no code queries or commands; use the records API");
    const rows = s.all<{ id: string; version: number; data_json: string; created_at: string; updated_at: string }>(
      "SELECT id, version, data_json, created_at, updated_at FROM records WHERE app_id = ? ORDER BY created_at ASC, id ASC LIMIT ?",
      appId, RUNTIME_POLICY.snapshotMaxRecords + 1,
    );
    if (rows.length > RUNTIME_POLICY.snapshotMaxRecords) throw new AgentOsError("LIMIT_EXCEEDED", `snapshots hold at most ${RUNTIME_POLICY.snapshotMaxRecords} records`);
    const visible = Object.keys(bundle.data.fields);
    let bytes = 0;
    const records = rows.map((r) => {
      const full = JSON.parse(r.data_json) as Record<string, FieldValue>;
      const data: Record<string, FieldValue> = {};
      for (const k of visible) if (Object.hasOwn(full, k)) data[k] = full[k]!;
      bytes += r.data_json.length + 160;
      return { id: r.id, recordVersion: r.version, createdAt: r.created_at, updatedAt: r.updated_at, data };
    });
    if (bytes > RUNTIME_POLICY.snapshotMaxBytes) throw new AgentOsError("LIMIT_EXCEEDED", "the record snapshot exceeds 20 MiB");
    return { bundle, revisionId: app.active_revision_id, appEpoch: app.epoch, dataEpoch: app.data_epoch, records };
  }

  /** Synchronous read-only query (spec §10.1). No write, no receipt; session/origin/epoch are checked by HTTP. */
  async query(appId: string, queryId: string, input: unknown, expectedAppEpoch: number, opts: { serviceDepth?: number } = {}): Promise<QueryResult> {
    const s = this.ctx.store;
    const snap = s.read(() => this.snapshot(appId));
    if (snap.appEpoch !== expectedAppEpoch) throw new AgentOsError("APP_EPOCH_STALE", "the app version changed; reload", { appEpoch: snap.appEpoch });
    const decl = Object.hasOwn(snap.bundle.queries, queryId) ? snap.bundle.queries[queryId] : undefined;
    if (!decl) throw new AgentOsError("UNKNOWN_HANDLER", `query "${queryId}" is not declared by this version`);
    const inIssue = rpcValueIssue(decl.inputSchema, input);
    if (inIssue) throw new AgentOsError("INVALID_REQUEST", `input ${inIssue.message}`, { path: `/input${inIssue.path === "/" ? "" : inIssue.path}` });
    const { inst, generation } = this.runtime.route(appId, { revisionId: snap.revisionId });
    const context: HandlerContext = {
      callId: randomUUID(), appId, revisionId: snap.revisionId, appEpoch: snap.appEpoch, dataEpoch: snap.dataEpoch,
      logicalTime: this.now(), deadline: iso(s.clock.now() + RUNTIME_POLICY.queryTimeoutMs), records: snap.records,
    };
    let usedGrants: string[] = [];
    const out = await this.ctx.instances!.call(inst, "query", queryId, input, context, RUNTIME_POLICY.queryTimeoutMs).finally(() => {
      usedGrants = [...inst.usedGrants];
    });
    if (utf8Bytes(canonicalJson(out ?? null)) > CODE_LIMITS.maxQueryOutputBytes) throw new AgentOsError("LIMIT_EXCEEDED", `query output exceeds ${CODE_LIMITS.maxQueryOutputBytes} bytes`);
    const outIssue = rpcValueIssue(decl.outputSchema, out);
    if (outIssue) throw new AgentOsError("INVALID_REQUEST", `the app returned output that does not match its schema at ${outIssue.path}: ${outIssue.message}`, { appError: "BAD_OUTPUT" });
    // An answer from an instance or revision that is no longer current is not a current result (spec §10.1).
    const still = s.read(() => {
      const a = s.get<{ epoch: number; active_revision_id: string }>("SELECT epoch, active_revision_id FROM apps WHERE id = ?", appId);
      const revoked = usedGrants.some((g) => s.get<{ revoked_at: string | null }>("SELECT revoked_at FROM service_grants WHERE id = ?", g)?.revoked_at);
      if (revoked) throw new AgentOsError("GRANT_REVOKED", "a service this view used was disconnected while it loaded; reload");
      return !!a && a.epoch === snap.appEpoch && a.active_revision_id === snap.revisionId && this.runtime.stillActive(appId, inst.id, generation);
    });
    if (!still) throw new AgentOsError("INSTANCE_STALE", "the app changed version while the query ran; reload");
    return { output: out, revisionId: snap.revisionId, appEpoch: snap.appEpoch, dataEpoch: snap.dataEpoch, runtimeGeneration: generation };
  }

  /** ABI 2 system-plan call setup (spec §11.2 step 2): the active instance and a read-only context. */
  prepareSystemPlanCall(appId: string, timeoutMs: number): { inst: import("../runtime/instances.js").LiveInstance; generation: number; context: HandlerContext; revisionId: string; appEpoch: number; dataEpoch: number } {
    const s = this.ctx.store;
    const snap = s.read(() => this.snapshot(appId));
    const { inst, generation } = this.runtime.route(appId, { revisionId: snap.revisionId });
    const context: HandlerContext = {
      callId: randomUUID(), appId, revisionId: snap.revisionId, appEpoch: snap.appEpoch, dataEpoch: snap.dataEpoch,
      logicalTime: this.now(), deadline: iso(s.clock.now() + timeoutMs), records: snap.records,
    };
    return { inst, generation, context, revisionId: snap.revisionId, appEpoch: snap.appEpoch, dataEpoch: snap.dataEpoch };
  }

  stillActive(appId: string, instanceId: string, generation: number): boolean {
    return this.runtime.stillActive(appId, instanceId, generation);
  }

  get(id: string): InvocationRow | undefined {
    return this.ctx.store.get<InvocationRow>("SELECT * FROM invocations WHERE id = ?", id);
  }

  dto(r: InvocationRow): InvocationDto {
    const res = r.result_json ? (JSON.parse(r.result_json) as { result: unknown; commit: InvocationDto["commit"] }) : null;
    return {
      invocationId: r.id,
      appId: r.app_id,
      commandId: r.command_id,
      status: r.status,
      revisionId: r.revision_id,
      appEpoch: r.app_epoch,
      dataEpoch: r.data_epoch,
      attempt: r.attempt,
      deadlineAt: r.deadline_at,
      result: res?.result ?? null,
      commit: res?.commit ?? null,
      error: r.error_json ? (JSON.parse(r.error_json) as InvocationDto["error"]) : null,
    };
  }

  /**
   * Accept a command (spec §10.2 steps 1–2), inside the gateway transaction that already checked session, client
   * epoch and the receipt. Returns the 202 body; the final business receipt is written by the commit.
   */
  acceptInTx(principal: Principal, appId: string, commandId: string, input: unknown, expectedAppEpoch: number, requestKey: string): { invocationId: string; status: string } {
    const s = this.ctx.store;
    const snapApp = s.get<{ active_revision_id: string | null; epoch: number; data_epoch: number }>("SELECT active_revision_id, epoch, data_epoch FROM apps WHERE id = ?", appId);
    if (!snapApp) throw new AgentOsError("NOT_FOUND", "app not found");
    if (snapApp.epoch !== expectedAppEpoch) throw new AgentOsError("APP_EPOCH_STALE", "the app version changed; reload before acting", { appEpoch: snapApp.epoch });
    const bundle = snapApp.active_revision_id ? (this.ctx.apps.revisionBundle(appId, snapApp.active_revision_id) as AnyBundle) : null;
    if (!bundle || !isCodeBundle(bundle)) throw new AgentOsError("INVALID_REQUEST", "this app version has no commands");
    const decl = Object.hasOwn(bundle.commands, commandId) ? bundle.commands[commandId] : undefined;
    if (!decl) throw new AgentOsError("UNKNOWN_HANDLER", `command "${commandId}" is not declared by this version`);
    if (utf8Bytes(canonicalJson(input ?? null)) > CODE_LIMITS.maxCommandInputBytes) throw new AgentOsError("LIMIT_EXCEEDED", `command input exceeds ${CODE_LIMITS.maxCommandInputBytes} bytes`);
    const inIssue = rpcValueIssue(decl.inputSchema, input);
    if (inIssue) throw new AgentOsError("INVALID_REQUEST", `input ${inIssue.message}`, { path: `/input${inIssue.path === "/" ? "" : inIssue.path}` });
    const ar = this.runtime.row(appId);
    if (!ar || ar.enabled === 0) throw new AgentOsError("RUNTIME_STOPPED", "this app is stopped; start it to use it");
    const id = randomUUID();
    const now = s.clock.now();
    s.run(
      `INSERT INTO invocations (id, app_id, revision_id, app_epoch, data_epoch, command_id, input_json, input_hash, request_key, principal_key, status, instance_id, generation, attempt, logical_time, deadline_at, result_json, error_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', NULL, NULL, 0, ?, ?, NULL, NULL, ?, ?)`,
      id, appId, snapApp.active_revision_id, snapApp.epoch, snapApp.data_epoch, commandId, canonicalJson(input ?? null), sha256Hex(canonicalJson(input ?? null)),
      requestKey, principalKey(principal), iso(now), iso(now + RUNTIME_POLICY.commandLifetimeMs), iso(now), iso(now),
    );
    s.event("invocation.accepted", { invocationId: id, commandId }, { appId });
    return { invocationId: id, status: "accepted" };
  }

  #finish(id: string, status: "succeeded" | "failed", fields: { result?: unknown; commit?: CommitResult | null; error?: { code: string; message: string; details?: unknown } }): void {
    const s = this.ctx.store;
    s.run(
      "UPDATE invocations SET status = ?, result_json = ?, error_json = ?, updated_at = ? WHERE id = ? AND status IN ('accepted','executing')",
      status,
      status === "succeeded" ? JSON.stringify({ result: fields.result ?? null, commit: fields.commit ? { created: fields.commit.created, updated: fields.commit.updated, deleted: fields.commit.deleted, dataEpoch: fields.commit.dataEpoch } : null }) : null,
      fields.error ? JSON.stringify(fields.error) : null,
      this.now(),
      id,
    );
    // The final business receipt, distinct from the 202 acceptance receipt (spec §10.3).
    const inv = this.get(id)!;
    s.run(
      "INSERT OR IGNORE INTO operations (principal, operation_key, request_hash, status_code, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      inv.principal_key, `invocation:${id}:commit`, inv.input_hash, status === "succeeded" ? 200 : 409, JSON.stringify({ ok: status === "succeeded", body: this.dto(inv) }), this.now(),
    );
    s.event(`invocation.${status}`, { invocationId: id, code: fields.error?.code ?? null }, { appId: inv.app_id });
  }

  failInTx(id: string, code: string, message: string, details?: unknown): void {
    this.#finish(id, "failed", { error: { code, message: message.slice(0, 800), ...(details !== undefined ? { details } : {}) } });
  }

  /** Execute and commit an accepted invocation (spec §10.2 steps 3–5). Safe to call again after a restart. */
  dispatch(id: string): Promise<void> {
    if (this.#dispatching.has(id)) return Promise.resolve();
    this.#dispatching.add(id);
    return this.#dispatch(id)
      .catch((e) => this.ctx.log("error", "invocation dispatch crashed", { invocationId: id, error: (e as Error).message }))
      .finally(() => this.#dispatching.delete(id));
  }

  async #dispatch(id: string): Promise<void> {
    const s = this.ctx.store;
    for (;;) {
      // Admission for this attempt: current version, data epoch, deadline, attempts.
      const step = s.tx(() => {
        const inv = this.get(id);
        if (!inv || inv.status === "succeeded" || inv.status === "failed") return { done: true as const };
        if (Date.parse(inv.deadline_at) <= s.clock.now()) {
          this.failInTx(id, "INVOCATION_EXPIRED", "the command did not complete within its lifetime; nothing was written");
          return { done: true as const };
        }
        if (inv.attempt >= RUNTIME_POLICY.commandMaxAttempts) {
          this.failInTx(id, "INVOCATION_LIMIT_EXCEEDED", "the command was executed the maximum number of times without completing");
          return { done: true as const };
        }
        const app = s.get<{ epoch: number; data_epoch: number; active_revision_id: string }>("SELECT epoch, data_epoch, active_revision_id FROM apps WHERE id = ?", inv.app_id)!;
        if (app.epoch !== inv.app_epoch || app.active_revision_id !== inv.revision_id) {
          this.failInTx(id, "APP_EPOCH_STALE", "the app version changed before the command ran; nothing was written", { appEpoch: app.epoch });
          return { done: true as const };
        }
        if (app.data_epoch !== inv.data_epoch) {
          this.failInTx(id, "DATA_EPOCH_STALE", "records changed before the command ran; nothing was written", { dataEpoch: app.data_epoch });
          return { done: true as const };
        }
        let routed;
        try {
          routed = this.runtime.route(inv.app_id, { revisionId: inv.revision_id });
        } catch (e) {
          const code = (e as AgentOsError).code;
          if (code === "INSTANCE_NOT_READY" && (e as AgentOsError).details?.health === "recovering") return { wait: true as const };
          this.failInTx(id, code ?? "INSTANCE_NOT_READY", (e as Error).message);
          return { done: true as const };
        }
        s.run(
          "UPDATE invocations SET status = 'executing', attempt = attempt + 1, instance_id = ?, generation = ?, updated_at = ? WHERE id = ?",
          routed.inst.id, routed.generation, this.now(), id,
        );
        const snap = this.snapshot(inv.app_id);
        return { inv: this.get(id)!, routed, snap };
      });
      if ("done" in step) return;
      if ("wait" in step) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      const { inv, routed, snap } = step;
      const decl = snap.bundle.commands[inv.command_id]!;
      const remaining = Date.parse(inv.deadline_at) - s.clock.now();
      const timeout = Math.max(1, Math.min(RUNTIME_POLICY.commandTimeoutMs, remaining));
      const context: HandlerContext = {
        callId: `${inv.id}:${inv.attempt}`, appId: inv.app_id, revisionId: inv.revision_id, appEpoch: inv.app_epoch, dataEpoch: inv.data_epoch,
        logicalTime: inv.logical_time, deadline: iso(s.clock.now() + timeout), records: snap.records,
      };
      let out: unknown;
      try {
        out = await this.ctx.instances!.call(routed.inst, "command", inv.command_id, JSON.parse(inv.input_json), context, timeout, {
          // The commit right is withdrawn before the kill (spec §11.3).
          onTimeout: () => s.tx(() => this.failInTx(id, "APP_TIMEOUT", `the command exceeded ${timeout} ms; the app was stopped and nothing was written`)),
        });
      } catch (e) {
        const ae = e as AgentOsError;
        if (ae.code === "INSTANCE_STALE" && this.get(id)?.status === "executing") {
          // The instance died mid-call: retry within the budget on a new instance (no business side effect yet).
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        s.tx(() => this.failInTx(id, ae.code ?? "INVALID_REQUEST", ae.message, ae.details));
        return;
      }
      fault("invocation.before_commit");
      // Validate the plan and the result before touching the database.
      const plan = checkMutationPlan(out);
      if (!plan.ok) return void s.tx(() => this.failInTx(id, "INVALID_MUTATION", `the app returned an invalid plan at ${plan.issue.path}: ${plan.issue.message}`));
      if (utf8Bytes(canonicalJson(plan.plan.result ?? null)) > CODE_LIMITS.maxCommandResultBytes) {
        return void s.tx(() => this.failInTx(id, "LIMIT_EXCEEDED", `the command result exceeds ${CODE_LIMITS.maxCommandResultBytes} bytes`));
      }
      const rIssue = rpcValueIssue(decl.outputSchema, plan.plan.result);
      if (rIssue) return void s.tx(() => this.failInTx(id, "INVALID_REQUEST", `the command result does not match its schema at ${rIssue.path}: ${rIssue.message}`));
      // Final commit: one transaction re-checks everything and writes changes, receipt, events and the end state.
      const outcome = s.tx((): "ok" | "stale" | "gone" => {
        const cur = this.get(id);
        if (!cur || cur.status !== "executing" || cur.attempt !== inv.attempt || cur.instance_id !== routed.inst.id) return "gone";
        if (Date.parse(cur.deadline_at) <= s.clock.now()) {
          this.failInTx(id, "INVOCATION_EXPIRED", "the command finished after its deadline; nothing was written");
          return "gone";
        }
        const app = s.get<{ epoch: number; active_revision_id: string }>("SELECT epoch, active_revision_id FROM apps WHERE id = ?", cur.app_id)!;
        if (app.epoch !== cur.app_epoch || app.active_revision_id !== cur.revision_id || !this.runtime.stillActive(cur.app_id, routed.inst.id, routed.generation) || routed.inst.revoked) {
          this.failInTx(id, "INSTANCE_STALE", "the app changed version or instance while the command ran; nothing was written");
          return "gone";
        }
        try {
          const commit = s.savepoint(() =>
            commitMutations(s, { appId: cur.app_id, bundle: snap.bundle, command: decl, contract: this.ctx.apps.contractOf(this.ctx.apps.requireApp(cur.app_id)), mutations: plan.plan.mutations, expectedDataEpoch: cur.data_epoch }),
          );
          this.#finish(id, "succeeded", { result: plan.plan.result, commit });
          return "ok";
        } catch (e) {
          const ae = e as AgentOsError;
          this.failInTx(id, ae.code ?? "INVALID_MUTATION", ae.message, ae.details);
          return "stale";
        }
      });
      if (outcome === "ok") fault("invocation.after_commit");
      return;
    }
  }

  /** Startup (spec §15): unfinished invocations retry within their budget if the data epoch still matches. */
  recoverAfterBoot(): string[] {
    const s = this.ctx.store;
    const open = s.all<{ id: string }>("SELECT id FROM invocations WHERE status IN ('accepted','executing')");
    s.tx(() => {
      for (const o of open) s.run("UPDATE invocations SET status = 'accepted', instance_id = NULL, generation = NULL, updated_at = ? WHERE id = ? AND status = 'executing'", this.now(), o.id);
    });
    for (const o of open) void this.dispatch(o.id);
    return open.map((o) => o.id);
  }
}
