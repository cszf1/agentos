import { fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import fs from "node:fs";
import path from "node:path";
import type { AnyBundle, AppBundle, CodeBundle, DataContract, Field } from "@agentos/contracts";

/** Hand-written v0.2 fixtures (repository fixtures/v0.2), used only by the faux test model. */
const FIXTURES = path.resolve(import.meta.dirname, "..", "..", "..", "fixtures", "v0.2");
function fixture(name: string): CodeBundle {
  const dir = path.join(FIXTURES, name);
  const b = JSON.parse(fs.readFileSync(path.join(dir, "bundle.json"), "utf8")) as CodeBundle;
  const files: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p, `${rel}/${n}`);
      else files[`${rel}/${n}`] = fs.readFileSync(p, "utf8");
    }
  };
  walk(path.join(dir, "src"), "src");
  b.code.files = files;
  return b;
}

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
  activeBundle: AnyBundle | null;
  contract: DataContract;
}

/** Code bundles for the faux model: picked by words in the request (the real model writes its own). */
export function codeBundleFor(g: AppGet): CodeBundle | null {
  const intent = cleanIntent(g.intent);
  let name: string | null = null;
  if (/概览|overview/i.test(intent)) name = "work-overview";
  else if (/csv/i.test(intent)) name = "csv-import";
  else if (/工时|estimate/i.test(intent)) name = "todo-kanban-hours";
  else if (/看板|kanban|批量/i.test(intent)) name = "todo-kanban";
  else if (g.activeBundle?.formatVersion === 2 && marker(g.intent, "same") === undefined) {
    const b = structuredClone(g.activeBundle);
    b.manifest.description = intent.slice(0, 200) || b.manifest.description;
    return b;
  }
  if (!name) return null;
  const b = fixture(name);
  b.manifest.appId = g.appId;
  // Carry every contract field (hidden ones too) with its exact spec.
  for (const [k, spec] of Object.entries(g.contract.fields)) {
    if (!Object.hasOwn(b.data.fields, k)) b.data.fields[k] = { ...(spec as object), label: k } as Field;
  }
  return b;
}

function cleanIntent(intent: string): string {
  return intent.replace(/\[faux:[^\]]*\]/g, "").trim();
}

export function buildBundleFor(g: AppGet): AnyBundle {
  const code = codeBundleFor(g);
  if (code) return code;
  return buildDeclarative(g);
}

