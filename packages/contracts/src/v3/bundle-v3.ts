import { Ajv2020 } from "ajv/dist/2020.js";
import { canonicalJson, sha256Hex, type ValidationIssue } from "../bundle.js";
import {
  CODE_BUNDLE_SCHEMA,
  CODE_LIMITS,
  checkCodeSemantics,
  checkCodeStructure,
  normalizeCodeBundle,
  type CodeBundleV2,
  type CommandDecl,
  type ExportDecl,
  type ImportDecl,
  type QueryDecl,
} from "../v2/bundle-v2.js";
import { checkRpcSchema } from "../v2/rpc-schema.js";
import { IDENT_PATTERN, type SlotTreeView } from "../v2/ui.js";
import { capabilityDecl, type ResourceKind } from "./providers.js";

/**
 * formatVersion 3 (spec §9): v2 plus system bindings, provider reads on queries and system action handlers that only
 * produce plans. v1/v2 schemas, normalization, hashes and runners are untouched; this is a separate branch with its
 * own domain-separated hash.
 */
export const V3_LIMITS = { maxBindings: 8, maxProviderReadsPerQuery: 4, maxActions: 8, maxObservationsPerAction: 4, maxCapsPerBinding: 8 } as const;
export const BINDABLE_KINDS: readonly ResourceKind[] = ["import-root", "managed-root", "service", "lab-network", "host-network", "serial"];

export interface ProviderReadDecl {
  bindingAlias: string;
  capabilityId: string;
}
export interface QueryDeclV3 extends QueryDecl {
  providerReads?: ProviderReadDecl[];
}
export interface SystemBindingDecl {
  alias: string;
  resourceKind: ResourceKind;
  capabilities: { capabilityId: string; contractVersion: number }[];
  description: string;
}
export interface SystemActionDecl {
  description?: string;
  bindingAlias: string;
  capabilityId: string;
  contractVersion: number;
  inputSchema: unknown;
  previewSchema: unknown;
  observations: ProviderReadDecl[];
}

export interface CodeBundleV3 {
  formatVersion: 3;
  manifest: { appId: string; title: string; description?: string; runtime: "isolated-code-v2"; capabilities: ("records.read" | "records.write")[] };
  data: CodeBundleV2["data"];
  code: CodeBundleV2["code"];
  runtimeLockId: string;
  queries: Record<string, QueryDeclV3>;
  commands: Record<string, CommandDecl>;
  exports: ExportDecl[];
  imports: ImportDecl[];
  system: { bindings: SystemBindingDecl[]; actions: Record<string, SystemActionDecl> };
  view: SlotTreeView;
}

const v2props = CODE_BUNDLE_SCHEMA.properties;
const v2defs = CODE_BUNDLE_SCHEMA.$defs;
const capRef = {
  type: "object",
  additionalProperties: false,
  required: ["bindingAlias", "capabilityId"],
  properties: { bindingAlias: { type: "string", pattern: IDENT_PATTERN }, capabilityId: { type: "string", pattern: "^[a-z]+\\.[a-z_]+$" } },
};

export const CODE_BUNDLE_V3_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:agentos:code-bundle:v3",
  title: "AgentOS isolated code application bundle v3 (system bindings and plans)",
  type: "object",
  additionalProperties: false,
  required: ["formatVersion", "manifest", "data", "code", "runtimeLockId", "queries", "commands", "exports", "imports", "system", "view"],
  properties: {
    ...v2props,
    formatVersion: { const: 3 },
    manifest: {
      ...v2props.manifest,
      properties: { ...v2props.manifest.properties, runtime: { const: "isolated-code-v2" } },
    },
    queries: { ...v2props.queries, additionalProperties: { $ref: "#/$defs/queryDeclV3" } },
    system: {
      type: "object",
      additionalProperties: false,
      required: ["bindings", "actions"],
      properties: {
        bindings: {
          type: "array",
          maxItems: V3_LIMITS.maxBindings,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["alias", "resourceKind", "capabilities", "description"],
            properties: {
              alias: { type: "string", pattern: IDENT_PATTERN },
              resourceKind: { enum: [...BINDABLE_KINDS] },
              capabilities: {
                type: "array",
                minItems: 1,
                maxItems: V3_LIMITS.maxCapsPerBinding,
                items: { type: "object", additionalProperties: false, required: ["capabilityId", "contractVersion"], properties: { capabilityId: { type: "string" }, contractVersion: { type: "integer", minimum: 1, maximum: 1000 } } },
              },
              description: { type: "string", minLength: 1, maxLength: 256 },
            },
          },
        },
        actions: {
          type: "object",
          maxProperties: V3_LIMITS.maxActions,
          propertyNames: { pattern: IDENT_PATTERN },
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            required: ["bindingAlias", "capabilityId", "contractVersion", "inputSchema", "previewSchema", "observations"],
            properties: {
              description: { type: "string", maxLength: 256 },
              bindingAlias: { type: "string", pattern: IDENT_PATTERN },
              capabilityId: { type: "string" },
              contractVersion: { type: "integer", minimum: 1, maximum: 1000 },
              inputSchema: {},
              previewSchema: {},
              observations: { type: "array", maxItems: V3_LIMITS.maxObservationsPerAction, items: capRef },
            },
          },
        },
      },
    },
  },
  $defs: {
    ...v2defs,
    queryDeclV3: {
      type: "object",
      additionalProperties: false,
      required: ["inputSchema", "outputSchema"],
      properties: { ...v2defs.queryDecl.properties, providerReads: { type: "array", maxItems: V3_LIMITS.maxProviderReadsPerQuery, items: capRef } },
    },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: true, coerceTypes: false, removeAdditional: false, useDefaults: false });
