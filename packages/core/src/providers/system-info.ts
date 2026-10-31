import os from "node:os";
import { HOST_VERSION, PRODUCT_VERSION, type SystemInfo } from "@agentos/contracts";

/** Read-only system.info provider: real Node OS APIs, no shell output parsing. */
export function readSystemInfo(): SystemInfo {
  const load = os.loadavg();
  return {
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    hostname: os.hostname(),
    uptimeSeconds: Math.round(os.uptime()),
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
    loadAverage: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    cpus: os.cpus().length,
    nodeVersion: process.version,
    hostVersion: HOST_VERSION,
    productVersion: PRODUCT_VERSION,
  };
}
