#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import * as c from "../packages/contracts/dist/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const out = path.join(ROOT, "fixtures", "v1.0", "protocol", "vectors.json");

const user = "22222222-2222-4222-8222-222222222222";
const ws = "44444444-4444-4444-8444-444444444444";
const store = "66666666-6666-4666-8666-666666666666";
const req = "55555555-5555-4555-8555-555555555555";
const machine = "11111111-1111-4111-8111-111111111111";

const sealed = c.sealWorkspaceWrite({
  machineInstallId: machine,
  workspaceId: ws,
  storeUUID: store,
  workspaceIncarnation: 2,
  executionUid: 20000,
  principalKind: "user",
  userId: user,
  memberVersion: 1,
  runId: null,
  executionEpoch: null,
  machineControlEpoch: 4,
  requestId: req,
  deadline: 1700000000000,
  body: { hello: "世界", n: 1, ok: true, empty: null },
});
const { requestHash, body, ...outer } = sealed;
if (c.domainHash(c.WORKSPACE_WRITE_DOMAIN, outer) !== requestHash) throw new Error("write hash drifted");

const frame = c.encodeNativeFrame(Buffer.from('{"a":1}'));
const vectors = {
  generatedBy: "scripts/v1-vectors.mjs",
  hashes: [
    { name: "write", domain: c.WORKSPACE_WRITE_DOMAIN, value: outer, hash: requestHash },
    { name: "body", domain: c.WORKSPACE_BODY_DOMAIN, value: body, hash: sealed.bodyHash },
    { name: "nested", domain: "agentos.test.v1", value: { b: 1, a: [true, null, "x\"\n"] }, hash: c.domainHash("agentos.test.v1", { b: 1, a: [true, null, "x\"\n"] }) },
  ],
  strict: [
    { name: "duplicate", text: '{"a":1,"a":2}', ok: false },
    { name: "object", text: '{"b":1,"a":2}', ok: true },
    { name: "nonfinite", text: "1e309", ok: false },
  ],
  frame: { payload: '{"a":1}', hex: frame.toString("hex") },
};

const text = `${JSON.stringify(vectors, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (!fs.existsSync(out) || fs.readFileSync(out, "utf8") !== text) {
    console.error("fixtures/v1.0/protocol/vectors.json is out of date (run node scripts/v1-vectors.mjs)");
    process.exit(1);
  }
  console.log("v1 vectors up to date");
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  console.log(`wrote ${out}`);
}
