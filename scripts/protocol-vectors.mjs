#!/usr/bin/env node
// Generates fixtures/v0.3/protocol/vectors.json from the TypeScript contracts. The Rust protocol crate's tests
// (native/crates/protocol/tests/vectors.rs) must reach the same verdicts and hashes (V3-C04).
// `--check` exits 1 when the committed file differs.
import fs from "node:fs";
import path from "node:path";
import * as c from "../packages/contracts/dist/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const out = path.join(ROOT, "fixtures", "v0.3", "protocol", "vectors.json");

const H = "sha256:" + "0".repeat(64);
const baseEnv = {
  protocolVersion: 1, machineInstallId: "mi_0123456789abcdef01234567", storeUuid: "6b5577bd-7d22-4aae-a7d4-0d569f6979c3", workspaceIncarnation: 3,
  operationId: "op_0123456789abcdef01234567", actionId: "sa_0123456789abcdef01234567", planHash: H, capabilityId: "service.set_limit", contractVersion: 1,
  resourceId: "res_service_0123456789abcdef0123", resourceGeneration: 2, grantId: "pg_0123456789abcdef0123", grantVersion: 1,
  preconditions: { resourceGeneration: 2, "é": "ü", "\u00e9a": 1, "Z": [1, 2, { b: null, a: true }] },
  deadlineMs: 1793196376387, params: { property: "CPUQuotaPerSecUSec", value: 500000 }, compensatesOperationId: null,
};

const canonicalCases = [
  { name: "ascii-order", value: { b: 1, a: 2, A: 3, _: 4 } },
  { name: "utf16-order", value: { "\u{1F600}": 1, "\uFFFF": 2, "é": 3, "z": 4 } },
  { name: "escapes", value: { s: "line\nnew\t\"q\" \\ \u0001 \u001f \u007f \u2028 中文" } },
  { name: "nested", value: { a: [{ c: 3, b: [true, false, null] }, "x", -9007199254740991, 9007199254740991] } },
  { name: "empty", value: { a: {}, b: [] } },
];

const vectors = { generatedBy: "scripts/protocol-vectors.mjs", canonical: [], envelopes: [], grants: [], params: [], depth: [] };

for (const k of canonicalCases) vectors.canonical.push({ name: k.name, value: k.value, canonical: c.protocolCanonical(k.value), hash: c.domainHash("agentos.test.v1", k.value) });
// Rejected by both: floats and unsafe integers in protocol values.
for (const [name, text] of [["float", '{"a":1.5}'], ["unsafe-int", '{"a":9007199254740993}']]) {
  let ok = true;
  try {
    c.protocolCanonical(JSON.parse(text));
  } catch {
    ok = false;
  }
  vectors.canonical.push({ name, text, ok });
}

const sealed = c.sealEnvelope(baseEnv);
const envCases = [
  ["valid", sealed, true],
  ["unknown-field", { ...sealed, extra: 1 }, false],
  ["bad-hash", { ...sealed, requestHash: H }, false],
  ["missing-compensates", Object.fromEntries(Object.entries(sealed).filter(([k]) => k !== "compensatesOperationId")), false],
  ["negative-generation", c.sealEnvelope({ ...baseEnv, resourceGeneration: -1 }), false],
  ["unsafe-deadline", { ...sealed, deadlineMs: 9007199254740993 }, false],
  ["bad-plan-hash", c.sealEnvelope({ ...baseEnv, planHash: "sha256:XYZ" }), false],
  ["bad-token", c.sealEnvelope({ ...baseEnv, operationId: "op with space" }), false],
];
for (const [name, value, ok] of envCases) {
  const ts = c.checkWriteEnvelope(JSON.parse(JSON.stringify(value)));
  if ((ts === null) !== ok) throw new Error(`TS verdict for envelope ${name} is ${ts}`);
  vectors.envelopes.push({ name, text: JSON.stringify(value), ok, requestHash: ok ? sealed.requestHash : null });
}

