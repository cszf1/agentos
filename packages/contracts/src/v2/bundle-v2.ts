import { Ajv2020 } from "ajv/dist/2020.js";
import v1Schema from "../app-bundle.schema.json" with { type: "json" };
import {
  RESERVED_KEYS,
  canonicalJson,
  fieldSpec,
  sha256Hex,
  utf8Bytes,
  valueIssue,
  type AppBundle,
  type Capability,
  type DataContract,
  type Field,
  type FieldSpec,
  type ValidationIssue,
  checkCompatibility as checkCompatibilityV1,
} from "../bundle.js";
import { LIMITS } from "../limits.js";
import { checkRpcSchema, schemaIdentity, type RpcSchema } from "./rpc-schema.js";
import { checkSlotTree, IDENT_PATTERN, type SlotTreeView } from "./ui.js";
import type { CodeBundleV3 } from "../v3/bundle-v3.js";

/** Spec §7 / §20.2 limits for code bundles. */
export const CODE_LIMITS = {
  maxSourceFiles: 16,
  maxSourceBytes: 256 * 1024,
  maxBundleBytes: 512 * 1024,
  maxHandlers: 32,
  maxExports: 16,
  maxImports: 16,
  maxBodyBytes: 1024 * 1024,
  maxCommandInputBytes: 128 * 1024,
  maxQueryOutputBytes: 256 * 1024,
  maxCommandResultBytes: 64 * 1024,
  maxMutations: 100,
  maxMutationPlanBytes: 256 * 1024,
  maxServiceOutputBytes: 64 * 1024,
} as const;

export const CODE_ENTRY = "src/app.ts";
export type MutationKind = "create" | "update" | "delete";

export interface QueryDecl {
  description?: string;
  inputSchema: RpcSchema;
  outputSchema: RpcSchema;
}
export interface CommandDecl {
  description?: string;
  inputSchema: RpcSchema;
  outputSchema: RpcSchema;
  operations: MutationKind[];
  writableFields: string[];
}
export interface ExportDecl {
  exportName: string;
  queryId: string;
  contractVersion: number;
  description: string;
}
export interface ImportDecl {
  alias: string;
  description?: string;
  inputSchema: RpcSchema;
  outputSchema: RpcSchema;
}

export interface CodeBundleV2 {
  formatVersion: 2;
  manifest: { appId: string; title: string; description?: string; runtime: "isolated-code-v1"; capabilities: Capability[] };
  data: { fields: Record<string, Field> };
  code: { entry: typeof CODE_ENTRY; files: Record<string, string> };
  runtimeLockId: string;
  queries: Record<string, QueryDecl>;
  commands: Record<string, CommandDecl>;
  exports: ExportDecl[];
  imports: ImportDecl[];
  view: SlotTreeView;
}

/** Code bundles: frozen v2 (ABI 1) and v3 (ABI 2, system bindings). */
export type CodeBundle = CodeBundleV2 | CodeBundleV3;
export type AnyBundle = AppBundle | CodeBundle;
export const isCodeBundle = (b: { formatVersion: number }): b is CodeBundle => b.formatVersion === 2 || b.formatVersion === 3;

