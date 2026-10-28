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
  /** v0.2 code runtime: rootless Podman API socket (null = runtime disabled), platform files root and catalog. */
  podmanSocket: string | null;
  platformRoot: string;
  catalogFile: string;
  platform: "linux/amd64" | "linux/arm64";
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
  const platformRoot = path.resolve(env.AGENTOS_PLATFORM_ROOT || path.join(import.meta.dirname, "..", "..", ".."));
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const runtimeMode = (env.AGENTOS_RUNTIME || "podman").toLowerCase();
  const podmanSocket = runtimeMode === "off" ? null : path.resolve(expandHome(env.AGENTOS_PODMAN_SOCKET || `/run/user/${uid}/podman/podman.sock`));
  return {
    dataDir,
    host,
    port,
    allowedHosts: [...new Set(allowedHosts)],
    logLevel: ["debug", "info", "warn", "error"].includes(lvl) ? lvl : "info",
    webDir,
    sessionTtlMs: 12 * 3600 * 1000,
    testMode: env.NODE_ENV === "test",
    podmanSocket,
    platformRoot,
    catalogFile: path.join(platformRoot, "runtime", "catalog", "catalog.json"),
    platform: process.arch === "arm64" ? "linux/arm64" : "linux/amd64",
  };
}
