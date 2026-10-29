import fs from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CompactionTask, LiveDoc, ROOT_CONVERSATION_ID, createRegistry, defineDoc, defineDocFamily, Harness, type Conversation, type HarnessSettings } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PROTOCOL_VERSION, type AgentProfileId } from "@agentos/contracts";
import {
  fault,
  type AgentEngine,
  type AgentInspection,
  type AgentOps,
  type AgentSubmissionStatus,
  type CompactionStart,
  type CompactionState,
  type ConversationBinding,
  type DirectoryEntry,
  type FrozenRunInput,
  type TranscriptSummary,
} from "@agentos/core";
import { createRoleExtensions, type RoleExtensions, type ToolLog } from "./tools.js";
import { renderRunInput } from "./prompt.js";
import { buildModels, type BuiltModels, type ModelConfig } from "./models.js";
import { RouteTable, type RouteGate } from "./routes.js";
import { ensureConversation, listDirectory } from "./conversations.js";

const ctx = BACKGROUND_CONTEXT;

/** Pairing marker between os.sqlite and agent.sqlite, stored on the fixed root conversation (kept in v0.4, spec §6.1). */
export const WorkspaceDoc = defineDoc<{ storeUUID?: string; protocolVersion?: number; toolsetVersion?: number; schedulerProtocolVersion?: number }>({
  kind: "agentos.workspace",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
  checkpointWhen: () => true,
});

/** compactionKey → Pi task id, written in the same commit that creates the compaction task (spec §20.3). */
export const CompactionMap = defineDocFamily<{ taskId?: string; conversationId?: string }, null>({
  kind: "agentos.compaction-map",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({}),
  checkpointWhen: () => true,
} as never);

/**
 * Fixed Durable settings (spec §10 v0.1, §20.1 v0.4): provider-internal retries off, background compaction off for
 * every conversation (backgroundTokens=0); idle compaction only through approved compaction jobs.
 */
export const HARNESS_SETTINGS = (extensions: HarnessSettings["extensions"]): HarnessSettings => ({
  extensions,
  stream: { maxRetries: 0, transport: "sse" },
  retry: { enabled: true, maxRetries: 2 },
  compaction: { enabled: true, backgroundTokens: 0 },
  toolExecution: "sequential",
});

export type BindResult = { ok: true; bound: "already" | "completed" | "new" } | { ok: false; reason: string };

export interface PiEngineOptions {
  agentDbPath: string;
  ops: AgentOps;
  /** host model admission/settlement (core ModelBudgets) */
  gate: RouteGate;
  modelConfig: ModelConfig | null;
  fauxContextWindow?: number;
  compaction?: { reserveTokens?: number; keepRecentTokens?: number };
  onFailure?: (error: unknown) => void;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Per-tool execution log (spec §15). */
  toolLog?: ToolLog;
  /** extra tools (maintenance roles) registered by the host */
  extraTools?: Parameters<typeof createRoleExtensions>[2];
}

/** The only place that imports Pi Durable. One Harness, many conversations (spec §4). */
export class PiAgentEngine implements AgentEngine {
  #harness: Harness | undefined;
  #root: Conversation | undefined;
  #built: BuiltModels | undefined;
  #routes: RouteTable | undefined;
  #roles: RoleExtensions | undefined;
  readonly opts: PiEngineOptions;
  #existedBeforeOpen = false;

  constructor(opts: PiEngineOptions) {
    this.opts = opts;
  }

  get modelAvailable(): boolean {
    return this.#built?.available ?? false;
  }
  get modelDiagnostic(): string | null {
    return this.#built?.diagnostic ?? null;
  }
  get modelRef(): { provider: string; modelId: string } | null {
    return this.#built?.available ? this.#built.ref : null;
  }
  get agentFileExisted(): boolean {
    return this.#existedBeforeOpen;
  }
  get routeCounters() {
    return this.#routes?.counters ?? { admissions: 0, denials: 0, networkStarts: 0 };
  }