const grantBase = {
  identity: { machineInstallId: baseEnv.machineInstallId, storeUuid: baseEnv.storeUuid, workspaceIncarnation: 3 }, grantId: "pg_0123456789abcdef0123", grantVersion: 1,
  principal: { kind: "app", appId: "6b0c3d2e-1f4a-4b5c-8d9e-0a1b2c3d4e5f", revisionId: H }, capabilityId: "service.set_limit", contractVersion: 1,
  resourceId: baseEnv.resourceId, resourceGeneration: 2, limits: { CPUQuotaPerSecUSec: { min: 100000, max: 2000000 } }, paramsHash: null, expiresAtMs: 1793196376387,
};
const sg = c.sealGrant(grantBase);
for (const [name, value, ok] of [["valid", sg, true], ["unknown-field", { ...sg, extra: true }, false], ["tampered-limits", { ...sg, limits: { CPUQuotaPerSecUSec: { min: 0, max: 9000000 } } }, false]]) {
  const ts = c.checkGrantSync(JSON.parse(JSON.stringify(value)));
  if ((ts === null) !== ok) throw new Error(`TS verdict for grant ${name} is ${ts}`);
  vectors.grants.push({ name, text: JSON.stringify(value), ok, requestHash: ok ? sg.requestHash : null });
}

const paramCases = [
  ["file.write_text_atomic", { path: "a/b.txt", content: "x", expectedAbsent: true }],
  ["file.write_text_atomic", { path: "../etc/passwd", content: "x", expectedAbsent: true }],
  ["file.write_text_atomic", { path: "/abs", content: "x", expectedAbsent: true }],
  ["file.write_text_atomic", { path: "a//b", content: "x", expectedAbsent: true }],
  ["file.write_text_atomic", { path: "a\\b", content: "x", expectedAbsent: true }],
  ["file.write_text_atomic", { path: "a/./b", content: "x", expectedAbsent: true }],
  ["file.write_text_atomic", { path: "ok.txt", content: "x" }],
  ["file.write_text_atomic", { path: "ok.txt", content: "x", expectedAbsent: true, expectedVersion: H }],
  ["file.write_text_atomic", { path: "ok.txt", content: "x".repeat(131073), expectedAbsent: true }],
  ["file.read_text", { path: "notes.md" }],
  ["file.read_text", { path: "notes.md", maxBytes: 0 }],
  ["file.list", {}],
  ["file.list", { path: "", limit: 201 }],
  ["service.ensure_state", { state: "running" }],
  ["service.ensure_state", { state: "restart" }],
  ["service.ensure_state", { state: "running", unit: "sshd.service" }],
  ["service.set_limit", { property: "CPUQuotaPerSecUSec", value: 500000 }],
  ["service.set_limit", { property: "ExecStart", value: 1 }],
  ["service.set_limit", { property: "MemoryMax", value: -1 }],
  ["service.set_limit", { property: "MemoryMax", value: 1.5 }],
  ["network.apply_profile", { profileId: "local-deny" }],
  ["network.apply_profile", { profileId: "flush ruleset" }],
  ["network.apply_profile", { profileId: "local-deny", nft: "add rule inet x" }],
  ["serial.exchange", { command: "SAMPLE", count: 3 }],
  ["serial.exchange", { command: "SAMPLE", count: 9 }],
  ["serial.exchange", { command: "ECHO", text: "hello world" }],
  ["serial.exchange", { command: "ECHO", text: "bad;cmd" }],
  ["serial.exchange", { command: "RAW", frame: "AT+X" }],
  ["serial.exchange", { command: "IOCTL", request: 21505 }],
  ["shell.exec", { command: "id" }],
  ["service.describe", {}],
  ["service.describe", { unit: "any.service" }],
];
for (const [cap, input] of paramCases) {
  let res;
  try {
    res = { ok: true, normalized: c.checkProviderParams(cap, input) };
  } catch (e) {
    res = { ok: false, code: e.code };
  }
  vectors.params.push({ capabilityId: cap, input, ...res });
}

for (const d of [8, 9]) {
  let v = 1;
  for (let i = 0; i < d; i++) v = [v];
  vectors.depth.push({ depth: d, text: JSON.stringify({ v }).slice(0, 2000), measured: c.jsonDepth(JSON.stringify({ v })) });
}

const text = `${JSON.stringify(vectors, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (!fs.existsSync(out) || fs.readFileSync(out, "utf8") !== text) {
    console.error("fixtures/v0.3/protocol/vectors.json is out of date (run node scripts/protocol-vectors.mjs)");
    process.exit(1);
  }
  console.log("protocol vectors up to date");
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  console.log(`wrote ${out}`);
}
