#!/usr/bin/env node
// Development: build the host packages, then run the host through bin/agentos-host (same lock as production) with
// its own data dir. The same data dir only ever has one host.
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const run = (cmd, args, opts = {}) => spawn(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
await new Promise((resolve) => run("npx", ["tsc", "-b", "packages/host"]).on("exit", resolve));
// The dev host listens on its own port (default 4318) so it never collides with an installed service on 4317.
const host = run(path.join(ROOT, "bin", "agentos-host"), [], {
  env: {
    ...process.env,
    AGENTOS_DATA_DIR: process.env.AGENTOS_DATA_DIR ?? path.join(ROOT, ".data", "dev"),
    AGENTOS_PORT: process.env.AGENTOS_DEV_PORT ?? "4318",
  },
});
const stop = () => host.kill("SIGTERM");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
host.on("exit", (c) => console.error(`host exited (${c})`));
