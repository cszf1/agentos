import {
  bundleHash,
  checkCompatibility,
  checkSemantics,
  checkStructure,
  normalizeBundle,
  type AppBundle,
  type DataContract,
  type ValidationIssue,
} from "../bundle.js";
import { checkCodeSemantics, checkCodeStructure, codeBundleHash, normalizeCodeBundle, type AnyBundle, type CodeBundle } from "./bundle-v2.js";

/**
 * Discriminated entry for both formats (spec §7.1): formatVersion 1 goes to the frozen v1 schema and hash, 2 to the
 * CodeBundle validators. The v1 schema is not widened; a v1 bundle carrying code fields still fails it.
 */
export function checkAnyStructure(input: unknown): { ok: true; bundle: AnyBundle } | { ok: false; issues: ValidationIssue[] } {
  const fv = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as { formatVersion?: unknown }).formatVersion : undefined;
  if (fv === 2) return checkCodeStructure(input);
  return checkStructure(input);
}

export function normalizeAny(b: AnyBundle): AnyBundle {
  return b.formatVersion === 2 ? normalizeCodeBundle(b) : normalizeBundle(b);
}

export function anyBundleHash(b: AnyBundle): string {
  return b.formatVersion === 2 ? codeBundleHash(b) : bundleHash(b);
}

/** Extra checks the host supplies (runtime catalog, approved modules). */
export type ExtraBundleCheck = (b: CodeBundle) => ValidationIssue[];

export function checkAnySemantics(b: AnyBundle, targetAppId: string, extra?: ExtraBundleCheck): ValidationIssue[] {
  if (b.formatVersion === 2) return [...checkCodeSemantics(b, targetAppId), ...(extra ? extra(b) : [])];
  return checkSemantics(b, targetAppId);
}

export function checkAnyCompatibility(b: AnyBundle, contract: DataContract | null, mode: "candidate" | "historical"): ValidationIssue[] {
  return checkCompatibility({ data: b.data } as unknown as AppBundle, contract, mode);
}

export function validateAnyBundle(
  input: unknown,
  targetAppId: string,
  contract: DataContract | null,
  mode: "candidate" | "historical",
  extra?: ExtraBundleCheck,
): { bundle?: AnyBundle; structural: boolean; issues: ValidationIssue[] } {
  const s = checkAnyStructure(input);
  if (!s.ok) return { structural: false, issues: s.issues };
  const bundle = normalizeAny(s.bundle);
  const issues = [...checkAnySemantics(bundle, targetAppId, extra), ...checkAnyCompatibility(bundle, contract, mode)];
  return { bundle, structural: true, issues };
}

/** Static scan of import specifiers in source (early diagnostics; the build enforces the real rule). */
export function importSpecifiers(source: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|[;\s])(?:import|export)\s[^'"`]*?from\s*(['"])([^'"\n]{1,200})\1|(?:^|[;\s])import\s*(['"])([^'"\n]{1,200})\3|import\s*\(\s*(['"`])([^'"`\n]{1,200})\5\s*\)|require\s*\(\s*(['"`])([^'"`\n]{1,200})\7\s*\)/gm;
  for (const m of source.matchAll(re)) {
    const spec = m[2] ?? m[4] ?? m[6] ?? m[8];
    if (spec) out.add(spec);
  }
  return [...out];
}

/** Dynamic import/require with a non-literal argument is not allowed (it would hide the dependency). */
export function hasDynamicImport(source: string): boolean {
  return /import\s*\(\s*[^'"`\s)]/.test(source) || /require\s*\(\s*[^'"`\s)]/.test(source);
}
