import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PermitReleaseOutbox } from "../../packages/host/src/permit-release-outbox.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function journal(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-permits-"));
  dirs.push(dir);
  return path.join(dir, "outbox.sqlite");
}
function pending(file: string): number {
  const db = new DatabaseSync(file);
  try { return Number(db.prepare("SELECT COUNT(*) AS n FROM releases").get()?.n); }
  finally { db.close(); }
}

it("replays both completed model and build releases after an outage and Host restart", async () => {
  const file = journal();
  const first = new PermitReleaseOutbox(file, "workspace-a");
  first.put("model-permit", "used");
  first.put("build-permit", "used");
  await expect(first.flush(async () => { throw new Error("machined stopped"); })).rejects.toThrow("machined stopped");
  expect(pending(file)).toBe(2);
  const recovered = new PermitReleaseOutbox(file, "workspace-a");
  const seen: string[] = [];
  await recovered.flush(async (op, args) => {
    expect(op).toBe("permits.release");
    expect(args.usage).toBe("used");
    seen.push(args.permitId);
    return { permitId: args.permitId, state: "released", usageStatus: "used" };
  });
  expect(seen.sort()).toEqual(["build-permit", "model-permit"]);
  expect(pending(file)).toBe(0);
});

it("retries the same permit after a lost acknowledgement and does not accept a held or mismatched result", async () => {
  const file = journal();
  const outbox = new PermitReleaseOutbox(file, "workspace-a");
  outbox.put("stable-id", "unknown");
  for (const result of [{ permitId: "stable-id", state: "reconciling" }, { permitId: "other", state: "released" }, null]) {
    await outbox.flush(async (_, args) => {
      expect(args).toEqual({ permitId: "stable-id", usage: "unknown" });
      return result;
    });
    expect(pending(file)).toBe(1);
  }
  await outbox.flush(async () => ({ permitId: "stable-id", state: "released" }));
  expect(pending(file)).toBe(0);
});

it("does not invent timeout completion or persist arbitrary usage payloads", async () => {
  const file = journal();
  const outbox = new PermitReleaseOutbox(file, "workspace-a");
  await outbox.flush(async () => { throw new Error("no terminal work should be reported"); });
  expect(pending(file)).toBe(0);
  outbox.put("unused-id", "unused");
  outbox.put("unused-id", "used");
  await outbox.flush(async (_, args) => {
    expect(args).toEqual({ permitId: "unused-id", usage: "unused" });
    return { permitId: args.permitId, state: "revoked" };
  });
  expect(pending(file)).toBe(0);
});

it("persists only numeric token metrics, never arbitrary provider data", async () => {
  const file = journal();
  const outbox = new PermitReleaseOutbox(file, "workspace-a");
  outbox.put("metrics-id", "used", { input: 10, output: 5, totalTokens: 15, cost: { secret: "faux-private" }, apiKey: "faux-private" });
  expect(fs.readFileSync(file).includes(Buffer.from("faux-private"))).toBe(false);
  await outbox.flush(async (_, args) => {
    expect(args).toEqual({ permitId: "metrics-id", usage: "used", usage_json: { input: 10, output: 5, totalTokens: 15 } });
    return { permitId: "metrics-id", state: "released" };
  });
});

it("does not replay a source workspace's journal after cloning its data", async () => {
  const file = journal();
  new PermitReleaseOutbox(file, "source-workspace").put("source-permit", "used");
  const clone = new PermitReleaseOutbox(file, "cloned-workspace");
  clone.put("clone-permit", "used");
  await clone.flush(async (_, args) => {
    expect(args.permitId).toBe("clone-permit");
    return { permitId: args.permitId, state: "released" };
  });
  expect(pending(file)).toBe(1);
});

it("an unacknowledged old permit cannot starve newer terminal reports", async () => {
  const file = journal();
  const outbox = new PermitReleaseOutbox(file, "workspace-a");
  outbox.put("old-permit", "unknown");
  outbox.put("new-permit", "used");
  await expect(outbox.flush(async (_, args) => {
    if (args.permitId === "old-permit") throw new Error("old permit unavailable");
    return { permitId: args.permitId, state: "released" };
  })).rejects.toThrow("old permit unavailable");
  expect(pending(file)).toBe(1);
});
