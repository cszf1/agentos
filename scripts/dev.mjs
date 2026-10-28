#!/usr/bin/env node
// Development: incremental tsc for the host packages, the host through bin/agentos-host (same lock as production),
// and Vite on 127.0.0.1:5173 proxying /api to the host. The same data dir only ever has one host.
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const run = (cmd, args, opts = {}) => spawn(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
const tsc = spawnSync("npx", ["tsc", "-b", "packages/host"]);
function spawnSync(cmd, args) {
  return new Promise((resolve) => run(cmd, args).on("exit", resolve));
}
await tsc;
const host = run(path.join(ROOT, "bin", "agentos-host"), [], { env: { ...process.env, AGENTOS_DATA_DIR: process.env.AGENTOS_DATA_DIR ?? path.join(ROOT, ".data", "dev") } });
const web = run("pnpm", ["--filter", "@agentos/web", "dev"]);
const stop = () => {
  host.kill("SIGTERM");
  web.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
host.on("exit", (c) => {
  console.error(`host exited (${c})`);
  web.kill("SIGTERM");
});
