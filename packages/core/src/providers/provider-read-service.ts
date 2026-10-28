import { AgentOsError, SYSTEM_LIMITS, capabilityDecl, checkProviderParams, ParamError, type ObservationEnvelope } from "@agentos/contracts";
import { BrokerError } from "@agentos/broker-client";
import type { ResourceRow, ResourceService } from "../resources/resource-service.js";
import type { GrantRow, ProviderGrantService } from "../system-grants/grant-service.js";
import type { ObservationScope, ObservationService } from "../observations/observation-service.js";
import type { BrokerLink } from "../system/broker-link.js";
import { NativeUserError, type NativeUser } from "./native-user.js";

export function paramError(e: unknown): never {
  if (e instanceof ParamError) throw new AgentOsError(e.code as never, e.message);
  throw e;
}

/**
 * ProviderReadService (spec §10): read-only dispatch to the unprivileged native reader or the broker. Callers have
 * already resolved who may read (app grant via binding alias, run scope, or the user); this service re-checks the
 * grant before and after the read, records an observation and returns the uniform envelope.
 */
export class ProviderReadService {
  constructor(
    readonly resources: ResourceService,
    readonly grants: ProviderGrantService,
    readonly observations: ObservationService,
    readonly native: NativeUser,
    readonly broker: BrokerLink,
  ) {}

  async read(scope: ObservationScope, resource: ResourceRow, capabilityId: string, rawParams: unknown, opts: { grant?: GrantRow | null; timeoutMs?: number; recheck?: () => void } = {}): Promise<ObservationEnvelope> {
    const d = capabilityDecl(capabilityId);
    if (!d) throw new AgentOsError("CAPABILITY_VERSION_UNSUPPORTED", `unknown capability ${capabilityId}`);
    if (d.mode !== "read") throw new AgentOsError("INVALID_SYSTEM_PLAN", `${capabilityId} is not a read capability`);
    if (!d.resourceKinds.includes(resource.kind)) throw new AgentOsError("INVALID_SYSTEM_PLAN", `${capabilityId} does not apply to ${resource.kind}`);
    let params: Record<string, unknown>;
    try {
      params = checkProviderParams(capabilityId, rawParams ?? {});
    } catch (e) {
      paramError(e);
    }
    if (resource.status === "gone" || resource.status === "suspended") throw new AgentOsError(resource.status === "gone" ? "RESOURCE_GONE" : "RESOURCE_GENERATION_STALE", `resource is ${resource.status}`);
    if (opts.grant) this.grants.requireUsable(opts.grant);
    const timeoutMs = Math.min(opts.timeoutMs ?? SYSTEM_LIMITS.providerReadMs, 5000);
    let data: unknown;
    let version: string | null = null;
    try {
      ({ data, version } = await this.#dispatch(resource, capabilityId, params, opts.grant ?? null, timeoutMs));
    } catch (e) {
      if (e instanceof NativeUserError) throw e.toAgentOs();
      if (e instanceof BrokerError) throw e.toAgentOs();
      throw e;
    }
    // Spec §8.2: check revocation and version again before the result is returned.
    if (opts.grant) {
      const fresh = this.grants.get(opts.grant.id);
      if (fresh) this.grants.requireUsable(fresh);
    }
    opts.recheck?.();
    const cur = this.resources.require(resource.id);
    if (cur.generation !== resource.generation) throw new AgentOsError("RESOURCE_GENERATION_STALE", "the resource changed during the read");
    const summary = summarize(capabilityId, params, data);
    const quality = capabilityId.startsWith("telemetry.") && (data as { gap?: boolean } | null)?.gap ? "gap" : "fresh";
    const o = this.observations.record(scope, { id: resource.id, generation: resource.generation }, capabilityId, version, quality, summary);
    return { resourceId: resource.id, resourceGeneration: resource.generation, observedAt: o.observed_at, observationId: o.id, resourceVersion: version, data: data as never, quality };
  }

  async #dispatch(r: ResourceRow, cap: string, params: Record<string, unknown>, grant: GrantRow | null, timeoutMs: number): Promise<{ data: unknown; version: string | null }> {
    const ident = r.identity_json ? (JSON.parse(r.identity_json) as Record<string, unknown>) : {};
    switch (r.kind) {
      case "import-root": {
        await this.resources.checkImportRoot(r);
        const data = await this.native.request<Record<string, unknown>>("file", { root: { path: r.host_path, identity: ident }, capabilityId: cap, params }, timeoutMs);
        return { data, version: (data.version as string) ?? (data.dirVersion as string) ?? null };
      }
      case "host-network": {
        const data = await this.native.request("network_snapshot", {}, timeoutMs);
        return { data, version: null };
      }
      case "service": {
        if (cap === "telemetry.summary" || cap === "telemetry.events") return this.#telemetry(r, cap, params);
        const data = await this.native.request<Record<string, unknown>>("service", { unit: ident.unit, capabilityId: cap }, timeoutMs);
        const version = cap === "service.describe" ? `${String(data.invocationId ?? "")}:${String(data.activeState ?? "")}:${String(data.CPUQuotaPerSecUSec ?? "")}:${String(data.MemoryMax ?? "")}` : null;
        return { data, version };
      }
      case "serial": {
        if (cap === "device.list") return { data: await this.native.request("device_list", {}, timeoutMs), version: null };
        return this.#brokerRead(r, cap, params, grant, timeoutMs);
      }
      case "telemetry":
        return this.#telemetry(r, cap, params);
      case "managed-root":
      case "lab-network":
        return this.#brokerRead(r, cap, params, grant, timeoutMs);
      default:
        throw new AgentOsError("CAPABILITY_VERSION_UNSUPPORTED", `no reader for ${r.kind}`);
    }
  }

