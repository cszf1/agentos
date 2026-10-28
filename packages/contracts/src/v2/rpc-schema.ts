import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { canonicalJson, RESERVED_KEYS, type ValidationIssue } from "../bundle.js";

/**
 * Spec §7.1: RPC payload schemas use a bounded JSON Schema subset: object, array, string, integer, number, boolean,
 * enum, required, range and length limits. Objects reject unknown fields. No $ref, no recursion (impossible without
 * $ref), no pattern/format (no arbitrary regex), no execution extensions. Max nesting depth 8.
 */
export const RPC_SCHEMA_MAX_DEPTH = 8;

const KEYWORDS: Record<string, ReadonlySet<string>> = {
  object: new Set(["type", "properties", "required", "additionalProperties", "description", "title"]),
  array: new Set(["type", "items", "minItems", "maxItems", "description", "title"]),
  string: new Set(["type", "minLength", "maxLength", "enum", "description", "title"]),
  integer: new Set(["type", "minimum", "maximum", "enum", "description", "title"]),
  number: new Set(["type", "minimum", "maximum", "description", "title"]),
  boolean: new Set(["type", "description", "title"]),
};
const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_SCHEMA_BYTES = 16 * 1024;

export type RpcSchema = Record<string, unknown>;

/** Structural check of a payload schema. Returns issues with paths rooted at `root`. */
export function checkRpcSchema(schema: unknown, root: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, code: "INVALID_RPC_SCHEMA", message });
  let text: string;
  try {
    text = JSON.stringify(schema);
  } catch {
    add(root, "schema is not JSON");
    return issues;
  }
  if (text === undefined || Buffer.byteLength(text) > MAX_SCHEMA_BYTES) {
    add(root, `schema must be JSON of at most ${MAX_SCHEMA_BYTES} bytes`);
    return issues;
  }
  const walk = (s: unknown, path: string, depth: number) => {
    if (issues.length > 20) return;
    if (depth > RPC_SCHEMA_MAX_DEPTH) return add(path, `nesting deeper than ${RPC_SCHEMA_MAX_DEPTH}`);
    if (s === null || typeof s !== "object" || Array.isArray(s)) return add(path, "schema node must be an object");
    const node = s as Record<string, unknown>;
    const type = node.type;
    if (typeof type !== "string" || !Object.hasOwn(KEYWORDS, type)) {
      return add(`${path}/type`, "type must be one of object, array, string, integer, number, boolean");
    }
    const allowed = KEYWORDS[type]!;
    for (const k of Object.keys(node)) {
      if (!allowed.has(k)) add(`${path}/${k}`, `keyword "${k}" is not allowed for ${type}`);
    }
    for (const k of ["description", "title"]) {
      if (node[k] !== undefined && (typeof node[k] !== "string" || (node[k] as string).length > 256)) add(`${path}/${k}`, `${k} must be a string of at most 256 characters`);
    }
    const nonNegInt = (k: string, max: number) => {
      const v = node[k];
      if (v !== undefined && (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > max)) add(`${path}/${k}`, `${k} must be an integer 0..${max}`);
    };
    switch (type) {
      case "object": {
        const props = node.properties ?? {};
        if (props === null || typeof props !== "object" || Array.isArray(props)) {
          add(`${path}/properties`, "properties must be an object");
          break;
        }
        const keys = Object.keys(props);
        if (keys.length > 64) add(`${path}/properties`, "at most 64 properties");
        for (const k of keys) {
          if (!IDENT.test(k) || RESERVED_KEYS.has(k)) add(`${path}/properties/${k}`, "property names are ASCII identifiers and not reserved keys");
          walk((props as Record<string, unknown>)[k], `${path}/properties/${k}`, depth + 1);
        }
        if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
          add(`${path}/additionalProperties`, "objects reject unknown fields: additionalProperties must be false or omitted");
        }
        if (node.required !== undefined) {
          if (!Array.isArray(node.required) || node.required.some((r) => typeof r !== "string" || !keys.includes(r))) {
            add(`${path}/required`, "required must list declared properties");
          } else if (new Set(node.required).size !== node.required.length) add(`${path}/required`, "duplicate required entry");
        }
        break;
      }
      case "array":
        if (node.items === undefined) add(`${path}/items`, "arrays must declare items");
        else walk(node.items, `${path}/items`, depth + 1);
        nonNegInt("minItems", 100_000);
        nonNegInt("maxItems", 100_000);
        if (node.maxItems === undefined) add(`${path}/maxItems`, "arrays must declare maxItems");
        break;
      case "string":
        nonNegInt("minLength", 1_000_000);
        nonNegInt("maxLength", 1_000_000);
        if (node.enum !== undefined) {
          if (!Array.isArray(node.enum) || node.enum.length === 0 || node.enum.length > 64 || node.enum.some((v) => typeof v !== "string")) {
            add(`${path}/enum`, "enum must be 1..64 strings");
          }
        } else if (node.maxLength === undefined) add(`${path}/maxLength`, "strings must declare maxLength or enum");
        break;
      case "integer":
      case "number":
        for (const k of ["minimum", "maximum"]) {
          const v = node[k];
          if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || (type === "integer" && !Number.isSafeInteger(v)))) {
            add(`${path}/${k}`, `${k} must be a finite ${type}`);
          }
        }
        if (type === "integer" && node.enum !== undefined) {
          if (!Array.isArray(node.enum) || node.enum.length === 0 || node.enum.length > 64 || node.enum.some((v) => !Number.isSafeInteger(v))) {
            add(`${path}/enum`, "enum must be 1..64 integers");
          }
        }
        break;
    }
  };
  walk(schema, root, 1);
  return issues;
}

/** Objects get additionalProperties:false so unknown fields are rejected. */
function closeObjects(s: RpcSchema): RpcSchema {
  const out: RpcSchema = { ...s };
  if (out.type === "object") {
    out.additionalProperties = false;
    const props = (out.properties ?? {}) as Record<string, RpcSchema>;
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, closeObjects(v)]));
  } else if (out.type === "array" && out.items) out.items = closeObjects(out.items as RpcSchema);
  return out;
}

const ajv = new Ajv2020({ allErrors: false, strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
const cache = new Map<string, ValidateFunction>();

/** Compile a schema that already passed checkRpcSchema. Cached by canonical text. */
export function compileRpcSchema(schema: RpcSchema): ValidateFunction {
  const closed = closeObjects(schema);
  const key = canonicalJson(closed);
  let fn = cache.get(key);
  if (!fn) {
    fn = ajv.compile(closed);
    if (cache.size > 512) cache.clear();
    cache.set(key, fn);
  }
  return fn;
}

/** Validate a value against an RPC schema; returns the first issue or undefined. */
export function rpcValueIssue(schema: RpcSchema, value: unknown, root = ""): ValidationIssue | undefined {
  const fn = compileRpcSchema(schema);
  if (fn(value)) return undefined;
  const e = fn.errors?.[0];
  let path = `${root}${e?.instancePath ?? ""}` || "/";
  if (e?.keyword === "additionalProperties" && typeof e.params.additionalProperty === "string") path = `${path}/${e.params.additionalProperty}`;
  if (e?.keyword === "required" && typeof e.params.missingProperty === "string") path = `${path}/${e.params.missingProperty}`;
  return { path, code: "SCHEMA_MISMATCH", message: e?.message ?? "value does not match schema" };
}

/** Contract identity of an RPC signature (used for export/import contractHash). */
export function schemaIdentity(schema: RpcSchema): string {
  return canonicalJson(closeObjects(schema));
}