const v1Defs = (v1Schema as { $defs: Record<string, unknown> }).$defs;
const anyJson = {};
/** Envelope schema of a CodeBundle; RPC schemas and the view are checked by their own validators. */
export const CODE_BUNDLE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:agentos:code-bundle:v2",
  title: "AgentOS isolated code application bundle v2",
  type: "object",
  additionalProperties: false,
  required: ["formatVersion", "manifest", "data", "code", "runtimeLockId", "queries", "commands", "exports", "imports", "view"],
  properties: {
    formatVersion: { const: 2 },
    manifest: {
      type: "object",
      additionalProperties: false,
      required: ["appId", "title", "runtime", "capabilities"],
      properties: {
        appId: { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" },
        title: { type: "string", minLength: 1, maxLength: 80 },
        description: { type: "string", maxLength: 512 },
        runtime: { const: "isolated-code-v1" },
        capabilities: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: ["records.read", "records.write"] }, contains: { const: "records.read" } },
      },
    },
    data: {
      type: "object",
      additionalProperties: false,
      required: ["fields"],
      properties: { fields: { type: "object", minProperties: 1, maxProperties: 32, propertyNames: { $ref: "#/$defs/fieldKey" }, additionalProperties: { $ref: "#/$defs/field" } } },
    },
    code: {
      type: "object",
      additionalProperties: false,
      required: ["entry", "files"],
      properties: {
        entry: { const: CODE_ENTRY },
        files: { type: "object", minProperties: 1, maxProperties: CODE_LIMITS.maxSourceFiles, additionalProperties: { type: "string" } },
      },
    },
    runtimeLockId: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}@[0-9]+$" },
    queries: { type: "object", minProperties: 1, maxProperties: CODE_LIMITS.maxHandlers, propertyNames: { pattern: IDENT_PATTERN }, additionalProperties: { $ref: "#/$defs/queryDecl" } },
    commands: { type: "object", maxProperties: CODE_LIMITS.maxHandlers, propertyNames: { pattern: IDENT_PATTERN }, additionalProperties: { $ref: "#/$defs/commandDecl" } },
    exports: {
      type: "array",
      maxItems: CODE_LIMITS.maxExports,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["exportName", "queryId", "contractVersion", "description"],
        properties: {
          exportName: { type: "string", pattern: IDENT_PATTERN },
          queryId: { type: "string", pattern: IDENT_PATTERN },
          contractVersion: { type: "integer", minimum: 1, maximum: 1000 },
          description: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
    },
    imports: {
      type: "array",
      maxItems: CODE_LIMITS.maxImports,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["alias", "inputSchema", "outputSchema"],
        properties: { alias: { type: "string", pattern: IDENT_PATTERN }, description: { type: "string", maxLength: 256 }, inputSchema: anyJson, outputSchema: anyJson },
      },
    },
    view: { type: "object" },
  },
  $defs: {
    ...v1Defs,
    queryDecl: {
      type: "object",
      additionalProperties: false,
      required: ["inputSchema", "outputSchema"],
      properties: { description: { type: "string", maxLength: 256 }, inputSchema: anyJson, outputSchema: anyJson },
    },
    commandDecl: {
      type: "object",
      additionalProperties: false,
      required: ["inputSchema", "outputSchema", "operations", "writableFields"],
      properties: {
        description: { type: "string", maxLength: 256 },
        inputSchema: anyJson,
        outputSchema: anyJson,
        operations: { type: "array", maxItems: 3, uniqueItems: true, items: { enum: ["create", "update", "delete"] } },
        writableFields: { type: "array", maxItems: 32, uniqueItems: true, items: { $ref: "#/$defs/fieldKey" } },
      },
    },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: true, coerceTypes: false, removeAdditional: false, useDefaults: false });
const validateEnvelope = ajv.compile(CODE_BUNDLE_SCHEMA);

