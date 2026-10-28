import { randomBytes } from "node:crypto";
import path from "node:path";
import { AgentOsError, SYSTEM_LIMITS, domainHash, type ResourceKind } from "@agentos/contracts";
import type { BrokerResource } from "@agentos/broker-client";
import { iso, type Store } from "../persistence/store.js";
import { NativeUserError, type NativeUser } from "../providers/native-user.js";

export interface ResourceRow {
  id: string;
  kind: ResourceKind;
  display_name: string;
  execution_class: "provider-user" | "broker";
  generation: number;
  catalog_key: string | null;
  identity_digest: string | null;
  identity_json: string | null;
  host_path: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ResourceView {
  resourceId: string;
  kind: ResourceKind;
  displayName: string;
  generation: number;
  status: string;
  source: "user-registered" | "installed-catalog" | "platform";
  executionClass: "provider-user" | "broker";
  identity: Record<string, unknown> | null;
  limits: Record<string, unknown> | null;
  quarantineOperationId: string | null;
  updatedAt: string;
}

/**
 * Stable resource identities (spec §8.1). Apps and the model use resourceIds and aliases, never raw paths, unit names,
 * ifindex, PIDs or device names. A changed identity raises the generation and voids old observations, plans and
 * grants; a moved/replaced import root is suspended until the user registers it again.
 */
export class ResourceService {
  /** Last broker describe: install caps per resource (for previews and early checks). */
  brokerLimits = new Map<string, Record<string, unknown>>();
  brokerQuarantine = new Map<string, string | null>();

  constructor(readonly store: Store, readonly native: NativeUser, readonly storeUUID: string) {}

  get(id: string): ResourceRow | undefined {
    return this.store.get<ResourceRow>("SELECT * FROM system_resources WHERE id = ?", id);
  }

  require(id: string): ResourceRow {
    const r = this.get(id);
    if (!r) throw new AgentOsError("RESOURCE_NOT_BOUND", "unknown resource", { resourceId: id });
    return r;
  }

  list(): ResourceRow[] {
    return this.store.all<ResourceRow>("SELECT * FROM system_resources ORDER BY kind, display_name");
  }

  view(r: ResourceRow): ResourceView {
    const ident = r.identity_json ? (JSON.parse(r.identity_json) as Record<string, unknown>) : null;
    // The absolute path of an import root is shown to the user (they typed it); privileged paths never are.
    const identity = ident ? { ...ident } : null;
    if (identity && r.kind === "import-root" && r.host_path) identity.path = r.host_path;
    return {
      resourceId: r.id,
      kind: r.kind,
      displayName: r.display_name,
      generation: r.generation,
      status: r.status,
      source: r.kind === "import-root" ? "user-registered" : r.execution_class === "broker" ? "installed-catalog" : "platform",
      executionClass: r.execution_class,
      identity,
      limits: this.brokerLimits.get(r.id) ?? null,
      quarantineOperationId: this.brokerQuarantine.get(r.id) ?? null,
      updatedAt: r.updated_at,
    };
  }

  /** Platform resources the host reads itself (host network, telemetry). Idempotent. */
  ensurePlatformResources(): void {
    const now = iso(this.store.clock.now());
    const s = this.storeUUID.slice(0, 8);
    this.store.tx(() => {
      for (const [id, kind, name] of [
        [`res_hostnet_${s}`, "host-network", "本机网络（只读）"],
        [`res_telemetry_${s}`, "telemetry", "系统遥测（eBPF）"],
      ] as const) {
        this.store.run(
          "INSERT INTO system_resources (id, kind, display_name, execution_class, generation, status, created_at, updated_at) VALUES (?, ?, ?, 'provider-user', 1, 'available', ?, ?) ON CONFLICT(id) DO NOTHING",
          id, kind, name, now, now,
        );
      }
    });
  }

  /** Mirror the installed catalog from broker describe (generation and identity are the broker's). */
  syncFromBroker(resources: BrokerResource[]): void {
    const now = iso(this.store.clock.now());
    this.store.tx(() => {
      for (const r of resources) {
        const details = (r.details ?? {}) as { identity?: Record<string, unknown>; details?: Record<string, unknown> };
        // Only non-privileged identity facts are kept host-side (unit name for read-only property reads).
        const ident: Record<string, unknown> = { catalogKey: r.catalogKey };
        if (r.kind === "service") {
          const cg = details.details?.controlGroup as string | undefined;
          ident.unit = (details.identity as { unit?: string } | undefined)?.unit ?? details.details?.unit ?? (cg ? cg.split("/").pop() : undefined);
        }
        if (r.kind === "lab-network") ident.netns = (details.identity as { netns?: string; name?: string } | undefined)?.netns ?? (details.identity as { name?: string } | undefined)?.name;
        if (r.kind === "serial") ident.profile = (r.limits as { profile?: string }).profile;
        const status = r.quarantineOperationId ? "quarantined" : r.status === "available" ? "available" : r.status === "gone" ? "gone" : "unavailable";
        this.brokerLimits.set(r.resourceId, r.limits);
        this.brokerQuarantine.set(r.resourceId, r.quarantineOperationId);
        const cur = this.get(r.resourceId);
        if (!cur) {
          this.store.run(
            "INSERT INTO system_resources (id, kind, display_name, execution_class, generation, catalog_key, identity_digest, identity_json, status, created_at, updated_at) VALUES (?, ?, ?, 'broker', ?, ?, ?, ?, ?, ?, ?)",
            r.resourceId, r.kind, r.displayName, r.generation, r.catalogKey, r.identityDigest, JSON.stringify(ident), status, now, now,
          );
        } else {
          this.store.run(
            "UPDATE system_resources SET display_name = ?, generation = ?, identity_digest = COALESCE(?, identity_digest), identity_json = ?, status = ?, updated_at = ? WHERE id = ?",
            r.displayName, Math.max(r.generation, cur.generation), r.identityDigest, JSON.stringify(ident), status, now, r.resourceId,
          );
        }
      }
    });
  }

