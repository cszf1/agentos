import { fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import type { AppBundle, DataContract, Field } from "@agentos/contracts";

/**
 * Deterministic "model" for faux acceptance mode, built on pi-ai's official faux provider. It reads the real
 * transcript (user input and tool results produced by the real Durable tool path) and decides the next call.
 * Test scenarios are selected by markers in the user's intent, e.g. "[faux:invalid]".
 */

type Msg = TranscriptContext["messages"][number];

function textOf(m: Msg): string {
  const c = (m as { content?: unknown }).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("");
  return "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function marker(intent: string, name: string): string | undefined {
  const m = intent.match(new RegExp(`\\[faux:${name}(?::([^\\]]*))?\\]`));
  return m ? (m[1] ?? "") : undefined;
}

interface AppGet {
  appId: string;
  mode: "create" | "modify";
  intent: string;
  activeBundle: AppBundle | null;
  contract: DataContract;
}

function cleanIntent(intent: string): string {
  return intent.replace(/\[faux:[^\]]*\]/g, "").trim();
}

export function buildBundleFor(g: AppGet): AppBundle {
  const intent = cleanIntent(g.intent);
  if (g.activeBundle === null) {
    const isTodo = /待办|todo|任务/i.test(intent) || intent.length === 0;
    if (isTodo) {
      return {
        formatVersion: 1,
        manifest: { appId: g.appId, title: "待办清单", description: "记录任务并标记完成状态。", runtime: "declarative-v1", capabilities: ["records.read", "records.write"] },
        data: {
          fields: {
            title: { type: "string", label: "任务", minLength: 1, maxLength: 200 },
            done: { type: "boolean", label: "已完成", default: false },
          },
        },
        view: { kind: "records", titleField: "title", columns: ["title", "done"], formFields: ["title", "done"], searchField: "title", filters: ["done"] },
      };
    }
    return {
      formatVersion: 1,
      manifest: { appId: g.appId, title: intent.slice(0, 40) || "记录", runtime: "declarative-v1", capabilities: ["records.read", "records.write"] },
      data: { fields: { title: { type: "string", label: "标题", minLength: 1, maxLength: 200 }, note: { type: "string", label: "备注", maxLength: 1000, default: "" } } },
      view: { kind: "records", titleField: "title", columns: ["title", "note"], formFields: ["title", "note"], searchField: "title", filters: [] },
    };
  }
  const b = structuredClone(g.activeBundle);
  // Every contract field must be carried, even ones the active (older) version hides.
  for (const [k, spec] of Object.entries(g.contract.fields)) {
    if (!Object.hasOwn(b.data.fields, k)) b.data.fields[k] = { ...(spec as object), label: k } as Field;
  }
  if (/优先级|priority/i.test(intent) && !Object.hasOwn(b.data.fields, "priority")) {
    b.manifest.title = `${b.manifest.title.replace(/ · 优先级$/, "")} · 优先级`;
    b.manifest.description = "记录任务、完成状态和优先级，并按优先级筛选。";
    b.data.fields.priority = { type: "enum", label: "优先级", values: ["low", "normal", "high"], default: "normal" };
    for (const list of [b.view.columns, b.view.formFields, b.view.filters]) if (!list.includes("priority")) list.push("priority");
  } else if (/优先级|priority/i.test(intent)) {
    for (const list of [b.view.columns, b.view.formFields, b.view.filters]) if (!list.includes("priority")) list.push("priority");
  } else if (marker(g.intent, "same") === undefined) {
    b.manifest.description = intent.slice(0, 200);
  }
  return b;
}

function call(name: string, args: Record<string, unknown>): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
}

