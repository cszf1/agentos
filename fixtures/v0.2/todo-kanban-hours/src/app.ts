import { defineCommands, defineQueries, type Mutation, type RecordEnvelope } from "@agentos/app-sdk";
import { priorityLabel, type Priority } from "./labels";

function rows(records: readonly RecordEnvelope[]) {
  return records.map((r) => ({
    id: r.id,
    version: r.recordVersion,
    title: String(r.data.title),
    done: r.data.done === true,
    priority: (r.data.priority ?? "normal") as Priority,
    priorityLabel: priorityLabel((r.data.priority ?? "normal") as Priority),
    estimate_minutes: typeof r.data.estimate_minutes === "number" ? r.data.estimate_minutes : 0,
  }));
}

function summarize(records: readonly RecordEnvelope[]) {
  const items = rows(records);
  const open = items.filter((i) => !i.done);
  return {
    items,
    open,
    totalMinutes: items.reduce((n, i) => n + i.estimate_minutes, 0),
    remainingMinutes: open.reduce((n, i) => n + i.estimate_minutes, 0),
  };
}

export const queries = defineQueries({
  main: (_input: Record<string, never>, ctx) => {
    const s = summarize(ctx.records);
    const byPriority = { high: 0, normal: 0, low: 0 };
    const minutes = { high: 0, normal: 0, low: 0 };
    for (const i of s.open) {
      byPriority[i.priority]++;
      minutes[i.priority] += i.estimate_minutes;
    }
    const chart = (["high", "normal", "low"] as Priority[]).map((p) => ({ priority: priorityLabel(p), open: byPriority[p], minutes: minutes[p] }));
    return {
      items: s.items.map(({ version: _v, ...rest }) => rest),
      total: s.items.length,
      open: s.open.length,
      byPriority,
      totalMinutes: s.totalMinutes,
      remainingMinutes: s.remainingMinutes,
      chart,
    };
  },
  summary: (_input: Record<string, never>, ctx) => {
    const s = summarize(ctx.records);
    return { total: s.items.length, open: s.open.length, remainingMinutes: s.remainingMinutes };
  },
});

export const commands = defineCommands({
  add: (input: { title: string; priority?: Priority; estimate_minutes?: number }) => {
    const data: Record<string, string | number> = { title: input.title };
    if (input.priority) data.priority = input.priority;
    if (typeof input.estimate_minutes === "number") data.estimate_minutes = input.estimate_minutes;
    return { result: { created: 1 }, mutations: [{ kind: "create", localKey: "new", data }] };
  },
  completeMany: (input: { recordIds: string[] }, ctx) => {
    const wanted = new Set(input.recordIds);
    const mutations: Mutation[] = [];
    for (const r of ctx.records) {
      if (wanted.has(r.id) && r.data.done !== true) mutations.push({ kind: "update", recordId: r.id, expectedRecordVersion: r.recordVersion, changes: { done: true } });
    }
    return { result: { completed: mutations.length }, mutations };
  },
  setEstimate: (input: { recordIds: string[]; minutes: number }, ctx) => {
    const wanted = new Set(input.recordIds);
    const mutations: Mutation[] = [];
    for (const r of ctx.records) {
      if (wanted.has(r.id) && r.data.estimate_minutes !== input.minutes) {
        mutations.push({ kind: "update", recordId: r.id, expectedRecordVersion: r.recordVersion, changes: { estimate_minutes: input.minutes } });
      }
    }
    return { result: { updated: mutations.length }, mutations };
  },
});
