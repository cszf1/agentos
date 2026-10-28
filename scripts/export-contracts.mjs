#!/usr/bin/env node
// Writes the v0.2/v0.3 machine-readable contracts into docs/contracts from the code that enforces them (single source).
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
  // v0.3
  "code-bundle-v3.schema.json": c.CODE_BUNDLE_V3_SCHEMA,
  "slot-tree-v2.schema.json": c.slotTreeSchemaDocument(2),
  "system-plan.schema.json": c.SYSTEM_PLAN_SCHEMA,
  "provider-catalog.json": { catalogVersion: c.CATALOG_VERSION, capabilities: c.CAPABILITIES },
  "broker-protocol.json": { protocolVersion: c.BROKER_PROTOCOL_VERSION, socket: c.BROKER_SOCKET, maxFrameBytes: c.MAX_BROKER_FRAME, maxJsonDepth: c.MAX_JSON_DEPTH, methods: c.BROKER_METHODS, writeEnvelope: c.WRITE_ENVELOPE_SCHEMA, grantSync: c.GRANT_SYNC_SCHEMA, hashDomains: ["agentos.broker.write.v1", "agentos.broker.grant.v1", "agentos.system-plan.v1", "agentos.system-params.v1"] },
  "system-limits.json": { system: c.SYSTEM_LIMITS, v3: c.V3_LIMITS, runnerAbis: c.SUPPORTED_RUNNER_ABIS, componentsV2: c.COMPONENT_TYPES_V2, v03ErrorCodes: c.V03_ERROR_CODES },
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
