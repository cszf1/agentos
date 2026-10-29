import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));
const alias = {
  "@agentos/contracts": src("contracts"),
  "@agentos/core": src("core"),
  "@agentos/agent-pi": src("agent-pi"),
  "@agentos/host": src("host"),
  "@agentos/runtime-podman": src("runtime-podman"),
  "@agentos/broker-client": src("broker-client"),
  // the web renderer under test (review #5 List template) resolves React from the web package
  react: fileURLToPath(new URL("./packages/web/node_modules/react", import.meta.url)),
  "react-dom": fileURLToPath(new URL("./packages/web/node_modules/react-dom", import.meta.url)),
};

export default defineConfig({
  test: {
    projects: [
      { resolve: { alias }, test: { name: "unit", include: ["tests/integration/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 60_000, pool: "forks" } },
      // v0.4: multi-conversation agents, maintenance, online GC and compaction (faux Pi, real files).
      { resolve: { alias }, test: { name: "agents", include: ["tests/agents/**/*.test.ts", "packages/agent-pi/test/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000, pool: "forks" } },
      { resolve: { alias }, test: { name: "maintenance", include: ["tests/maintenance/**/*.test.ts"], testTimeout: 180_000, hookTimeout: 120_000, pool: "forks" } },
      { resolve: { alias }, test: { name: "maintenance-recovery", include: ["tests/maintenance-recovery/**/*.test.ts"], testTimeout: 400_000, hookTimeout: 120_000, pool: "forks", poolOptions: { forks: { singleFork: true } } } },
      { resolve: { alias }, test: { name: "gc-online", include: ["tests/gc-online/**/*.test.ts"], testTimeout: 300_000, hookTimeout: 120_000, pool: "forks" } },
      { resolve: { alias }, test: { name: "compaction", include: ["tests/compaction/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000, pool: "forks" } },
      { resolve: { alias }, test: { name: "recovery", include: ["tests/recovery/**/*.test.ts"], testTimeout: 400_000, hookTimeout: 120_000, pool: "forks" } },
      // v0.3: real native stack (installed broker/workers, lab namespace, PTY fixture); serial: one broker, one store.
      { resolve: { alias }, test: { name: "native", include: ["tests/native/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000, pool: "forks", poolOptions: { forks: { singleFork: true } }} },
      { resolve: { alias }, test: { name: "broker-recovery", include: ["tests/broker-recovery/**/*.test.ts"], testTimeout: 180_000, hookTimeout: 120_000, pool: "forks", poolOptions: { forks: { singleFork: true } }} },
      { resolve: { alias }, test: { name: "telemetry", include: ["tests/telemetry/**/*.test.ts"], testTimeout: 600_000, hookTimeout: 600_000, pool: "forks", poolOptions: { forks: { singleFork: true } } } },
      { resolve: { alias }, test: { name: "sandbox", include: ["tests/sandbox/**/*.test.ts"], testTimeout: 300_000, hookTimeout: 300_000, pool: "forks", poolOptions: { forks: { singleFork: true } } } },
    ],
  },
});
