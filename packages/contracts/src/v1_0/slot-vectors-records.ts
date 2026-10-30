// formatVersion 1 records view model shared by the web AppView and the native Shell (spec §10.2 first row, V1-D02).
// Port of packages/web/src/AppView.tsx: default draft rules, hidden fields kept by sending only changed form fields,
// search/filter/paging requests, version rebase. Local field checks use the Host's own valueIssue().
import { fieldSpec, valueIssue, type AppBundle, type Field, type FieldValue } from "../bundle.js";
import { forward, type ForwardRequest } from "./slot-vectors.js";

export const RECORDS_PAGE = 20;
type Draft = Record<string, FieldValue | undefined>;

export function defaultDraft(bundle: AppBundle): Draft {
  const d: Draft = {};
  for (const k of bundle.view.formFields) {
    const f = bundle.data.fields[k]!;
    if (f.default !== undefined) d[k] = f.default;
    else if (f.type === "boolean") d[k] = false;
    else if (f.type === "string") d[k] = "";
    else if (f.type === "enum") d[k] = f.values[0]!;
  }
  return d;
}

export function displayValue(f: Field, v: FieldValue | undefined): string {
  if (v === undefined) return "";
  if (f.type === "boolean") return v ? "✓" : "—";
  return String(v);
}

/** What an input control hands back: integer "" -> undefined, otherwise Number(text) (a number input never gives junk). */
export function fieldInput(f: Field, raw: string | boolean): FieldValue | undefined {
  if (f.type === "boolean") return raw === true;
  if (f.type === "integer") return raw === "" ? undefined : Number(raw);
  return String(raw);
}

export function listRequest(appId: string, bundle: AppBundle, q: string, filters: Record<string, FieldValue>, offset: number): ForwardRequest {
  const body: Record<string, unknown> = {};
  if (bundle.view.searchField && q) body.q = q;
  if (Object.keys(filters).length > 0) body.filters = filters;
  body.offset = offset;
  body.limit = RECORDS_PAGE;
  return forward("apps.records.list", { appId }, body, "read");
}

/** A filter select changed ("" = all). Booleans arrive as "true"/"false" and become booleans. */
export function changeFilter(bundle: AppBundle, filters: Record<string, FieldValue>, key: string, v: string): Record<string, FieldValue> {
  const f = bundle.data.fields[key]!;
  const next = { ...filters };
  if (v === "") delete next[key];
  else next[key] = f.type === "boolean" ? v === "true" : v;
  return next;
}

/** Filters the active version no longer offers are dropped on a version switch. */
export function keepFilters(bundle: AppBundle, filters: Record<string, FieldValue>): Record<string, FieldValue> {
  return Object.fromEntries(Object.entries(filters).filter(([k]) => bundle.view.filters.includes(k)));
}

export function openEdit(bundle: AppBundle, data: Record<string, FieldValue>): Draft {
  const draft: Draft = {};
  for (const k of bundle.view.formFields) if (data[k] !== undefined) draft[k] = data[k]!;
  return draft;
}

export function localIssues(bundle: AppBundle, draft: Draft): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of bundle.view.formFields) {
    const v = draft[k];
    if (v === undefined) continue;
    const msg = valueIssue(fieldSpec(bundle.data.fields[k]!), v);
    if (msg) out[k] = msg;
  }
  return out;
}

export function createRequest(appId: string, appEpoch: number, draft: Draft, key: string): ForwardRequest {
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(draft)) if (v !== undefined) data[k] = v;
  return forward("apps.records.post", { appId }, { expectedAppEpoch: appEpoch, data }, key);
}

/** Only changed form fields go out, so fields hidden by this version are never touched. null = nothing changed. */
export function editRequest(appId: string, appEpoch: number, record: { id: string; recordVersion: number; data: Record<string, FieldValue> }, draft: Draft, key: string): ForwardRequest | null {
  const changes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(draft)) if (v !== undefined && v !== record.data[k]) changes[k] = v;
  if (Object.keys(changes).length === 0) return null;
  return forward("apps.records.patch", { appId, recordId: record.id }, { expectedAppEpoch: appEpoch, expectedRecordVersion: record.recordVersion, changes }, key);
}

export function deleteRequest(appId: string, appEpoch: number, record: { id: string; recordVersion: number }, key: string): ForwardRequest {
  return forward("apps.records.delete", { appId, recordId: record.id }, { expectedAppEpoch: appEpoch, expectedRecordVersion: record.recordVersion }, key);
}

/** Rebase a dirty form onto a new version: keep values for fields the new form still has. */
export function rebase(bundle: AppBundle, mode: "create" | "edit", draft: Draft): Draft {
  const fresh: Draft = mode === "create" ? defaultDraft(bundle) : {};
  for (const k of bundle.view.formFields) if (draft[k] !== undefined) fresh[k] = draft[k]!;
  return fresh;
}

export function deployRequest(appId: string, appEpoch: number, revisionId: string, key: string): ForwardRequest {
  return forward("apps.deployments.post", { appId }, { revisionId, expectedAppEpoch: appEpoch }, key);
}

/** Form key rule: a network failure keeps the key (a retry cannot write twice); any server answer needs a fresh key. */
export function keyAfter(outcome: "network" | "server"): "keep" | "fresh" {
  return outcome === "network" ? "keep" : "fresh";
}
