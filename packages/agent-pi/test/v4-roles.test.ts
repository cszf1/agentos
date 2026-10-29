/**
 * V4-P02 role boundary (spec §21.3): each role's Pi extension carries exactly its tool list; maintenance roles have no
 * grant, exec, spawn, shell, fetch, activation or record-reading entry, and compaction has no tool at all.
 */
import { describe, expect, it } from "vitest";
import { AGENT_PROFILES } from "@agentos/contracts";
import { createRoleExtensions } from "../src/tools.js";

const FORBIDDEN = /grant|exec|spawn|shell|fetch|activate|prepare|records?_|app_stage|system_plan|install|publish/i;

describe("V4-P02 role tool sets", () => {
  const ext = createRoleExtensions(new Proxy({}, { get: () => () => ({ ok: false }) }) as never);
  const names = (p: keyof typeof ext) => ((ext[p] as unknown as { tools?: { name: string }[] }).tools ?? []).map((t) => t.name).sort();

  it("every role carries exactly its declared tools", () => {
    for (const p of Object.keys(ext) as (keyof typeof ext)[]) expect(names(p)).toEqual([...AGENT_PROFILES[p].tools].sort());
  });

  it("maintenance roles have no grant/exec/spawn/activation/data entry; compaction has no tool", () => {
    for (const p of ["maintenance-analyst", "maintenance-refactor"] as const) {
      for (const n of names(p)) expect(n, `${p}:${n}`).not.toMatch(FORBIDDEN);
    }
    expect(names("compaction")).toEqual([]);
    // the refactor role can stage and check a candidate and register a proposal, but never publish it
    expect(names("maintenance-refactor")).toContain("proposal_submit");
    expect(names("maintenance-refactor")).not.toContain("app_activate");
  });
});

describe("bundle strings with a trailing bracket defect", () => {
  const obj = { formatVersion: 2, title: "看板", ui: { root: { type: "Stack", children: [{ type: "Button", input: { form: "f" } }] } } };
  const text = JSON.stringify(obj);
  it("one closer too many or too few at the very end is repaired; the body is unchanged", async () => {
    const { decodeBundleArg, undecodableBundle } = await import("../src/tools.js");
    for (const bad of [text + "}", text.slice(0, -1), text.slice(0, -2) + "}}}}", text + " \n"]) {
      expect(undecodableBundle(bad)).toBeNull();
      expect(decodeBundleArg(bad)).toEqual(obj);
    }
  });
  it("a defect inside the body is still refused with its position", async () => {
    const { decodeBundleArg, undecodableBundle } = await import("../src/tools.js");
    const bad = text.replace('"Button",', '"Button" ');
    expect(undecodableBundle(bad)).toMatch(/not valid JSON/);
    expect(decodeBundleArg(bad)).toBe(bad);
    const early = JSON.stringify({ a: [1, 2], b: "x" }).replace("2]", "2}");
    expect(undecodableBundle(early)).toMatch(/not valid JSON/);
  });
});

describe("maintenance_report argument schema", () => {
  it("is closed: unknown fields, an unlisted template and a free-form confidence fail Pi's validation before the host", async () => {
    const { validateToolArguments } = await import("@earendil-works/pi-ai");
    const ext = createRoleExtensions(new Proxy({}, { get: () => () => ({ ok: false }) }) as never);
    const tools = (ext["maintenance-analyst"] as unknown as { tools?: { name: string; parameters: unknown }[] }).tools ?? [];
    const t = tools.find((x) => x.name === "maintenance_report");
    expect(t).toBeTruthy();
    const v = { Check: (args: unknown) => { try { validateToolArguments(t as never, { name: "maintenance_report", arguments: args } as never); return true; } catch { return false; } } };
    const good = { summary: "s", hypotheses: [{ text: "h", confidence: "low" }], evidenceRefs: ["incident:1"], recommendedTemplate: "app-recovery" };
    expect(v.Check(good)).toBe(true);
    expect(v.Check({ ...good, explanation: "x" })).toBe(false);
    expect(v.Check({ ...good, recommendedTemplate: "memory_resource_exhaustion" })).toBe(false);
    expect(v.Check({ ...good, hypotheses: [{ text: "h", confidence: "certain" }] })).toBe(false);
  });
});
