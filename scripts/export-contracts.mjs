#!/usr/bin/env node
// Writes the v0.2 machine-readable contracts into docs/contracts from the code that enforces them (single source).
// `--check` exits 1 when the committed files differ (run by the contracts test).
import fs from "node:fs";
import path from "node:path";
import * as c from "../packages/contracts/dist/index.js";
import { RUNTIME_POLICY } from "../packages/core/dist/runtime/policy.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const out = path.join(ROOT, "docs", "contracts");
const files = {
  "app-bundle.schema.json": c.APP_BUNDLE_SCHEMA,
  "code-bundle-v2.schema.json": c.CODE_BUNDLE_SCHEMA,
  "slot-tree-v1.schema.json": c.slotTreeSchemaDocument(),
  "mutation-plan.schema.json": c.MUTATION_PLAN_SCHEMA,
  "limits.json": { run: c.LIMITS, code: c.CODE_LIMITS, ui: c.UI_LIMITS, frames: c.FRAME_LIMITS, runtime: RUNTIME_POLICY, abiVersion: c.RUNNER_ABI_VERSION, protocolVersion: c.RUNNER_PROTOCOL_VERSION, components: c.COMPONENT_TYPES, slots: c.SLOT_NAMES },
  "error-codes.json": c.ERROR_STATUS,
};
const check = process.argv.includes("--check");
let bad = 0;
for (const [name, value] of Object.entries(files)) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const f = path.join(out, name);
  if (name === "app-bundle.schema.json") {
    // The frozen v0.1 schema file keeps its original bytes; only its meaning is compared.
    if (JSON.stringify(JSON.parse(fs.readFileSync(f, "utf8"))) !== JSON.stringify(value)) {
      console.error("docs/contracts/app-bundle.schema.json no longer matches the v1 validator");
      bad++;
    }
    continue;
  }
  if (check) {
    if (!fs.existsSync(f) || fs.readFileSync(f, "utf8") !== text) {
      console.error(`docs/contracts/${name} is out of date (run node scripts/export-contracts.mjs)`);
      bad++;
    }
  } else fs.writeFileSync(f, text);
}
if (bad) process.exit(1);
console.log(check ? "contracts docs up to date" : `wrote ${Object.keys(files).length} files to docs/contracts`);
