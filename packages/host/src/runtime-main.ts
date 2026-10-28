import { loadConfig } from "./config.js";
import { doctor, prefetch } from "./runtime-ops.js";

/** bin/agentos-runtime doctor|prefetch: read-only environment checks and image warm-up (no workspace lock needed). */
async function main(): Promise<void> {
  const cmd = process.argv[2];
  const config = loadConfig();
  if (cmd === "doctor") {
    const r = await doctor(config);
    for (const c of r.checks) process.stdout.write(`${c.ok ? "ok  " : "FAIL"}  ${c.name}: ${c.detail}\n`);
    process.stdout.write(`${r.ok ? "runtime ready" : "runtime NOT ready"}\n`);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === "prefetch") {
    const r = await prefetch(config);
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    process.exit(r.ok ? 0 : 1);
  } else {
    process.stderr.write("usage: agentos-runtime doctor | prefetch\n");
    process.exit(2);
  }
}
main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