const validateV3 = ajv.compile(CODE_BUNDLE_V3_SCHEMA);

export function checkCodeStructureV3(input: unknown): { ok: true; bundle: CodeBundleV3 } | { ok: false; issues: ValidationIssue[] } {
  if (!validateV3(input)) {
    const issues = (validateV3.errors ?? []).slice(0, 30).map((e) => {
      let path = e.instancePath || "/";
      const p = e.params as Record<string, unknown>;
      if (e.keyword === "additionalProperties" && typeof p.additionalProperty === "string") path = `${e.instancePath}/${p.additionalProperty}`;
      if (e.keyword === "required" && typeof p.missingProperty === "string") path = `${e.instancePath}/${p.missingProperty}`;
      return { path, code: `SCHEMA_${e.keyword.toUpperCase()}`, message: e.message ?? e.keyword };
    });
    return { ok: false, issues };
  }
  // Reuse the v2 source/size/RPC checks on a v2-shaped view of the same bundle.
  const b = input as CodeBundleV3;
  const asV2 = { ...b, formatVersion: 2, manifest: { ...b.manifest, runtime: "isolated-code-v1" }, queries: stripReads(b.queries) } as Record<string, unknown>;
  delete asV2.system;
  const s = checkCodeStructure(asV2);
  if (!s.ok) return { ok: false, issues: s.issues };
  const issues: ValidationIssue[] = [];
  for (const [id, a] of Object.entries(b.system.actions)) {
    issues.push(...checkRpcSchema(a.inputSchema as never, `/system/actions/${id}/inputSchema`), ...checkRpcSchema(a.previewSchema as never, `/system/actions/${id}/previewSchema`));
  }
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, 30) };
  return { ok: true, bundle: b };
}

function stripReads(q: Record<string, QueryDeclV3>): Record<string, QueryDecl> {
  const out: Record<string, QueryDecl> = {};
  for (const [k, v] of Object.entries(q)) {
    const { providerReads: _r, ...rest } = v;
    out[k] = rest;
  }
  return out;
}

export function normalizeCodeBundleV3(b: CodeBundleV3): CodeBundleV3 {
  const n = normalizeCodeBundle({ ...b, formatVersion: 2 } as unknown as CodeBundleV2) as unknown as CodeBundleV3;
  return { ...b, data: n.data };
}

export function codeBundleHashV3(b: CodeBundleV3): string {
  return `sha256:${sha256Hex(`agentos.code-bundle.v3\n${canonicalJson(normalizeCodeBundleV3(b))}`)}`;
}