function buildDeclarative(g: AppGet): AppBundle {
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
  const b = structuredClone(g.activeBundle) as AppBundle;
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
  // A new run starts with app_get, even when a platform note (for example a tool set upgrade) follows the user input.
  if (last.role === "user" || (last.role !== "toolResult" && results.length === 0 && msgs.slice(userIdx + 1).every((m) => m.role !== "assistant"))) return call("app_get", {});
  if (last.role !== "toolResult") return fauxAssistantMessage("完成。");
  const lr = last as unknown as { toolName: string; isError?: boolean };
  const body = parse(textOf(last));
  const appGetText = results.find((r) => r.toolName === "app_get" && !r.isError);
  const g = appGetText ? (parse(textOf(appGetText as never)) as unknown as AppGet) : undefined;
  const stages = results.filter((r) => r.toolName === "app_stage").length;
  const invalidAlways = marker(intent, "invalid") !== undefined;
  const invalidOnce = marker(intent, "invalid-once") !== undefined;
  const compileOnce = marker(intent, "compile-error-once") !== undefined;
  const compileAlways = marker(intent, "compile-error") !== undefined;
  const healthOnce = marker(intent, "health-fail-once") !== undefined;

  const nextBundle = (): AnyBundle => {
    const b = buildBundleFor(g!);
    if (b.formatVersion === 2) {
      const c = structuredClone(b);
      if (compileAlways || (compileOnce && stages === 0)) {
        // A type error the sandbox compiler reports with file:line.
        c.code.files["src/app.ts"] = `${c.code.files["src/app.ts"]}\nexport const broken: number = "not a number";\n`;
      } else if (healthOnce && stages === 0) {
        // main returns output that violates its outputSchema: the preview health check fails.
        c.code.files["src/app.ts"] = c.code.files["src/app.ts"]!.replace("total: ", "total: -1 + 0 * ");
      }
      return c;
    }
    if (invalidAlways || (invalidOnce && stages === 0)) {
      // Structurally fine, semantically wrong: search on a boolean field.
      return { ...b, view: { ...b.view, searchField: Object.keys(b.data.fields).find((k) => b.data.fields[k]!.type === "boolean") ?? "nope" } };
    }
    return b;
  };
  const lastStagedRevision = () => parse(textOf(results.filter((r) => r.toolName === "app_stage" && !r.isError).at(-1) as never)).revisionId as string;
  const afterDeployment = (d: Record<string, unknown>): AssistantMessage => {
    if (d.status === "ready") {
      if (marker(intent, "post-write") !== undefined) {
        // Activation plus a second write in the same round: the second must be refused by the publish fence.
        const extra = structuredClone(buildBundleFor(g!));
        extra.manifest.title = `${extra.manifest.title} (extra)`;
        return fauxAssistantMessage([fauxToolCall("app_activate", { deploymentId: d.deploymentId as string }), fauxToolCall("app_stage", { bundle: extra } as never)], { stopReason: "toolUse" });
      }
      return call("app_activate", { deploymentId: d.deploymentId as string });
    }
    if (d.status === "queued" || d.status === "preparing") return call("app_prepare_status", { deploymentId: d.deploymentId as string });
    if (stages >= 3) return fauxAssistantMessage(`准备失败，已用完暂存次数：${JSON.stringify(d.error ?? {})}`);
    return call("app_stage", { bundle: nextBundle() });
  };

  switch (lr.toolName) {
    case "app_get":
      if (lr.isError || !g) return fauxAssistantMessage(`无法读取目标应用：${String(body.message ?? "")}`);
      if (marker(intent, "same") !== undefined && g.activeBundle) return call("app_stage", { bundle: g.activeBundle });
      if (marker(intent, "refuse") !== undefined) return fauxAssistantMessage("这个需求超出了 v0.1 的能力，没有发布应用。");
      // A code app: read the runtime catalog (locks, approved modules) first.
      if (codeBundleFor(g)) return call("runtime_catalog", {});
      return call("app_stage", { bundle: nextBundle() });
    case "runtime_catalog":
      if (lr.isError || body.codeRuntimeAvailable === false) return fauxAssistantMessage(`代码运行环境不可用：${String(body.message ?? "")}`);
      // An app that reads another app: look the service up instead of guessing its schema.
      if ((codeBundleFor(g!)?.imports ?? []).length > 0) return call("service_catalog", {});
      return call("app_stage", { bundle: nextBundle() });
    case "service_catalog":
      return call("app_stage", { bundle: nextBundle() });
    case "app_stage":
      if (lr.isError) {
        if (body.error === "FORBIDDEN" || body.error === "BUDGET_EXCEEDED") return fauxAssistantMessage(`停止：${String(body.message)}`);
        return call("app_stage", { bundle: nextBundle() });
      }
      if (results.some((r) => r.toolName === "app_activate" && !r.isError)) return fauxAssistantMessage("应用已发布。");
      return call("app_validate", { revisionId: body.revisionId });
    case "app_validate":
      if (body.valid === true) return call("app_prepare", { revisionId: (body.revisionId as string) ?? lastStagedRevision() });
      return call("app_stage", { bundle: nextBundle() });
    case "app_prepare":
    case "app_prepare_status":
      if (lr.isError) {
        if (stages >= 3 || body.error === "FORBIDDEN" || body.error === "BUDGET_EXCEEDED" || body.error === "SANDBOX_UNAVAILABLE") return fauxAssistantMessage(`准备失败：${String(body.message ?? body.error)}`);
        return call("app_stage", { bundle: nextBundle() });
      }
      return afterDeployment(body);
    case "app_activate":
      if (lr.isError) {
        // After a restart the candidate is prepared again: poll its status and activate once it is ready.
        const prep = results.filter((r) => (r.toolName === "app_prepare" || r.toolName === "app_prepare_status") && !r.isError).at(-1);
        const depId = prep ? (parse(textOf(prep as never)).deploymentId as string | undefined) : undefined;
        const retries = results.filter((r) => r.toolName === "app_activate" && r.isError).length;
        if (body.error === "INSTANCE_NOT_READY" && depId && retries <= 3) return call("app_prepare_status", { deploymentId: depId });
        return fauxAssistantMessage(`发布失败：${String(body.message ?? "")}`);
      }
      return fauxAssistantMessage(body.changed === false ? "当前版本已经满足需求。" : "应用已发布。");
    default:
      return fauxAssistantMessage(fauxText("完成。").text);
  }
}
