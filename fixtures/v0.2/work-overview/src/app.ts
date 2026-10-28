import { defineQueries } from "@agentos/app-sdk";

interface Summary {
  total: number;
  open: number;
  remainingMinutes: number;
}

export const queries = defineQueries({
  main: async (_input: Record<string, never>, ctx) => {
    try {
      const r = await ctx.services.call<Summary>("todo", {});
      return { connected: true, total: r.output.total, remainingMinutes: r.output.remainingMinutes, message: "" };
    } catch (e) {
      const code = (e as { code?: string }).code ?? "SERVICE_UNAVAILABLE";
      const text = code === "GRANT_REQUIRED" ? "待办服务未连接" : code === "GRANT_REVOKED" ? "待办服务已断开" : `待办服务不可用（${code}）`;
      return { connected: false, total: 0, remainingMinutes: 0, message: text };
    }
  },
});

export const commands = {};
