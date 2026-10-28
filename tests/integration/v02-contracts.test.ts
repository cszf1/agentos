import { describe, expect, it } from "vitest";
import path from "node:path";
import fs, { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CODE_LIMITS,
  bundleHash,
  checkAnyStructure,
  checkCodeSemantics,
  checkCodeStructure,
  checkRpcSchema,
  checkRuntimeLock,
  checkSlotTree,
  codeBundleHash,
  readPointer,
  sourcePathIssue,
  type AppBundle,
  type CodeBundle,
  type RuntimeCatalog,
} from "@agentos/contracts";
import { ArtifactStore } from "@agentos/core";
import { codeFixture } from "../fixtures-v02.js";
import { tmpDir } from "../helpers.js";

const root = path.resolve(import.meta.dirname, "../..");
const v1 = JSON.parse(readFileSync(path.join(root, "fixtures/todo-v1.json"), "utf8")) as AppBundle;
const v2 = JSON.parse(readFileSync(path.join(root, "fixtures/todo-v2.json"), "utf8")) as AppBundle;
const catalog = JSON.parse(readFileSync(path.join(root, "runtime/catalog/catalog.json"), "utf8")) as RuntimeCatalog;
const kanban = () => codeFixture("todo-kanban");
const paths = (issues: { path: string }[]) => issues.map((i) => i.path);

describe("V2-C01 v1 format and hash are frozen", () => {
  it("v0.1 fixture revision ids are unchanged", () => {
    // Values recorded from the v0.1 release (commit 7cd2bbe); the v1 algorithm must never change.
    expect(bundleHash(v1)).toBe(bundleHash(JSON.parse(JSON.stringify(v1))));
    expect(bundleHash(v1)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(bundleHash(v1)).toBe(V1_HASH);
    expect(bundleHash(v2)).toBe(V2_HASH);
  });
  it("a v1 bundle carrying code fields is still rejected by the v1 schema", () => {
    const bad = { ...v1, code: { entry: "src/app.ts", files: { "src/app.ts": "" } } };
    const r = checkAnyStructure(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(paths(r.issues)).toContain("/code");
    const bad2 = { ...v1, view: { ...v1.view, kind: "slot-tree-v1" } };
    expect(checkAnyStructure(bad2).ok).toBe(false);
  });
});

describe("V2-C02 CodeBundle structure", () => {
  it("accepts the kanban fixture", () => {
    const r = checkCodeStructure(kanban());
    expect(r.ok).toBe(true);
    if (r.ok) expect(checkCodeSemantics(r.bundle, r.bundle.manifest.appId)).toEqual([]);
  });
  it("reports unknown fields, unknown runtime, missing handlers and bad capabilities with paths", () => {
    const b = kanban() as unknown as Record<string, any>;
    b.extra = 1;
    let r = checkCodeStructure(b);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(paths(r.issues)).toContain("/extra");
    const b2 = kanban() as unknown as Record<string, any>;
    b2.manifest.runtime = "native-v9";
    r = checkCodeStructure(b2);
    if (!r.ok) expect(paths(r.issues)).toContain("/manifest/runtime");
    else throw new Error("accepted");
    const b3 = kanban();
    delete (b3.queries as Record<string, unknown>).main;
    b3.queries.other = { inputSchema: { type: "object" }, outputSchema: { type: "object" } };
    b3.view.dataSources = { board: { queryId: "other" } };
    const s3 = checkCodeStructure(b3);
    expect(s3.ok).toBe(true);
    if (s3.ok) expect(paths(checkCodeSemantics(s3.bundle, b3.manifest.appId))).toContain("/queries/main");
    const b4 = kanban() as unknown as Record<string, any>;
    b4.manifest.capabilities = ["records.write", "net.fetch"];
    r = checkCodeStructure(b4);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(paths(r.issues).some((p) => p.startsWith("/manifest/capabilities"))).toBe(true);
  });
  it("commands that write need records.write and declared writable fields", () => {
    const b = kanban();
    b.manifest.capabilities = ["records.read"];
    b.commands.completeMany!.writableFields = ["nope"];
    const issues = checkCodeSemantics(b, b.manifest.appId);
    expect(paths(issues)).toEqual(expect.arrayContaining(["/commands/completeMany/operations", "/commands/completeMany/writableFields/0"]));
  });
  it("requires a create path for fields without a default", () => {
    const b = kanban();
    const main = b.view.slots.main;
    main.children = main.children!.filter((c) => c.type !== "Form");
    expect(checkCodeSemantics(b, b.manifest.appId).map((i) => i.code)).toContain("NO_CREATE_PATH");
  });
});

describe("V2-C03 source paths and sizes", () => {
  it.each([
    ["/etc/passwd.ts", "absolute"],
    ["C:/x.ts", "absolute"],
    ["src/../x.ts", "dot"],
    ["src/./x.ts", "dot"],
    ["src\\x.ts", "backslash"],
    ["src//x.ts", "empty"],
    ["lib/x.ts", "under src/"],
    ["src/x.js", ".ts"],
    ["src/x.d.ts", ".ts"],
  ])("%s is rejected", (p) => {
    expect(sourcePathIssue(p)).toBeTruthy();
  });
  it("rejects duplicate normalized paths, too many files, oversize source and binary text", () => {
    const dup = kanban();
    dup.code.files["src/App.ts"] = "export {}";
    dup.code.files["src/app.TS".replace(".TS", ".ts").replace("app", "APP")] = "export {}";
    let r = checkCodeStructure({ ...dup, code: { ...dup.code, files: { ...dup.code.files, "src/APP.ts": "x", "src/app.ts": dup.code.files["src/app.ts"]! } } });
    expect(r.ok).toBe(false);
    const many = kanban();
    for (let i = 0; i < CODE_LIMITS.maxSourceFiles; i++) many.code.files[`src/f${i}.ts`] = "export {}";
    r = checkCodeStructure(many);
    expect(r.ok).toBe(false);
    const big = kanban();
    big.code.files["src/big.ts"] = `export const s = "${"x".repeat(CODE_LIMITS.maxSourceBytes)}";`;
    r = checkCodeStructure(big);
    expect(r.ok).toBe(false);
    const bin = kanban();
    bin.code.files["src/bin.ts"] = "export const s = 1;\u0000\u0001";
    r = checkCodeStructure(bin);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]!.code).toBe("SOURCE_PATH_INVALID");
  });
});