function ajvIssues(errors: { instancePath: string; keyword: string; params: Record<string, unknown>; message?: string }[] | null | undefined): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const e of errors ?? []) {
    let path = e.instancePath || "/";
    if (e.keyword === "additionalProperties" && typeof e.params.additionalProperty === "string") path = `${e.instancePath}/${e.params.additionalProperty}`;
    else if (e.keyword === "required" && typeof e.params.missingProperty === "string") path = `${e.instancePath}/${e.params.missingProperty}`;
    const i = { path, code: `SCHEMA_${e.keyword.toUpperCase()}`, message: e.message ?? e.keyword };
    const k = `${i.path}|${i.code}|${i.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
    if (out.length >= 30) break;
  }
  return out;
}

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
/** Spec §7.1: only normalized relative POSIX paths under src/, .ts files, no "." / "..", no duplicates after normalization. */
export function sourcePathIssue(path: string): string | undefined {
  if (path.length === 0 || path.length > 200) return "path length must be 1..200";
  if (path.includes("\\")) return "backslashes are not allowed";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "absolute paths are not allowed";
  const segs = path.split("/");
  if (segs[0] !== "src") return "source files live under src/";
  if (segs.length < 2 || segs.length > 6) return "path depth must be 2..6";
  for (const s of segs) {
    if (s === "" ) return "empty path segment";
    if (s === "." || s === "..") return "dot segments are not allowed";
    if (!SEGMENT.test(s)) return `segment "${s}" has characters outside [A-Za-z0-9_.-]`;
    if (RESERVED_KEYS.has(s)) return "reserved name";
  }
  if (!path.endsWith(".ts") || path.endsWith(".d.ts")) return "only .ts source files are accepted";
  return undefined;
}

/** Text check: valid UTF-16 (no lone surrogates) and no NUL / control bytes other than tab, LF, CR. */
export function textIssue(s: string): string | undefined {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return "invalid UTF-16 (lone surrogate)";
      i++;
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return "invalid UTF-16 (lone surrogate)";
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return "binary or control characters are not allowed";
    if (c === 0x7f) return "binary or control characters are not allowed";
  }
  return undefined;
}

/** Byte limit, envelope schema, source paths and sizes, RPC schemas. Structural problems are not stored. */
export function checkCodeStructure(input: unknown): { ok: true; bundle: CodeBundleV2 } | { ok: false; issues: ValidationIssue[] } {
  let text: string | undefined;
  try {
    text = JSON.stringify(input);
  } catch {
    return { ok: false, issues: [{ path: "/", code: "NOT_JSON", message: "bundle is not JSON serializable" }] };
  }
  if (text === undefined) return { ok: false, issues: [{ path: "/", code: "NOT_JSON", message: "bundle is missing" }] };
  if (utf8Bytes(text) > CODE_LIMITS.maxBundleBytes) {
    return { ok: false, issues: [{ path: "/", code: "LIMIT_EXCEEDED", message: `bundle exceeds ${CODE_LIMITS.maxBundleBytes} bytes` }] };
  }
  if (!validateEnvelope(input)) return { ok: false, issues: ajvIssues(validateEnvelope.errors as never) };
  const b = input as CodeBundleV2;
  const issues: ValidationIssue[] = [];
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });
  let total = 0;
  const normalized = new Set<string>();
  for (const [p, src] of Object.entries(b.code.files)) {
    const why = sourcePathIssue(p);
    if (why) add(`/code/files/${p}`, "SOURCE_PATH_INVALID", why);
    const lower = p.toLowerCase();
    if (normalized.has(lower)) add(`/code/files/${p}`, "SOURCE_PATH_INVALID", "duplicate path after normalization");
    normalized.add(lower);
    const t = textIssue(src);
    if (t) add(`/code/files/${p}`, "SOURCE_PATH_INVALID", t);
    total += utf8Bytes(src);
  }
  if (total > CODE_LIMITS.maxSourceBytes) add("/code/files", "LIMIT_EXCEEDED", `source files total at most ${CODE_LIMITS.maxSourceBytes} bytes`);
  if (!Object.hasOwn(b.code.files, CODE_ENTRY)) add(`/code/files/${CODE_ENTRY}`, "SOURCE_PATH_INVALID", `the entry ${CODE_ENTRY} is required`);
  for (const [id, q] of Object.entries(b.queries)) {
    if (RESERVED_KEYS.has(id)) add(`/queries/${id}`, "RESERVED_NAME", "reserved handler id");
    issues.push(...checkRpcSchema(q.inputSchema, `/queries/${id}/inputSchema`), ...checkRpcSchema(q.outputSchema, `/queries/${id}/outputSchema`));
  }
  for (const [id, c] of Object.entries(b.commands)) {
    if (RESERVED_KEYS.has(id)) add(`/commands/${id}`, "RESERVED_NAME", "reserved handler id");
    issues.push(...checkRpcSchema(c.inputSchema, `/commands/${id}/inputSchema`), ...checkRpcSchema(c.outputSchema, `/commands/${id}/outputSchema`));
  }
  b.imports.forEach((imp, i) => {
    issues.push(...checkRpcSchema(imp.inputSchema, `/imports/${i}/inputSchema`), ...checkRpcSchema(imp.outputSchema, `/imports/${i}/outputSchema`));
  });
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, 30) };
  return { ok: true, bundle: b };
}

/** Normalize omitted field constraints like v1 (source text stays byte-exact). */
export function normalizeCodeBundle(b: CodeBundleV2): CodeBundleV2 {
  const fields: Record<string, Field> = {};
  for (const [k, f] of Object.entries(b.data.fields)) fields[k] = { ...fieldSpec(f), label: f.label } as Field;
  return { ...b, data: { fields } };
}

/**
 * v2 revisionId (spec §7.1): its own algorithm, domain-separated from v1. Covers the canonical bundle including the
 * raw source text, the runtimeLockId and every declaration. Never derived from build output, image tags or PIDs.
 */
export function codeBundleHash(b: CodeBundleV2): string {
  return `sha256:${sha256Hex(`agentos.code-bundle.v2\n${canonicalJson(normalizeCodeBundle(b))}`)}`;
}

export function contractOfExport(b: CodeBundle, e: ExportDecl): { inputSchema: RpcSchema; outputSchema: RpcSchema } | null {
  const q = b.queries[e.queryId];
  return q ? { inputSchema: q.inputSchema, outputSchema: q.outputSchema } : null;
}

/** contractHash of a service contract: name, version and both schemas, never user data. */
export function serviceContractHash(sig: { exportName: string; contractVersion: number; inputSchema: RpcSchema; outputSchema: RpcSchema }): string {
  return `sha256:${sha256Hex(`agentos.service-contract.v1\n${sig.exportName}\n${sig.contractVersion}\n${schemaIdentity(sig.inputSchema)}\n${schemaIdentity(sig.outputSchema)}`)}`;
}

/** An import matches an export when both payload schemas are identical after normalization. */
export function importMatchesExport(imp: { inputSchema: RpcSchema; outputSchema: RpcSchema }, sig: { inputSchema: RpcSchema; outputSchema: RpcSchema }): boolean {
  return schemaIdentity(imp.inputSchema) === schemaIdentity(sig.inputSchema) && schemaIdentity(imp.outputSchema) === schemaIdentity(sig.outputSchema);
}

/** Semantic checks (spec §7, §8, §9): fields, handlers, view references, create path, exports, imports. */
export function checkCodeSemantics(b: CodeBundleV2, targetAppId: string, v3?: { systemActions: Record<string, unknown>; viewKind: "slot-tree-v2" }): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });
  if (b.manifest.appId !== targetAppId) add("/manifest/appId", "APP_ID_MISMATCH", "appId must equal the host-bound target app");
  const fields = b.data.fields;
  for (const [k, f] of Object.entries(fields)) {
    const p = `/data/fields/${k}`;
    if (RESERVED_KEYS.has(k)) add(p, "RESERVED_FIELD", "reserved field name");
    const spec = fieldSpec(f);
    if (spec.type === "string" && spec.minLength > spec.maxLength) add(`${p}/minLength`, "RANGE", "minLength must be <= maxLength");
    if (spec.type === "integer" && spec.minimum > spec.maximum) add(`${p}/minimum`, "RANGE", "minimum must be <= maximum");
    if (spec.type === "enum" && spec.values.length > LIMITS.maxEnumValues) add(`${p}/values`, "LIMIT_EXCEEDED", "too many enum values");
    if (spec.default !== undefined) {
      const why = valueIssue(spec, spec.default);
      if (why) add(`${p}/default`, "INVALID_DEFAULT", `default ${why}`);
    }
  }
  if (!Object.hasOwn(b.queries, "main")) add("/queries/main", "UNKNOWN_HANDLER", 'a "main" query is required');
  if (Object.keys(b.queries).length + Object.keys(b.commands).length > CODE_LIMITS.maxHandlers) add("/queries", "LIMIT_EXCEEDED", `at most ${CODE_LIMITS.maxHandlers} handlers`);
  const writes = b.manifest.capabilities.includes("records.write");
  for (const [id, c] of Object.entries(b.commands)) {
    const p = `/commands/${id}`;
    if (Object.hasOwn(b.queries, id)) add(p, "DUPLICATE_HANDLER", `"${id}" is both a query and a command`);
    c.writableFields.forEach((f, i) => {
      if (!Object.hasOwn(fields, f)) add(`${p}/writableFields/${i}`, "UNKNOWN_FIELD", `field "${f}" does not exist in this revision`);
    });
    if (c.operations.length > 0 && !writes) add(`${p}/operations`, "CAPABILITY", "commands that change records need records.write");
    if ((c.operations.includes("create") || c.operations.includes("update")) && c.writableFields.length === 0) {
      add(`${p}/writableFields`, "WRITABLE_FIELDS", "create/update commands must list writableFields");
    }
  }
  const exportNames = new Set<string>();
  b.exports.forEach((e, i) => {
    const p = `/exports/${i}`;
    if (exportNames.has(e.exportName)) add(`${p}/exportName`, "DUPLICATE", "duplicate export name");
    exportNames.add(e.exportName);
    if (!Object.hasOwn(b.queries, e.queryId)) add(`${p}/queryId`, "UNKNOWN_HANDLER", `exports only map declared queries; "${e.queryId}" is not one`);
  });
  const aliases = new Set<string>();
  b.imports.forEach((imp, i) => {
    if (aliases.has(imp.alias)) add(`/imports/${i}/alias`, "DUPLICATE", "duplicate import alias");
    aliases.add(imp.alias);
  });
  const { issues: viewIssues, facts } = checkSlotTree(b.view, { queries: b.queries, commands: b.commands, systemActions: v3?.systemActions, viewKind: v3?.viewKind ?? "slot-tree-v1" });
  issues.push(...viewIssues);
  // A create path for every required field without a default (spec §8).
  const required = Object.entries(fields).filter(([, f]) => f.default === undefined).map(([k]) => k);
  if (required.length > 0) {
    const ok = facts.buttons.some((btn) => {
      const cmd = b.commands[btn.command];
      if (!cmd || !cmd.operations.includes("create") || btn.form === undefined) return false;
      const inputs = facts.forms.get(btn.form);
      return inputs !== undefined && required.every((k) => cmd.writableFields.includes(k) && inputs.has(k));
    });
    if (!ok) {
      add("/view", "NO_CREATE_PATH", `a Button must bind a form with inputs ${required.join(", ")} to a create command whose writableFields include them`);
    }
  }
  return issues;
}

/** Compatibility: same only-growing rules as v1, over the full contract (spec §8). */
export function checkCodeCompatibility(b: CodeBundleV2, contract: DataContract | null, mode: "candidate" | "historical"): ValidationIssue[] {
  return checkCompatibilityV1({ data: b.data } as unknown as AppBundle, contract, mode);
}

/** The data part both formats share, for contract growth. */
export function bundleFields(b: AnyBundle): Record<string, Field> {
  return b.data.fields;
}

export function contractFromFields(fields: Record<string, Field>): Record<string, FieldSpec> {
  const out: Record<string, FieldSpec> = {};
  for (const [k, f] of Object.entries(fields)) out[k] = fieldSpec(f);
  return out;
}
