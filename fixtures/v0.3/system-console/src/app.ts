import { defineQueries, defineSystemActions, type ObservationEnvelope } from "@agentos/app-sdk";

type Read = <T>(alias: string, cap: string, params?: Record<string, unknown>) => Promise<ObservationEnvelope<T>>;

function why(e: unknown): string {
  const code = (e as { code?: string }).code ?? "PROVIDER_UNAVAILABLE";
  return code === "PROVIDER_GRANT_REQUIRED" ? "需要连接资源" : code === "GRANT_REVOKING" ? "授权撤销中" : code === "GRANT_REVOKED" ? "授权已撤销" : `不可用（${code}）`;
}

async function safe<T>(read: Read, alias: string, cap: string, params?: Record<string, unknown>): Promise<{ env: ObservationEnvelope<T> | null; err: string }> {
  try {
    const env = await read<T>(alias, cap, params);
    if (env.quality === "unavailable") return { env: null, err: "预览中：模拟快照" };
    return { env, err: "" };
  } catch (e) {
    return { env: null, err: why(e) };
  }
}

const pct = (u: unknown) => (typeof u === "number" && u < 1e15 ? `${u / 10000}%` : "不限");
const mib = (b: unknown) => (typeof b === "number" && b < 1e15 ? `${Math.round(b / 1048576)} MiB` : "不限");
const cut = (s: string, n = 200) => (s.length > n ? s.slice(0, n) : s);

export const queries = defineQueries({
  main: async (_input: Record<string, never>, ctx) => {
    const read = ctx.providers.read as Read;
    const svc = await safe<{ activeState: string; subState: string; CPUQuotaPerSecUSec: number; MemoryMax: number }>(read, "svc", "service.describe");
    const ex = await safe<{ entries: { name: string }[] }>(read, "exports", "file.list", {});
    const lab = await safe<{ activeProfile: string | null; probe?: { allowed: boolean } }>(read, "lab", "network.policy_status");
    const dev = await safe<{ connected: boolean; samples: { data: string }[] }>(read, "dev", "serial.status");
    const times: string[] = [];
    for (const e of [svc.env, ex.env, lab.env, dev.env]) if (e) times.push(e.observedAt);
    times.sort();
    return {
      svc: svc.env ? cut(`${svc.env.data?.activeState ?? "?"} / ${svc.env.data?.subState ?? "?"}`) : svc.err,
      cpu: svc.env ? pct(svc.env.data?.CPUQuotaPerSecUSec) : svc.err.slice(0, 60),
      memory: svc.env ? mib(svc.env.data?.MemoryMax) : svc.err.slice(0, 60),
      exports: ex.env ? `${ex.env.data?.entries.length ?? 0} 个文件` : ex.err,
      lab: lab.env ? cut(`策略 ${lab.env.data?.activeProfile ?? "无"} · 探测${lab.env.data?.probe?.allowed ? "可达" : "不可达"}`) : lab.err,
      serial: dev.env ? (dev.env.data?.connected ? `已连接 · 最近 ${dev.env.data?.samples.at(-1)?.data ?? "无"}` : "未连接") : dev.err,
      observedAt: times.length ? `观察于 ${times[0]}` : "没有可用观察",
      quality: svc.env?.quality ?? "unavailable",
    };
  },
  telemetry: async (_input: Record<string, never>, ctx) => {
    const read = ctx.providers.read as Read;
    const m = await safe<{ metrics: { memoryCurrent: number | null; pidsCurrent: number | null; cpuStat: { usage_usec?: number } } }>(read, "svc", "service.metrics");
    const t = await safe<{ available: boolean; gap: boolean; counts: Record<string, { exec: number; exit: number }> }>(read, "svc", "telemetry.summary");
    const c = t.env ? Object.values(t.env.data?.counts ?? {})[0] : undefined;
    return {
      usage: m.env ? cut(`内存 ${mib(m.env.data?.metrics.memoryCurrent)} · 进程 ${m.env.data?.metrics.pidsCurrent ?? "?"} · CPU 累计 ${Math.round((m.env.data?.metrics.cpuStat.usage_usec ?? 0) / 1000)} ms`) : `用量：${m.err}`,
      telemetry: t.env ? (t.env.data?.available ? `遥测：exec ${c?.exec ?? 0} 次 · exit ${c?.exit ?? 0} 次${t.env.data?.gap ? "（有缺口，计数不完整）" : ""}` : "遥测不可用") : `遥测：${t.err}`,
    };
  },
});

export const commands = {};

export const systemActions = defineSystemActions({
  setCpu: async (input: { percent: number }, ctx) => {
    const o = await ctx.providers.read("svc", "service.describe");
    return { bindingAlias: "svc", capabilityId: "service.set_limit", params: { property: "CPUQuotaPerSecUSec", value: input.percent * 10000 }, observationIds: [o.observationId], preview: { text: `CPU 上限设为 ${input.percent}%` } };
  },
  startService: async (_input: Record<string, never>, ctx) => {
    const o = await ctx.providers.read("svc", "service.describe");
    return { bindingAlias: "svc", capabilityId: "service.ensure_state", params: { state: "running" }, observationIds: [o.observationId], preview: { text: "启动服务" } };
  },
  stopService: async (_input: Record<string, never>, ctx) => {
    const o = await ctx.providers.read("svc", "service.describe");
    return { bindingAlias: "svc", capabilityId: "service.ensure_state", params: { state: "stopped" }, observationIds: [o.observationId], preview: { text: "停止服务" } };
  },
  writeReport: async (input: { name: string }, ctx) => {
    const name = `${input.name.replace(/[^A-Za-z0-9_-]/g, "") || "report"}.txt`;
    const content = `AgentOS 状态报告\n生成时间 ${ctx.logicalTime}\n应用版本 ${ctx.revisionId.slice(7, 19)}\n`;
    try {
      const cur = await ctx.providers.read<{ version: string }>("exports", "file.read_text", { path: name });
      return { bindingAlias: "exports", capabilityId: "file.write_text_atomic", params: { path: name, content, expectedVersion: cur.data!.version }, observationIds: [cur.observationId], preview: { text: `替换 ${name}` } };
    } catch (e) {
      if ((e as { code?: string }).code !== "RESOURCE_GONE") throw e;
      return { bindingAlias: "exports", capabilityId: "file.write_text_atomic", params: { path: name, content, expectedAbsent: true }, observationIds: [], preview: { text: `新建 ${name}` } };
    }
  },
  applyProfile: async (input: { profileId: "local-allow" | "local-deny" }, ctx) => {
    const o = await ctx.providers.read("lab", "network.policy_status");
    return { bindingAlias: "lab", capabilityId: "network.apply_profile", params: { profileId: input.profileId }, observationIds: [o.observationId], preview: { text: `测试网络策略 ${input.profileId}` } };
  },
  sample: async (_input: Record<string, never>, ctx) => {
    const o = await ctx.providers.read("dev", "serial.status");
    return { bindingAlias: "dev", capabilityId: "serial.exchange", params: { command: "SAMPLE", count: 3 }, observationIds: [o.observationId], preview: { text: "串口采样 3 次" } };
  },
});
