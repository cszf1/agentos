import { describe, it, expect } from "vitest";
import { checkPlan } from "../../packages/core/src/records/mutations.js";
import { RunCoordinator } from "@agentos/core";
import { checkSlotTree } from "@agentos/contracts";
import { codeFixture } from "../fixtures-v02.js";

/**
 * Regressions for the code review of main@79377eb (2026-10-28): issues 1–5. Issue 1 (deployment expiry rolled back)
 * is covered on the real sandbox in tests/sandbox/v03-regressions.test.ts; issue 4 in the e2e suite.
 */
describe("review #3: the record limit applies after the whole atomic plan", () => {
  const b = codeFixture("todo-kanban");
  const cmdId = Object.keys(b.commands).find((k) => b.commands[k]!.operations.includes("create") && b.commands[k]!.operations.includes("delete")) ?? Object.keys(b.commands)[0]!;
  const command = { ...b.commands[cmdId]!, operations: ["create", "update", "delete"] as ("create" | "update" | "delete")[] };
  const contract = { fields: b.data.fields } as never;
  const data: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(b.data.fields)) if ((f as { default?: unknown }).default === undefined) data[k] = (f as { type: string }).type === "string" ? "x" : (f as { type: string }).type === "boolean" ? false : (f as { values?: string[] }).values?.[0] ?? 1;
  const get = (id: string) => (id === "old" ? { version: 1, data: { ...data } } : undefined);

  it("delete + create at exactly 1000 records is accepted", () => {
    expect(() => checkPlan({ bundle: b, command: { ...command, writableFields: Object.keys(b.data.fields) } as never, contract, mutations: [{ kind: "delete", recordId: "old", expectedRecordVersion: 1 }, { kind: "create", localKey: "n", data: data as never }] }, get, 1000)).not.toThrow();
  });
  it("two creates after one delete at 1000 still exceed the limit", () => {
    expect(() =>
      checkPlan({ bundle: b, command: { ...command, writableFields: Object.keys(b.data.fields) } as never, contract, mutations: [{ kind: "delete", recordId: "old", expectedRecordVersion: 1 }, { kind: "create", localKey: "n1", data: data as never }, { kind: "create", localKey: "n2", data: data as never }] }, get, 1000),
    ).toThrow(/at most 1000 records/);
  });
});

describe("review #2: a failed abort is retried (v0.4: per-conversation abort)", () => {
  it("abortConversation failing once is attempted again", async () => {
    let calls = 0;
    const run = { id: "r1", status: "cancel_requested", stop_reason: "user", pi_submission_id: null, conversation_id: "c1", execution_epoch: 2 };
    const engine = {
      abortConversation: async (conv: string) => {
        expect(conv).toBe("c1");
        calls++;
        if (calls === 1) throw new Error("transient engine error");
      },
      status: async () => ({ state: "missing" }),
      inspectConversation: async () => ({ scheduling: "running", tasks: 1, submissions: 0, blocked: [] }),
    };
    const runs = { markBlocked: () => undefined, store: {} } as never;
    const c = new RunCoordinator(runs, engine as never, { info() {}, warn() {}, error() {} } as never, 10);
    const watch = (c as unknown as { watch: (r: unknown) => Promise<void> }).watch.bind(c);
    await watch(run).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    await watch(run).catch(() => undefined);
    expect(calls).toBe(1); // not hammered right away
    await new Promise((r) => setTimeout(r, 1100));
    await watch(run).catch(() => undefined);
    expect(calls).toBe(2); // retried after the backoff
  });
});

describe("review #5: item bindings", () => {
  it("are refused by validation because no v1/v2 component provides an item context (the renderer never sees one)", () => {
    const view = { kind: "slot-tree-v1", dataSources: {}, slots: { main: { type: "Text", props: { text: { $bind: { from: "item", pointer: "/title" } } } } } };
    const r = checkSlotTree(view, { queries: new Set(), commands: new Set(), commandInputs: new Map() } as never);
    expect(r.issues.map((i) => i.message)).toContain("item bindings are only valid inside a list item");
  });
});