  private get harness(): Harness {
    if (!this.#harness) throw new Error("agent engine is not open");
    return this.#harness;
  }

  async open(): Promise<void> {
    this.#existedBeforeOpen = fs.existsSync(this.opts.agentDbPath);
    this.#built = await buildModels(this.opts.modelConfig, { contextWindow: this.opts.fauxContextWindow });
    if (this.#built.inner && this.#built.real) this.#routes = new RouteTable(this.#built.models, this.#built.inner, this.#built.real, this.opts.gate);
    const registry = createRegistry();
    this.#roles = createRoleExtensions(this.opts.ops, this.opts.toolLog, this.opts.extraTools);
    for (const ext of Object.values(this.#roles)) registry.install(ext);
    const storage = await openNodeSqliteStorage(this.opts.agentDbPath);
    // Default selection: nothing (a conversation gets exactly its role extension when configured).
    const settings = HARNESS_SETTINGS([]);
    const harness = await Harness.open(
      storage,
      {
        models: this.#built.models,
        registry,
        settings: { ...settings, compaction: { ...settings.compaction, ...(this.opts.compaction ?? {}) } },
        identity: { attribution: null },
        onReport: (error, info) => this.opts.log?.("pi report", { type: info.type, error: error instanceof Error ? error.message : String(error) }),
      },
      ctx,
    );
    this.#harness = harness;
    harness.closed.then((end) => {
      if (end.reason === "failed") this.opts.onFailure?.(end.error);
    });
  }

  /** Legacy root: pairing marker and v0.1–v0.3 history only; never receives a v0.4 run. */
  private async root(): Promise<Conversation> {
    if (this.#root) return this.#root;
    this.#root = await this.harness.root(ctx);
    return this.#root;
  }

  async bind(storeUUID: string, state: "pending" | "bound"): Promise<BindResult> {
    if (state === "bound" && !this.#existedBeforeOpen) {
      return { ok: false, reason: "agent.sqlite was missing for a bound workspace; refusing to create a replacement" };
    }
    const root = await this.root();
    const marker = await this.harness.snapshot(WorkspaceDoc, root.id, ctx);
    if (marker?.storeUUID !== undefined) {
      if (marker.storeUUID !== storeUUID) return { ok: false, reason: "agent.sqlite belongs to a different workspace (storeUUID mismatch)" };
      return { ok: true, bound: state === "bound" ? "already" : "completed" };
    }
    if (state === "bound") return { ok: false, reason: "agent.sqlite has no workspace marker" };
    const insp = await this.harness.inspect(ctx);
    const entries = await root.entries({}, 1, undefined, ctx);
    if (insp.tasks.length > 0 || insp.submissions.length > 0 || entries.items.some((e) => e.kind === "pi.user")) {
      return { ok: false, reason: "agent.sqlite already carries work; it cannot be paired with a new workspace" };
    }
    await root.commit(async (tx) => {
      const doc = await tx.doc(WorkspaceDoc, root.id);
      doc.storeUUID = storeUUID;
      doc.protocolVersion = PROTOCOL_VERSION;
    }, ctx);
    fault("bind.after_marker");
    return { ok: true, bound: "new" };
  }

  /**
   * Tool-set upgrade (spec §21.2, §23.4): only when the whole Harness is idle (no tasks, no submissions in any
   * conversation). Recorded in agent.sqlite's workspace doc; the host records the same migration in os.sqlite.
   */
  async upgradeToolset(target: number): Promise<{ ok: true; from: number } | { ok: false; reason: string }> {
    const root = await this.root();
    const marker = await this.harness.snapshot(WorkspaceDoc, root.id, ctx);
    const from = marker?.toolsetVersion ?? 1;
    if (from === target) return { ok: true, from };
    if (from > target) return { ok: false, reason: `agent.sqlite uses tool set v${from}, newer than this host (v${target})` };
    const insp = await this.harness.inspect(ctx);
    if (insp.tasks.length > 0 || insp.submissions.length > 0) {
      return { ok: false, reason: `agent.sqlite still has unfinished tasks from tool set v${from}; finish or cancel them with the previous host version before upgrading to v${target}` };
    }
    await root.commit(async (tx) => {
      const doc = await tx.doc(WorkspaceDoc, root.id);
      doc.toolsetVersion = target;
      doc.schedulerProtocolVersion = 1;
    }, ctx);
    return { ok: true, from };
  }

  resume(): void {
    this.harness.resume();
  }

  async ensureConversation(binding: ConversationBinding): Promise<string> {
    return ensureConversation(this.harness, binding);
  }

  async directory(): Promise<DirectoryEntry[]> {
    return listDirectory(this.harness);
  }

  /** Register the conversation's route alias and pin the conversation to it and its role extension (idempotent). */
  async attachRoute(conversationId: string, routeId: string, profileId: AgentProfileId): Promise<void> {
    const conv = await this.harness.conversation(conversationId as never, ctx);
    if (!conv) throw new Error(`conversation ${conversationId} not found`);
    const ext = this.#roles![profileId];
    const ref = this.#routes ? this.#routes.attach(routeId) : null;
    const agent = await conv.agent(ctx);
    const sameModel = ref === null ? true : agent.model?.provider === ref.provider && agent.model?.modelId === ref.modelId;
    const sameExt = agent.extensions.length === 1 && agent.extensions[0]?.name === ext.name;
    if (!sameModel || !sameExt) await conv.configure({ ...(ref ? { model: ref } : {}), extensions: [ext] }, ctx);
  }

  async submit(conversationId: string, run: FrozenRunInput): Promise<{ submissionId: number }> {
    const conv = await this.harness.conversation(conversationId as never, ctx);
    if (!conv) throw new Error(`conversation ${conversationId} not found`);
    const sub = await conv.submit({ type: "input", content: renderRunInput(run), requestId: run.runId, whenBusy: "reject" }, ctx);
    return { submissionId: Number(sub.id) };
  }

  async status(submissionId: number): Promise<AgentSubmissionStatus> {
    const sub = await this.harness.submission(submissionId as never, ctx);
    if (!sub) return { state: "missing" };
    const rec = await sub.status(ctx);
    if (rec.status === "done") return { state: "done" };
    if (rec.status === "unanswered") {
      const r = rec as { reason?: string; detail?: unknown };
      return { state: "unanswered", reason: String(r.reason ?? "unknown"), detail: r.detail === undefined ? undefined : String(typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail)) };
    }
    return { state: rec.status === "placed" ? "placed" : "queued" };
  }

  async abortConversation(conversationId: string): Promise<void> {
    const conv = await this.harness.conversation(conversationId as never, ctx);
    if (!conv) return;
    await conv.abort(ctx, { background: true });
  }

  async inspectConversation(conversationId: string): Promise<AgentInspection> {
    const insp = await this.harness.inspect(ctx);
    const tasks = insp.tasks.filter((t) => String(t.record.conversationId) === conversationId);
    return {
      scheduling: insp.scheduling,
      tasks: tasks.length,
      submissions: insp.submissions.filter((s) => String((s as { conversationId?: unknown }).conversationId) === conversationId).length,
      blocked: tasks
        .filter((t) => t.state.kind === "blocked")
        .map((t) => ({ taskId: String(t.record.id), kind: String(t.record.kind), reason: (t.state as { reason: string }).reason })),
    };
  }

  async inspect(): Promise<AgentInspection & { byConversation: Record<string, number> }> {
    const insp = await this.harness.inspect(ctx);
    const by: Record<string, number> = {};
    const key = (c: unknown) => (String(c) === String(ROOT_CONVERSATION_ID) ? "root" : String(c));
    for (const t of insp.tasks) by[key(t.record.conversationId)] = (by[key(t.record.conversationId)] ?? 0) + 1;
    for (const s of insp.submissions) {
      const c = (s as { conversationId?: unknown }).conversationId;
      by[key(c)] = (by[key(c)] ?? 0) + 1;
    }
    return {
      scheduling: insp.scheduling,
      tasks: insp.tasks.length,
      submissions: insp.submissions.length,
      blocked: insp.tasks
        .filter((t) => t.state.kind === "blocked")
        .map((t) => ({ taskId: String(t.record.id), kind: String(t.record.kind), reason: (t.state as { reason: string }).reason })),
      byConversation: by,
    };
  }

  async isIdle(): Promise<boolean> {
    const i = await this.harness.inspect(ctx);
    return i.tasks.length === 0 && i.submissions.length === 0;
  }

  async transcript(conversationId: string): Promise<TranscriptSummary> {
    const conv = conversationId === "root" ? await this.root() : await this.harness.conversation(conversationId as never, ctx);
    if (!conv) return { items: [] };
    const page = await conv.entries({}, 80, undefined, ctx);
    const items = page.items
      .slice()
      .reverse()
      .map((e) => {
        const data = (e as { data?: unknown }).data as Record<string, unknown> | undefined;
        const model = (e as { model?: unknown }).model as { role?: string; content?: unknown; toolName?: string; isError?: boolean }[] | undefined;
        const m = model?.[0];
        let text = "";
        const content = m?.content ?? data?.content ?? (data as { summary?: unknown } | undefined)?.summary;
        if (typeof content === "string") text = content;
        else if (Array.isArray(content)) {
          text = content
            .map((p: { type?: string; text?: string; name?: string; arguments?: unknown }) =>
              p.type === "text" ? (p.text ?? "") : p.type === "toolCall" ? `→ ${p.name}(${JSON.stringify(p.arguments).slice(0, 200)})` : "",
            )
            .filter(Boolean)
            .join("\n");
        }
        return { kind: e.kind, role: m?.role ?? e.kind, text: text.slice(0, 2000), toolName: m?.toolName, isError: m?.isError, entryId: String(e.id) };
      })
      .filter((i) => i.kind !== "pi.system");
    return { items };
  }

  async headEntry(conversationId: string): Promise<string | null> {
    const conv = await this.harness.conversation(conversationId as never, ctx);
    if (!conv) return null;
    const page = await conv.entries({}, 1, undefined, ctx);
    return page.items[0] ? String(page.items[0].id) : null;
  }

  /**
   * Conversation-owned manual compaction (spec §20.3): the task, its LiveDoc status and the host mapping document are
   * created in ONE conversation commit, read-before-create by compactionKey; a retry finds the same task.
   */
  async startCompaction(start: CompactionStart): Promise<string> {
    const conv = await this.harness.conversation(start.conversationId as never, ctx);
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
    this.harness.resume();
    return id;
  }

  async compactionState(compactionKey: string): Promise<CompactionState> {
    const map = await this.harness.snapshot(CompactionMap, compactionKey, ctx);
    if (!map?.taskId) return { taskId: null, state: "missing" };
    const rec = await this.harness.getTask(Number(map.taskId) as never, ctx);
    if (!rec) return { taskId: String(map.taskId), state: "missing" };
    if (rec.state.status !== "terminal") return { taskId: String(map.taskId), state: "running" };
    const outcome = (rec.state as { outcome: { status: string; result?: { entryId?: unknown; submissionId?: unknown }; error?: { message?: string } } }).outcome;
    if (outcome.status === "completed") {
      return { taskId: String(map.taskId), state: outcome.result?.entryId !== undefined || outcome.result?.submissionId !== undefined ? "done" : "done_unplaced", entryId: outcome.result?.entryId !== undefined ? String(outcome.result.entryId) : undefined };
    }
    if (outcome.status === "aborted" || outcome.status === "cancelled") return { taskId: String(map.taskId), state: "cancelled" };
    return { taskId: String(map.taskId), state: "failed", error: outcome.error?.message ?? outcome.status };
  }

  async abortCompaction(compactionKey: string): Promise<void> {
    const map = await this.harness.snapshot(CompactionMap, compactionKey, ctx);
    if (!map?.taskId) return;
    await this.harness.abortTask(Number(map.taskId) as never, ctx);
  }

  /** Per-conversation (or session-wide) token/cost totals (Pi usage documents). */
  async usage(conversationId?: string): Promise<unknown> {
    if (!conversationId) return this.harness.usage(ctx);
    const { UsageDoc } = await import("@earendil-works/pi-durable");
    return this.harness.snapshot(UsageDoc as never, conversationId as never, ctx);
  }

  async close(): Promise<void> {
    if (this.#harness) await this.#harness.close(ctx);
  }

  /** The pairing marker on the legacy root (diagnostics, agents:doctor). */
  async workspaceMarker(): Promise<{ storeUUID?: string; protocolVersion?: number; toolsetVersion?: number; schedulerProtocolVersion?: number } | undefined> {
    const root = await this.root();
    return this.harness.snapshot(WorkspaceDoc, root.id, ctx);
  }

  /** For tests: the harness, to assert on Pi state. */
  get rawHarness(): Harness | undefined {
    return this.#harness;
  }

  /** For compaction jobs: re-point a conversation's route at its compaction subject (the host rebinds os.sqlite first). */
  attachCompactionRoute(routeId: string): void {
    this.#routes?.attach(routeId);
  }
}