  async #brokerRead(r: ResourceRow, cap: string, params: Record<string, unknown>, grant: GrantRow | null, timeoutMs: number) {
    if (!grant) throw new AgentOsError("PROVIDER_GRANT_REQUIRED", "broker-backed reads need a grant");
    await this.broker.ensure();
    const identity = this.broker.requireWritable();
    const res = await this.broker.client.read({ identity, grantId: grant.id, capabilityId: cap, contractVersion: 1, resourceId: r.id, resourceGeneration: r.generation, params }, Math.max(timeoutMs, 750) + 500);
    const data = res.data as Record<string, unknown>;
    const version = (data?.version as string) ?? (data?.ruleHash as string) ?? null;
    return { data, version };
  }

  #telemetry(r: ResourceRow, cap: string, params: Record<string, unknown>) {
    const t = this.observations.telemetry;
    if (cap === "telemetry.summary") {
      const counts = r.kind === "service" ? { [r.id]: t.counts[r.id] ?? { exec: 0, exit: 0, lastExitCode: null } } : t.counts;
      return Promise.resolve({ data: { available: t.available, reason: t.reason, gap: t.gap || !t.available, lastGapReason: t.lastGapReason, kernelDrops: t.kernelDrops, userDrops: t.userDrops, sourceEpoch: t.sourceEpoch, counts }, version: null });
    }
    const ev = this.observations.events(Number(params.sinceSeq ?? 0), Number(params.limit ?? 100));
    const filtered = ev.events.filter((e) => e.source === "telemetry" && (r.kind !== "service" || (e.payload as { workloadKey?: string }).workloadKey === r.id || String(e.kind).startsWith("gap")));
    return Promise.resolve({ data: { available: t.available, gap: ev.requiresFullReread || t.gap || !t.available, events: filtered, lastSeq: ev.lastSeq }, version: null });
  }
}

/** Trusted, bounded summary stored with an observation: never full content (spec §10). */
function summarize(cap: string, params: Record<string, unknown>, data: unknown): unknown {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (cap) {
    case "file.read_text":
      return { path: params.path, size: d.size, truncated: d.truncated, version: d.version };
    case "file.list":
      return { path: params.path, entries: Array.isArray(d.entries) ? d.entries.length : 0, dirVersion: d.dirVersion };
    case "file.stat":
      return { path: params.path, kind: d.kind, size: d.size };
    case "service.describe":
      return { activeState: d.activeState, subState: d.subState, invocationId: d.invocationId, CPUQuotaPerSecUSec: d.CPUQuotaPerSecUSec, MemoryMax: d.MemoryMax };
    case "service.metrics":
      return { activeState: d.activeState };
    case "network.policy_status":
      return { activeProfile: d.activeProfile, ruleHash: d.ruleHash };
    case "serial.status":
      return { connected: d.connected, identity: d.identity };
    default:
      return { capabilityId: cap };
  }
}