  /** POST /api/system-resources/import-roots: verify with the user's own permissions; no privileged scope is created. */
  async registerImportRoot(hostPath: string, displayName: string | undefined): Promise<ResourceRow> {
    if (typeof hostPath !== "string" || !path.isAbsolute(hostPath) || path.normalize(hostPath) !== hostPath || (hostPath.length > 1 && hostPath.endsWith("/"))) {
      throw new AgentOsError("PATH_SCOPE_VIOLATION", "an absolute, normalized directory path is required");
    }
    let r: { path: string; identity: { dev: number; ino: number; uid: number }; mode: string; ownedByUser: boolean };
    try {
      r = await this.native.request("register_root", { path: hostPath }, 2000);
    } catch (e) {
      if (e instanceof NativeUserError) throw e.toAgentOs();
      throw e;
    }
    const digest = domainHash("agentos.import-root.v1", { dev: r.identity.dev, ino: r.identity.ino, uid: r.identity.uid, path: hostPath });
    const now = iso(this.store.clock.now());
    const name = (displayName ?? path.basename(hostPath)).slice(0, 80) || hostPath;
    return this.store.tx(() => {
      const existing = this.store.get<ResourceRow>("SELECT * FROM system_resources WHERE kind = 'import-root' AND host_path = ?", hostPath);
      if (existing) {
        if (existing.identity_digest === digest && existing.status === "available") return existing;
        // Same path, different (or re-verified) directory object: new generation; old grants/plans stay void.
        const gen = existing.identity_digest === digest ? existing.generation : existing.generation + 1;
        this.store.run("UPDATE system_resources SET generation = ?, identity_digest = ?, identity_json = ?, status = 'available', display_name = ?, updated_at = ? WHERE id = ?", gen, digest, JSON.stringify(r.identity), name, now, existing.id);
        this.store.event("resource.reregistered", { resourceId: existing.id, generation: gen });
        return this.get(existing.id)!;
      }
      const n = this.store.get<{ n: number }>("SELECT count(*) AS n FROM system_resources WHERE kind = 'import-root' AND status <> 'gone'")!.n;
      if (n >= SYSTEM_LIMITS.importRoots) throw new AgentOsError("LIMIT_EXCEEDED", `at most ${SYSTEM_LIMITS.importRoots} import roots`);
      const id = `res_import_${randomBytes(10).toString("hex")}`;
      this.store.run(
        "INSERT INTO system_resources (id, kind, display_name, execution_class, generation, identity_digest, identity_json, host_path, status, created_at, updated_at) VALUES (?, 'import-root', ?, 'provider-user', 1, ?, ?, ?, 'available', ?, ?)",
        id, name, digest, JSON.stringify(r.identity), hostPath, now, now,
      );
      this.store.event("resource.registered", { resourceId: id, kind: "import-root" });
      return this.get(id)!;
    });
  }

  /** Re-verify an import root before use; a moved or replaced directory is suspended (spec §8.1, §13.2). */
  async checkImportRoot(r: ResourceRow): Promise<ResourceRow> {
    if (r.kind !== "import-root" || !r.host_path) return r;
    if (r.status === "suspended") throw new AgentOsError("RESOURCE_GENERATION_STALE", "the directory was moved or replaced; register it again", { resourceId: r.id });
    try {
      await this.native.request("observe_root", { root: { path: r.host_path, identity: JSON.parse(r.identity_json ?? "{}") } }, 750);
      return r;
    } catch (e) {
      const code = e instanceof NativeUserError ? e.code : "PROVIDER_UNAVAILABLE";
      if (code === "RESOURCE_GENERATION_STALE" || code === "RESOURCE_GONE") {
        this.store.tx(() => {
          this.store.run("UPDATE system_resources SET status = ?, generation = generation + 1, updated_at = ? WHERE id = ? AND status <> 'suspended'", code === "RESOURCE_GONE" ? "gone" : "suspended", iso(this.store.clock.now()), r.id);
          this.store.event("resource.suspended", { resourceId: r.id, reason: code });
        });
        throw new AgentOsError(code === "RESOURCE_GONE" ? "RESOURCE_GONE" : "RESOURCE_GENERATION_STALE", "the registered directory is gone or was replaced; access is paused until it is registered again", { resourceId: r.id });
      }
      throw e instanceof NativeUserError ? e.toAgentOs() : e;
    }
  }
}
