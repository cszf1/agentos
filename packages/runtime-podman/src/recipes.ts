import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "@agentos/contracts";
import type { TarEntry } from "./tar.js";

/**
 * Platform image recipes (spec §6 runtime/images, §12.1). An image is built locally from the approved base image
 * (pinned by platform manifest digest) plus fixed platform files: the overlay lockfile (every transitive dependency
 * with integrity), the SDK, and the runner or builder. Its identity is the recipe hash over all of these.
 */
export type ImageRole = "builder" | "runtime";

const RUNTIME_CONTAINERFILE = `ARG BASE
FROM \${BASE}
COPY overlay/package.json overlay/package-lock.json /opt/agentos/overlay/
RUN cd /opt/agentos/overlay && npm ci --ignore-scripts --omit=dev --no-audit --no-fund --loglevel=error \\
 && mkdir -p node_modules && mv node_modules /node_modules && rm -rf /root/.npm /home/node/.npm /tmp/* /opt/agentos/overlay
COPY sdk/ /node_modules/@agentos/app-sdk/
COPY runner/ /opt/agentos/runner/
`;
const BUILDER_CONTAINERFILE = `ARG BASE
FROM \${BASE}
COPY overlay/package.json overlay/package-lock.json /opt/agentos/overlay/
RUN cd /opt/agentos/overlay && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error \\
 && mkdir -p node_modules && mv node_modules /node_modules && rm -rf /root/.npm /home/node/.npm /tmp/* /opt/agentos/overlay
COPY sdk/ /node_modules/@agentos/app-sdk/
COPY builder/ /opt/agentos/builder/
COPY approved.json /opt/agentos/approved.json
`;

export interface RecipeInput {
  platformRoot: string;
  profileId: string;
  role: ImageRole;
  baseDigestRef: string;
  approvedSpecifiers: string[];
  lockId: string;
}

function readDir(dir: string, prefix: string, filter: (name: string) => boolean): TarEntry[] {
  const out: TarEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isFile() && filter(name)) out.push({ path: `${prefix}/${name}`, data: readFileSync(p) });
  }
  return out;
}

export function recipeContext(r: RecipeInput): { entries: TarEntry[]; recipeHash: string; containerfile: string } {
  const root = r.platformRoot;
  const overlay = path.join(root, "runtime", "overlays", r.profileId, r.role);
  const entries: TarEntry[] = [
    { path: "overlay/package.json", data: readFileSync(path.join(overlay, "package.json")) },
    { path: "overlay/package-lock.json", data: readFileSync(path.join(overlay, "package-lock.json")) },
    { path: "sdk/package.json", data: Buffer.from(JSON.stringify({ name: "@agentos/app-sdk", version: "1.0.0", type: "module", main: "./index.js", types: "./index.d.ts" })) },
    ...readDir(path.join(root, "packages", "app-sdk", "dist"), "sdk", (n) => n === "index.js" || n === "index.d.ts"),
  ];
  const moduleDir = r.role === "runtime" ? "runner" : "builder";
  entries.push({ path: `${moduleDir}/package.json`, data: Buffer.from('{"type":"module"}') });
  entries.push(...readDir(path.join(root, "packages", "app-runner", "dist"), moduleDir, (n) => n.endsWith(".js")));
  if (r.role === "builder") {
    entries.push({ path: "approved.json", data: Buffer.from(canonicalJson({ lockId: r.lockId, specifiers: [...r.approvedSpecifiers].sort() })) });
  }
  const containerfile = r.role === "runtime" ? RUNTIME_CONTAINERFILE : BUILDER_CONTAINERFILE;
  entries.push({ path: "Containerfile", data: Buffer.from(containerfile) });
  const h = createHash("sha256");
  h.update(`agentos.image-recipe.v1\n${r.role}\n${r.profileId}\n${r.baseDigestRef}\n`);
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    h.update(`${e.path}\n${createHash("sha256").update(e.data).digest("hex")}\n`);
  }
  return { entries, recipeHash: `sha256:${h.digest("hex")}`, containerfile };
}

export function imageName(role: ImageRole, profileId: string, recipeHash: string): string {
  return `localhost/agentos-${role}-${profileId}:${recipeHash.slice(7, 23)}`;
}

export function lockfileHash(platformRoot: string, profileId: string): string {
  const h = createHash("sha256");
  for (const role of ["builder", "runtime"]) {
    h.update(`${role}\n`);
    h.update(readFileSync(path.join(platformRoot, "runtime", "overlays", profileId, role, "package-lock.json")));
  }
  return `sha256:${h.digest("hex")}`;
}
