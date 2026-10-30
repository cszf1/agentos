// Build a real v0.4 instance from the frozen v0.4 commit and take its own cold backup (V1-M01 source).
// Usage: node scripts/v04-instance.mjs <v0.4 checkout with built packages> <dataDir> <backupDir>
// It uses ONLY the v0.4 code: core for app versions/records, the v0.4 Host to create and bind agent.sqlite,
// and the v0.4 `agentos-admin backup`. The v1.0 tree is not imported here.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const [v04, dataDir, backupDir] = process.argv.slice(2);
const core = await import(pathToFileURL(path.join(v04, "packages/core/dist/index.js")).href);
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const env = { ...process.env, AGENTOS_DATA_DIR: dataDir, AGENTOS_RUNTIME: "off", AGENTOS_PORT: String(20000 + (process.pid % 20000)), NODE_ENV: "production" };

// 1. first Host start creates both databases and binds the Pi marker
async function hostOnce() {
  const h = spawn(path.join(v04, "bin/agentos-host"), [], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  h.stdout.on("data", (d) => (out += d));
  h.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 100 && !/listening|ready|Server listening/i.test(out); i++) await new Promise((r) => setTimeout(r, 200));
  h.kill("SIGTERM");
  await new Promise((r) => h.on("exit", r));
  if (!fs.existsSync(path.join(dataDir, "agent.sqlite"))) throw new Error("v0.4 host did not create agent.sqlite:\n" + out);
}
await hostOnce();

// 2. app versions and records, through the v0.4 core (the same calls the v0.4 tests use)
const c = core.openCore(path.join(dataDir, "os.sqlite"));
const fx = (n) => JSON.parse(fs.readFileSync(path.join(v04, "fixtures", n), "utf8"));
const meta = (body) => ({ operationKey: randomUUID(), requestHash: core.requestHash({ body }) });
function publish(bundle) {
  return c.store.tx(() => {
    const appId = bundle.manifest.appId;
    if (!c.apps.getAppRow(appId)) c.store.run("INSERT INTO apps (id, active_revision_id, epoch, contract_json, created_at, updated_at) VALUES (?, NULL, 0, '{\"fields\":{}}', 'x', 'x')", appId);
    const { revisionId, issues } = c.apps.stage(appId, bundle, null);
    if (issues.length) throw new Error(JSON.stringify(issues));
    c.apps.activateInTx(appId, revisionId, c.apps.requireApp(appId).epoch, { historicalOnly: false, runId: null });
    return revisionId;
  });
}
const v1 = fx("todo-v1.json");
const r1 = publish(v1);
const appId = v1.manifest.appId;
const rec = (data) => { const epoch = c.apps.requireApp(appId).epoch; return c.user.createRecord(meta({ appId, epoch, data }), appId, epoch, data).body; };
rec({ title: "买牛奶", done: false });
rec({ title: "繁體：寫報告", done: true });
const r2 = publish(fx("todo-v2.json"));
rec({ title: "with priority", done: false, priority: "high" });
{ const epoch = c.apps.requireApp(appId).epoch; c.user.activateHistorical(meta({ appId, revisionId: r1, epoch }), appId, r1, epoch); }
c.store.close();
await hostOnce();

// 3. the v0.4 cold backup tool
const b = spawnSync(path.join(v04, "bin/agentos-admin"), ["backup", "--output", backupDir], { env, encoding: "utf8" });
process.stdout.write(b.stdout + b.stderr);
if (b.status !== 0) process.exit(b.status ?? 1);
console.log(JSON.stringify({ appId, revisions: [r1, r2], activeRevision: r1 }));