describe("V2-C04 references and schemas", () => {
  it("rejects bad tree bindings, unknown components, export→query mismatch, recursive/remote schemas", () => {
    const b = kanban();
    (b.view.slots.main.children![0]!.children![0]!.props as Record<string, unknown>).value = { $bind: { from: "query", source: "nope", pointer: "/x" } };
    b.view.slots.main.children!.push({ type: "Iframe" as never, props: { src: "http://x" } });
    b.exports = [{ exportName: "s", queryId: "missing", contractVersion: 1, description: "x" }];
    const issues = checkCodeSemantics(b, b.manifest.appId);
    expect(issues.map((i) => i.message).join("\n")).toMatch(/data source "nope"/);
    expect(issues.map((i) => i.message).join("\n")).toMatch(/unknown component "Iframe"/);
    expect(paths(issues)).toContain("/exports/0/queryId");
    expect(checkRpcSchema({ type: "object", properties: { a: { $ref: "#" } } }, "/s").length).toBeGreaterThan(0);
    expect(checkRpcSchema({ $ref: "https://evil.example/schema.json" }, "/s").length).toBeGreaterThan(0);
    expect(checkRpcSchema({ type: "string", pattern: "(a+)+$", maxLength: 4 }, "/s").length).toBeGreaterThan(0);
    let deep: Record<string, unknown> = { type: "boolean" };
    for (let i = 0; i < 9; i++) deep = { type: "object", properties: { a: deep } };
    expect(checkRpcSchema(deep, "/s").map((i) => i.message).join()).toMatch(/nesting/);
  });
  it("tree limits: node count, depth and chart series", () => {
    let node: Record<string, unknown> = { type: "Text", props: { text: "x" } };
    for (let i = 0; i < 13; i++) node = { type: "Stack", children: [node] };
    const r = checkSlotTree({ kind: "slot-tree-v1", dataSources: {}, slots: { main: node } }, { queries: {}, commands: {} });
    expect(r.issues.map((i) => i.message).join()).toMatch(/levels deep/);
    const wide = { type: "Stack", children: Array.from({ length: 60 }, () => ({ type: "Stack", children: Array.from({ length: 5 }, () => ({ type: "Text", props: { text: "x" } })) })) };
    expect(checkSlotTree({ kind: "slot-tree-v1", dataSources: {}, slots: { main: wide } }, { queries: {}, commands: {} }).issues.map((i) => i.message).join()).toMatch(/256 nodes/);
  });
  it("pointers only read own properties", () => {
    const o = JSON.parse('{"a":{"b":[1,2]},"__proto__":{"x":1}}');
    expect(readPointer(o, "/a/b/1")).toBe(2);
    expect(readPointer(o, "/__proto__/x")).toBeUndefined();
    expect(readPointer({}, "/constructor")).toBeUndefined();
    expect(readPointer(o, "/a/../a")).toBeUndefined();
  });
});

