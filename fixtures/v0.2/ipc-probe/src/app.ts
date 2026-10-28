import { defineQueries } from "@agentos/app-sdk";

async function attempt(fn: () => Promise<unknown>): Promise<string> {
  try {
    const r = (await fn()) as { output?: { detail?: string; blob?: string } };
    return `OK:${(r.output?.detail ?? String(r.output?.blob?.length ?? "")).slice(0, 200)}`;
  } catch (e) {
    return (e as { code?: string }).code ?? "ERR";
  }
}

export const queries = defineQueries({
  main: async (input: { which?: string; ms?: number }, ctx) => {
    const which = input.which ?? "none";
    let detail = "idle";
    if (which === "slow") detail = await attempt(() => ctx.services.call("lab_slow", { ms: input.ms ?? 10 }));
    else if (which === "big") detail = await attempt(() => ctx.services.call("lab_big", {}));
    else if (which === "nested") detail = await attempt(() => ctx.services.call("lab_nested", {}));
    else if (which === "five") {
      const out: string[] = [];
      for (let i = 0; i < 5; i++) out.push(await attempt(() => ctx.services.call("lab_slow", { ms: 1 })));
      detail = out.join(",");
    }
    return { ok: true, detail };
  },
});

export const commands = {};
