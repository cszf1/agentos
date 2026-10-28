import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  envApiKeyAuth,
  fauxAssistantMessage,
  fauxProvider,
  type AssistantMessageEventStream,
  type Model,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { LIMITS } from "@agentos/contracts";
import { fauxBuilderResponse } from "./faux.js";

export interface ModelConfig {
  mode: "real" | "faux";
  provider: string;
  modelId: string;
  baseUrl?: string;
}

export type Admission = () => { ok: true } | { ok: false; reason: string };

/** Read AGENTOS_MODEL_* without choosing a model for the user. */
export function modelConfigFromEnv(env: NodeJS.ProcessEnv): ModelConfig | null {
  const mode = env.AGENTOS_MODEL_MODE === "faux" ? "faux" : "real";
  if (mode === "faux") return { mode, provider: "agentos-faux", modelId: "faux-builder" };
  const provider = env.AGENTOS_MODEL_PROVIDER?.trim();
  const modelId = env.AGENTOS_MODEL_ID?.trim();
  if (!provider || !modelId) return null;
  const cfg: ModelConfig = { mode, provider, modelId };
  if (env.AGENTOS_MODEL_BASE_URL) cfg.baseUrl = env.AGENTOS_MODEL_BASE_URL.trim();
  return cfg;
}

function errorStream(model: Model<string>, message: string): AssistantMessageEventStream {
  const s = createAssistantMessageEventStream();
  const msg = { ...fauxAssistantMessage("", { stopReason: "error", errorMessage: message }), api: model.api, provider: model.provider, model: model.id };
  queueMicrotask(() => {
    s.push({ type: "error", reason: "error", error: msg });
    s.end(msg);
  });
  return s;
}

/**
 * Budget gate at the provider entry: every request (generation, retry, compaction, re-send after restart)
 * must be admitted by os.sqlite before anything connects upstream. Output is capped with maxTokens.
 */
export function budgetedProvider(inner: Provider, admit: Admission, maxTokens: number = LIMITS.maxOutputTokens): Provider {
  const wrapped = Object.create(inner) as Provider & Record<string, unknown>;
  wrapped.stream = ((model: Model<string>, context: unknown, options?: Record<string, unknown>) => {
    const a = admit();
    if (!a.ok) return errorStream(model, `AgentOS budget: ${a.reason}`);
    return inner.stream(model as never, context as never, { ...(options ?? {}), maxTokens } as never);
  }) as Provider["stream"];
  wrapped.streamSimple = ((model: Model<string>, context: unknown, options?: Record<string, unknown>) => {
    const a = admit();
    if (!a.ok) return errorStream(model, `AgentOS budget: ${a.reason}`);
    return inner.streamSimple(model as never, context as never, { ...(options ?? {}), maxTokens } as never);
  }) as Provider["streamSimple"];
  return wrapped;
}

/**
 * Real providers enabled in v0.1. Spec §10/§14: only providers whose behaviour (SSE transport, internal retries off
 * via stream.maxRetries=0, maxTokens cap, budget gate) has passed acceptance are enabled. Others report unavailable.
 */
export const VALIDATED_REAL_PROVIDERS = ["openai-compatible"] as const;

/** An OpenAI-compatible endpoint (base URL + AGENTOS_MODEL_API_KEY). */
function openAiCompatibleProvider(baseUrl: string, modelId: string): Provider {
  const raw = (process.env.AGENTOS_MODEL_REASONING_EFFORT ?? "").trim();
  if (raw && !["none", "low", "medium", "high"].includes(raw)) throw new Error("AGENTOS_MODEL_REASONING_EFFORT must be none, low, medium or high");
  const effort = raw || null;
  return createProvider({
    id: "openai-compatible",
    name: "OpenAI-compatible",
    baseUrl,
    // pi-ai openai-completions: the official OPENAI_API_KEY is accepted; AGENTOS_MODEL_API_KEY wins when both are set.
    auth: { apiKey: envApiKeyAuth("AgentOS model API key", ["AGENTOS_MODEL_API_KEY", "OPENAI_API_KEY"]) },
    models: [
      {
        id: modelId,
        name: modelId,
        api: "openai-completions",
        provider: "openai-compatible",
        baseUrl,
        input: ["text"],
        // AGENTOS_MODEL_REASONING_EFFORT (none|low|medium|high): sent as OpenAI-style reasoning_effort on every request,
        // so a reasoning model cannot spend the whole 16384-token output budget thinking. Unset: the provider default.
        ...(effort ? { reasoning: true, compat: { supportsReasoningEffort: true }, thinkingLevelMap: { off: effort } } : { reasoning: false }),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: LIMITS.maxOutputTokens,
      } as Model<"openai-completions">,
    ],
    api: openAICompletionsApi(),
  });
}

export interface BuiltModels {
  models: MutableModels;
  ref: { provider: string; modelId: string };
  available: boolean;
  diagnostic: string | null;
}

export async function buildModels(cfg: ModelConfig | null, admit: Admission, faux?: { contextWindow?: number }): Promise<BuiltModels> {
  const models = createModels();
  if (cfg === null) return { models, ref: { provider: "none", modelId: "none" }, available: false, diagnostic: "AGENTOS_MODEL_PROVIDER / AGENTOS_MODEL_ID are not configured" };
  let inner: Provider | undefined;
  if (cfg.mode === "faux") {
    const handle = fauxProvider({
      provider: cfg.provider,
      models: [{ id: cfg.modelId, contextWindow: faux?.contextWindow ?? 128000, maxTokens: LIMITS.maxOutputTokens }],
      tokensPerSecond: 100000,
    });
    // An endless script: every request is answered by the deterministic builder.
    const step = (ctx: unknown, opts: unknown, _st: unknown, model: unknown) => fauxBuilderResponse(ctx as never, opts as never, model as never);
    handle.setResponses(Array.from({ length: 10_000 }, () => step as never));
    inner = handle.provider;
  } else if (cfg.provider === "openai-compatible") {
    if (!cfg.baseUrl) return { models, ref: cfg, available: false, diagnostic: "AGENTOS_MODEL_BASE_URL is required for openai-compatible" };
    inner = openAiCompatibleProvider(cfg.baseUrl, cfg.modelId);
  } else {
    return {
      models,
      ref: cfg,
      available: false,
      diagnostic: `provider "${cfg.provider}" is not enabled in v0.1 (validated: ${VALIDATED_REAL_PROVIDERS.join(", ")})`,
    };
  }
  models.setProvider(budgetedProvider(inner, admit));
  const model = models.getModel(cfg.provider === "openai-compatible" ? "openai-compatible" : cfg.provider, cfg.modelId);
  if (!model) return { models, ref: cfg, available: false, diagnostic: `model "${cfg.modelId}" is not in provider "${cfg.provider}"` };
  let configured = true;
  try {
    configured = (await models.getAuth(model)) !== undefined || cfg.mode === "faux";
  } catch {
    configured = cfg.mode === "faux";
  }
  if (!configured) return { models, ref: cfg, available: false, diagnostic: `no credentials for provider "${cfg.provider}"` };
  return { models, ref: { provider: model.provider, modelId: model.id }, available: true, diagnostic: null };
}
