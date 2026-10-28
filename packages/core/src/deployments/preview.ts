import type { CodeBundle, DataContract, FieldSpec, RecordEnvelopeV2, RpcSchema } from "@agentos/contracts";

/**
 * Platform preview fixtures (spec §14.1): candidates never see real records or real services. Health checks use an
 * empty collection and a small default-valued collection derived from the contract only.
 */
function sampleValue(spec: FieldSpec, i: number): string | number | boolean {
  if (spec.default !== undefined) return spec.default;
  switch (spec.type) {
    case "string": {
      const base = `示例${i + 1}`;
      const s = base.length < spec.minLength ? base.padEnd(spec.minLength, "x") : base;
      return [...s].slice(0, spec.maxLength).join("");
    }
    case "boolean":
      return false;
    case "integer":
      return Math.max(spec.minimum, Math.min(spec.maximum, 0));
    case "enum":
      return spec.values[0]!;
  }
}

export function previewRecords(bundle: CodeBundle, contract: DataContract, n: number): RecordEnvelopeV2[] {
  const out: RecordEnvelopeV2[] = [];
  const visible = Object.keys(bundle.data.fields);
  for (let i = 0; i < n; i++) {
    const data: Record<string, string | number | boolean> = {};
    for (const k of visible) {
      const spec = contract.fields[k];
      if (spec) data[k] = sampleValue(spec, i);
    }
    out.push({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, recordVersion: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", data });
  }
  return out;
}

/** A minimal value satisfying a bounded RPC schema (ids taken from the fixture when a string array looks like ids). */
export function sampleInput(schema: RpcSchema, ids: string[], depth = 0): unknown {
  const s = schema as Record<string, any>;
  if (depth > 8) return null;
  switch (s.type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const props = (s.properties ?? {}) as Record<string, RpcSchema>;
      for (const k of (s.required ?? []) as string[]) out[k] = sampleInput(props[k]!, ids, depth + 1);
      return out;
    }
    case "array": {
      const n = Math.max(1, s.minItems ?? 0);
      const items = s.items as Record<string, any>;
      if (items?.type === "string" && !items.enum && ids.length > 0) return ids.slice(0, Math.min(Math.max(n, ids.length), s.maxItems ?? 1));
      return Array.from({ length: Math.min(n, s.maxItems ?? n) }, () => sampleInput(items as RpcSchema, ids, depth + 1));
    }
    case "string": {
      if (Array.isArray(s.enum)) return s.enum[0];
      const min = s.minLength ?? 0;
      const base = "示例";
      return (base.length >= min ? base : base.padEnd(min, "x")).slice(0, s.maxLength ?? 2);
    }
    case "integer":
      if (Array.isArray(s.enum)) return s.enum[0];
      return Math.max(s.minimum ?? 0, Math.min(s.maximum ?? 1, 1));
    case "number":
      return Math.max(s.minimum ?? 0, Math.min(s.maximum ?? 1, 1));
    case "boolean":
      return false;
    default:
      return null;
  }
}
