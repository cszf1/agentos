/** What core needs from the agent runtime. Implemented by @agentos/agent-pi; core never imports Pi types. */

import type { AgentProfileId, RunMode } from "@agentos/contracts";

export interface FrozenRunInput {
  protocolVersion: 1;
  runId: string;
  storeUUID: string;
  mode: "create" | "modify";
  /** v0.3: build (default, absent on older runs) or system_plan; v0.4 adds the two background analysis modes. Frozen by the host. */
  runMode?: RunMode;
  /** v0.4: role template; decides the conversation's only tool set. */
  agentProfileId?: AgentProfileId;
  systemScope?: unknown;
  /** null for non-app runs (v0.4); v0.3 system_plan runs carried the hidden placeholder. */
  targetAppId: string | null;
  expectedAppEpoch: number;
  intent: string;
  /** Data contract and active revision at acceptance time (live state comes from app_get). */
  contractAtAccept: { fields: Record<string, unknown> };
  activeRevisionAtAccept: string | null;
  /** v0.4 background analysis: the job, incident and the frozen evidence / candidate scope. */
  maintenance?: { jobId: string; incidentId: string | null; scope: Record<string, unknown> };
  system: { hostVersion: string; platform: string; arch: string };
  acceptedAt: string;
}

export type AgentSubmissionStatus =
  | { state: "queued" | "placed" }
  | { state: "done" }
  | { state: "unanswered"; reason: string; detail?: string }
  | { state: "missing" };

export interface AgentInspection {
  scheduling: string;
  tasks: number;
  submissions: number;
  blocked: { taskId: string; kind: string; reason: string }[];
}

export interface TranscriptItem {
  kind: string;
  role: string;
  text: string;
  toolName?: string;
  isError?: boolean;
  at?: string;
  entryId?: string;
}

export interface TranscriptSummary {
  items: TranscriptItem[];
}

/** The trusted binding the adapter writes into agent.sqlite together with the conversation (spec §6.1). */
export interface ConversationBinding {
  storeUUID: string;
  createKey: string;
  purpose: "run" | "compaction";
  runId: string | null;
  profileId: AgentProfileId;
  routeId: string;
  /** canonical hash of the binding body; the same createKey with another body is refused */
  bindingHash: string;
  toolsetVersion: number;
}

/** One conversation as the adapter's trusted directory lists it (for recovery). */
export interface DirectoryEntry {
  createKey: string;
  conversationId: string;
  runId: string | null;
  bindingHash: string;
  purpose: string;
}

export interface CompactionStart {
  compactionKey: string;
  conversationId: string;
  instructions?: string;
}

export interface CompactionState {
  taskId: string | null;
  /** running | done | failed | cancelled | missing */
  state: string;
  entryId?: string;
  error?: string;
}

export interface AgentEngine {
  /** Open storage without starting scheduling. */
  open(): Promise<void>;
  /** Start scheduling (only after every active binding and route is rebuilt). */
  resume(): void;
  /** Read-before-create in one Pi commit (spec §6.2): returns the conversation of this createKey, creating it once. */
  ensureConversation(binding: ConversationBinding): Promise<string>;
  /** Every conversation in the trusted directory (recovery: spec §10.3). */
  directory(): Promise<DirectoryEntry[]>;
  /** Register the host-controlled model route of a conversation before any request (spec §9.1). */
  attachRoute(conversationId: string, routeId: string, profileId: AgentProfileId): Promise<void>;
  /** Submit the frozen input to its own conversation with requestId=runId; a redelivery lands on the same submission. */
  submit(conversationId: string, run: FrozenRunInput): Promise<{ submissionId: number }>;
  /** Pure read; must not start scheduling. */
  status(submissionId: number): Promise<AgentSubmissionStatus>;
  /** Abort ONE conversation (never the root or the whole Harness). */
  abortConversation(conversationId: string): Promise<void>;
  /** Live tasks/submissions owned by one conversation. */
  inspectConversation(conversationId: string): Promise<AgentInspection>;
  /** Whole-session inspection (diagnostics and orphan detection). */
  inspect(): Promise<AgentInspection & { byConversation: Record<string, number> }>;
  /** The transcript of one conversation only. */
  transcript(conversationId: string): Promise<TranscriptSummary>;
  /** Conversation-owned manual compaction created with its host mapping in one commit (spec §20.3). */
  startCompaction(start: CompactionStart): Promise<string>;
  compactionState(compactionKey: string): Promise<CompactionState>;
  abortCompaction(compactionKey: string): Promise<void>;
  /** Newest visible entry id of a conversation (compaction cutoff). */
  headEntry(conversationId: string): Promise<string | null>;
  /** Per-conversation usage (reporting only). */
  usage?(conversationId?: string): Promise<unknown>;
  close(): Promise<void>;
}
