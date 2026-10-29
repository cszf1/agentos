import {
  createModels,
  createProvider,
  envApiKeyAuth,
  fauxProvider,
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
  /** Pi's model registry: holds ONLY host route aliases (spec §9.1); the real provider is never registered directly. */
  models: MutableModels;
  /** the real provider and model every route forwards to */
  inner: Provider | null;
  real: Model<string> | null;
  ref: { provider: string; modelId: string };
  available: boolean;
  diagnostic: string | null;
}

export async function buildModels(cfg: ModelConfig | null, faux?: { contextWindow?: number }): Promise<BuiltModels> {
  const models = createModels();
  const none = (ref: { provider: string; modelId: string }, diagnostic: string): BuiltModels => ({ models, inner: null, real: null, ref, available: false, diagnostic });
  if (cfg === null) return none({ provider: "none", modelId: "none" }, "AGENTOS_MODEL_PROVIDER / AGENTOS_MODEL_ID are not configured");
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
    if (!cfg.baseUrl) return none(cfg, "AGENTOS_MODEL_BASE_URL is required for openai-compatible");
    inner = openAiCompatibleProvider(cfg.baseUrl, cfg.modelId);
  } else {
    return none(cfg, `provider "${cfg.provider}" is not enabled (validated: ${VALIDATED_REAL_PROVIDERS.join(", ")})`);
  }
  const real = inner.getModels().find((m) => m.id === cfg.modelId) as Model<string> | undefined;
  if (!real) return none(cfg, `model "${cfg.modelId}" is not in provider "${cfg.provider}"`);
  // Credential check through a throw-away registry: the real provider must never be reachable from Pi's registry.
  let configured = true;
  try {
    const probe = createModels();
    probe.setProvider(inner);
    configured = (await probe.getAuth(real)) !== undefined || cfg.mode === "faux";
  } catch {
    configured = cfg.mode === "faux";
  }
  if (!configured) return { ...none(cfg, `no credentials for provider "${cfg.provider}"`), inner, real };
  return { models, inner, real, ref: { provider: real.provider, modelId: real.id }, available: true, diagnostic: null };
}
