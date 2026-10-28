import { defineCommands, defineQueries, type Mutation } from "@agentos/app-sdk";
import Papa from "papaparse";
import { format, isValid, parseISO } from "date-fns";

const PRIORITIES = new Set(["low", "normal", "high"]);

export const queries = defineQueries({
  main: (_input: Record<string, never>, ctx) => {
    const items = ctx.records.map((r) => ({
      id: r.id,
      title: String(r.data.title),
      done: r.data.done === true,
      due: String(r.data.due ?? ""),
      priority: String(r.data.priority ?? "normal"),
    }));
    return { items, total: items.length };
  },
});

export const commands = defineCommands({
  add: (input: { title: string }) => ({ result: { created: 1 }, mutations: [{ kind: "create", localKey: "new", data: { title: input.title } }] }),
  importCsv: (input: { csv: string }) => {
    const parsed = Papa.parse<Record<string, string>>(input.csv.trim(), { header: true, skipEmptyLines: true });
    if (parsed.errors.length > 0) throw new Error(`CSV 解析失败：第 ${(parsed.errors[0]!.row ?? 0) + 1} 行 ${parsed.errors[0]!.message}`);
    const rows = parsed.data;
    if (rows.length === 0) throw new Error("CSV 没有数据行");
    if (rows.length > 100) throw new Error(`最多导入 100 行，收到 ${rows.length} 行`);
    const mutations: Mutation[] = rows.map((row, i) => {
      const title = (row.title ?? "").trim();
      if (title.length === 0) throw new Error(`第 ${i + 1} 行缺少 title`);
      const data: Record<string, string | boolean> = { title };
      if (row.done !== undefined && row.done !== "") data.done = ["1", "true", "yes", "是"].includes(row.done.trim().toLowerCase());
      if (row.due) {
        const d = parseISO(row.due.trim());
        if (!isValid(d)) throw new Error(`第 ${i + 1} 行日期无效：${row.due}`);
        data.due = format(d, "yyyy-MM-dd");
      }
      if (row.priority) {
        const p = row.priority.trim().toLowerCase();
        if (!PRIORITIES.has(p)) throw new Error(`第 ${i + 1} 行优先级无效：${row.priority}`);
        data.priority = p;
      }
      return { kind: "create", localKey: `row${i + 1}`, data };
    });
    return { result: { imported: mutations.length }, mutations };
  },
});
