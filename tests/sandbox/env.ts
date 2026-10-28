import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeCatalog } from "@agentos/contracts";
import { ArtifactStore, RuntimeCatalogService } from "@agentos/core";
import { PodmanDriver, recipeContext } from "@agentos/runtime-podman";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const CATALOG = JSON.parse(readFileSync(path.join(ROOT, "runtime", "catalog", "catalog.json"), "utf8")) as RuntimeCatalog;

export function podmanSocket(): string {
  return process.env.AGENTOS_PODMAN_SOCKET ?? `/run/user/${process.getuid!()}/podman/podman.sock`;
}

export function makeDriver(): PodmanDriver {
  return new PodmanDriver({
    socketPath: podmanSocket(),
    recipe: (img) => {
      const lock = CATALOG.locks.find((l) => l.builderImage.name === img.name || l.runtimeImage.name === img.name);
      if (!lock) return null;
      const base = `${lock.baseImage.reference}@${lock.baseImage.digest}`;
      const c = recipeContext({ platformRoot: ROOT, profileId: lock.profileId, role: img.role, baseDigestRef: base, approvedSpecifiers: lock.modules.flatMap((m) => m.specifiers), lockId: lock.id, abiVersion: lock.abiVersion });
      return { entries: c.entries, recipeHash: c.recipeHash, baseDigestRef: base };
    },
  });
}

export function catalogService(): RuntimeCatalogService {
  return new RuntimeCatalogService(CATALOG, "linux/amd64");
}

export function sandboxDir(): { dir: string; cleanup: () => void } {
  // Short path: unix socket paths are limited to 107 bytes.
  const dir = mkdtempSync(path.join(os.tmpdir(), "aos-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function artifacts(dir: string): ArtifactStore {
  return new ArtifactStore(path.join(dir, "artifacts"));
}
