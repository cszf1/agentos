import { defineCommands, defineQueries, type Mutation } from "@agentos/app-sdk";
import { priorityLabel, type Priority } from "./labels";

export const queries = defineQueries({
  main: (_input: Record<string, never>, ctx) => {
    const items = ctx.records.map((r) => ({
      id: r.id,
      title: String(r.data.title),
      done: r.data.done === true,
      priority: (r.data.priority ?? "normal") as Priority,
      priorityLabel: priorityLabel((r.data.priority ?? "normal") as Priority),
    }));
    const open = items.filter((i) => !i.done);
    const byPriority = { high: 0, normal: 0, low: 0 };
    for (const i of open) byPriority[i.priority]++;
    return { items, total: items.length, open: open.length, byPriority };
  },
});

export const commands = defineCommands({
  add: (input: { title: string; priority?: Priority }) => {
    const data: Record<string, string> = { title: input.title.trim() || input.title };
    if (input.priority) data.priority = input.priority;
    return { result: { created: 1 }, mutations: [{ kind: "create", localKey: "new", data }] };
  },
  completeMany: (input: { recordIds: string[] }, ctx) => {
    const wanted = new Set(input.recordIds);
    const mutations: Mutation[] = [];
    for (const r of ctx.records) {
      if (wanted.has(r.id) && r.data.done !== true) {
        mutations.push({ kind: "update", recordId: r.id, expectedRecordVersion: r.recordVersion, changes: { done: true } });
      }
    }
    return { result: { completed: mutations.length }, mutations };
  },
});
