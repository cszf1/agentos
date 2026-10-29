/**
 * Conversation-owned manual compaction (spec §20.3, §25 agent-pi/compaction.ts): the Pi compaction task, its LiveDoc
 * status and the host mapping document (compactionKey → task id) are created in ONE conversation commit,
 * read-before-create by compactionKey, so a retry after a crash finds the same task instead of creating another.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CompactionTask, LiveDoc, defineDocFamily, type Harness } from "@earendil-works/pi-durable";
import type { CompactionStart, CompactionState } from "@agentos/core";

const ctx = BACKGROUND_CONTEXT;

/** compactionKey → Pi task id, written in the same commit that creates the compaction task (spec §20.3). */
export const CompactionMap = defineDocFamily<{ taskId?: string; conversationId?: string }, null>({
  kind: "agentos.compaction-map",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({}),
  checkpointWhen: () => true,
} as never);

export async function startCompaction(harness: Harness, start: CompactionStart): Promise<string> {
  const conv = await harness.conversation(start.conversationId as never, ctx);
  if (!conv) throw new Error(`conversation ${start.conversationId} not found`);
  const id = await conv.commit(async (tx) => {
    const map = await tx.doc(CompactionMap, start.compactionKey, null);
    if (map.taskId) return String(map.taskId);
    const taskId = await tx.createTask(CompactionTask, { reason: "manual" as const, ...(start.instructions ? { instructions: start.instructions } : {}) }, { ownership: { kind: "conversation" }, conversationId: conv.id, background: false } as never);
    const live = (await tx.doc(LiveDoc, conv.id as never)) as unknown as { compactions?: unknown[] };
    live.compactions ??= [];
    live.compactions.push({ taskId, reason: "manual", blocking: false, attempt: 1 });
    map.taskId = String(taskId);
    map.conversationId = start.conversationId;
    return String(taskId);
  }, ctx);
  harness.resume();
  return id;
}

/**
 * The task's state. Pi completes with an empty result when nothing lies before the kept-recent window (or a hook
 * declined): that is `done_unplaced` (no summary generated), never `done`.
 */
export async function compactionState(harness: Harness, compactionKey: string): Promise<CompactionState> {
  const map = await harness.snapshot(CompactionMap, compactionKey, ctx);
  if (!map?.taskId) return { taskId: null, state: "missing" };
  const rec = await harness.getTask(Number(map.taskId) as never, ctx);
  if (!rec) return { taskId: String(map.taskId), state: "missing" };
  if (rec.state.status !== "terminal") return { taskId: String(map.taskId), state: "running" };
  const outcome = (rec.state as { outcome: { status: string; result?: { entryId?: unknown; submissionId?: unknown }; error?: { message?: string } } }).outcome;
  if (outcome.status === "completed") {
    const placedId = outcome.result?.entryId ?? outcome.result?.submissionId;
    return { taskId: String(map.taskId), state: placedId !== undefined ? "done" : "done_unplaced", entryId: placedId !== undefined ? String(placedId) : undefined };
  }
  if (outcome.status === "aborted" || outcome.status === "cancelled") return { taskId: String(map.taskId), state: "cancelled" };
  return { taskId: String(map.taskId), state: "failed", error: outcome.error?.message ?? outcome.status };
}

export async function abortCompaction(harness: Harness, compactionKey: string): Promise<void> {
  const map = await harness.snapshot(CompactionMap, compactionKey, ctx);
  if (!map?.taskId) return;
  await harness.abortTask(Number(map.taskId) as never, ctx);
}
