/** What core needs from the agent runtime. Implemented by @agentos/agent-pi; core never imports Pi types. */

export interface FrozenRunInput {
  protocolVersion: 1;
  runId: string;
  storeUUID: string;
  mode: "create" | "modify";
  /** v0.3: build (default, absent on older runs) or system_plan; frozen by the host, never switchable by the model. */
  runMode?: "build" | "system_plan";
  systemScope?: unknown;
  targetAppId: string;
  expectedAppEpoch: number;
  intent: string;
  /** Data contract and active revision at acceptance time (live state comes from app_get). */
  contractAtAccept: { fields: Record<string, unknown> };
  activeRevisionAtAccept: string | null;
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
}

export interface TranscriptSummary {
  items: TranscriptItem[];
}

export interface AgentEngine {
  /** Open storage without starting scheduling. */
  open(): Promise<void>;
  /** Start scheduling (only after the active run is bound). */
  resume(): void;
  submit(run: FrozenRunInput): Promise<{ submissionId: number }>;
  /** Pure read; must not start scheduling. */
  status(submissionId: number): Promise<AgentSubmissionStatus>;
  cancelConversation(): Promise<void>;
  transcript(): Promise<TranscriptSummary>;
  /** Pure read projection of every unfinished task and submission. */
  inspect(): Promise<AgentInspection>;
  isIdle(): Promise<boolean>;
  /** Session-wide model usage totals (for reporting only). */
  usage?(): Promise<unknown>;
  close(): Promise<void>;
}
