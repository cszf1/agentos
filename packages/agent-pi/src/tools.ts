import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { fault, readSystemInfo, type AgentOps, type ToolOutcome } from "@agentos/core";
import { SYSTEM_RULES } from "./prompt.js";

export const EXTENSION_NAME = "agentos-app-builder";

/** Domain capability ↔ Pi tool name (Pi names use underscores). */
export const TOOL_CAPABILITY: Record<string, string> = {
  system_info: "system.info",
  app_list: "apps.list",
  app_get: "apps.get",
  app_stage: "apps.stage",
  app_validate: "apps.validate",
  app_activate: "apps.activate.agent",
};

function result<T>(out: ToolOutcome<T>, terminateOnSuccess = false): ToolExecutionResult {
  if (out.ok) {
    return {
      output: [{ type: "text", text: JSON.stringify(out.value) }],
      ...(terminateOnSuccess ? { control: { terminate: true } } : {}),
    };
  }
  const body: Record<string, unknown> = { error: out.code, message: out.message };
  if (out.issues) body.issues = out.issues;
  return { output: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}

/** Some models send the bundle as a JSON string; repair that before validation. */
function parseBundleArg(args: unknown): { bundle: unknown } {
  if (args && typeof args === "object" && "bundle" in args) {
    const b = (args as { bundle: unknown }).bundle;
    if (typeof b === "string") {
      try {
        return { bundle: JSON.parse(b) };
      } catch {
        return { bundle: b };
      }
    }
    return { bundle: b };
  }
  return args as { bundle: unknown };
}

/**
 * The only extension the root conversation runs with. Tools are replay-safe because every write is keyed by a
 * host-generated operation key and answered from the os.sqlite receipt on replay.
 */
export function createBuilderExtension(ops: AgentOps): Extension {
  const id = (taskId: unknown, toolName: string) => ({ piTaskId: String(taskId), toolName });
  const tools = [
    defineTool({
      name: "system_info",
      description: "Read-only overview of the Linux host (platform, arch, uptime, memory, host version).",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_a, api) => result(ops.systemInfo(id(api.taskId, "system_info"), readSystemInfo)),
    }),
    defineTool({
      name: "app_list",
      description: "List the workspace apps (id, title, epoch, active revision). Never returns records.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_a, api) => result(ops.appList(id(api.taskId, "app_list"))),
    }),
    defineTool({
      name: "app_get",
      description: "Read the host-bound target app: appId, expectedAppEpoch, active bundle, full data contract and limits.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_a, api) => {
        fault("tool.app_get");
        return result(ops.appGet(id(api.taskId, "app_get")));
      },
    }),
    defineTool({
      name: "app_stage",
      description: "Store a complete AppBundle as an immutable candidate revision of the target app. Returns revisionId and issues.",
      parameters: Type.Object({ bundle: Type.Unknown({ description: "The complete AppBundle JSON object" }) }),
      prepareArguments: (args: unknown) => parseBundleArg(args) as never,
      replay: "safe",
      execute: async (a, api) => result(ops.appStage(id(api.taskId, "app_stage"), (a as { bundle: unknown }).bundle)),
    }),
    defineTool({
      name: "app_validate",
      description: "Validate a staged revision against the schema rules and the current data contract.",
      parameters: Type.Object({ revisionId: Type.String() }),
      replay: "safe",
      execute: async (a, api) => result(ops.appValidate(id(api.taskId, "app_validate"), a.revisionId)),
    }),
    defineTool({
      name: "app_activate",
      description: "Publish a validated revision as the target app's active version. Call once; then finish.",
      parameters: Type.Object({ revisionId: Type.String() }),
      replay: "safe",
      execute: async (a, api) => result(ops.appActivate(id(api.taskId, "app_activate"), a.revisionId), true),
    }),
  ];
  return defineExtension({
    name: EXTENSION_NAME,
    tools,
    sections: [section("agentos_rules", () => SYSTEM_RULES)],
  });
}
