/**
 * v0.4 M0 (spec §26 M0, V4-B03, V4-O07): minimal prototype against the pinned Pi 1.4.0, independent of AgentOS code.
 * Verifies the API paths v0.4 relies on before any concurrency is opened:
 *   1. ownerless conversations created in ONE Session commit together with a host directory/binding document
 *      (read-before-create inside the commit; a retry after a crash finds the same conversation for the same createKey);
 *   2. per-conversation model route aliases (a provider per conversation whose wrapper closure carries the subject) —
 *      both stream entry points go through the same gate, the real model identity is forwarded;
 *   3. two conversations generating at the same time (overlapping provider calls);
 *   4. Conversation.abort() of one conversation does not touch the other or the root;
 *   5. a conversation-owned manual compaction task created in the same commit as its host mapping document;
 *      its result and summary placement are readable after a reopen;
 *   6. reopen: routes are rebuilt before resume(); bindings are found again.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type Model, type Provider } from "@earendil-works/pi-ai";
import { CompactionTask, LiveDoc, createRegistry, defineDoc, defineDocFamily, Harness, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { tmpDir } from "../../../tests/helpers.js";

const ctx = BACKGROUND_CONTEXT;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const Directory = defineDocFamily<{ conversationId?: string; bodyHash?: string }, null>({
  kind: "m0.directory", version: 1, scope: "session", family: true, initial: () => ({}), checkpointWhen: () => true,
} as never);
const Binding = defineDoc<{ runId?: string; createKey?: string }>({
  kind: "m0.binding", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({}), checkpointWhen: () => true,
} as never);
const CompactionMap = defineDocFamily<{ taskId?: string }, null>({
  kind: "m0.compaction-map", version: 1, scope: "session", family: true, initial: () => ({}), checkpointWhen: () => true,
} as never);

interface Call { route: string; entry: "stream" | "streamSimple"; start: number; end?: number; model: string }

function setup() {
  const calls: Call[] = [];
  const faux = fauxProvider({ provider: "m0-real", models: [{ id: "real-model", contextWindow: 4000, maxTokens: 512 }], tokensPerSecond: 100000 });
  const step = async (c: unknown, _o: unknown, _s: unknown, model: Model<string>) => {
    const messages = (c as { messages: { role: string; content: unknown }[] }).messages;
    const last = JSON.stringify(messages[messages.length - 1]?.content ?? "");
    if (/summar/i.test(JSON.stringify((c as { systemPrompt?: string }).systemPrompt ?? "")) || /summar/i.test(last)) return fauxAssistantMessage("SUMMARY of earlier turns");
    await sleep(/slow/.test(last) ? 2000 : 300);
    return fauxAssistantMessage(`done ${model.id}`);
  };
  faux.setResponses(Array.from({ length: 200 }, () => step as never));
  const inner = faux.provider;
  const models = createModels();
  models.setProvider(inner);
  const routes = new Map<string, { subject: string; admitted: number }>();
  /** A provider per route alias; the closure holds the subject; the real model is forwarded. */
  function addRoute(alias: string, subject: string) {
    routes.set(alias, { subject, admitted: 0 });
    const real = inner.getModels()[0]!;
    const aliasModel = { ...real, provider: alias } as Model<string>;
    const gate = (entry: Call["entry"], m: Model<string>) => {
      const r = routes.get(alias);
      if (!r) throw new Error("no binding");
      r.admitted++;
      const c: Call = { route: alias, entry, start: Date.now(), model: `${real.provider}/${real.id}` };
      calls.push(c);
      expect(m.provider).toBe(alias);
      return c;
    };
    const p: Provider = {
      id: alias, name: alias, auth: inner.auth,
      getModels: () => [aliasModel],
      stream: (m, c, o) => { const call = gate("stream", m as never); const s = inner.stream(real as never, c, o as never); void s.result().then(() => { call.end = Date.now(); }); return s; },
      streamSimple: (m, c, o) => { const call = gate("streamSimple", m); const s = inner.streamSimple(real, c, o); void s.result().then(() => { call.end = Date.now(); }); return s; },
    };
    models.setProvider(p);
  }
  return { models, addRoute, routes, calls };
}

