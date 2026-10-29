import { describe, it, expect } from "vitest";
import { checkPlan } from "../../packages/core/src/records/mutations.js";
import { RunCoordinator } from "@agentos/core";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { checkSlotTree, slotTreeSchemaDocument } from "@agentos/contracts";
// The web source is type-checked by its own project (DOM lib, bundler resolution); here it is only loaded.
const SLOT_RENDERER = "../../packages/web/src/SlotRenderer.js";
const { SlotPreview } = (await import(/* @vite-ignore */ SLOT_RENDERER)) as { SlotPreview: (props: Record<string, unknown>) => ReturnType<typeof createElement> };
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

describe("review #5: item bindings (implemented in v0.4 as the slot-tree-v2 List item template)", () => {
  const ctx = (kind: "slot-tree-v1" | "slot-tree-v2") => ({ queries: { listTodos: { inputSchema: {} } }, commands: { toggleDone: {} }, systemActions: {}, viewKind: kind });
  const view = (kind: "slot-tree-v1" | "slot-tree-v2", main: unknown) => ({ kind, dataSources: { todos: { queryId: "listTodos" } }, slots: { main } });
  const msgs = (kind: "slot-tree-v1" | "slot-tree-v2", main: unknown) => checkSlotTree(view(kind, main), ctx(kind) as never).issues.map((i) => i.message);
  const item = (pointer: string) => ({ $bind: { from: "item", pointer } });
  const list = (children: unknown[], extra: Record<string, unknown> = {}) => ({ type: "List", props: { items: { $bind: { from: "query", source: "todos", pointer: "/items" } }, rowId: "/id", ...extra }, children });
  const good = list([
    { type: "Text", props: { text: item("/title"), variant: "title" } },
    { type: "Text", props: { text: "已完成" }, visibleWhen: { value: item("/done"), op: "eq", equals: true } },
    { type: "Button", props: { label: "切换", command: "toggleDone", input: { item: { pointer: "/id", as: "id" } } } },
  ]);

  it("a v2 List with item bindings, an item visibleWhen and a Button input.item validates", () => {
    expect(msgs("slot-tree-v2", good)).toEqual([]);
  });
  it("item bindings outside a list item are still refused (v1 and v2)", () => {
    expect(msgs("slot-tree-v1", { type: "Text", props: { text: item("/title") } })).toContain("item bindings are only valid inside a list item");
    expect(msgs("slot-tree-v2", { type: "Text", props: { text: item("/title") } })).toContain("item bindings are only valid inside a list item");
    expect(msgs("slot-tree-v2", list([{ type: "Text", props: { text: "x" } }], { items: item("/sub") }))).toContain("item bindings are only valid inside a list item");
  });
  it("v1 stays frozen: no List, no input.item", () => {
    expect(msgs("slot-tree-v1", good).join(" ")).toMatch(/needs slot-tree-v2|unknown component/);
    expect(msgs("slot-tree-v1", { type: "Button", props: { label: "x", command: "toggleDone", input: { item: { pointer: "/id", as: "id" } } } }).length).toBeGreaterThan(0);
    expect(JSON.stringify(slotTreeSchemaDocument(1), null, 2) + "\n").toBe(fs.readFileSync(path.join(import.meta.dirname, "../../docs/contracts/slot-tree-v1.schema.json"), "utf8"));
  });
  it("refuses what would repeat or explode per item", () => {
    expect(msgs("slot-tree-v2", list([list([{ type: "Text", props: { text: "x" } }])]))).toContain("lists cannot be nested");
    expect(msgs("slot-tree-v2", list([{ type: "Form", props: { formId: "f" }, children: [] }])).join(" ")).toMatch(/forms cannot be inside a list item/);
    expect(msgs("slot-tree-v2", list([{ type: "Table", props: { items: item("/subtasks"), columns: [{ pointer: "/t", label: "t" }], selectionId: "s" } }])).join(" ")).toMatch(/selection cannot be declared inside a list item/);
    expect(msgs("slot-tree-v2", { type: "Button", props: { label: "x", command: "toggleDone", input: { item: { pointer: "/id", as: "id" } } } })).toContain("input.item is only valid inside a list item");
    expect(msgs("slot-tree-v2", list(Array.from({ length: 25 }, () => ({ type: "Text", props: { text: "x" } }))))).toContain("a list item template holds at most 24 nodes");
    expect(msgs("slot-tree-v2", { type: "List", props: { items: { $bind: { from: "query", source: "todos", pointer: "/items" } } } })).toContain("List needs an item template (at least one child)");
    expect(msgs("slot-tree-v2", list([{ type: "Text", props: { text: "x" } }], { maxItems: 101 })).length).toBeGreaterThan(0);
  });
  it("a nested Table inside an item may read an item array (no selection)", () => {
    expect(msgs("slot-tree-v2", list([{ type: "Table", props: { items: item("/subtasks"), columns: [{ pointer: "/t", label: "子任务" }] } }]))).toEqual([]);
  });
  it("the real renderer draws one template per item, resolves item bindings and passes input.item", () => {
    const calls: unknown[] = [];
    const html = renderToStaticMarkup(
      createElement(SlotPreview, { node: good as never, sources: { todos: { items: [{ id: "a1", title: "买牛奶", done: true }, { id: "b2", title: "<写周报>", done: false }] } }, onCommand: (p: { command: string }, it: unknown) => calls.push([p.command, it]) }),
    );
    expect(html.match(/role="listitem"/g)?.length).toBe(2);
    expect(html).toContain('data-row-id="a1"');
    expect(html).toContain("买牛奶");
    expect(html).toContain("&lt;写周报&gt;"); // data is text, never markup
    expect(html.match(/已完成/g)?.length).toBe(1); // item visibleWhen: only the done item
    const empty = renderToStaticMarkup(createElement(SlotPreview, { node: list([{ type: "Text", props: { text: item("/title") } }], { emptyText: "没有任务" }) as never, sources: { todos: { items: [] } } }));
    expect(empty).toContain("没有任务");
    const many = renderToStaticMarkup(createElement(SlotPreview, { node: list([{ type: "Text", props: { text: item("/title") } }], { maxItems: 3 }) as never, sources: { todos: { items: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, title: `t${i}` })) } } }));
    expect(many.match(/role="listitem"/g)?.length).toBe(3);
    expect(many).toContain("仅显示前 3 项（共 10 项）");
  });
});
