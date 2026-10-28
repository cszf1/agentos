import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import schema from "./app-bundle.schema.json" with { type: "json" };
import { LIMITS } from "./limits.js";

export const APP_BUNDLE_SCHEMA: object = schema;

export type StringField = { type: "string"; label: string; minLength?: number; maxLength: number; default?: string };
export type BooleanField = { type: "boolean"; label: string; default?: boolean };
export type IntegerField = { type: "integer"; label: string; minimum?: number; maximum?: number; default?: number };
export type EnumField = { type: "enum"; label: string; values: string[]; default?: string };
export type Field = StringField | BooleanField | IntegerField | EnumField;
export type FieldValue = string | boolean | number;
export type Capability = "records.read" | "records.write";

export interface AppBundle {
  formatVersion: 1;
  manifest: {
    appId: string;
    title: string;
    description?: string;
    runtime: "declarative-v1";
    capabilities: Capability[];
  };
  data: { fields: Record<string, Field> };
  view: {
    kind: "records";
    titleField: string;
    columns: string[];
    formFields: string[];
    searchField?: string;
    filters: string[];
  };
}

/** Storage-relevant part of a field: normalized, without label. */
export type FieldSpec =
  | { type: "string"; minLength: number; maxLength: number; default?: string }
  | { type: "boolean"; default?: boolean }
  | { type: "integer"; minimum: number; maximum: number; default?: number }
  | { type: "enum"; values: string[]; default?: string };

/** The only-growing data contract of an app. */
export interface DataContract {
  fields: Record<string, FieldSpec>;
}

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export const RESERVED_KEYS: ReadonlySet<string> = new Set(["constructor", "prototype", "__proto__"]);