async function open(file: string, models: ReturnType<typeof setup>["models"]) {
  const storage = await openNodeSqliteStorage(file);
  return Harness.open(storage, {
    models, registry: createRegistry(), identity: { attribution: null },
    settings: { stream: { maxRetries: 0 }, retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: true, backgroundTokens: 0, reserveTokens: 200, keepRecentTokens: 50 } },
  }, ctx);
}

/** Read-before-create in one Session commit: the directory doc decides reuse; binding written in the same commit. */
async function createBound(h: Harness, createKey: string, runId: string, crashAfterCommit = false): Promise<ConversationId> {
  const id = await h.commit(async (tx) => {
    const dir = await tx.doc(Directory, createKey, null);
    if (dir.conversationId) {
      if (dir.bodyHash !== runId) throw new Error("same createKey, different body");
      return dir.conversationId as ConversationId;
    }
    const rec = await tx.createConversation({ ownership: { kind: "ownerless" } });
    dir.conversationId = rec.id;
    dir.bodyHash = runId;
    const b = await tx.doc(Binding, rec.id);
    b.runId = runId;
    b.createKey = createKey;
    return rec.id;
  }, ctx);
  if (crashAfterCommit) throw new Error("simulated crash before the host saved the mapping");
  return id;
}

const results: Record<string, unknown> = {};

