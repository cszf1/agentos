export type Priority = "low" | "normal" | "high";
const LABELS: Record<Priority, string> = { high: "高", normal: "普通", low: "低" };
export function priorityLabel(p: Priority): string {
  return LABELS[p] ?? p;
}
