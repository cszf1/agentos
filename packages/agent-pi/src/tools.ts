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
  runtime_catalog: "runtime.catalog",
  service_catalog: "services.read",
  app_stage: "apps.stage",
  app_validate: "apps.validate",
  app_prepare: "apps.prepare.agent",
  app_prepare_status: "deployments.read",
  app_activate: "apps.activate.agent",
};

/**
 * Tool-set version recorded in os.sqlite (meta.agent_toolset_version) and agent.sqlite (workspace doc).
 * 1 = v0.1 (activate by revisionId). 2 = v0.2 (prepare/status/activate by deploymentId, catalogs).
 */
export const TOOLSET_VERSION = 2;

function result<T>(out: ToolOutcome<T>, terminateOnSuccess = false): ToolExecutionResult {
  if (out.ok) {
    return {
      output: [{ type: "text", text: JSON.stringify(out.value) }],
      ...(terminateOnSuccess ? { control: { terminate: true } } : {}),
    };
  }
  const body: Record<string, unknown> = { error: out.code, message: out.message };
  if (out.issues) body.errors = out.issues;
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
export type ToolLog = (msg: string, fields: Record<string, unknown>) => void;

export function createBuilderExtension(ops: AgentOps, toolLog?: ToolLog): Extension {
  const id = (taskId: unknown, toolName: string) => ({ piTaskId: String(taskId), toolName });
  /** Spec §15: one log line per tool execution (ids, status, duration; never bundle bodies). */
  const withLog = <T extends { name: string; execute: (...args: never[]) => Promise<ToolExecutionResult> }>(tool: T): T => {
    if (!toolLog) return tool;
    const inner = tool.execute as unknown as (a: unknown, api: { taskId: unknown }, ...rest: unknown[]) => Promise<ToolExecutionResult>;
    const execute = async (a: unknown, api: { taskId: unknown }, ...rest: unknown[]): Promise<ToolExecutionResult> => {
      const started = performance.now();
      const call = ops.describeCall(id(api.taskId, tool.name));
      const out = await inner(a, api, ...rest);
      let revisionId: unknown = (a as { revisionId?: unknown } | undefined)?.revisionId ?? null;
      let code: unknown = null;
      try {
        const first = out.output?.[0] as { type: string; text?: string } | undefined;
        const body = first?.type === "text" && first.text ? (JSON.parse(first.text) as Record<string, unknown>) : {};
        revisionId = body.revisionId ?? revisionId;
        if (out.isError) code = body.error ?? null;
      } catch {
        /* non-JSON output */
      }
      toolLog("tool", {
        tool: tool.name,
        piTaskId: String(api.taskId),
        runId: call?.runId ?? null,
        operationKey: call?.operationKey ?? null,
        revisionId,
        status: out.isError ? "error" : "ok",
        code,
        durationMs: Math.round(performance.now() - started),
      });
      return out;
    };
    return { ...tool, execute } as T;
  };
  const tools = [
    defineTool({
      name: "system_info",
      description: "Read-only overview of the Linux host (platform, arch, uptime, memory, host version) and whether code apps can run.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_a, api) =>
        result(ops.systemInfo(id(api.taskId, "system_info"), () => ({ ...readSystemInfo(), codeRuntimeAvailable: ops.runtime?.runtimeReady ?? false, runtimeProblems: (ops.runtime?.environmentProblems ?? []).slice(0, 3) }))),
    }),
    defineTool({
      name: "app_list",
      description: "List the workspace apps (id, title, epoch, active revision, runtime, health). Never returns records.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_a, api) => result(ops.appList(id(api.taskId, "app_list"))),
    }),
    defineTool({
      name: "app_get",
      description: "Read the host-bound target app: appId, expectedAppEpoch, active bundle (with source code for code apps), full data contract, limits, allowed components.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_a, api) => {
        fault("tool.app_get");
        return result(ops.appGet(id(api.taskId, "app_get")));
      },
    }),
    defineTool({
      name: "runtime_catalog",
      description: "List the approved runtimeLockIds (profiles core-v1, data-v1), their SDK/ABI and approved modules. Code bundles must use one of them.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_a, api) => result(ops.runtimeCatalog(id(api.taskId, "runtime_catalog"))),
    }),
    defineTool({
      name: "service_catalog",
      description: "List read-only services other apps export (names, descriptions, input/output schemas). No data, no grants: the user connects services.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_a, api) => result(ops.serviceCatalog(id(api.taskId, "service_catalog"))),
    }),
    defineTool({
      name: "app_stage",
      description: "Store a complete bundle (formatVersion 1 declarative or 2 code) as an immutable candidate revision of the target app. Returns revisionId, valid and errors.",
      parameters: Type.Object({ bundle: Type.Unknown({ description: "The complete AppBundle JSON object" }) }),
      prepareArguments: (args: unknown) => parseBundleArg(args) as never,
      replay: "safe",
      execute: async (a, api) => result(ops.appStage(id(api.taskId, "app_stage"), (a as { bundle: unknown }).bundle)),
    }),
    defineTool({
      name: "app_validate",
      description: "Validate a staged revision against the schema rules and the current data contract. Returns {valid, errors:[{path,code,message}]}.",
      parameters: Type.Object({ revisionId: Type.String() }),
      replay: "safe",
      execute: async (a, api) => result(ops.appValidate(id(api.taskId, "app_validate"), a.revisionId)),
    }),
    defineTool({
      name: "app_prepare",
      description: "Prepare a validated revision for publication (build in the sandbox, start a candidate, health checks on sample data). Returns {deploymentId, status, stage, error}. Waits up to 30 s.",
      parameters: Type.Object({ revisionId: Type.String() }),
      replay: "safe",
      execute: async (a, api) => result(await ops.appPrepare(id(api.taskId, "app_prepare"), a.revisionId)),
    }),
    defineTool({
      name: "app_prepare_status",
      description: "Read the status of a deployment you prepared (may wait up to 10 s). Read-only.",
      parameters: Type.Object({ deploymentId: Type.String() }),
      replay: "safe",
      execute: async (a, api) => result(await ops.appPrepareStatus(id(api.taskId, "app_prepare_status"), a.deploymentId)),
    }),
    defineTool({
      name: "app_activate",
      description: "Publish a ready deployment as the target app's active version. Call once; then finish.",
      parameters: Type.Object({ deploymentId: Type.String() }),
      replay: "safe",
      execute: async (a, api) => result(await ops.appActivate(id(api.taskId, "app_activate"), a.deploymentId), true),
    }),
  ];
  return defineExtension({
    name: EXTENSION_NAME,
    tools: tools.map((t) => withLog(t as never)) as typeof tools,
    sections: [section("agentos_rules", () => SYSTEM_RULES)],
  });
}
