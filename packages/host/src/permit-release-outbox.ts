import { DatabaseSync } from "node:sqlite";

export type PermitUsage = "used" | "unused" | "unknown";
type Call = (op: string, args: { permitId: string; usage: PermitUsage; usage_json?: Record<string, number> }) => Promise<unknown>;

function usageMetrics(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object") return null;
  const metrics: Record<string, number> = {};
  for (const [key, amount] of Object.entries(value)) {
    if (["input", "output", "totalTokens"].includes(key) && typeof amount === "number" && Number.isFinite(amount) && amount >= 0) metrics[key] = amount;
  }
  return Object.keys(metrics).length ? metrics : null;
}

export class PermitReleaseOutbox {
  readonly #db: DatabaseSync;
  #flushing = false;

  constructor(file: string, readonly workspaceId: string) {
    this.#db = new DatabaseSync(file);
    this.#db.exec("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS releases (workspace_id TEXT NOT NULL, permit_id TEXT NOT NULL, usage TEXT NOT NULL CHECK(usage IN ('used','unused','unknown')), usage_json TEXT, PRIMARY KEY(workspace_id, permit_id))");
  }

  put(permitId: string, usage: PermitUsage, usageJson?: unknown): void {
    this.#db.prepare("INSERT INTO releases (workspace_id, permit_id, usage, usage_json) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, permit_id) DO NOTHING").run(this.workspaceId, permitId, usage, JSON.stringify(usageMetrics(usageJson)));
  }

  async flush(call: Call): Promise<void> {
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      let failed: unknown;
      for (const row of this.#db.prepare("SELECT permit_id, usage, usage_json FROM releases WHERE workspace_id = ?").all(this.workspaceId)) {
        const permitId = row.permit_id;
        const usage = row.usage;
        if (typeof permitId !== "string" || (usage !== "used" && usage !== "unused" && usage !== "unknown")) throw new Error("invalid permit release journal");
        const metrics = usageMetrics(typeof row.usage_json === "string" ? JSON.parse(row.usage_json) : null);
        try {
          const result = await call("permits.release", { permitId, usage, ...(metrics ? { usage_json: metrics } : {}) });
          if (result && typeof result === "object" && "permitId" in result && result.permitId === permitId && "state" in result && (result.state === "released" || result.state === "revoked")) {
            this.#db.prepare("DELETE FROM releases WHERE workspace_id = ? AND permit_id = ?").run(this.workspaceId, permitId);
          }
        } catch (error) {
          failed = error;
        }
      }
      if (failed) throw failed;
    } finally {
      this.#flushing = false;
    }
  }
}
