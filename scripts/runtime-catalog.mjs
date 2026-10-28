#!/usr/bin/env node
// Platform maintenance: regenerate runtime/catalog/catalog.json from the overlays and platform files.
// Existing lock ids may not change meaning; pass --allow-change only before a catalog has ever been released.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateLock, checkCatalogStable } from "../packages/runtime-podman/dist/index.js";
import { catalogHash } from "../packages/contracts/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "runtime", "catalog", "catalog.json");
const platforms = ["linux/amd64"];
const next = { catalogVersion: 1, locks: platforms.flatMap((p) => [generateLock(root, "core-v1", p, 1), generateLock(root, "data-v1", p, 1)]) };
if (existsSync(file) && !process.argv.includes("--allow-change")) {
  const prev = JSON.parse(readFileSync(file, "utf8"));
  const problems = checkCatalogStable(prev, next);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
}
writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
console.log(JSON.stringify({ file, catalogHash: catalogHash(next), locks: next.locks.map((l) => ({ id: l.id, platform: l.platform, builder: l.builderImage.name, runtime: l.runtimeImage.name })) }, null, 2));
