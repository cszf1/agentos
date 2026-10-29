import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { canonicalJson, sha256Hex } from "@agentos/contracts";
import type { Admission } from "@agentos/core";

/** Host admission + settlement (implemented by core ModelBudgets). */
export interface RouteGate {
  admit(routeId: string, configHash: string, signal?: AbortSignal): Promise<Admission>;
  settle(attemptId: string, background: boolean, outcome: { usage?: { output?: number; input?: number; totalTokens?: number } | null; failed?: boolean }): void;
}

export const ROUTE_PREFIX = "agentos-r-";

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
 * Host-controlled model routes (spec §9.1): one provider alias per conversation, registered in Pi's Models registry.
 * The wrapper closure holds only the routeId; the subject (run / compaction job), its execution epoch and budget are
 * re-read from os.sqlite at every request through `gate.admit`, before anything connects upstream. Both stream entry
 * points go through the same gate exactly once per network attempt; the real provider/model and its credentials are
 * used for the forwarded request; provider-internal retries stay off (stream.maxRetries=0).
 */
export class RouteTable {
  #attached = new Set<string>();
  /** network attempts actually started upstream (V4-P03 counts admissions vs network starts) */
  readonly counters = { admissions: 0, denials: 0, networkStarts: 0 };

  constructor(
    private readonly models: MutableModels,
    private readonly inner: Provider,
    private readonly real: Model<string>,
    private readonly gate: RouteGate,
  ) {}

  get realRef(): { provider: string; modelId: string } {
    return { provider: this.real.provider, modelId: this.real.id };
  }

  alias(routeId: string): string {
    return `${ROUTE_PREFIX}${routeId}`;
  }

  /** Register (idempotently) the provider alias of a route and return the ModelRef the conversation is configured with. */
  attach(routeId: string): { provider: string; modelId: string } {
    const id = this.alias(routeId);
    if (!this.#attached.has(id)) {
      this.models.setProvider(this.#provider(routeId));
      this.#attached.add(id);
    }
    return { provider: id, modelId: this.real.id };
  }

  detach(routeId: string): void {
    const id = this.alias(routeId);
    if (this.#attached.delete(id)) this.models.deleteProvider(id);
  }

  #provider(routeId: string): Provider {
    const alias = this.alias(routeId);
    const aliasModel = { ...this.real, provider: alias } as Model<string>;
    const configHash = sha256Hex(canonicalJson({ provider: this.real.provider, model: this.real.id, api: this.real.api, baseUrl: (this.real as { baseUrl?: string }).baseUrl ?? null }));
    const forward = (entry: "stream" | "streamSimple", model: Model<string>, context: unknown, options?: Record<string, unknown>): AssistantMessageEventStream => {
      const out = createAssistantMessageEventStream();
      const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
      void (async () => {
        let adm: Admission;
        try {
          adm = await this.gate.admit(routeId, configHash, signal);
        } catch (e) {
          adm = { ok: false, reason: (e as Error).message, code: "FORBIDDEN" };
        }
        if (!adm.ok) {
          this.counters.denials++;
          const err = errorStream(model, `AgentOS budget: ${adm.reason}`);
          for await (const ev of err) out.push(ev);
          out.end(await err.result());
          return;
        }
        this.counters.admissions++;
        this.counters.networkStarts++;
        let result: AssistantMessage | undefined;
        let failed = false;
        try {
          const opts = { ...(options ?? {}), maxTokens: adm.maxTokens };
          const upstream = entry === "stream" ? this.inner.stream(this.real as never, context as never, opts as never) : this.inner.streamSimple(this.real as never, context as never, opts as never);
          for await (const ev of upstream) {
            const e = ev as { type: string };
            if (e.type === "error") failed = true;
            out.push(ev);
          }
          result = await upstream.result();
          if ((result as { stopReason?: string }).stopReason === "error" || (result as { stopReason?: string }).stopReason === "aborted") failed = true;
        } catch (e) {
          failed = true;
          const err = errorStream(model, (e as Error).message);
          for await (const ev of err) out.push(ev);
          result = await err.result();
        } finally {
          const usage = (result as { usage?: { output?: number; input?: number; totalTokens?: number } } | undefined)?.usage;
          // Trusted terminal usage only: an error or abort keeps the full reservation (usage unknown).
          this.gate.settle(adm.attemptId, adm.background, { usage: !failed && usage && usage.output !== undefined ? usage : null, failed });
        }
        out.end(result);
      })();
      return out;
    };
    return {
      id: alias,
      name: `AgentOS route ${routeId}`,
      auth: this.inner.auth,
      getModels: () => [aliasModel],
      stream: ((m: Model<string>, c: unknown, o?: Record<string, unknown>) => forward("stream", m, c, o)) as Provider["stream"],
      streamSimple: ((m: Model<string>, c: unknown, o?: Record<string, unknown>) => forward("streamSimple", m, c, o)) as Provider["streamSimple"],
    };
  }
}
