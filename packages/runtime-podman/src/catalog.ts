import { readFileSync } from "node:fs";
import path from "node:path";
import { RUNNER_ABI_VERSION, type ApprovedModule, type RuntimeCatalog, type RuntimeLock } from "@agentos/contracts";
import { imageName, lockfileHash, recipeContext } from "./recipes.js";

/**
 * Platform maintenance: generate catalog entries from the overlays and platform files. Existing lock ids never
 * change meaning: when a recipe changes, a new lock id (@N+1) must be introduced (checked by checkCatalogStable).
 */
export const BASE_IMAGES: Record<string, { reference: string; digest: string }> = {
  // node:24.22.1-bookworm-slim, platform manifest digests (verified 2026-10-28).
  "linux/amd64": { reference: "docker.io/library/node", digest: "sha256:e1582112fb9f152ed38eefcd712efc93fee1becb519fdfa57574d5e07eaa5e7d" },
  "linux/arm64": { reference: "docker.io/library/node", digest: "sha256:932a44adcdb8f5dfbf00f00eb38da8d22b450b2ad258b6d1b2319beca823bfbd" },
};

const LICENSES: Record<string, string> = { papaparse: "MIT", "date-fns": "MIT", typescript: "Apache-2.0", esbuild: "MIT", "@types/papaparse": "MIT" };

function approvedModules(platformRoot: string, profileId: string): ApprovedModule[] {
  const lock = JSON.parse(readFileSync(path.join(platformRoot, "runtime", "overlays", profileId, "runtime", "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string; integrity?: string; license?: string }>;
  };
  const pkg = JSON.parse(readFileSync(path.join(platformRoot, "runtime", "overlays", profileId, "runtime", "package.json"), "utf8")) as { dependencies: Record<string, string> };
  return Object.keys(pkg.dependencies)
    .sort()
    .map((name) => {
      const e = lock.packages[`node_modules/${name}`]!;
      return { name, version: e.version!, license: e.license ?? LICENSES[name] ?? "UNKNOWN", integrity: e.integrity!, specifiers: [name] };
    });
}

export function baseRef(platform: string): string {
  const b = BASE_IMAGES[platform];
  if (!b) throw new Error(`no approved base image for ${platform}`);
  return `${b.reference}@${b.digest}`;
}

export function generateLock(platformRoot: string, profileId: "core-v1" | "data-v1", platform: "linux/amd64" | "linux/arm64", version: number): RuntimeLock {
  const id = `${profileId}@${version}`;
  const modules = approvedModules(platformRoot, profileId);
  const specifiers = modules.flatMap((m) => m.specifiers);
  const rec = (role: "builder" | "runtime") => recipeContext({ platformRoot, profileId, role, baseDigestRef: baseRef(platform), approvedSpecifiers: specifiers, lockId: id });
  const b = rec("builder");
  const r = rec("runtime");
  const builderPkg = JSON.parse(readFileSync(path.join(platformRoot, "runtime", "overlays", profileId, "builder", "package.json"), "utf8")) as { dependencies: Record<string, string> };
  return {
    id,
    profileId,
    platform,
    baseImage: BASE_IMAGES[platform]!,
    builderImage: { name: imageName("builder", profileId, b.recipeHash), recipeHash: b.recipeHash },
    runtimeImage: { name: imageName("runtime", profileId, r.recipeHash), recipeHash: r.recipeHash },
    sdkVersion: "1.0.0",
    abiVersion: RUNNER_ABI_VERSION,
    compiler: { typescript: builderPkg.dependencies.typescript!, esbuild: builderPkg.dependencies.esbuild! },
    modules,
    dependencyLockHash: lockfileHash(platformRoot, profileId),
    policyVersion: 1,
  };
}

/** Recompute a lock's recipe from the platform files on this machine; mismatch means the files are not the approved ones. */
export function verifyLockRecipe(platformRoot: string, lock: RuntimeLock): string[] {
  const problems: string[] = [];
  const specifiers = lock.modules.flatMap((m) => m.specifiers);
  for (const role of ["builder", "runtime"] as const) {
    const c = recipeContext({ platformRoot, profileId: lock.profileId, role, baseDigestRef: `${lock.baseImage.reference}@${lock.baseImage.digest}`, approvedSpecifiers: specifiers, lockId: lock.id });
    const want = role === "builder" ? lock.builderImage.recipeHash : lock.runtimeImage.recipeHash;
    if (c.recipeHash !== want) problems.push(`${lock.id} ${role} recipe ${c.recipeHash} does not match the catalog (${want})`);
  }
  if (lockfileHash(platformRoot, lock.profileId) !== lock.dependencyLockHash) problems.push(`${lock.id} dependency lockfiles do not match the catalog`);
  return problems;
}

export function checkCatalogStable(prev: RuntimeCatalog, next: RuntimeCatalog): string[] {
  const problems: string[] = [];
  for (const old of prev.locks) {
    const now = next.locks.find((l) => l.id === old.id && l.platform === old.platform);
    if (!now) problems.push(`lock ${old.id} (${old.platform}) was removed`);
    else if (JSON.stringify(now) !== JSON.stringify(old)) problems.push(`lock ${old.id} (${old.platform}) changed; add a new lock version instead`);
  }
  return problems;
}
