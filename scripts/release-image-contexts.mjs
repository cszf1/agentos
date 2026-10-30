#!/usr/bin/env node
// Writes one build context per approved image of a platform (spec §19.1: the release carries the approved OCI
// images). Usage: release-image-contexts.mjs <platformRoot> <platform> <outDir>
// Each <outDir>/<n>/ holds the exact recipe entries (the same bytes the Host's driver sends to podman build) plus
// meta.json with the image name, recipe hash, labels and base reference. The release build runs `podman build`
// on them offline; the Host checks the recipe label again before it uses an imported image.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [root, platform, out] = process.argv.slice(2);
const rp = await import(pathToFileURL(path.join(root, "packages", "runtime-podman", "dist", "index.js")).href);
const catalog = JSON.parse(fs.readFileSync(path.join(root, "runtime", "catalog", "catalog.json"), "utf8"));
const images = [];
let n = 0;
for (const lock of catalog.locks.filter((l) => l.platform === platform)) {
  const base = `${lock.baseImage.reference}@${lock.baseImage.digest}`;
  for (const role of ["builder", "runtime"]) {
    const img = lock[`${role}Image`];
    const c = rp.recipeContext({
      platformRoot: root, profileId: lock.profileId, role, baseDigestRef: base,
      approvedSpecifiers: lock.modules.flatMap((m) => m.specifiers), lockId: lock.id, abiVersion: lock.abiVersion,
    });
    if (c.recipeHash !== img.recipeHash) throw new Error(`${lock.id} ${role}: recipe ${c.recipeHash} != catalog ${img.recipeHash}`);
    const dir = path.join(out, String(n++));
    for (const e of c.entries) {
      fs.mkdirSync(path.dirname(path.join(dir, e.path)), { recursive: true });
      fs.writeFileSync(path.join(dir, e.path), e.data);
    }
    const labels = { "agentos.recipe": img.recipeHash, "agentos.role": role, "agentos.profile": lock.profileId, "agentos.base": base };
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ name: img.name, recipeHash: img.recipeHash, role, profileId: lock.profileId, base, labels, overlay: `${lock.profileId}/${role}` }));
    images.push({ name: img.name, recipeHash: img.recipeHash, role, profileId: lock.profileId });
  }
}
fs.writeFileSync(path.join(out, "images.json"), JSON.stringify(images));
console.log(JSON.stringify(images));
