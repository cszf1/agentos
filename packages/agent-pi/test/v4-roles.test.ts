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
