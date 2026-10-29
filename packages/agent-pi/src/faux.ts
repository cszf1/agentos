import { fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import fs from "node:fs";
import path from "node:path";
import type { AnyBundle, AppBundle, CodeBundle, DataContract, Field } from "@agentos/contracts";

/** Hand-written v0.2 fixtures (repository fixtures/v0.2), used only by the faux test model. */
const FIXTURES = path.resolve(import.meta.dirname, "..", "..", "..", "fixtures", "v0.2");
const FIXTURES_V3 = path.resolve(import.meta.dirname, "..", "..", "..", "fixtures", "v0.3");
function fixture(name: string, root = FIXTURES): CodeBundle {
  const dir = path.join(root, name);
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
  let root = FIXTURES;
  if (/系统控制台|系统监控|system console/i.test(intent)) {
    name = "system-console";
    root = FIXTURES_V3;
  } else if (/概览|overview/i.test(intent)) name = "work-overview";
  else if (/csv/i.test(intent)) name = "csv-import";
  else if (/工时|estimate/i.test(intent)) name = "todo-kanban-hours";
  else if (/看板|kanban|批量/i.test(intent)) name = "todo-kanban";
  else if (g.activeBundle?.formatVersion === 2 && marker(g.intent, "same") === undefined) {
    const b = structuredClone(g.activeBundle);
    b.manifest.description = intent.slice(0, 200) || b.manifest.description;
    return b;
  }
  if (!name) return null;
  const b = fixture(name, root);
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
  const intent = userText.split("User request:\n")[1]?.split("\n\nFollow the fixed tool order")[0]?.split("\n\nTool order:")[0] ?? userText;
  const delay = marker(intent, "slow");
  if (delay !== undefined) await sleep(Number(delay) || 1000);
  if (marker(intent, "model-error") !== undefined) {
    return fauxAssistantMessage("", { stopReason: "error", errorMessage: "faux upstream error" });
  }
  const results = msgs.slice(userIdx + 1).filter((m) => m.role === "toolResult") as unknown as { toolName: string; isError?: boolean; content: unknown }[];
  const last = msgs[msgs.length - 1]!;
  if (userText.includes("system_plan run ")) return fauxSystemPlan(intent, msgs.slice(userIdx + 1), results, last);
  if (userText.includes("Mode: maintenance_diagnose")) return fauxDiagnose(results, last);
  if (userText.includes("Mode: maintenance_refactor")) return fauxRefactor(userText, results, last);
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
    if (b.formatVersion === 2 || b.formatVersion === 3) {
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
      if (b.formatVersion !== 1) return b;
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


/**
 * system_plan faux script (spec §20): list → read → one plan → finish. The plan is derived from words in the request
 * (the real model reasons itself). Markers: [faux:no-plan], [faux:plan-invalid-once], [faux:plan-twice],
 * [faux:try-build] (calls a build tool, which the host refuses), [faux:claim-done] (final text must still not count).
 */
function fauxSystemPlan(intent: string, after: Msg[], results: { toolName: string; isError?: boolean; content: unknown }[], last: Msg): AssistantMessage {
  const text = cleanIntent(intent);
  if (results.length === 0 && after.every((m) => m.role !== "assistant")) {
    if (marker(intent, "try-build") !== undefined) return call("app_stage", { bundle: {} });
    return call("system_resource_list", {});
  }
  if (last.role !== "toolResult") return fauxAssistantMessage("完成。");
  const lr = last as unknown as { toolName: string; isError?: boolean };
  const body = parse(textOf(last));
  const listMsg = results.find((r) => r.toolName === "system_resource_list" && !r.isError);
  const list = listMsg ? (parse(textOf(listMsg as never)) as { resources?: { resourceId: string; kind: string; displayName: string; limits?: Record<string, unknown> }[]; proposeCapabilities?: string[] }) : {};
  const res = list.resources ?? [];
  const pick = (kinds: string[]) => res.find((r) => kinds.includes(r.kind));
  const choose = (): { r: (typeof res)[number]; cap: string; params: Record<string, unknown>; readCap: string } | null => {
    const pct = text.match(/(\d{1,3})\s*%/);
    const svc = pick(["service"]);
    if (svc && /cpu/i.test(text) && pct) return { r: svc, cap: "service.set_limit", params: { property: "CPUQuotaPerSecUSec", value: Number(pct[1]) * 10000 }, readCap: "service.describe" };
    const mib = text.match(/(\d{2,5})\s*(MiB|MB|M)\b/i);
    if (svc && /内存|memory/i.test(text) && mib) return { r: svc, cap: "service.set_limit", params: { property: "MemoryMax", value: Number(mib[1]) * 1048576 }, readCap: "service.describe" };
    if (svc && /停止|stop/i.test(text)) return { r: svc, cap: "service.ensure_state", params: { state: "stopped" }, readCap: "service.describe" };
    if (svc && /启动|start|运行/i.test(text)) return { r: svc, cap: "service.ensure_state", params: { state: "running" }, readCap: "service.describe" };
    const net = pick(["lab-network"]);
    if (net && /deny|阻断|禁止/i.test(text)) return { r: net, cap: "network.apply_profile", params: { profileId: "local-deny" }, readCap: "network.policy_status" };
    if (net && /allow|放行|允许/i.test(text)) return { r: net, cap: "network.apply_profile", params: { profileId: "local-allow" }, readCap: "network.policy_status" };
    const ser = pick(["serial"]);
    if (ser && /sample|采样/i.test(text)) return { r: ser, cap: "serial.exchange", params: { command: "SAMPLE", count: 3 }, readCap: "serial.status" };
    if (ser && /echo/i.test(text)) return { r: ser, cap: "serial.exchange", params: { command: "ECHO", text: "hello" }, readCap: "serial.status" };
    const mr = pick(["managed-root"]);
    const fm = text.match(/([A-Za-z0-9_-]+\.(?:txt|md|csv|json))/);
    if (mr && fm) return { r: mr, cap: "file.write_text_atomic", params: { path: fm[1], content: `${text.replace(/\[.*?\]/g, "").trim()}\n`, expectedAbsent: true }, readCap: "file.list" };
    return null;
  };
  const c = choose();
  switch (lr.toolName) {
    case "app_stage":
      return call("system_resource_list", {});
    case "system_resource_list":
      if (lr.isError) return fauxAssistantMessage(`无法读取资源：${String(body.message ?? "")}`);
      if (!c) return fauxAssistantMessage("这个请求不能表达为所选资源上的一个允许动作，没有生成计划。");
      return call("system_read", { resourceId: c.r.resourceId, capabilityId: c.readCap, params: {} });
    case "system_read": {
      if (lr.isError) return fauxAssistantMessage(`读取失败：${String(body.message ?? "")}`);
      if (marker(intent, "no-plan") !== undefined || !c) return fauxAssistantMessage("我查看了当前状态，但没有生成计划。");
      const obsId = String(body.observationId ?? "");
      const plans = results.filter((r) => r.toolName === "system_plan").length;
      const params = marker(intent, "plan-invalid-once") !== undefined && plans === 0 && c.cap === "service.set_limit" ? { ...c.params, value: 99_000_000 } : c.params;
      return call("system_plan", { resourceId: c.r.resourceId, capabilityId: c.cap, params, observationIds: [obsId] });
    }
    case "system_plan": {
      if (lr.isError) {
        const plans = results.filter((r) => r.toolName === "system_plan").length;
        if (plans >= 3 || body.error === "BUDGET_EXCEEDED" || body.error === "FORBIDDEN" || !c) return fauxAssistantMessage(`计划未通过：${String(body.message ?? "")}`);
        const readMsg = results.filter((r) => r.toolName === "system_read" && !r.isError).at(-1);
        const obsId = readMsg ? String(parse(textOf(readMsg as never)).observationId ?? "") : "";
        return call("system_plan", { resourceId: c.r.resourceId, capabilityId: c.cap, params: c.params, observationIds: [obsId] });
      }
      if (marker(intent, "plan-twice") !== undefined && results.filter((r) => r.toolName === "system_plan").length === 1 && c) {
        return call("system_plan", { resourceId: c.r.resourceId, capabilityId: c.cap, params: { ...c.params }, observationIds: [] });
      }
      if (marker(intent, "claim-done") !== undefined) return fauxAssistantMessage("已经执行完成。");
      return fauxAssistantMessage("计划已生成，等待你在 AgentOS 中确认后才会执行。");
    }
    default:
      return fauxAssistantMessage("完成。");
  }
}

/**
 * Formal faux maintenance analyst: read the frozen evidence, submit ONE hypothesis report, finish. Never a write tool.
 */
function fauxDiagnose(results: { toolName: string; isError?: boolean; content: unknown }[], last: Msg): AssistantMessage {
  const done = (n: string) => results.some((r) => r.toolName === n);
  // one request reads both (the analysis budget is 3 model requests)
  if (!done("maintenance_context")) return fauxAssistantMessage([fauxToolCall("maintenance_context", {}), fauxToolCall("incident_get", {})], { stopReason: "toolUse" });
  if (!done("maintenance_report")) {
    return call("maintenance_report", { summary: "faux: the evidence is consistent with a transient failure", hypotheses: [{ text: "the process exited once and recovered", confidence: "low" }], missingEvidence: ["a second occurrence"] });
  }
  void last;
  return fauxAssistantMessage("报告已提交。");
}

/**
 * Formal faux optimiser: read the target app, stage ONE candidate that only changes code text (inside the boundary;
 * with the [faux:refactor-schema] marker in the approved goal it changes the schema instead, to exercise the refusal),
 * validate, run the platform check, poll it, submit the proposal.
 */
function fauxRefactor(userText: string, results: { toolName: string; isError?: boolean; content: unknown }[], last: Msg): AssistantMessage {
  const ok = (n: string) => results.filter((r) => r.toolName === n && !r.isError);
  const bodyOf = (r: { content: unknown } | undefined) => (r ? parse(textOf(r as never)) : {});
  const target = bodyOf(ok("target_app_get").at(-1));
  if (!ok("target_app_get").length) return call("target_app_get", {});
  const lr = last as unknown as { toolName?: string; isError?: boolean };
  if (lr.isError && lr.toolName !== "candidate_check_status") return fauxAssistantMessage(`候选失败：${textOf(last).slice(0, 300)}`);
  const staged = ok("candidate_stage").at(-1);
  if (!staged) {
    const base = JSON.parse(JSON.stringify(target.activeBundle ?? {})) as { code?: { files?: Record<string, string>; entry?: string }; data?: { fields?: Record<string, unknown> } };
    if (userText.includes("[faux:refactor-schema]") && base.data?.fields) {
      base.data.fields["extraFaux"] = { type: "string", label: "extra" };
    } else if (base.code?.files) {
      const f = base.code.entry && base.code.files[base.code.entry] !== undefined ? base.code.entry : Object.keys(base.code.files).sort()[0]!;
      base.code.files[f] = `${base.code.files[f]}\n// optimised by the faux candidate\n`;
    }
    return call("candidate_stage", { bundle: base });
  }
  const revisionId = String(bodyOf(staged).revisionId ?? "");
  if (bodyOf(staged).valid === false) return fauxAssistantMessage(`候选无效：${JSON.stringify(bodyOf(staged).errors ?? []).slice(0, 300)}`);
  const started = ok("candidate_check").at(-1);
  // validate and start the check in one request (the optimisation budget is 6 model requests)
  if (!started && !results.some((r) => r.toolName === "candidate_check")) return fauxAssistantMessage([fauxToolCall("candidate_validate", { revisionId }), fauxToolCall("candidate_check", { revisionId })], { stopReason: "toolUse" });
  if (!started) return fauxAssistantMessage(`平台检查无法开始：${textOf(last).slice(0, 300)}`);
  const checkId = String(bodyOf(started).checkId ?? "");
  const st = ok("candidate_check_status").at(-1);
  const state = st ? String(bodyOf(st).state ?? "") : "";
  if (!st || ["queued", "running", "preparing", "checking"].includes(state) || lr.toolName === "candidate_check_status" && lr.isError) {
    return call("candidate_check_status", { checkId });
  }
  if (state !== "passed") return fauxAssistantMessage(`平台检查未通过：${state}`);
  if (!results.some((r) => r.toolName === "proposal_submit")) {
    return call("proposal_submit", { revisionId, checkId, reasons: "faux: remove a repeated computation", expectedBenefit: "fewer recomputations", knownLimits: "faux candidate" });
  }
  return fauxAssistantMessage("候选已提交，等待用户决定。");
}
