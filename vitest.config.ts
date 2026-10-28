import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));
const alias = {
  "@agentos/contracts": src("contracts"),
  "@agentos/core": src("core"),
  "@agentos/agent-pi": src("agent-pi"),
  "@agentos/host": src("host"),
  "@agentos/runtime-podman": src("runtime-podman"),
};

export default defineConfig({
  test: {
    projects: [
      { resolve: { alias }, test: { name: "unit", include: ["tests/integration/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 60_000, pool: "forks" } },
      { resolve: { alias }, test: { name: "recovery", include: ["tests/recovery/**/*.test.ts"], testTimeout: 400_000, hookTimeout: 120_000, pool: "forks" } },
      { resolve: { alias }, test: { name: "sandbox", include: ["tests/sandbox/**/*.test.ts"], testTimeout: 300_000, hookTimeout: 300_000, pool: "forks", poolOptions: { forks: { singleFork: true } } } },
    ],
  },
});
