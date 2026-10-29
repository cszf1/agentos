import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, type Harness } from "@earendil-works/pi-durable";
import type { ConversationBinding, DirectoryEntry } from "@agentos/core";

const ctx = BACKGROUND_CONTEXT;

/**
 * Trusted conversation directory in agent.sqlite (spec §6.1–§6.2): a session-scoped document family keyed by createKey,
 * plus a binding document on each conversation. Both are written by this adapter only, in the SAME Pi commit that
 * creates the conversation; the directory is read first inside that commit so a retry after a crash finds the same
 * conversation instead of creating a second one. Pi's internal tables are never edited directly.
 */
export const ConversationDirectory = defineDocFamily<{ conversationId?: string; bindingHash?: string; runId?: string | null; purpose?: string }, null>({
  kind: "agentos.conversation-directory",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({}),
  checkpointWhen: () => true,
} as never);

/** The key list of the directory (a family cannot be enumerated by key prefix through the public API). */
export const DirectoryIndex = defineDoc<{ keys?: string[] }>({
  kind: "agentos.conversation-directory-index",
  version: 1,
  scope: "session",
  initial: () => ({}),
  checkpointWhen: () => true,
} as never);

/** `agentos.run-binding`: who this conversation works for (storeUUID, run, createKey, mode/profile, route). */
export const RunBindingDoc = defineDoc<{
  storeUUID?: string;
  createKey?: string;
  purpose?: string;
  runId?: string | null;
  profileId?: string;
  routeId?: string;
  bindingHash?: string;
  toolsetVersion?: number;
}>({
  kind: "agentos.run-binding",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
  checkpointWhen: () => true,
});

export class BindingConflict extends Error {}

/** Read-before-create in one Session commit; same createKey + same body → same conversation; other body → refused. */
export async function ensureConversation(h: Harness, b: ConversationBinding): Promise<string> {
  return h.commit(async (tx) => {
    const dir = await tx.doc(ConversationDirectory, b.createKey, null);
    if (dir.conversationId) {
      if (dir.bindingHash !== b.bindingHash) throw new BindingConflict(`createKey ${b.createKey} is bound with a different body`);
      return String(dir.conversationId);
    }
    const rec = await tx.createConversation({ ownership: { kind: "ownerless" } });
    dir.conversationId = String(rec.id);
    dir.bindingHash = b.bindingHash;
    dir.runId = b.runId;
    dir.purpose = b.purpose;
    const idx = await tx.doc(DirectoryIndex);
    idx.keys = [...(idx.keys ?? []), b.createKey];
    const doc = await tx.doc(RunBindingDoc, rec.id);
    doc.storeUUID = b.storeUUID;
    doc.createKey = b.createKey;
    doc.purpose = b.purpose;
    doc.runId = b.runId;
    doc.profileId = b.profileId;
    doc.routeId = b.routeId;
    doc.bindingHash = b.bindingHash;
    doc.toolsetVersion = b.toolsetVersion;
    return String(rec.id);
  }, ctx);
}

export async function listDirectory(h: Harness): Promise<DirectoryEntry[]> {
  const idx = await h.snapshot(DirectoryIndex, ctx);
  const out: DirectoryEntry[] = [];
  for (const key of idx?.keys ?? []) {
    const d = await h.snapshot(ConversationDirectory, key, ctx);
    if (d?.conversationId) out.push({ createKey: key, conversationId: String(d.conversationId), runId: (d.runId as string | null) ?? null, bindingHash: String(d.bindingHash ?? ""), purpose: String(d.purpose ?? "run") });
  }
  return out;
}

export async function readBinding(h: Harness, conversationId: string) {
  return h.snapshot(RunBindingDoc, conversationId as never, ctx);
}