function parse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function fauxBuilderResponse(context: TranscriptContext, _options: unknown, _model: Model<string>): Promise<AssistantMessage> {
  const msgs = context.messages;
  let userIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]!.role === "user") { userIdx = i; break; }
  const userText = userIdx >= 0 ? textOf(msgs[userIdx]!) : "";
  // A compaction request summarizes; answer with a short summary.
  const sys = String((context as { systemPrompt?: unknown }).systemPrompt ?? "");
  if (sys.includes("context summarization assistant") || userText.includes("structured context checkpoint summary")) {
    return fauxAssistantMessage("## Goal\nBuild AgentOS apps.\n## Progress\nEarlier generation runs finished.");
  }
  const intent = userText.split("User request:\n")[1]?.split("\n\nFollow the fixed tool order")[0] ?? userText;
  const delay = marker(intent, "slow");
  if (delay !== undefined) await sleep(Number(delay) || 1000);
  if (marker(intent, "model-error") !== undefined) {
    return fauxAssistantMessage("", { stopReason: "error", errorMessage: "faux upstream error" });
  }
  const results = msgs.slice(userIdx + 1).filter((m) => m.role === "toolResult") as unknown as { toolName: string; isError?: boolean; content: unknown }[];
  const last = msgs[msgs.length - 1]!;
  if (last.role === "user") return call("app_get", {});
  if (last.role !== "toolResult") return fauxAssistantMessage("完成。");
  const lr = last as unknown as { toolName: string; isError?: boolean };
  const body = parse(textOf(last));
  const appGetText = results.find((r) => r.toolName === "app_get" && !r.isError);
  const g = appGetText ? (parse(textOf(appGetText as never)) as unknown as AppGet) : undefined;
  const stages = results.filter((r) => r.toolName === "app_stage").length;
  const invalidAlways = marker(intent, "invalid") !== undefined;
  const invalidOnce = marker(intent, "invalid-once") !== undefined;

  const nextBundle = (): AppBundle => {
    const b = buildBundleFor(g!);
    if (invalidAlways || (invalidOnce && stages === 0)) {
      // Structurally fine, semantically wrong: search on a boolean field.
      return { ...b, view: { ...b.view, searchField: Object.keys(b.data.fields).find((k) => b.data.fields[k]!.type === "boolean") ?? "nope" } };
    }
    return b;
  };

  switch (lr.toolName) {
    case "app_get":
      if (lr.isError || !g) return fauxAssistantMessage(`无法读取目标应用：${String(body.message ?? "")}`);
      if (marker(intent, "same") !== undefined && g.activeBundle) return call("app_stage", { bundle: g.activeBundle });
      if (marker(intent, "refuse") !== undefined) return fauxAssistantMessage("这个需求超出了 v0.1 的能力，没有发布应用。");
      return call("app_stage", { bundle: nextBundle() });
    case "app_stage":
      if (lr.isError) {
        if (body.error === "FORBIDDEN" || body.error === "BUDGET_EXCEEDED") return fauxAssistantMessage(`停止：${String(body.message)}`);
        return call("app_stage", { bundle: nextBundle() });
      }
      if (results.some((r) => r.toolName === "app_activate" && !r.isError)) return fauxAssistantMessage("应用已发布。");
      return call("app_validate", { revisionId: body.revisionId });
    case "app_validate":
      if (body.valid === true) {
        const revisionId = parse(textOf(results.filter((r) => r.toolName === "app_stage").at(-1) as never)).revisionId as string;
        if (marker(intent, "post-write") !== undefined) {
          // Activation plus a second write in the same round: the second must be refused by the publish fence.
          const extra = structuredClone(buildBundleFor(g!));
          extra.manifest.title = `${extra.manifest.title} (extra)`;
          return fauxAssistantMessage([fauxToolCall("app_activate", { revisionId }), fauxToolCall("app_stage", { bundle: extra } as never)], { stopReason: "toolUse" });
        }
        return call("app_activate", { revisionId });
      }
      return call("app_stage", { bundle: nextBundle() });
    case "app_activate":
      if (lr.isError) return fauxAssistantMessage(`发布失败：${String(body.message ?? "")}`);
      return fauxAssistantMessage(body.changed === false ? "当前版本已经满足需求。" : "应用已发布。");
    default:
      return fauxAssistantMessage(fauxText("完成。").text);
  }
}
