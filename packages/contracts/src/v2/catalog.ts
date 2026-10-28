import { canonicalJson, sha256Hex, type ValidationIssue } from "../bundle.js";
import { importSpecifiers, hasDynamicImport } from "./any-bundle.js";
import type { CodeBundle } from "./bundle-v2.js";

/**
 * Runtime catalog (spec §12.1). Each runtimeLockId names an immutable lock descriptor. The catalog ships with the
 * platform and is only changed by the platform maintenance process; an existing lock id never changes meaning.
 */
export interface ApprovedModule {
  name: string;
  version: string;
  license: string;
  integrity: string;
  /** Import specifiers apps may use (the module name, plus listed subpaths). */
  specifiers: string[];
}

export interface RuntimeLock {
  id: string;
  profileId: "core-v1" | "data-v1" | "core-v2" | "data-v2";
  platform: "linux/amd64" | "linux/arm64";
  /** Approved base image, pinned by its platform manifest digest. */
  baseImage: { reference: string; digest: string };
  /** Platform images are built locally from the pinned base and this recipe; their identity is the recipe hash. */
  builderImage: { name: string; recipeHash: string };
  runtimeImage: { name: string; recipeHash: string };
  sdkVersion: string;
  abiVersion: number;
  compiler: { typescript: string; esbuild: string };
  modules: ApprovedModule[];
  /** sha256 of the overlay package-lock.json: every transitive dependency with its integrity. */
  dependencyLockHash: string;
  policyVersion: number;
}

export interface RuntimeCatalog {
  catalogVersion: number;
  locks: RuntimeLock[];
}

export function catalogHash(c: RuntimeCatalog): string {
  return `sha256:${sha256Hex(canonicalJson(c))}`;
}

export function lockHash(l: RuntimeLock): string {
  return `sha256:${sha256Hex(canonicalJson(l))}`;
}

const SDK = "@agentos/app-sdk";

/** Import rules for a lock: relative imports inside the bundle, the SDK, and the lock's approved specifiers. */
export function checkImports(b: CodeBundle, lock: RuntimeLock | undefined): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allowed = new Set<string>([SDK, ...(lock?.modules.flatMap((m) => m.specifiers) ?? [])]);
  for (const [path, src] of Object.entries(b.code.files)) {
    if (hasDynamicImport(src)) issues.push({ path: `/code/files/${path}`, code: "DEPENDENCY_NOT_ALLOWED", message: "dynamic import/require with a computed argument is not allowed" });
    for (const spec of importSpecifiers(src)) {
      if (spec.startsWith("./") || spec.startsWith("../")) continue;
      if (spec.startsWith("node:") || !allowed.has(spec)) {
        issues.push({
          path: `/code/files/${path}`,
          code: "DEPENDENCY_NOT_ALLOWED",
          message: `import "${spec}" is not approved for ${b.runtimeLockId}; allowed: relative imports, ${[...allowed].join(", ")}`,
        });
      }
    }
  }
  return issues.slice(0, 20);
}

export function checkRuntimeLock(b: CodeBundle, catalog: RuntimeCatalog, platform: string): ValidationIssue[] {
  const lock = catalog.locks.find((l) => l.id === b.runtimeLockId);
  if (!lock) {
    return [{ path: "/runtimeLockId", code: "DEPENDENCY_NOT_ALLOWED", message: `unknown runtimeLockId "${b.runtimeLockId}"; choose one from runtime_catalog: ${catalog.locks.map((l) => l.id).join(", ")}` }];
  }
  if (lock.platform !== platform) {
    return [{ path: "/runtimeLockId", code: "IMAGE_UNAVAILABLE", message: `${lock.id} is built for ${lock.platform}, this host is ${platform}` }];
  }
  // A frozen v2 bundle keeps ABI 1; a v3 bundle needs an ABI-2 lock (spec §9: no silent ABI change of an old lock).
  const wantAbi = b.formatVersion === 3 ? 2 : 1;
  if (lock.abiVersion !== wantAbi) {
    return [{ path: "/runtimeLockId", code: "DEPENDENCY_NOT_ALLOWED", message: `formatVersion ${b.formatVersion} needs an ABI-${wantAbi} runtime lock; ${lock.id} is ABI ${lock.abiVersion}` }];
  }
  return checkImports(b, lock);
}
