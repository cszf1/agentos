import fs from "node:fs";
import type { RuntimeCatalog } from "@agentos/contracts";
import { RuntimeCatalogService } from "@agentos/core";
import { PodmanDriver, recipeContext, verifyLockRecipe } from "@agentos/runtime-podman";
import type { HostConfig } from "./config.js";

/** The approved catalog shipped with this checkout, for this host's platform. */
export function loadCatalog(config: HostConfig): RuntimeCatalogService {
  const catalog = JSON.parse(fs.readFileSync(config.catalogFile, "utf8")) as RuntimeCatalog;
  return new RuntimeCatalogService(catalog, config.platform);
}

/** Recipe problems: the platform files here must be exactly the ones the catalog was generated from. */
export function catalogProblems(config: HostConfig, catalog: RuntimeCatalogService): string[] {
  const out: string[] = [];
  for (const lock of catalog.locks()) {
    try {
      out.push(...verifyLockRecipe(config.platformRoot, lock));
    } catch (e) {
      out.push(`${lock.id}: ${(e as Error).message}`);
    }
  }
  if (catalog.locks().length === 0) out.push(`the catalog has no locks for ${config.platform}`);
  return out;
}

export function createDriver(config: HostConfig, catalog: RuntimeCatalogService): PodmanDriver | null {
  if (!config.podmanSocket) return null;
  return new PodmanDriver({
    socketPath: config.podmanSocket,
    releaseImages: process.env.AGENTOS_RELEASE_IMAGES || undefined,
    recipe: (img) => {
      const lock = catalog.locks().find((l) => l.builderImage.name === img.name || l.runtimeImage.name === img.name);
      if (!lock) return null;
      const base = `${lock.baseImage.reference}@${lock.baseImage.digest}`;
      const c = recipeContext({ platformRoot: config.platformRoot, profileId: lock.profileId, role: img.role, baseDigestRef: base, approvedSpecifiers: lock.modules.flatMap((m) => m.specifiers), lockId: lock.id, abiVersion: lock.abiVersion });
      return { entries: c.entries, recipeHash: c.recipeHash, baseDigestRef: base };
    },
  });
}
