import os from "node:os";
import path from "node:path";

export interface HostConfig {
  dataDir: string;
  host: string;
  port: number;
  allowedHosts: string[];
  logLevel: "debug" | "info" | "warn" | "error";
  webDir: string;
  sessionTtlMs: number;
  testMode: boolean;
}

export function expandHome(p: string): string {
  return p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HostConfig {
  const dataDir = path.resolve(expandHome(env.AGENTOS_DATA_DIR || "~/.local/share/agentos"));
  const host = env.AGENTOS_HOST || "127.0.0.1";
  const port = Number(env.AGENTOS_PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid AGENTOS_PORT ${env.AGENTOS_PORT}`);
  const allowedHosts = [`${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`];
  for (const h of (env.AGENTOS_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) allowedHosts.push(h);
  const lvl = (env.AGENTOS_LOG_LEVEL || "info") as HostConfig["logLevel"];
  const webDir = path.resolve(env.AGENTOS_WEB_DIR || path.join(import.meta.dirname, "..", "..", "web", "dist"));
  return {
    dataDir,
    host,
    port,
    allowedHosts: [...new Set(allowedHosts)],
    logLevel: ["debug", "info", "warn", "error"].includes(lvl) ? lvl : "info",
    webDir,
    sessionTtlMs: 12 * 3600 * 1000,
    testMode: env.NODE_ENV === "test",
  };
}