const ajv = new Ajv2020({ allErrors: true, strict: true, coerceTypes: false, removeAdditional: false, useDefaults: false });
const validateSchema = ajv.compile(APP_BUNDLE_SCHEMA);

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function ajvIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const e of errors ?? []) {
    let path = e.instancePath || "/";
    if (e.keyword === "additionalProperties" && typeof e.params.additionalProperty === "string") {
      path = `${e.instancePath}/${e.params.additionalProperty}`;
    } else if (e.keyword === "required" && typeof e.params.missingProperty === "string") {
      path = `${e.instancePath}/${e.params.missingProperty}`;
    }
    out.push({ path, code: `SCHEMA_${e.keyword.toUpperCase()}`, message: e.message ?? e.keyword });
    if (out.length >= 50) break;
  }
  // oneOf on fields reports every branch; keep the list short and deduplicated.
  const seen = new Set<string>();
  return out.filter((i) => {
    const k = `${i.path}|${i.code}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 30);
}

/** Byte limit, then JSON Schema. Returns the typed bundle or issues. */
export function checkStructure(input: unknown): { ok: true; bundle: AppBundle } | { ok: false; issues: ValidationIssue[] } {
  let text: string;
  try {
    text = JSON.stringify(input);
  } catch {
    return { ok: false, issues: [{ path: "/", code: "NOT_JSON", message: "bundle is not JSON serializable" }] };
  }
  if (text === undefined) return { ok: false, issues: [{ path: "/", code: "NOT_JSON", message: "bundle is missing" }] };
  if (utf8Bytes(text) > LIMITS.maxBundleBytes) {
    return { ok: false, issues: [{ path: "/", code: "LIMIT_EXCEEDED", message: `bundle exceeds ${LIMITS.maxBundleBytes} bytes` }] };
  }
  if (!validateSchema(input)) return { ok: false, issues: ajvIssues(validateSchema.errors) };
  return { ok: true, bundle: input as AppBundle };
}

export function fieldSpec(field: Field): FieldSpec {
  switch (field.type) {
    case "string": {
      const s: FieldSpec = { type: "string", minLength: field.minLength ?? 0, maxLength: field.maxLength };
      if (field.default !== undefined) s.default = field.default;
      return s;
    }
    case "boolean": {
      const s: FieldSpec = { type: "boolean" };
      if (field.default !== undefined) s.default = field.default;
      return s;
    }
    case "integer": {
      const s: FieldSpec = {
        type: "integer",
        minimum: field.minimum ?? Number.MIN_SAFE_INTEGER,
        maximum: field.maximum ?? Number.MAX_SAFE_INTEGER,
      };
      if (field.default !== undefined) s.default = field.default;
      return s;
    }
    case "enum": {
      const s: FieldSpec = { type: "enum", values: [...field.values] };
      if (field.default !== undefined) s.default = field.default;
      return s;
    }
  }
}

/** Normalize omitted constraints so equal meaning gives equal bytes and hash. */
export function normalizeBundle(b: AppBundle): AppBundle {
  const fields: Record<string, Field> = {};
  for (const [k, f] of Object.entries(b.data.fields)) {
    const spec = fieldSpec(f);
    fields[k] = { ...spec, label: f.label } as Field;
  }
  return { ...b, data: { fields } };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** revisionId of a structurally valid bundle: sha256 of canonical normalized JSON. */
export function bundleHash(b: AppBundle): string {
  return `sha256:${sha256Hex(canonicalJson(normalizeBundle(b)))}`;
}

export function valueIssue(spec: FieldSpec, value: unknown): string | undefined {
  switch (spec.type) {
    case "string": {
      if (typeof value !== "string") return "must be a string";
      const n = codePoints(value);
      if (n < spec.minLength) return spec.minLength === 1 ? "must not be empty" : `must have at least ${spec.minLength} characters`;
      if (n > spec.maxLength) return `must have at most ${spec.maxLength} characters`;
      return undefined;
    }
    case "boolean":
      return typeof value === "boolean" ? undefined : "must be a boolean";
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) return "must be a safe integer";
      if (value < spec.minimum) return `must be >= ${spec.minimum}`;
      if (value > spec.maximum) return `must be <= ${spec.maximum}`;
      return undefined;
    case "enum":
      if (typeof value !== "string") return "must be a string";
      return spec.values.includes(value) ? undefined : `must be one of ${spec.values.join(", ")}`;
  }
}

/** Semantic checks after the schema (spec §6, items 1-5). */
export function checkSemantics(b: AppBundle, targetAppId: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });
  if (b.manifest.appId !== targetAppId) add("/manifest/appId", "APP_ID_MISMATCH", "appId must equal the host-bound target app");
  const fields = b.data.fields;
  const keys = Object.keys(fields);
  if (keys.length > LIMITS.maxFields) add("/data/fields", "LIMIT_EXCEEDED", `at most ${LIMITS.maxFields} fields`);
  for (const k of keys) {
    const p = `/data/fields/${k}`;
    if (RESERVED_KEYS.has(k)) add(p, "RESERVED_FIELD", "reserved field name");
    const f = fields[k]!;
    const spec = fieldSpec(f);
    if (spec.type === "string" && spec.minLength > spec.maxLength) add(`${p}/minLength`, "RANGE", "minLength must be <= maxLength");
    if (spec.type === "integer" && spec.minimum > spec.maximum) add(`${p}/minimum`, "RANGE", "minimum must be <= maximum");
    if (spec.type === "enum" && spec.values.length > LIMITS.maxEnumValues) add(`${p}/values`, "LIMIT_EXCEEDED", "too many enum values");
    if (spec.default !== undefined) {
      const why = valueIssue(spec, spec.default);
      if (why) add(`${p}/default`, "INVALID_DEFAULT", `default ${why}`);
    }
  }
  const v = b.view;
  const refCheck = (path: string, key: string) => {
    if (!Object.hasOwn(fields, key)) {
      add(path, "UNKNOWN_FIELD", `field "${key}" does not exist`);
      return false;
    }
    return true;
  };
  if (refCheck("/view/titleField", v.titleField) && fields[v.titleField]!.type !== "string") {
    add("/view/titleField", "FIELD_TYPE", "titleField must be a string field");
  }
  if (v.searchField !== undefined && refCheck("/view/searchField", v.searchField) && fields[v.searchField]!.type !== "string") {
    add("/view/searchField", "FIELD_TYPE", "searchField must be a string field");
  }
  const listCheck = (name: "columns" | "formFields" | "filters") => {
    const seen = new Set<string>();
    v[name].forEach((key, i) => {
      if (seen.has(key)) add(`/view/${name}/${i}`, "DUPLICATE", `duplicate field "${key}"`);
      seen.add(key);
      if (refCheck(`/view/${name}/${i}`, key) && name === "filters") {
        const t = fields[key]!.type;
        if (t !== "boolean" && t !== "enum") add(`/view/filters/${i}`, "FIELD_TYPE", "filters may only reference boolean or enum fields");
      }
    });
  };
  listCheck("columns");
  listCheck("formFields");
  listCheck("filters");
  if (!v.columns.includes(v.titleField)) add("/view/columns", "TITLE_NOT_IN_COLUMNS", "columns must include titleField");
  for (const k of keys) {
    if (fields[k]!.default === undefined && !v.formFields.includes(k)) {
      add(`/data/fields/${k}`, "REQUIRED_FIELD_HIDDEN", `field "${k}" has no default and must appear in formFields`);
    }
  }
  if (!b.manifest.capabilities.includes("records.read")) add("/manifest/capabilities", "CAPABILITY", "records.read is required");
  return issues;
}

export function specEqual(a: FieldSpec, b: FieldSpec): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function contractFromBundle(b: AppBundle): DataContract {
  const fields: Record<string, FieldSpec> = {};
  for (const [k, f] of Object.entries(b.data.fields)) fields[k] = fieldSpec(f);
  return { fields };
}

/**
 * Compatibility with the app's current data contract (spec §8).
 * candidate: must carry every contract field unchanged; added fields need a valid default.
 * historical: an already activated revision may carry a subset, each field unchanged.
 * A null/empty contract (never activated) accepts any semantically valid bundle.
 */
export function checkCompatibility(b: AppBundle, contract: DataContract | null, mode: "candidate" | "historical"): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (contract === null || Object.keys(contract.fields).length === 0) return issues;
  const fields = b.data.fields;
  if (mode === "candidate") {
    for (const [k, spec] of Object.entries(contract.fields)) {
      if (!Object.hasOwn(fields, k)) {
        issues.push({ path: `/data/fields/${k}`, code: "SCHEMA_INCOMPATIBLE", message: `existing field "${k}" must be kept` });
      } else if (!specEqual(fieldSpec(fields[k]!), spec)) {
        issues.push({
          path: `/data/fields/${k}`,
          code: "SCHEMA_INCOMPATIBLE",
          message: `existing field "${k}" must keep type, constraints, values and default: ${canonicalJson(spec)}`,
        });
      }
    }
    for (const [k, f] of Object.entries(fields)) {
      if (!Object.hasOwn(contract.fields, k) && f.default === undefined) {
        issues.push({ path: `/data/fields/${k}/default`, code: "SCHEMA_INCOMPATIBLE", message: `new field "${k}" needs a default` });
      }
    }
  } else {
    for (const [k, f] of Object.entries(fields)) {
      const spec = contract.fields[k];
      if (spec === undefined || !specEqual(fieldSpec(f), spec)) {
        issues.push({ path: `/data/fields/${k}`, code: "SCHEMA_INCOMPATIBLE", message: `field "${k}" differs from the data contract` });
      }
    }
  }
  return issues;
}

/** Merge newly added fields into the contract (only-growing). */
export function growContract(contract: DataContract | null, b: AppBundle): { contract: DataContract; added: string[] } {
  const fields: Record<string, FieldSpec> = { ...(contract?.fields ?? {}) };
  const added: string[] = [];
  for (const [k, f] of Object.entries(b.data.fields)) {
    if (!Object.hasOwn(fields, k)) {
      fields[k] = fieldSpec(f);
      added.push(k);
    }
  }
  return { contract: { fields }, added };
}

/** Full validation used by stage/validate/activate. */
export function validateBundle(
  input: unknown,
  targetAppId: string,
  contract: DataContract | null,
  mode: "candidate" | "historical",
): { bundle?: AppBundle; structural: boolean; issues: ValidationIssue[] } {
  const s = checkStructure(input);
  if (!s.ok) return { structural: false, issues: s.issues };
  const bundle = normalizeBundle(s.bundle);
  const issues = [...checkSemantics(bundle, targetAppId), ...checkCompatibility(bundle, contract, mode)];
  return { bundle, structural: true, issues };
}