/** Semantic checks: v2 rules plus bindings, provider reads, actions and the v2 view (spec §9). */
export function checkCodeSemanticsV3(b: CodeBundleV3, targetAppId: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });
  const asV2 = { ...b, formatVersion: 2, manifest: { ...b.manifest, runtime: "isolated-code-v1" }, queries: stripReads(b.queries) } as unknown as CodeBundleV2;
  issues.push(...checkCodeSemantics(asV2, targetAppId, { systemActions: b.system.actions, viewKind: "slot-tree-v2" }));
  const bindings = new Map<string, SystemBindingDecl>();
  b.system.bindings.forEach((bd, i) => {
    const p = `/system/bindings/${i}`;
    if (bindings.has(bd.alias)) add(`${p}/alias`, "DUPLICATE", "duplicate binding alias");
    bindings.set(bd.alias, bd);
    const seen = new Set<string>();
    bd.capabilities.forEach((c, j) => {
      const d = capabilityDecl(c.capabilityId);
      if (!d) add(`${p}/capabilities/${j}`, "CAPABILITY_VERSION_UNSUPPORTED", `unknown capability ${c.capabilityId}`);
      else {
        if (c.contractVersion !== d.contractVersion) add(`${p}/capabilities/${j}`, "CAPABILITY_VERSION_UNSUPPORTED", `${c.capabilityId} contract ${c.contractVersion} is not supported`);
        if (!d.resourceKinds.includes(bd.resourceKind)) add(`${p}/capabilities/${j}`, "INVALID_SYSTEM_PLAN", `${c.capabilityId} does not apply to ${bd.resourceKind}`);
      }
      if (seen.has(c.capabilityId)) add(`${p}/capabilities/${j}`, "DUPLICATE", "duplicate capability");
      seen.add(c.capabilityId);
    });
  });
  const readRef = (r: ProviderReadDecl, path: string) => {
    const bd = bindings.get(r.bindingAlias);
    if (!bd) return add(`${path}/bindingAlias`, "RESOURCE_NOT_BOUND", `binding "${r.bindingAlias}" is not declared`);
    const d = capabilityDecl(r.capabilityId);
    if (!d || d.mode !== "read") return add(`${path}/capabilityId`, "INVALID_SYSTEM_PLAN", `${r.capabilityId} is not a read capability`);
    if (!bd.capabilities.some((c) => c.capabilityId === r.capabilityId)) add(`${path}/capabilityId`, "INVALID_SYSTEM_PLAN", `binding "${r.bindingAlias}" does not declare ${r.capabilityId}`);
  };
  for (const [qid, q] of Object.entries(b.queries)) {
    (q.providerReads ?? []).forEach((r, i) => readRef(r, `/queries/${qid}/providerReads/${i}`));
    // Cross-app service contexts never read providers (spec §8.2): an exported query cannot declare provider reads.
    if ((q.providerReads ?? []).length > 0 && b.exports.some((e) => e.queryId === qid)) {
      add(`/queries/${qid}/providerReads`, "INVALID_SYSTEM_PLAN", "exported queries cannot use provider reads (no delegation of system resources in v0.3)");
    }
  }
  for (const [hid, a] of Object.entries(b.system.actions)) {
    const p = `/system/actions/${hid}`;
    if (Object.hasOwn(b.queries, hid) || Object.hasOwn(b.commands, hid)) add(p, "DUPLICATE_HANDLER", `"${hid}" is also a query or command`);
    const bd = bindings.get(a.bindingAlias);
    const d = capabilityDecl(a.capabilityId);
    if (!bd) add(`${p}/bindingAlias`, "RESOURCE_NOT_BOUND", `binding "${a.bindingAlias}" is not declared`);
    if (!d || d.mode !== "write") add(`${p}/capabilityId`, "INVALID_SYSTEM_PLAN", `${a.capabilityId} is not a write capability`);
    else if (a.contractVersion !== d.contractVersion) add(`${p}/contractVersion`, "CAPABILITY_VERSION_UNSUPPORTED", "unsupported contract version");
    if (bd && d && !bd.capabilities.some((c) => c.capabilityId === a.capabilityId)) add(`${p}/capabilityId`, "INVALID_SYSTEM_PLAN", `binding "${a.bindingAlias}" does not declare ${a.capabilityId}`);
    a.observations.forEach((o, i) => readRef(o, `${p}/observations/${i}`));
  }
  if (Object.keys(b.queries).length + Object.keys(b.commands).length + Object.keys(b.system.actions).length > CODE_LIMITS.maxHandlers) add("/system/actions", "LIMIT_EXCEEDED", `at most ${CODE_LIMITS.maxHandlers} handlers`);
  return issues;
}

/** The bundle formats a host accepts: frozen v1 (declarative), frozen v2 (code ABI 1) and v3 (code ABI 2). */
export const isV3 = (b: { formatVersion: number }): b is CodeBundleV3 => b.formatVersion === 3;
