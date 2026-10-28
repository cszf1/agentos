import { AgentOsError, catalogHash, checkRuntimeLock, type CodeBundle, type RuntimeCatalog, type RuntimeLock, type ValidationIssue } from "@agentos/contracts";

/** The approved runtime catalog shipped with the platform (spec §12.1), for one host platform. */
export class RuntimeCatalogService {
  readonly hash: string;
  constructor(readonly catalog: RuntimeCatalog, readonly platform: string) {
    this.hash = catalogHash(catalog);
  }

  locks(): RuntimeLock[] {
    return this.catalog.locks.filter((l) => l.platform === this.platform);
  }

  lock(id: string): RuntimeLock | undefined {
    return this.catalog.locks.find((l) => l.id === id && l.platform === this.platform);
  }

  requireLock(id: string): RuntimeLock {
    const l = this.lock(id);
    if (!l) throw new AgentOsError("DEPENDENCY_NOT_ALLOWED", `runtime lock ${id} is not in the catalog for ${this.platform}`);
    return l;
  }

  /** Extra semantic check for code bundles (unknown lock, platform, unapproved imports). */
  readonly check = (b: CodeBundle): ValidationIssue[] => checkRuntimeLock(b, this.catalog, this.platform);
}
