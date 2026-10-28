import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  AgentOsError,
  CAPABILITIES,
  SYSTEM_LIMITS,
  TELEMETRY_SOCKET,
  canonicalJson,
  capabilityDecl,
  checkProviderParams,
  isV3,
  validateSystemPlanOutput,
  type CodeBundleV3,
  type Frame,
  type ObservationEnvelope,
  type ProviderReadPayload,
} from "@agentos/contracts";
import { TelemetryClient } from "@agentos/broker-client";
import type { Core } from "../index.js";
import { iso } from "../persistence/store.js";
import type { RuntimeSystem } from "../runtime/system.js";
import type { LiveInstance } from "../runtime/instances.js";
import { NativeUser, NativeWatcher, nativeBinDir } from "../providers/native-user.js";
import { ProviderReadService, paramError } from "../providers/provider-read-service.js";
import { buildPreview } from "../providers/preview.js";
import { ResourceService, type ResourceRow } from "../resources/resource-service.js";
import { ProviderGrantService, type GrantRow } from "../system-grants/grant-service.js";
import { ObservationService } from "../observations/observation-service.js";
import { SystemActionService, type ActionRow, type FrozenPlan } from "../system-actions/system-action-service.js";
import { BrokerLink } from "./broker-link.js";

export interface SystemCapabilitiesOptions {
  dataDir: string;
  log: (level: "info" | "warn" | "error", msg: string, f?: Record<string, unknown>) => void;
  brokerSocket?: string;
  telemetrySocket?: string;
  nativeBin?: string;
  /** Start background loops (tests may drive them by hand). */
  autoStart?: boolean;
}

export interface RunScope {
  resourceIds: string[];
  /** Capabilities the run may read (metadata/state) and propose (one plan). */
  readCapabilities: string[];
  proposeCapabilities: string[];
  frozenAt: string;
  policyVersion: string | null;
  resources: { resourceId: string; generation: number; kind: string }[];
}

/**
 * The v0.3 layer (spec §5): resources, provider grants, provider reads, system actions, observations and the broker
 * link, wired around the v0.1/v0.2 core. It owns no business transaction semantics of records; system actions are a
 * separate execution path with their own durable state.
 */
export class SystemCapabilities {
  readonly broker: BrokerLink;
  readonly native: NativeUser;
  readonly resources: ResourceService;
  readonly grants: ProviderGrantService;
  readonly observations: ObservationService;
  readonly reads: ProviderReadService;
  readonly actions: SystemActionService;
  readonly telemetryClient: TelemetryClient;
  watcher: NativeWatcher | null = null;
  booted = false;
  #refreshTimer: NodeJS.Timeout | null = null;