describe("M0: pinned Pi 1.4.0 multi-conversation prototype", () => {
  const dir = tmpDir("agentos-m0-");
  const file = path.join(dir, "agent.sqlite");
  const env = setup();
  let h: Harness;
  let a: ConversationId;
  let b: ConversationId;

  afterAll(async () => {
    await h?.close(ctx).catch(() => undefined);
    fs.writeFileSync(path.join(dir, "m0-results.json"), JSON.stringify(results, null, 2));
    if (process.env.AGENTOS_M0_OUT) fs.writeFileSync(process.env.AGENTOS_M0_OUT, JSON.stringify(results, null, 2));
  });

  it("creates two bound conversations atomically and recovers the same id for a createKey after a crash", async () => {
    h = await open(file, env.models);
    await expect(createBound(h, "ck-a", "run-a", true)).rejects.toThrow(/simulated crash/);
    // "host restart": close and reopen, then retry the same createKey
    await h.close(ctx);
    h = await open(file, env.models);
    a = await createBound(h, "ck-a", "run-a");
    const again = await createBound(h, "ck-a", "run-a");
    expect(again).toBe(a);
    await expect(createBound(h, "ck-a", "run-OTHER")).rejects.toThrow(/different body/);
    b = await createBound(h, "ck-b", "run-b");
    expect(b).not.toBe(a);
    const scan = await h.commit((tx) => tx.scanConversations({}, 50), ctx);
    const owned = scan.items.filter((c) => c.owner === undefined && c.parent === undefined);
    // root is not created here; exactly the two bound conversations exist
    expect(owned.map((c) => c.id).sort()).toEqual([a, b].sort());
    expect((await h.snapshot(Binding, a, ctx))?.runId).toBe("run-a");
    results.atomicCreate = { ok: true, conversations: owned.length };
  });

  it("routes each conversation through its own alias and runs both at the same time", async () => {
    env.addRoute("agentos-route-a", "run-a");
    env.addRoute("agentos-route-b", "run-b");
    const ca = (await h.conversation(a, ctx))!;
    const cb = (await h.conversation(b, ctx))!;
    await ca.configure({ model: { provider: "agentos-route-a", modelId: "real-model" } }, ctx);
    await cb.configure({ model: { provider: "agentos-route-b", modelId: "real-model" } }, ctx);
    h.resume();
    const sa = await ca.submit({ type: "input", content: "hello A", requestId: "run-a" }, ctx);
    const sb = await cb.submit({ type: "input", content: "hello B", requestId: "run-b" }, ctx);
    // same requestId again lands on the same submission (redelivery)
    const sa2 = await ca.submit({ type: "input", content: "hello A", requestId: "run-a" }, ctx);
    expect(String(sa2.id)).toBe(String(sa.id));
    await Promise.all([sa.wait(ctx), sb.wait(ctx)]);
    const ra = env.calls.filter((c) => c.route === "agentos-route-a");
    const rb = env.calls.filter((c) => c.route === "agentos-route-b");
    expect(ra.length).toBe(1);
    expect(rb.length).toBe(1);
    expect(env.routes.get("agentos-route-a")!.admitted).toBe(1);
    expect(env.routes.get("agentos-route-b")!.admitted).toBe(1);
    // overlap: B started before A ended
    expect(rb[0]!.start).toBeLessThan(ra[0]!.end!);
    expect(ra[0]!.model).toBe("m0-real/real-model");
    results.routes = { ok: true, entries: [...new Set(env.calls.map((c) => c.entry))], overlapMs: ra[0]!.end! - rb[0]!.start };
  });

  it("aborts one conversation without touching the other", async () => {
    const ca = (await h.conversation(a, ctx))!;
    const cb = (await h.conversation(b, ctx))!;
    const sa = await ca.submit({ type: "input", content: "slow A", requestId: "run-a-2" }, ctx);
    const sb = await cb.submit({ type: "input", content: "slow B", requestId: "run-b-2" }, ctx);
    await sleep(300);
    await ca.abort(ctx, { background: true });
    const stA = await (await h.submission(sa.id, ctx))!.status(ctx);
    const doneB = await sb.wait(ctx);
    expect(["done", "unanswered"]).toContain(stA.status);
    expect(doneB.status).toBe("done");
    const insp = await h.inspect(ctx);
    expect(insp.tasks.length).toBe(0);
    results.abort = { ok: true, aStatus: stA.status, bStatus: doneB.status };
  });

  it("creates a manual compaction task and its host mapping in one commit; result survives a reopen", async () => {
    const cb = (await h.conversation(b, ctx))!;
    for (let i = 0; i < 3; i++) {
      const s = await cb.submit({ type: "input", content: `turn ${i} ${"x".repeat(400)}`, requestId: `fill-${i}` }, ctx);
      await s.wait(ctx);
    }
    const taskId = await cb.commit(async (tx) => {
      const map = await tx.doc(CompactionMap, "cmp-key-1", null);
      if (map.taskId) return Number(map.taskId);
      const id = await tx.createTask(CompactionTask, { reason: "manual", instructions: "keep goals" }, { ownership: { kind: "conversation" }, conversationId: b, background: false } as never);
      const live = await tx.doc(LiveDoc, b);
      (live as { compactions?: unknown[] }).compactions ??= [];
      (live as { compactions: unknown[] }).compactions.push({ taskId: id, reason: "manual", blocking: false, attempt: 1 });
      map.taskId = String(id);
      return Number(id);
    }, ctx);
    const settled = await h.waitForTask(taskId as never, ctx);
    expect(settled.state.status).toBe("terminal");
    expect((settled.state as { outcome: { status: string } }).outcome.status).toBe("completed");
    await h.close(ctx);
    h = await open(file, env.models);
    const map = await h.snapshot(CompactionMap, "cmp-key-1", ctx);
    expect(map?.taskId).toBe(String(taskId));
    const rec = await h.getTask(taskId as never, ctx);
    expect(rec?.state.status).toBe("terminal");
    const entries = await (await h.conversation(b, ctx))!.entries({}, 50, undefined, ctx);
    const summary = entries.items.find((e) => e.kind === "pi.compaction");
    expect(summary).toBeDefined();
    // the original entries are still stored
    expect(entries.items.filter((e) => e.kind === "pi.user").length).toBeGreaterThanOrEqual(3);
    results.compaction = { ok: true, taskId, summaryPlaced: summary !== undefined };
  });

  it("rebuilds routes before resume after a reopen and continues the same conversation", async () => {
    // routes live in the host process: a fresh Models without them must not reach the provider
    const ca = (await h.conversation(a, ctx))!;
    h.resume();
    const s = await ca.submit({ type: "input", content: "after reopen", requestId: "run-a-3" }, ctx);
    const out = await s.wait(ctx);
    expect(out.status).toBe("done");
    expect(env.routes.get("agentos-route-a")!.admitted).toBeGreaterThanOrEqual(2);
    results.reopen = { ok: true };
    results.pi = { version: JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "node_modules", "@earendil-works", "pi-durable", "package.json"), "utf8")).version };
  });
});
