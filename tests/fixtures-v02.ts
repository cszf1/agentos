import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodeBundle } from "@agentos/contracts";

export const FIXTURES_V02 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "v0.2");

function walk(dir: string, rel: string, out: Record<string, string>): void {
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const r = `${rel}/${name}`;
    if (statSync(p).isDirectory()) walk(p, r, out);
    else out[r] = readFileSync(p, "utf8");
  }
}

/** A v0.2 fixture: bundle.json with code.files filled from its src/ directory. */
export function codeFixture(name: string, patch?: (b: CodeBundle) => void): CodeBundle {
  const dir = path.join(FIXTURES_V02, name);
  const b = JSON.parse(readFileSync(path.join(dir, "bundle.json"), "utf8")) as CodeBundle;
  const files: Record<string, string> = {};
  walk(path.join(dir, "src"), "src", files);
  b.code.files = files;
  patch?.(b);
  return b;
}

export function readJson<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES_V02, name), "utf8")) as T;
}