  constructor(readonly core: Core, public runtime: RuntimeSystem | null, readonly opts: SystemCapabilitiesOptions) {
    const storeUUID = core.store.meta().store_uuid;
    this.broker = new BrokerLink(core.store, storeUUID, opts.brokerSocket);
    this.native = new NativeUser(opts.nativeBin ?? nativeBinDir());
    this.resources = new ResourceService(core.store, this.native, storeUUID);
    this.grants = new ProviderGrantService(core.store, this.resources, this.broker, core.apps);
    this.observations = new ObservationService(core.store);
    this.reads = new ProviderReadService(this.resources, this.grants, this.observations, this.native, this.broker);
    this.actions = new SystemActionService(core.store, this.resources, this.grants, this.observations, this.reads, this.broker, path.join(opts.dataDir, "system-blobs"), opts.log);
    this.telemetryClient = new TelemetryClient(opts.telemetrySocket ?? process.env.AGENTOS_TELEMETRY_SOCKET ?? TELEMETRY_SOCKET);
    this.observations.onRefreshNeeded = (ids, reason) => void this.#refresh(ids, reason).catch((e) => {
      if (!this.#stopped) this.opts.log("warn", "state re-read failed", { reason, error: (e as Error).message });
    });
    this.grants.onChange = () => this.actions.kick();
    // Version switches: pending operations block; awaiting plans of the old version and its provider grants are void.
    core.apps.activationGate = (appId) => this.#activationGate(appId);
    if (runtime) this.attachRuntime(runtime);
  }

  attachRuntime(rt: RuntimeSystem): void {
    rt.beforeActivate = (appId) => this.prepareActivation(appId);
    this.runtime = rt;
    const inst = rt.ctx.instances;
    if (inst) inst.onProviderRead = (i, f) => this.handleProviderRead(i, f);
  }

  // ---------------------------------------------------------------- startup (spec §22.1 steps 2–4)

  async boot(): Promise<void> {
    this.resources.ensurePlatformResources();
    await this.broker.ensure();
    if (this.broker.status.brokerReady && this.broker.status.binding === "bound") {
      await this.syncCatalog().catch((e) => this.opts.log("warn", "broker describe failed", { error: (e as Error).message }));
    }
    // Reconcile existing facts before admitting anything new: delivery resumes from the durable outbox.
    if (this.opts.autoStart !== false) {
      this.actions.start();
      await this.actions.tick();
      this.startWatcher();
      this.observations.connectTelemetry(this.telemetryClient, () => this.registerWorkloads());
      this.#refreshTimer = setInterval(() => void this.#periodic(), 30_000);
    }
    this.booted = true;
  }

  async syncCatalog(): Promise<void> {
    const identity = this.broker.identity();
    const d = await this.broker.client.describe(identity);
    this.resources.syncFromBroker(d.resources);
  }

  async #periodic(): Promise<void> {
    await this.broker.ensure();
    if (this.broker.status.brokerReady && this.broker.status.binding === "bound") await this.syncCatalog().catch(() => undefined);
    this.observations.pruneNow();
  }

  startWatcher(): void {
    const bin = path.join(path.dirname(this.native.bin), "agentos-provider-user");
    this.watcher?.stop();
    this.watcher = new NativeWatcher(bin, (e) => this.observations.ingest(String(e.source ?? "native"), e), () => setTimeout(() => this.startWatcher(), 2000));
    const roots = this.resources.list().filter((r) => r.kind === "import-root" && r.status === "available").map((r) => ({ resourceId: r.id, path: r.host_path!, identity: JSON.parse(r.identity_json ?? "{}") }));
    const units = this.resources.list().filter((r) => r.kind === "service").map((r) => ({ resourceId: r.id, unit: String((JSON.parse(r.identity_json ?? "{}") as { unit?: string }).unit ?? "") })).filter((u) => u.unit);
    this.watcher.start({ roots, units });
  }

  /** Workload registry comes from the trusted catalog and RuntimeManager, verified against real cgroups (spec §18.1). */
  async registerWorkloads(): Promise<void> {
    for (const r of this.resources.list().filter((x) => x.kind === "service")) {
      const unit = String((JSON.parse(r.identity_json ?? "{}") as { unit?: string }).unit ?? "");
      if (!unit) continue;
      await this.telemetryClient.register(r.id, `/sys/fs/cgroup/system.slice/${unit}`, "unit").catch(() => undefined);
    }
  }

  #stopped = false;

  async shutdown(): Promise<void> {
    this.#stopped = true;
    this.actions.stop();
    this.watcher?.stop();
    this.observations.stopTelemetry();
    if (this.#refreshTimer) clearInterval(this.#refreshTimer);
    this.native.close();
    this.broker.client.close();
  }

  /** A gap/reconnect: drop incremental assumptions and re-read real state (spec §10, §18.2). */
  async #refresh(ids: string[] | "all", reason: string): Promise<void> {
    const targets = ids === "all" ? this.resources.list().filter((r) => r.status !== "gone") : ids.map((i) => this.resources.get(i)).filter((x): x is ResourceRow => !!x);
    for (const r of targets) {
      const cap = r.kind === "service" ? "service.describe" : r.kind === "import-root" ? "file.list" : r.kind === "host-network" ? "network.snapshot" : null;
      if (!cap) continue;
      try {
        await this.reads.read({ kind: "user" }, r, cap, {}, { timeoutMs: 2000 });
      } catch {
        /* the resource state itself shows unavailability */
      }
    }
    if (this.#stopped) return; // shut down while reading: the store may already be closed
    if (reason.startsWith("telemetry")) this.observations.telemetryRefreshed();
    else for (const src of ["inotify", "dbus", "udev"]) if (reason.startsWith(src)) this.observations.markRefreshed(src);
    this.core.store.tx(() => this.core.store.event("observation.refreshed", { reason, resources: targets.map((t) => t.id) }));
  }

  // ---------------------------------------------------------------- state (spec §22.1)

  state(): Record<string, unknown> {
    const b = this.broker.status;
    const providers: Record<string, { available: boolean; reason: string | null }> = {};
    const nativeOk = this.native.available;
    const brokerOk = b.brokerReady && b.binding === "bound" && b.workspaceState === "active";
    for (const p of ["file", "service", "network", "device", "telemetry"]) {
      if (p === "telemetry") providers[p] = { available: this.observations.telemetry.available, reason: this.observations.telemetry.reason };
      else providers[p] = { available: nativeOk, reason: nativeOk ? (brokerOk ? null : `reads only: ${b.diagnostic ?? "broker unavailable"}`) : "native reader not installed" };
    }
    return {
      brokerReady: brokerOk,
      broker: b,
      telemetryAvailable: this.observations.telemetry.available,
      telemetry: { ...this.observations.telemetry, counts: undefined },
      providers,
      systemWritesEnabled: brokerOk,
      openActions: this.core.store.get<{ n: number }>("SELECT count(*) AS n FROM system_actions WHERE state NOT IN ('succeeded','failed_no_effect','cancelled_no_effect','expired_no_effect','rejected')")!.n,
    };
  }

  providerCatalog(): unknown[] {
    const b = this.broker.status;
    return CAPABILITIES.map((c) => ({
      capabilityId: c.capabilityId, contractVersion: c.contractVersion, provider: c.provider, mode: c.mode, resourceKinds: c.resourceKinds, replayClass: c.replayClass,
      inputSchema: c.inputSchema, standingAllowed: c.standingAllowed, compensation: c.compensation, evidence: c.evidence, preconditions: c.preconditions,
      available: c.mode === "read" ? this.native.available || c.provider === "telemetry" : b.brokerReady && b.binding === "bound",
      confirmationPolicyMax: c.standingAllowed === "never" || c.mode === "read" ? "per_plan" : "standing",
    }));
  }

  // ---------------------------------------------------------------- version gate

  #activationGate(appId: string): void {
    const blockers = this.actions.activationBlockers(appId);
    if (blockers.length > 0) {
      throw new AgentOsError("SYSTEM_ACTION_PENDING", "a system operation of this app is not settled yet; resolve it before switching versions", { actions: blockers.map((a) => ({ actionId: a.id, state: a.state })) });
    }
    if (!this.grants.revocationsConfirmed(appId)) {
      // Revocation is committed in its own transaction and confirmed by the broker before a later attempt passes.
      setImmediate(() => void this.prepareActivation(appId).catch(() => undefined));
      throw new AgentOsError("GRANT_REVOKING", "provider grants of the current version are being revoked first; retry the switch when the broker confirmed", { appId });
    }
    this.actions.voidAwaitingForAppInTx(appId, "the app switched versions before the plan was confirmed");
  }

  /** Revoke provider grants for a version switch and wait (bounded) for the broker's durable confirmation. */
  async prepareActivation(appId: string, timeoutMs = 10_000): Promise<void> {
    if (this.actions.activationBlockers(appId).length > 0) throw new AgentOsError("SYSTEM_ACTION_PENDING", "a system operation of this app is not settled yet");
    this.core.store.tx(() => {
      this.grants.invalidateAppInTx(appId, "app version switch");
      this.actions.voidAwaitingForAppInTx(appId, "the app is switching versions");
    });
    const until = Date.now() + timeoutMs;
    while (!this.grants.revocationsConfirmed(appId)) {
      await this.grants.pump();
      if (this.grants.revocationsConfirmed(appId)) break;
      if (Date.now() > until) throw new AgentOsError("GRANT_REVOKING", "the broker has not confirmed the revocation; the current version stays active");
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // ---------------------------------------------------------------- app provider reads (ABI 2)

  async handleProviderRead(inst: LiveInstance, f: Frame): Promise<unknown> {
    const p = f.payload as Partial<ProviderReadPayload>;
    const callId = String(p.callId ?? "");
    // Only the current top-level call of this instance, and only queries / system-plan calls (spec §10, V3-G07).
    if (inst.revoked || inst.dead || p.parentCallId !== inst.currentCallId || !inst.currentCallId) throw new AgentOsError("INSTANCE_STALE", "provider reads belong to the current call");
    if (inst.callKind !== "query" && inst.callKind !== "systemPlan") throw new AgentOsError("PROVIDER_GRANT_REQUIRED", `provider reads are not available in ${inst.callKind ?? "background"} context`);
    if (!isV3(inst.bundle) || inst.abiVersion !== 2) throw new AgentOsError("PROVIDER_GRANT_REQUIRED", "only ABI-2 apps can read providers");
    const app = this.core.store.get<{ active_revision_id: string | null }>("SELECT active_revision_id FROM apps WHERE id = ?", inst.appId);
    const activeInst = this.core.store.get<{ active_instance_id: string | null }>("SELECT active_instance_id FROM app_runtime WHERE app_id = ?", inst.appId);
    // Preview/candidate instances and inactive versions never read real system state (spec §9, V3-G07).
    if (app?.active_revision_id !== inst.revisionId || activeInst?.active_instance_id !== inst.id) {
      if (inst.callKind === "systemPlan") throw new AgentOsError("PROVIDER_GRANT_REQUIRED", "previews cannot plan system actions");
      // Prepare uses an explicitly labelled simulated snapshot; it is never real state and never plan evidence.
      return {
        callId, ok: true,
        envelope: { resourceId: "simulated", resourceGeneration: 0, observedAt: iso(Date.now()), observationId: "obs_000000000000000000000000", resourceVersion: null, quality: "unavailable", data: { simulated: true, note: "Prepare 预览使用模拟快照，不是真实系统状态" } },
      };
    }
    if (++inst.providerReads > SYSTEM_LIMITS.providerReadsPerCall) throw new AgentOsError("RESOURCE_BUSY", `at most ${SYSTEM_LIMITS.providerReadsPerCall} provider reads per call`);
    const b = inst.bundle as CodeBundleV3;
    const h = inst.currentHandler ?? "";
    const declared = inst.callKind === "query" ? (b.queries[h]?.providerReads ?? []) : (b.system.actions[h]?.observations ?? []);
    const alias = String(p.bindingAlias ?? "");
    const cap = String(p.capabilityId ?? "");
    if (!declared.some((d) => d.bindingAlias === alias && d.capabilityId === cap)) throw new AgentOsError("PROVIDER_GRANT_REQUIRED", `${h} does not declare ${alias}/${cap}`);
    const grant = this.grants.requireAppGrant(inst.appId, inst.revisionId, alias, cap);
    const r = this.resources.require(grant.resource_id);
    const left = Math.max(50, Math.min(SYSTEM_LIMITS.providerReadMs, inst.callDeadline - Date.now()));
    const env = await this.reads.read({ kind: "app_call", callId: inst.currentCallId, appId: inst.appId, revisionId: inst.revisionId }, r, cap, p.params ?? {}, {
      grant,
      timeoutMs: left,
      recheck: () => {
        if (inst.revoked || inst.currentCallId !== p.parentCallId) throw new AgentOsError("INSTANCE_STALE", "the call ended during the read");
      },
    });
    return { callId, ok: true, envelope: env };
  }

  // ---------------------------------------------------------------- plans from apps (spec §11.2)

  async planFromApp(appId: string, handlerId: string, input: unknown, expectedAppEpoch: number): Promise<ActionRow> {
    const rt = this.runtime;
    if (!rt?.ctx.instances) throw new AgentOsError("SANDBOX_UNAVAILABLE", "the code runtime is not available");
    const row = this.core.apps.getAppRow(appId);
    if (!row?.active_revision_id) throw new AgentOsError("NOT_FOUND", "app has no active version");
    if (row.epoch !== expectedAppEpoch) throw new AgentOsError("APP_EPOCH_STALE", "the app changed version", { appEpoch: row.epoch });
    const bundle = this.core.apps.revisionBundle(appId, row.active_revision_id);
    if (!bundle || !isV3(bundle)) throw new AgentOsError("INVALID_REQUEST", "this app version has no system actions");
    const decl = bundle.system.actions[handlerId];
    if (!decl) throw new AgentOsError("UNKNOWN_HANDLER", `no system action "${handlerId}"`);
    const grant = this.grants.requireAppGrant(appId, row.active_revision_id, decl.bindingAlias, decl.capabilityId);
    const resource = this.resources.require(grant.resource_id);
    const call = rt.invocations.prepareSystemPlanCall(appId, SYSTEM_LIMITS.handlerMs);
    const inst = call.inst;
    const ctx = call.context;
    if (call.revisionId !== row.active_revision_id) throw new AgentOsError("APP_EPOCH_STALE", "the app changed version");
    const output = await rt.ctx.instances.call(inst, "systemPlan", handlerId, input, ctx, SYSTEM_LIMITS.handlerMs);
    // Late output of a replaced instance is refused before the plan is accepted (spec §11.4).
    const cur = this.core.apps.getAppRow(appId);
    if (cur?.active_revision_id !== row.active_revision_id || cur.epoch !== row.epoch || inst.revoked || !rt.invocations.stillActive(appId, inst.id, call.generation)) throw new AgentOsError("INSTANCE_STALE", "the app changed during planning");
    if (output !== null && typeof output === "object" && !Array.isArray(output) && Object.hasOwn(output, "mutations")) {
      throw new AgentOsError("MIXED_EFFECTS_FORBIDDEN", "a system plan cannot carry records mutations; use a separate command");
    }
    if (Array.isArray(output)) throw new AgentOsError("MIXED_EFFECTS_FORBIDDEN", "one system action holds exactly one effect");
    if (!validateSystemPlanOutput(output)) throw new AgentOsError("INVALID_SYSTEM_PLAN", `plan output: ${validateSystemPlanOutput.errors?.[0]?.message ?? "invalid"}`);
    const plan = output as { bindingAlias: string; capabilityId: string; params: Record<string, unknown>; observationIds: string[]; preview: unknown };
    if (plan.bindingAlias !== decl.bindingAlias || plan.capabilityId !== decl.capabilityId) {
      throw new AgentOsError("MIXED_EFFECTS_FORBIDDEN", `the action is declared for ${decl.bindingAlias}/${decl.capabilityId}; another resource or capability cannot be planned`);
    }
    let params: Record<string, unknown>;
    try {
      params = checkProviderParams(plan.capabilityId, plan.params);
    } catch (e) {
      paramError(e);
    }
    this.observations.checkRefs(plan.observationIds, { kind: "app_call", callId: ctx.callId, appId, revisionId: row.active_revision_id }, { id: resource.id, generation: resource.generation }, (rid) => this.resources.get(rid)?.generation);
    const { preview, preconditions } = await this.#trustedPreview(resource, plan.capabilityId, params, grant);
    return this.core.store.tx(() => {
      const r2 = this.resources.require(resource.id);
      if (r2.generation !== resource.generation) throw new AgentOsError("RESOURCE_GENERATION_STALE", "the resource changed during planning");
      return this.actions.freezeInTx({
        origin: "app", appId, revisionId: row.active_revision_id, appEpoch: row.epoch, dataEpoch: ctx.dataEpoch, handlerId, capabilityId: plan.capabilityId, resource,
        params, preconditions, observationRefs: plan.observationIds, preview, appPreview: plan.preview, grant, standing: grant.confirmation_policy === "standing",
      });
    });
  }

  /** Trusted preview + frozen preconditions from a fresh user-scope read of the target (spec §9, §11.2). */
  async #trustedPreview(r: ResourceRow, cap: string, params: Record<string, unknown>, grant: GrantRow | null): Promise<{ preview: ReturnType<typeof buildPreview>; preconditions: Record<string, unknown> }> {
    let current: Record<string, unknown> | null = null;
    const preconditions: Record<string, unknown> = { resourceGeneration: r.generation };
    try {
      if (r.kind === "service") {
        const env = await this.reads.read({ kind: "user" }, r, "service.describe", {}, { timeoutMs: 2000 });
        current = env.data as Record<string, unknown>;
        const m = await this.reads.read({ kind: "user" }, r, "service.metrics", {}, { timeoutMs: 2000 }).catch(() => null);
        if (m) current = { ...current, memoryCurrent: (m.data as { metrics?: { memoryCurrent?: number } }).metrics?.memoryCurrent };
        preconditions.unitLoad = current.loadState;
        if (cap === "service.set_limit") preconditions.currentValue = current[String(params.property)];
      } else if (r.kind === "managed-root" && cap === "file.write_text_atomic") {
        const rg = this.#readGrantFor(r, "file.read_text", grant);
        if (rg && params.expectedVersion) {
          // Keep the previous content (≤256 KiB) so a compensation can restore it later.
          const env = await this.reads.read({ kind: "user" }, r, "file.read_text", { path: params.path }, { grant: rg, timeoutMs: 3000 }).catch(() => null);
          const d = env?.data as { content?: string; truncated?: boolean; version?: string } | undefined;
          if (d && !d.truncated && d.version === params.expectedVersion && typeof d.content === "string") preconditions.previousBlob = this.actions.saveBlob(d.content);
        }
      } else if (r.kind === "lab-network") {
        const rg = this.#readGrantFor(r, "network.policy_status", grant);
        if (rg) {
          const env = await this.reads.read({ kind: "user" }, r, "network.policy_status", {}, { grant: rg, timeoutMs: 3000 }).catch(() => null);
          current = (env?.data as Record<string, unknown>) ?? null;
          if (current) preconditions.previousProfile = current.activeProfile ?? null;
        }
      } else if (r.kind === "serial") {
        const rg = this.#readGrantFor(r, "serial.status", grant);
        if (rg) {
          const env = await this.reads.read({ kind: "user" }, r, "serial.status", {}, { grant: rg, timeoutMs: 3000 }).catch(() => null);
          const ident = (env?.data as { identity?: unknown } | undefined)?.identity;
          if (ident) preconditions.identityDigest = (await import("@agentos/contracts")).domainHash("agentos.resource-identity.v1", ident);
        }
      }
    } catch {
      /* the preview shows unknown current values; execution re-checks everything */
    }
    return { preview: buildPreview(r, cap, params, current), preconditions };
  }

  #readGrantFor(r: ResourceRow, cap: string, write: GrantRow | null): GrantRow | null {
    const q = write?.app_id
      ? this.core.store.get<GrantRow>("SELECT * FROM provider_grants WHERE principal_kind = 'app' AND app_id = ? AND revision_id = ? AND resource_id = ? AND capability_id = ? AND sync_state = 'active' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1", write.app_id, write.revision_id, r.id, cap)
      : write?.run_id
        ? this.core.store.get<GrantRow>("SELECT * FROM provider_grants WHERE principal_kind = 'run' AND run_id = ? AND resource_id = ? AND capability_id = ? AND sync_state = 'active' ORDER BY created_at DESC LIMIT 1", write.run_id, r.id, cap)
        : this.core.store.get<GrantRow>("SELECT * FROM provider_grants WHERE resource_id = ? AND capability_id = ? AND sync_state = 'active' AND revoked_at IS NULL AND resource_generation = ? ORDER BY created_at DESC LIMIT 1", r.id, cap, r.generation);
    return q ?? null;
  }

  // ---------------------------------------------------------------- system_plan runs (spec §8.4, §20)

  /** Freeze the user's chosen resources and capability scope for a new system_plan run (called in the run's tx). */
  freezeRunScopeInTx(runId: string, resourceIds: string[], capabilityScopes: string[], deadlineMs: number): RunScope {
    if (resourceIds.length === 0 || resourceIds.length > 8) throw new AgentOsError("INVALID_REQUEST", "choose 1..8 resources for a system plan");
    const res = resourceIds.map((id) => this.resources.require(id));
    for (const r of res) if (r.status === "gone" || r.status === "suspended") throw new AgentOsError("RESOURCE_GONE", `resource ${r.display_name} is ${r.status}`);
    const read = new Set<string>();
    const propose = new Set<string>();
    for (const c of capabilityScopes) {
      const d = capabilityDecl(c);
      if (!d) throw new AgentOsError("CAPABILITY_VERSION_UNSUPPORTED", `unknown capability ${c}`);
      if (!res.some((r) => d.resourceKinds.includes(r.kind))) throw new AgentOsError("INVALID_REQUEST", `${c} does not apply to the chosen resources`);
      (d.mode === "read" ? read : propose).add(c);
    }
    // Metadata/state reads of the chosen resources are always part of the scope; file content is not (spec §10).
    for (const r of res) {
      for (const d of CAPABILITIES) if (d.mode === "read" && d.resourceKinds.includes(r.kind) && d.capabilityId !== "file.read_text") read.add(d.capabilityId);
    }
    const scope: RunScope = {
      resourceIds: res.map((r) => r.id), readCapabilities: [...read].sort(), proposeCapabilities: [...propose].sort(), frozenAt: iso(this.core.store.clock.now()),
      policyVersion: this.broker.status.policyVersion, resources: res.map((r) => ({ resourceId: r.id, generation: r.generation, kind: r.kind })),
    };
    // Run-scoped broker read grants (valid only for this run; a new run never inherits them).
    for (const r of res) {
      if (r.execution_class !== "broker") continue;
      for (const c of scope.readCapabilities) {
        const d = capabilityDecl(c)!;
        if (d.resourceKinds.includes(r.kind) && d.execution[r.kind]?.startsWith("broker")) this.grants.createRunReadGrantInTx(runId, r, c, deadlineMs);
      }
    }
    return scope;
  }

  runScope(runId: string): { mode: string; scope: RunScope | null; status: string; prepared: string | null } {
    const r = this.core.store.get<{ mode: string; system_resource_scope: string | null; status: string; prepared_action_id: string | null }>("SELECT mode, system_resource_scope, status, prepared_action_id FROM runs WHERE id = ?", runId);
    if (!r) throw new AgentOsError("NOT_FOUND", "run not found");
    return { mode: r.mode, scope: r.system_resource_scope ? (JSON.parse(r.system_resource_scope) as RunScope) : null, status: r.status, prepared: r.prepared_action_id };
  }

  #requirePlanRun(runId: string): RunScope {
    const s = this.runScope(runId);
    if (s.mode !== "system_plan" || !s.scope) throw new AgentOsError("FORBIDDEN", "this tool is only available in system_plan runs");
    if (!["running", "queued"].includes(s.status)) throw new AgentOsError("FORBIDDEN", "the run is not active");
    return s.scope;
  }

  /** system_resource_list tool. */
  runResources(runId: string): unknown[] {
    const scope = this.#requirePlanRun(runId);
    return scope.resourceIds.map((id) => {
      const r = this.resources.require(id);
      return { resourceId: r.id, kind: r.kind, displayName: r.display_name, generation: r.generation, status: r.status, limits: this.resources.brokerLimits.get(r.id) ?? null };
    });
  }

  /** system_read tool: reads inside the frozen scope, observation bound to this run. */
  async runRead(runId: string, toolTaskId: string, resourceId: string, capabilityId: string, params: unknown): Promise<ObservationEnvelope> {
    const scope = this.#requirePlanRun(runId);
    if (!scope.resourceIds.includes(resourceId)) throw new AgentOsError("RESOURCE_NOT_BOUND", "this resource is not in the run's scope");
    if (!scope.readCapabilities.includes(capabilityId)) throw new AgentOsError("PROVIDER_GRANT_REQUIRED", `${capabilityId} is not in the run's read scope`);
    const r = this.resources.require(resourceId);
    const frozen = scope.resources.find((x) => x.resourceId === resourceId)!;
    if (frozen.generation !== r.generation) throw new AgentOsError("RESOURCE_GENERATION_STALE", "the resource changed since the run started");
    // A broker grant is needed only when this capability is executed by the broker for this kind (reads served by the
    // unprivileged provider-user process, like service.describe, carry no broker grant).
    const viaBroker = r.execution_class === "broker" && !!capabilityDecl(capabilityId)?.execution[r.kind]?.startsWith("broker");
    const grant = viaBroker ? (this.core.store.get<GrantRow>("SELECT * FROM provider_grants WHERE principal_kind = 'run' AND run_id = ? AND resource_id = ? AND capability_id = ? ORDER BY created_at DESC LIMIT 1", runId, r.id, capabilityId) ?? null) : null;
    if (viaBroker && !grant) throw new AgentOsError("PROVIDER_GRANT_REQUIRED", "no run read grant for this resource");
    if (grant && grant.sync_state === "pending") await this.grants.pump();
    return this.reads.read({ kind: "run", runId, toolTaskId }, r, capabilityId, params ?? {}, { grant: grant ? this.grants.get(grant.id) : null, timeoutMs: 3000 });
  }

  /** system_plan tool: freeze at most one valid action for the run; always awaiting the user's confirmation. */
  async runPlan(runId: string, toolTaskId: string, args: { resourceId: string; capabilityId: string; params: unknown; observationIds: string[] }): Promise<ActionRow> {
    const scope = this.#requirePlanRun(runId);
    const existing = this.runScope(runId).prepared;
    if (existing) {
      const a = this.actions.get(existing);
      if (a && canonicalJson({ r: a.resource_id, c: a.capability_id, p: (JSON.parse(a.plan_json) as FrozenPlan).params }) === canonicalJson({ r: args.resourceId, c: args.capabilityId, p: args.params })) return a; // replay
      throw new AgentOsError("INVALID_SYSTEM_PLAN", "this run already prepared its one system plan");
    }
    if (!scope.resourceIds.includes(args.resourceId)) throw new AgentOsError("RESOURCE_NOT_BOUND", "the resource is not in the run's scope");
    if (!scope.proposeCapabilities.includes(args.capabilityId)) throw new AgentOsError("PROVIDER_GRANT_REQUIRED", `${args.capabilityId} is not in the run's proposal scope`);
    const r = this.resources.require(args.resourceId);
    let params: Record<string, unknown>;
    try {
      params = checkProviderParams(args.capabilityId, args.params ?? {});
    } catch (e) {
      paramError(e);
    }
    // Install caps are checked here too (the broker enforces them again at admission).
    const caps = this.resources.brokerLimits.get(r.id) as Record<string, { min: number; max: number } | number | string[]> | undefined;
    if (args.capabilityId === "service.set_limit" && caps) {
      const range = caps[String(params.property)] as { min: number; max: number } | undefined;
      const v = Number(params.value);
      if (!range || v < range.min || v > range.max) throw new AgentOsError("BROKER_POLICY_DENIED", `${String(params.property)}=${v} is outside the installed range ${range?.min}..${range?.max}`);
    }
    this.observations.checkRefs(args.observationIds ?? [], { kind: "run", runId, toolTaskId }, { id: r.id, generation: r.generation }, (rid) => this.resources.get(rid)?.generation);
    const runGrant = this.core.store.get<GrantRow>("SELECT * FROM provider_grants WHERE principal_kind = 'run' AND run_id = ? AND resource_id = ? ORDER BY created_at DESC LIMIT 1", runId, r.id) ?? null;
    const { preview, preconditions } = await this.#trustedPreview(r, args.capabilityId, params, runGrant);
    return this.core.store.tx(() => {
      if (this.runScope(runId).prepared) throw new AgentOsError("INVALID_SYSTEM_PLAN", "this run already prepared its one system plan");
      const a = this.actions.freezeInTx({ origin: "agent", runId, toolTaskId, capabilityId: args.capabilityId, resource: r, params, preconditions, observationRefs: args.observationIds ?? [], preview });
      this.core.store.run("UPDATE runs SET prepared_action_id = ? WHERE id = ?", a.id, runId);
      return a;
    });
  }

  // ---------------------------------------------------------------- compensation (spec §17.5)

  async compensate(actionId: string): Promise<ActionRow> {
    const a = this.actions.require(actionId);
    if (a.state !== "succeeded") throw new AgentOsError("COMPENSATION_CONFLICT", "only a succeeded operation can be compensated");
    const plan = JSON.parse(a.plan_json) as FrozenPlan;
    const result = (a.result_json ? JSON.parse(a.result_json) : {}) as Record<string, unknown>;
    const r = this.resources.require(a.resource_id);
    let params: Record<string, unknown>;
    switch (a.capability_id) {
      case "file.write_text_atomic": {
        const prev = plan.preconditions.previousBlob as string | undefined;
        if (!prev) throw new AgentOsError("COMPENSATION_CONFLICT", plan.params.expectedAbsent ? "the file did not exist before; deleting is not offered in v0.3" : "the previous content was not captured");
        params = { path: plan.params.path, content: this.actions.readBlob(prev), expectedVersion: String(result.version) };
        break;
      }
      case "service.set_limit": {
        const before = (plan.preconditions.currentValue ?? result.previous) as number | undefined;
        if (typeof before !== "number" || before > Number.MAX_SAFE_INTEGER) throw new AgentOsError("COMPENSATION_CONFLICT", "the previous value is unknown or unlimited");
        // Post-condition must still hold: the current value equals this operation's result.
        const env = await this.reads.read({ kind: "user" }, r, "service.describe", {}, { timeoutMs: 2000 });
        const now = (env.data as Record<string, unknown>)[String(plan.params.property)];
        if (now !== plan.params.value) throw new AgentOsError("COMPENSATION_CONFLICT", "the value changed after this operation; restoring would overwrite a later change");
        params = { property: plan.params.property, value: before };
        break;
      }
      case "service.ensure_state":
        params = { state: plan.params.state === "running" ? "stopped" : "running" };
        break;
      case "network.apply_profile": {
        const prevProfile = plan.preconditions.previousProfile as string | null | undefined;
        if (!prevProfile) throw new AgentOsError("COMPENSATION_CONFLICT", "there was no previous profile to restore");
        params = { profileId: prevProfile };
        break;
      }
      default:
        throw new AgentOsError("COMPENSATION_CONFLICT", `${a.capability_id} has no compensation`);
    }
    const { preview, preconditions } = await this.#trustedPreview(r, a.capability_id, params, null);
    return this.core.store.tx(() =>
      this.actions.freezeInTx({ origin: "compensation", appId: a.app_id, capabilityId: a.capability_id, resource: r, params, preconditions: { ...preconditions, compensatesResult: result }, observationRefs: [], preview, compensatesActionId: a.id }),
    );
  }

  /** Reads for the Shell's resource page (user scope). Broker-backed reads use an existing grant on that resource. */
  async userRead(resourceId: string, capabilityId: string, params: unknown): Promise<ObservationEnvelope> {
    const r = this.resources.require(resourceId);
    const grant = r.execution_class === "broker" ? this.#readGrantFor(r, capabilityId, null) : null;
    if (r.execution_class === "broker" && !grant) throw new AgentOsError("PROVIDER_GRANT_REQUIRED", "connect this resource to an app (or start a system plan) to read it");
    return this.reads.read({ kind: "user" }, r, capabilityId, params ?? {}, { grant, timeoutMs: 3000 });
  }

  newId(prefix: string): string {
    return `${prefix}_${randomBytes(10).toString("hex")}`;
  }
}