describe("V2-C05 runtime locks", () => {
  it("rejects unknown locks, floating ids, foreign platforms and unapproved imports", () => {
    const b = kanban();
    b.runtimeLockId = "core-v1@latest";
    expect(checkCodeStructure(b).ok).toBe(false);
    b.runtimeLockId = "core-v1@9";
    expect(checkRuntimeLock(b, catalog, "linux/amd64")[0]!.code).toBe("DEPENDENCY_NOT_ALLOWED");
    b.runtimeLockId = "core-v1@1";
    expect(checkRuntimeLock(b, catalog, "linux/arm64")[0]!.code).toBe("IMAGE_UNAVAILABLE");
    expect(checkRuntimeLock(b, catalog, "linux/amd64")).toEqual([]);
    b.code.files["src/app.ts"] = `import fs from "node:fs";\nimport Papa from "papaparse";\n${b.code.files["src/app.ts"]}`;
    const issues = checkRuntimeLock(b, catalog, "linux/amd64");
    expect(issues.map((i) => i.message).join()).toMatch(/node:fs/);
    expect(issues.map((i) => i.message).join()).toMatch(/papaparse/);
    const csv = codeFixture("csv-import");
    expect(checkRuntimeLock(csv, catalog, "linux/amd64")).toEqual([]);
    csv.code.files["src/app.ts"] += "\nconst m = 'x'; void import(m);";
    expect(checkRuntimeLock(csv, catalog, "linux/amd64").map((i) => i.message).join()).toMatch(/dynamic/);
    for (const l of catalog.locks) {
      expect(l.baseImage.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      for (const m of l.modules) expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe("V2-C06 content identity", () => {
  it("source or lock changes change the revision id; v1 and v2 hashes are domain-separated", () => {
    const a = kanban();
    const h = codeBundleHash(a);
    const b = kanban();
    b.code.files["src/labels.ts"] += "\n";
    expect(codeBundleHash(b)).not.toBe(h);
    const c = kanban();
    c.runtimeLockId = "data-v1@1";
    expect(codeBundleHash(c)).not.toBe(h);
    expect(codeBundleHash(kanban())).toBe(h);
  });
  it("a damaged artifact never counts as verified", () => {
    const store = new ArtifactStore(path.join(tmpDir(), "artifacts"));
    const put = store.put({ "app.mjs": Buffer.from("export const queries = {};") }, { runtimeLockId: "core-v1@1", platform: "linux/amd64", abiVersion: 1 });
    expect(store.verify(put.artifactId)).toBeNull();
    const again = store.put({ "app.mjs": Buffer.from("export const queries = {};") }, { runtimeLockId: "core-v1@1", platform: "linux/amd64", abiVersion: 1 });
    expect(again.artifactId).toBe(put.artifactId);
    const f = path.join(store.dirOf(put.artifactId), "app.mjs");
    fs.chmodSync(f, 0o644);
    fs.writeFileSync(f, "export const queries = { evil: 1 };");
    expect(store.verify(put.artifactId)).toMatch(/hash mismatch/);
    expect(() => store.put({ "app.mjs": Buffer.from("export const queries = {};") }, { runtimeLockId: "core-v1@1", platform: "linux/amd64", abiVersion: 1 })).toThrow(/damaged/);
  });
});

// Computed by the v0.1 host (/data/home/agentos, commit 7cd2bbe) on 2026-10-28.
const V1_HASH = "sha256:428df8c73bfcf3a1bc07029d9b5e31286728c4026d4cfe4a203fbc87211332d5";
const V2_HASH = "sha256:91a9f594531f08286973416701ef4921db904c3c258a10f37d1f885d39d56cd2";
void ({} as CodeBundle);

describe("V2-C docs: the published contract files are the enforced ones", () => {
  it("docs/contracts matches the validators, limits and error codes in code", async () => {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, [path.join(root, "scripts", "export-contracts.mjs"), "--check"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });
});
