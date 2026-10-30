#!/usr/bin/env node
// Generates fixtures/v1.0/slot-vectors/*.json from the TS contracts (packages/contracts/dist, build with
// `tsc -p packages/contracts` first). The native Shell's ctest (desktop/tests/slot_vectors.cpp) replays every vector
// through the C++ renderer and compares semantics: validation verdicts, binding resolution / render snapshots,
// the request each click produces (route, body, idempotency-key reuse), field checks and error handling.
//   node scripts/slot-vectors.mjs          write the vectors (and desktop/renderer/*.json embedded copies)
//   node scripts/slot-vectors.mjs --check  fail if anything on disk differs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = process.env.AGENTOS_CONTRACTS_DIST ?? join(root, "packages/contracts/dist");
const ui = await import(join(dist, "v2/ui.js"));
const sv = await import(join(dist, "v1_0/slot-vectors.js"));
const rec = await import(join(dist, "v1_0/slot-vectors-records.js"));
const sh = await import(join(dist, "v1_0/slot-vectors-shell.js"));
const bundleMod = await import(join(dist, "bundle.js"));
const check = process.argv.includes("--check");
const outDir = join(root, "fixtures/v1.0/slot-vectors");
const json = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));
let drift = 0;
function emit(rel, value) {
  const text = JSON.stringify(value, null, 1) + "\n";
  const p = join(root, rel);
  if (check) {
    if (!existsSync(p) || readFileSync(p, "utf8") !== text) {
      console.error(`differs: ${rel}`);
      drift++;
    }
    return;
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
/** undefined -> {"$missing":true} everywhere (vector JSON keeps missing and null apart). */
function enc(v) {
  if (v === undefined) return { $missing: true };
  if (Array.isArray(v)) return v.map(enc);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]));
  return v;
}

// ------------------------------------------------------------------ embedded copies
const schemas = { v1: ui.slotTreeSchemaDocument(1), v2: ui.slotTreeSchemaDocument(2) };
emit("fixtures/v1.0/slot-vectors/schemas.json", schemas);
emit("desktop/renderer/slot-schemas.json", schemas);
const nrpc = await import(join(dist, "v1_0/native-rpc.js"));
const fwd = await import(join(dist, "v1_0/forward-routes.js"));
const routes = { forward: fwd.FORWARD_ROUTES, native: nrpc.NATIVE_ROUTES, writeRoutes: [...nrpc.WRITE_ROUTES].sort(), version: nrpc.NATIVE_RPC_VERSION };
emit("fixtures/v1.0/slot-vectors/routes.json", routes);
emit("desktop/renderer/routes.json", routes);
const policy = { errorText: sv.ERROR_TEXT, invocationText: sv.INVOCATION_TEXT, networkText: sv.NETWORK_ERROR_TEXT, policy: sv.ERROR_POLICY, defaultPolicy: sv.DEFAULT_ERROR_POLICY, hardwareActions: sh.HARDWARE_ACTIONS, displayRevertSeconds: sh.DISPLAY_REVERT_SECONDS, finalStates: sh.FINAL_STATES };
emit("fixtures/v1.0/slot-vectors/error-policy.json", policy);
emit("desktop/renderer/error-policy.json", policy);

// ------------------------------------------------------------------ fixtures
const B = {
  csv: json("fixtures/v0.2/csv-import/bundle.json"),
  fault: json("fixtures/v0.2/fault-lab/bundle.json"),
  kanban: json("fixtures/v0.2/todo-kanban/bundle.json"),
  hours: json("fixtures/v0.2/todo-kanban-hours/bundle.json"),
  overview: json("fixtures/v0.2/work-overview/bundle.json"),
  console: json("fixtures/v0.3/system-console/bundle.json"),
};
const APP = (b, epoch = 3, rev = "sha256:" + "a".repeat(64)) => ({ appId: b.manifest.appId, appEpoch: epoch, revisionId: rev });

/** A v3 bundle that exercises every component, slot, binding kind and visibleWhen form (V1-D03). */
function coverageBundle() {
  const b = clone(B.console);
  b.manifest = { ...b.manifest, appId: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b", title: "组件全集" };
  b.queries = { main: b.queries.main, items: b.queries.main, chart: b.queries.main };
  b.commands = { add: { description: "add", inputSchema: { type: "object" }, mutations: ["create"] }, done: { description: "done", inputSchema: { type: "object" }, mutations: ["update"] }, purge: { description: "purge", inputSchema: { type: "object" }, mutations: ["delete"] } };
  const q = (source, pointer) => ({ $bind: { from: "query", source, pointer } });
  b.view = {
    kind: "slot-tree-v2",
    dataSources: { main: { queryId: "main", input: {} }, items: { queryId: "items", input: { limit: 50 } }, chart: { queryId: "chart" } },
    refresh: { intervalSeconds: 30 },
    slots: {
      toolbar: { type: "Stack", props: { direction: "horizontal", gap: "sm" }, children: [
        { type: "Button", props: { label: "全部完成", command: "done", variant: "primary", input: { selection: { selectionId: "rows", as: "ids" } } } },
        { type: "Button", props: { label: "清空", command: "purge", variant: "danger", confirm: "确定清空？", input: { constant: { all: true } } } },
      ] },
      main: { type: "Tabs", props: { labels: ["概览", "表格", "列表"] }, children: [
        { type: "Stack", children: [
          { type: "Text", props: { text: q("main", "/title"), variant: "title" } },
          { type: "Text", props: { text: "固定说明", variant: "muted" } },
          { type: "Alert", props: { status: "error", text: q("main", "/error") }, visibleWhen: { value: q("main", "/error"), op: "exists" } },
          { type: "Alert", props: { status: "info", text: "空值不同于缺失" }, visibleWhen: { value: q("main", "/nullish"), op: "eq", equals: null } },
          { type: "Grid", props: { columns: 3, gap: "lg" }, children: [
            { type: "Metric", props: { label: "数字", value: q("main", "/n"), unit: "个" } },
            { type: "Metric", props: { label: "对象", value: q("main", "/obj") } },
            { type: "Metric", props: { label: "常量", value: 42 } },
            { type: "Metric", props: { label: "表单回显", value: { $bind: { from: "form", formId: "f", pointer: "/title" } } } },
            { type: "Metric", props: { label: "所选", value: { $bind: { from: "selection", selectionId: "rows" } } } },
          ] },
          { type: "BarChart", props: { title: "柱状", data: q("chart", "/rows"), xPointer: "/x", series: [{ pointer: "/a", label: "A" }, { pointer: "/b", label: "B" }] } },
          { type: "LineChart", props: { data: q("chart", "/rows"), xPointer: "/x", series: [{ pointer: "/a", label: "A" }] } },
          { type: "Kanban", props: { items: q("items", "/items"), groupPointer: "/state", groups: [{ value: "open", label: "进行中" }, { value: "done", label: "完成" }, { value: 1, label: "数字组" }], cardTitlePointer: "/title", cardFields: [{ pointer: "/owner", label: "负责人" }], rowId: "/id", selectionId: "cards" } },
        ] },
        { type: "Stack", children: [
          { type: "Table", props: { items: q("items", "/items"), columns: [{ pointer: "/title", label: "标题" }, { pointer: "/n", label: "数量" }, { pointer: "/meta", label: "元数据" }], rowId: "/id", pageSize: 3, selectionId: "rows", emptyText: "无" } },
          { type: "Table", props: { items: q("items", "/none"), columns: [{ pointer: "/title", label: "标题" }] } },
          { type: "Form", props: { formId: "f", title: "新建" }, children: [
            { type: "TextInput", props: { name: "title", label: "标题", required: true, maxLength: 5, placeholder: "≤5 字" } },
            { type: "TextInput", props: { name: "count", label: "数量", mode: "integer", minimum: 1, maximum: 10 } },
            { type: "TextArea", props: { name: "note", label: "备注", maxLength: 8 } },
            { type: "Select", props: { name: "kind", label: "类别", required: true, options: [{ value: "a", label: "甲" }, { value: "b", label: "乙" }] } },
            { type: "Select", props: { name: "opt", label: "可选", options: [{ value: "x", label: "X" }] } },
            { type: "Checkbox", props: { name: "urgent", label: "紧急" } },
            { type: "Button", props: { label: "添加", command: "add", input: { form: "f", constant: { source: "native" } } } },
            { type: "SystemActionButton", props: { label: "计划 CPU", action: "setCpu", input: { form: "f" } } },
          ] },
        ] },
        { type: "List", props: { items: q("items", "/items"), rowId: "/id", maxItems: 5, gap: "sm", emptyText: "列表为空" }, children: [
          { type: "Text", props: { text: { $bind: { from: "item", pointer: "/title" } } } },
          { type: "Text", props: { text: "过期" }, visibleWhen: { value: { $bind: { from: "item", pointer: "/late" } }, op: "eq", equals: true } },
          { type: "Button", props: { label: "完成此项", command: "done", input: { item: { pointer: "/id", as: "id" }, constant: { one: true } } } },
          { type: "SystemActionButton", props: { label: "写报告", action: "writeReport", input: { item: { pointer: "/title", as: "name" } } } },
        ] },
      ] },
      aside: { type: "List", props: { items: q("main", "/missing"), emptyText: "" }, children: [{ type: "Text", props: { text: "x" } }] },
    },
  };
  return b;
}
const COV = coverageBundle();
const covItems = [
  { id: "r1", title: "第一", n: 1, state: "open", owner: "甲", meta: { a: [1, null] }, late: true },
  { id: "r2", title: "第二", n: 2.5, state: "done", owner: "乙" },
  { id: "r3", title: "<b>粗体</b>", n: -0.000001, state: 1 },
  { id: 4, title: "数字 id", n: 1e21, state: "open", late: false },
  { title: "无 id", state: "open" },
  { id: "r1", title: "重复 id", state: "done" },
];

// ------------------------------------------------------------------ validation vectors
function ctxOf(b) {
  const v3 = b.formatVersion === 3;
  return { queries: b.queries, commands: b.commands, systemActions: v3 ? b.system.actions : undefined, viewKind: v3 ? "slot-tree-v2" : "slot-tree-v1" };
}
function normIssues(issues) {
  return issues.map((i) => ({ path: /^[A-Za-z]+: /.test(i.message) && i.path.includes("/props") ? i.path.replace(/\/props(\/.*)?$/, "/props") : i.path, code: i.code }));
}
const validation = [];
function vcase(name, b, view = b.view) {
  const { issues } = ui.checkSlotTree(view, ctxOf(b));
  validation.push({ name, ctx: { queries: Object.keys(b.queries), commands: Object.keys(b.commands), systemActions: b.formatVersion === 3 ? Object.keys(b.system.actions) : null, viewKind: ctxOf(b).viewKind }, view, valid: issues.length === 0, issues: normIssues(issues) });
}
for (const [k, b] of Object.entries(B)) vcase(`fixture:${k}`, b);
vcase("coverage", COV);
const mut = (name, base, f) => {
  const b = clone(base);
  f(b.view, b);
  vcase(name, b);
};
// injection and reserved names
mut("inject:qml-type", B.kanban, (v) => { v.slots.main.children[0].type = "Qt.createQmlObject"; });
mut("inject:url-type", B.kanban, (v) => { v.slots.main.children[0].type = "qrc:/evil.qml"; });
mut("inject:extra-prop-onClicked", B.csv, (v) => { v.slots.main.children[0].props.onClicked = "Qt.quit()"; });
mut("inject:html-in-label-ok", B.csv, (v) => { v.slots.main.children[0].props.columns[0].label = "<img src=x onerror=alert(1)>"; });
mut("inject:text-too-long", B.fault, (v) => { v.slots.main.props.text = "x".repeat(1025); });
mut("inject:text-1024-codepoints-ok", B.fault, (v) => { v.slots.main.props.text = "😀".repeat(1024); });
mut("inject:bind-expression", B.fault, (v) => { v.slots.main.props.text = { $bind: { from: "query", source: "m", pointer: "/a; Qt.quit()" } }; });
mut("inject:bind-extra-key", B.fault, (v) => { v.slots.main.props.text = { $bind: { from: "query", source: "m", pointer: "/a", expr: "1+1" } }; });
mut("inject:bind-unknown-from", B.fault, (v) => { v.slots.main.props.text = { $bind: { from: "eval", source: "m", pointer: "/a" } }; });
mut("pointer:tilde-escape", B.fault, (v) => { v.slots.main.props.text = { $bind: { from: "query", source: "m", pointer: "/a~1b" } }; });
mut("pointer:dotdot", B.fault, (v) => { v.slots.main.props.text = { $bind: { from: "query", source: "m", pointer: "/../etc" } }; });
mut("pointer:too-deep", B.fault, (v) => { v.slots.main.props.text = { $bind: { from: "query", source: "m", pointer: "/a/b/c/d/e/f/g/h/i" } }; });
mut("pointer:proto-allowed-syntax", B.fault, (v) => { v.slots.main.props.text = { $bind: { from: "query", source: "m", pointer: "/__proto__/x" } }; });
mut("pointer:empty-root", B.fault, (v) => { v.slots.main.props.text = { $bind: { from: "query", source: "m", pointer: "" } }; });
mut("reserved:datasource-constructor", B.fault, (v) => { v.dataSources.constructor = { queryId: "main" }; });
mut("reserved:node-field", B.fault, (v) => { v.slots.main.__proto_x = 1; });
mut("reserved:unknown-slot", B.fault, (v) => { v.slots.overlay = { type: "Text", props: { text: "系统已批准" } }; });
mut("reserved:view-field", B.fault, (v) => { v.css = "body{}"; });
mut("unknown:datasource-query", B.fault, (v) => { v.dataSources.m.queryId = "nope"; });
mut("unknown:command", B.csv, (v) => { v.slots.main.children[1].children[1].props.command = "rm"; });
mut("unknown:undeclared-source", B.fault, (v) => { v.slots.main.props.text = { $bind: { from: "query", source: "zz", pointer: "/a" } }; });
mut("unknown:item-outside-list", B.fault, (v) => { v.slots.main.props.text = { $bind: { from: "item", pointer: "/a" } }; });
mut("v1:list-not-allowed", B.fault, (v) => { v.slots.main = { type: "List", props: { items: { $bind: { from: "query", source: "m", pointer: "/a" } } }, children: [{ type: "Text", props: { text: "x" } }] }; });
mut("v1:system-action-not-allowed", B.fault, (v) => { v.slots.main = { type: "SystemActionButton", props: { label: "x", action: "a" } }; });
mut("refresh:too-fast", B.overview, (v) => { v.refresh.intervalSeconds = 4; });
mut("refresh:too-slow", B.overview, (v) => { v.refresh.intervalSeconds = 3601; });
mut("refresh:float", B.overview, (v) => { v.refresh.intervalSeconds = 10.5; });
mut("refresh:extra", B.overview, (v) => { v.refresh.jitter = 1; });
mut("props:null-is-empty", B.fault, (v) => { v.slots.main = { type: "Stack", props: null }; });
mut("children:on-leaf", B.fault, (v) => { v.slots.main.children = []; });
mut("children:not-array", B.fault, (v) => { v.slots.main = { type: "Stack", children: {} }; });
mut("tabs:count-mismatch", B.fault, (v) => { v.slots.main = { type: "Tabs", props: { labels: ["a", "b"] }, children: [{ type: "Text", props: { text: "x" } }] }; });
mut("grid:columns-5", B.fault, (v) => { v.slots.main = { type: "Grid", props: { columns: 5 } }; });
mut("visibleWhen:bad-op", B.overview, (v) => { v.slots.main.children[0].visibleWhen.op = "neq"; });
mut("visibleWhen:object-equals", B.overview, (v) => { v.slots.main.children[0].visibleWhen.equals = { a: 1 }; });
mut("input:outside-form", B.fault, (v) => { v.slots.main = { type: "TextInput", props: { name: "a", label: "A" } }; });
mut("form:nested", B.csv, (v) => { v.slots.main.children[1].children.push({ type: "Form", props: { formId: "inner" } }); });
mut("form:duplicate", B.csv, (v) => { v.slots.main.children[2].props.formId = "add"; });
mut("selection:undeclared", B.kanban, (v) => { v.slots.toolbar.children[0].props.input.selection.selectionId = "nope"; });
mut("constant:binding-inside", B.csv, (v) => { v.slots.main.children[1].children[1].props.input.constant = { x: { $bind: { from: "query", source: "nope", pointer: "/a" } } }; });
mut("chart:9-series", B.hours, (v) => { v.slots.main.children[1].props.series = Array.from({ length: 9 }, (_, i) => ({ pointer: `/s${i}`, label: `S${i}` })); });
mut("chart:8-series-ok", B.hours, (v) => { v.slots.main.children[1].props.series = Array.from({ length: 8 }, (_, i) => ({ pointer: `/s${i}`, label: `S${i}` })); });
// size limits
const leaf = { type: "Text", props: { text: "x" } };
mut("limit:65-children", B.fault, (v) => { v.slots.main = { type: "Stack", children: Array.from({ length: 65 }, () => clone(leaf)) }; });
mut("limit:64-children-ok", B.fault, (v) => { v.slots.main = { type: "Stack", children: Array.from({ length: 64 }, () => clone(leaf)) }; });
mut("limit:257-nodes", B.fault, (v) => { v.slots.main = { type: "Stack", children: Array.from({ length: 4 }, () => ({ type: "Stack", children: Array.from({ length: 62 }, () => clone(leaf)) })) }; v.slots.aside = { type: "Stack", children: [clone(leaf), clone(leaf), clone(leaf)] }; });
mut("limit:256-nodes-ok", B.fault, (v) => { v.slots.main = { type: "Stack", children: Array.from({ length: 4 }, () => ({ type: "Stack", children: Array.from({ length: 62 }, () => clone(leaf)) })) }; v.slots.aside = { type: "Stack", children: [clone(leaf), clone(leaf)] }; });
const deep = (n) => (n === 1 ? clone(leaf) : { type: "Stack", children: [deep(n - 1)] });
mut("limit:depth-13", B.fault, (v) => { v.slots.main = deep(13); });
mut("limit:depth-12-ok", B.fault, (v) => { v.slots.main = deep(12); });
mut("limit:9-datasources", B.fault, (v) => { for (let i = 0; i < 8; i++) v.dataSources[`d${i}`] = { queryId: "main" }; });
mut("limit:8-datasources-ok", B.fault, (v) => { for (let i = 0; i < 7; i++) v.dataSources[`d${i}`] = { queryId: "main" }; });
{
  const listOf = (template) => ({ type: "List", props: { items: { $bind: { from: "query", source: "main", pointer: "/a" } }, maxItems: 100 }, children: template });
  mut("list:25-template-nodes", COV, (v) => { v.slots.aside = listOf([{ type: "Stack", children: Array.from({ length: 24 }, () => clone(leaf)) }]); });
  mut("list:24-template-nodes-ok", COV, (v) => { v.slots.aside = listOf([{ type: "Stack", children: Array.from({ length: 23 }, () => clone(leaf)) }]); });
  mut("list:nested", COV, (v) => { v.slots.aside = listOf([listOf([clone(leaf)])]); });
  mut("list:form-inside", COV, (v) => { v.slots.aside = listOf([{ type: "Form", props: { formId: "x" } }]); });
  mut("list:selection-inside", COV, (v) => { v.slots.aside = listOf([{ type: "Table", props: { items: { $bind: { from: "item", pointer: "/a" } }, columns: [{ pointer: "/a", label: "a" }], selectionId: "inner" } }]); });
  mut("list:empty-template", COV, (v) => { v.slots.aside = listOf([]); });
  mut("list:max-101", COV, (v) => { v.slots.aside = listOf([clone(leaf)]); v.slots.aside.props.maxItems = 101; });
  // 10 lists x 24-node templates x 100 items = 24000 potential instances: VALID (the 4096 live budget is local only)
  mut("list:many-instances-valid", COV, (v) => {
    v.slots.main = { type: "Stack", children: Array.from({ length: 10 }, () => listOf([{ type: "Stack", children: Array.from({ length: 23 }, () => clone(leaf)) }])) };
    v.slots.toolbar = { type: "Text", props: { text: "big" } };
    delete v.slots.aside;
  });
}
emit("fixtures/v1.0/slot-vectors/validation.json", { generatedBy: "scripts/slot-vectors.mjs", cases: validation });

// ------------------------------------------------------------------ pointer / text vectors
const ptrData = { a: { b: [10, { c: "x" }], "x-y": null, __proto__x: 1 }, list: [0, 1, 2], n: 0, s: "", t: true };
Object.defineProperty(ptrData.a, "constructor", { value: "own-constructor", enumerable: true });
const ptrs = ["", "/a", "/a/b", "/a/b/0", "/a/b/1/c", "/a/b/2", "/a/b/01", "/a/b/-1", "/a/x-y", "/a/missing", "/list/2", "/list/1000000", "/n", "/s", "/t", "/t/x", "/a/constructor", "/a/__proto__", "/a/prototype", "/a/b/1/c/d", "/a b", "a", "/a/", "/a/~0", "/" + "x".repeat(65), "/1/2/3/4/5/6/7/8", "/1/2/3/4/5/6/7/8/9"];
const pointers = ptrs.map((p) => ({ pointer: p, result: enc(ui.readPointer(ptrData, p)) }));
const texts = [0, -0, 1, -1.5, 0.1, 1e21, 1e-7, 123456789012345680000, 1.5e300, 2 ** 53, 0.000001, 100, 1 / 3, true, false, null, "s", [1, "a", null], { b: 1, a: [true] }, { nested: { "k\"": "v\n" } }, "😀", "\u0001"].map((v) => ({ value: v, text: sv.asText(v) }));
texts.push({ value: { $missing: true }, text: sv.asText(undefined), missing: true });
const raws = ["", " ", "12", " 7 ", "+5", "-0", "1.5", "1e3", "0x10", "0b11", "0o7", ".5", "5.", "Infinity", "-Infinity", "NaN", "1_000", "12abc", "９", "9007199254740993", "-9007199254740991", "\u00a012\u3000", "1e400", "00012"];
const numbers = raws.map((raw) => {
  const n = Number(raw);
  const stored = raw.trim() === "" ? undefined : Number.isSafeInteger(n) ? n : raw;
  return { raw, stored: enc(stored), display: stored === undefined || stored === null ? "" : String(stored) };
});
const lengths = ["", "abc", "中文字", "😀😀", "a\u0301", "\ud800"].map((s) => ({ s, codePoints: bundleMod.codePoints(s) }));
emit("fixtures/v1.0/slot-vectors/values.json", { pointerData: ptrData, pointers, texts, numbers, lengths });

// ------------------------------------------------------------------ scenario vectors
function scenario(name, bundle, app, build) {
  const s = new sv.SlotSession(clone(bundle), app);
  const steps = [];
  const snap = () => ({ snapshot: enc(s.render()), forms: s.formsSnapshot(), selections: clone(s.selections), notice: s.notice, busy: s.busy, staleInput: s.staleInput });
  const api = {
    s,
    step(op, args, fn) {
      let result;
      let error = null;
      try {
        result = fn();
      } catch (e) {
        error = String(e.message ?? e);
      }
      steps.push({ op, ...args, expect: { result: enc(result ?? null), error, ...snap() } });
    },
    load: (source, output, extra = {}) => api.step("load", { source, output: enc(output), revisionId: extra.revisionId ?? s.app.revisionId, appEpoch: extra.appEpoch ?? s.app.appEpoch }, () => s.applyQuery(source, { output, revisionId: extra.revisionId ?? s.app.revisionId, appEpoch: extra.appEpoch ?? s.app.appEpoch })),
    type: (formId, name, raw) => api.step("type", { formId, name, raw }, () => s.typeText(formId, name, raw)),
    choose: (formId, name, value) => api.step("choose", { formId, name, value }, () => s.choose(formId, name, value)),
    check: (formId, name, on) => api.step("check", { formId, name, on }, () => s.check(formId, name, on)),
    toggle: (selectionId, id, on) => api.step("toggle", { selectionId, id, on }, () => s.toggle(selectionId, id, on)),
    page: (path, page) => api.step("page", { path, page }, () => s.setPage(path, page)),
    tab: (path, index) => api.step("tab", { path, index }, () => s.setTab(path, index)),
    click: (path) => api.step("click", { path }, () => s.click(path)),
    confirm: (accept) => api.step("confirm", { accept }, () => s.confirm(accept)),
    respond: (outcome) => api.step("respond", { outcome }, () => s.respond(outcome)),
    switchRevision: (b, a) => api.step("switchRevision", { bundle: b, app: a }, () => s.switchRevision(clone(b), a)),
    confirmNewVersion: () => api.step("confirmNewVersion", {}, () => s.confirmNewVersion()),
    clearScope: () => api.step("clearScope", {}, () => s.clearScope()),
    queries: () => api.step("queries", {}, () => s.queryRequests()),
  };
  steps.push({ op: "init", expect: { result: null, error: null, ...snap() } });
  build(api);
  return { name, bundle, app, validation: { valid: s.validate().length === 0 }, steps };
}
const scenarios = [];
const M = "/view/slots/main";
// v2 kanban: selection, batch command, form with integer + select, key reuse after network failure
scenarios.push(scenario("v2-kanban-hours", B.hours, APP(B.hours), (t) => {
  t.queries();
  t.load("board", { open: 2, totalMinutes: 90, remainingMinutes: 60, byPriority: { high: 1, normal: 1, low: 0 }, chart: [{ priority: "高", open: 1, minutes: 30 }, { priority: "普通", open: 1, minutes: 30.5 }, { priority: "低", open: 0, minutes: null }], items: [{ id: "a", title: "写报告", done: false, priorityLabel: "高", estimate_minutes: 30 }, { id: "b", title: "整理", done: true, priorityLabel: "普通" }, { id: "c", title: "回邮件", done: false, priorityLabel: "低", estimate_minutes: 0 }] });
  t.load("board", { open: 999 }, { revisionId: "sha256:" + "b".repeat(64) });
  t.load("board", { open: 999 }, { appEpoch: 2 });
  t.click("/view/slots/toolbar/children/0");
  t.toggle("picked", "a", true);
  t.toggle("picked", "c", true);
  t.toggle("picked", "a", false);
  t.toggle("picked", "a", true);
  t.click("/view/slots/toolbar/children/0");
  t.click("/view/slots/toolbar/children/0");
  t.respond({ network: true });
  t.click("/view/slots/toolbar/children/0");
  t.respond({ invocation: "succeeded", commitCount: 2 });
  t.click(`${M}/children/3/children/3`);
  t.type("newTask", "title", "新任务");
  t.type("newTask", "estimate_minutes", "abc");
  t.click(`${M}/children/3/children/3`);
  t.type("newTask", "estimate_minutes", " 45 ");
  t.type("newTask", "estimate_minutes", "-1");
  t.click(`${M}/children/3/children/3`);
  t.type("newTask", "estimate_minutes", "100001");
  t.click(`${M}/children/3/children/3`);
  t.type("newTask", "estimate_minutes", "");
  t.choose("newTask", "priority", "high");
  t.choose("newTask", "priority", "");
  t.choose("newTask", "priority", "low");
  t.type("newTask", "estimate_minutes", "15");
  t.click(`${M}/children/3/children/3`);
  t.respond({ invocation: "failed", code: "DATA_EPOCH_STALE" });
  t.click(`${M}/children/3/children/3`);
  t.respond({ apiError: "NOT_FOUND_OR_FORBIDDEN", message: "x" });
  t.click(`${M}/children/3/children/3`);
  t.respond({ apiError: "EFFECT_UNKNOWN", message: "x" });
  t.click(`${M}/children/3/children/3`);
  t.respond({ invocation: "running" });
  t.type("estimate", "minutes", "20");
  t.click(`${M}/children/4/children/1`);
  t.toggle("picked", "b", true);
  t.click(`${M}/children/4/children/1`);
  t.respond({ apiError: "MEMBERSHIP_REVOKED", message: "revoked" });
}));
scenarios.push(scenario("v2-kanban", B.kanban, APP(B.kanban), (t) => {
  t.load("board", { open: 1, byPriority: { high: 1 }, items: [{ id: "a", title: "甲", done: false, priorityLabel: "高" }, { id: "b", title: "乙", done: "false" }] });
  t.type("newTask", "title", "😀".repeat(200));
  t.click(`${M}/children/2/children/2`);
  t.type("newTask", "title", "😀".repeat(201));
  t.click(`${M}/children/2/children/2`);
  t.type("newTask", "title", "");
  t.click(`${M}/children/2/children/2`);
}));
// v2 cross-app read service (work-overview reads the todo app through a granted service)
scenarios.push(scenario("v2-cross-app-overview", B.overview, APP(B.overview), (t) => {
  t.queries();
  t.load("overview", { connected: false, message: "服务未连接：请在服务面板授权", total: null });
  t.load("overview", { connected: true, total: 5, remainingMinutes: 120 });
  t.load("overview", { total: 5 });
}));
scenarios.push(scenario("v2-csv-table", B.csv, APP(B.csv), (t) => {
  t.load("list", { items: Array.from({ length: 45 }, (_, i) => ({ id: `t${i}`, title: `任务 ${i}`, due: i % 2 ? null : "2026-11-01", priority: i })) });
  t.page(`${M}/children/0`, 2);
  t.page(`${M}/children/0`, 9);
  t.type("csv", "csv", "a,b\n1,2");
  t.click(`${M}/children/2/children/1`);
  t.respond({ invocation: "succeeded", commitCount: 1 });
  t.load("list", { items: [] });
}));
scenarios.push(scenario("v2-fault-text", B.fault, APP(B.fault), (t) => {
  t.load("m", { detail: "<script>alert(1)</script> import QtQuick; Qt.quit() file:///etc/passwd https://x.example" });
  t.load("m", { detail: { html: "<b>x</b>" } });
  t.load("m", { detail: null });
}));
// v3 system actions and the full component coverage bundle
scenarios.push(scenario("v3-system-console", B.console, APP(B.console), (t) => {
  t.load("main", { svc: "demo.service", cpu: "50%", memory: "256 MiB", exports: 3, lab: "deny", serial: null, observedAt: "2026-10-30T10:00:00Z" });
  t.load("tele", { usage: "cpu 2%", telemetry: "ok" });
  t.click(`${M}/children/4/children/1`);
  t.type("cpu", "percent", "300");
  t.click(`${M}/children/4/children/1`);
  t.type("cpu", "percent", "80");
  t.click(`${M}/children/4/children/1`);
  t.respond({ network: true });
  t.click(`${M}/children/4/children/1`);
  t.respond({ plan: "confirmationRequired", actionId: "act-1" });
  t.click(`${M}/children/5/children/2`);
  t.respond({ plan: "standing", actionId: "act-2" });
  t.click(`${M}/children/5/children/3`);
  t.respond({ apiError: "BROKER_UNAVAILABLE", message: "broker down" });
}));
scenarios.push(scenario("v3-coverage", COV, APP(COV), (t) => {
  t.queries();
  t.load("main", { title: "标题 <i>不是富文本</i>", n: 7, obj: { b: 1, a: "x" }, nullish: null });
  t.load("items", { items: covItems });
  t.load("chart", { rows: [{ x: "一", a: 1, b: 2 }, { x: 2, a: "3", b: -1 }, { a: 5 }] });
  t.toggle("rows", "r2", true);
  t.tab(M, 1);
  t.page(`${M}/children/1/children/0`, 1);
  t.toggle("rows", "4", true);
  t.click(`${M}/children/1/children/2/children/6`);
  t.type("f", "title", "一二三四五六");
  t.click(`${M}/children/1/children/2/children/6`);
  t.type("f", "title", "一二三四五");
  t.click(`${M}/children/1/children/2/children/6`);
  t.choose("f", "kind", "b");
  t.type("f", "count", "0x10");
  t.click(`${M}/children/1/children/2/children/6`);
  t.type("f", "count", "1e1");
  t.type("f", "note", "九个字九个字九个字");
  t.click(`${M}/children/1/children/2/children/6`);
  t.type("f", "note", "");
  t.check("f", "urgent", true);
  t.check("f", "urgent", false);
  t.click(`${M}/children/1/children/2/children/6`);
  t.respond({ invocation: "succeeded", commitCount: 1 });
  t.type("f", "title", "计划");
  t.choose("f", "kind", "a");
  t.click(`${M}/children/1/children/2/children/7`);
  t.respond({ plan: "confirmationRequired", actionId: "act-9" });
  t.click("/view/slots/toolbar/children/1");
  t.confirm(false);
  t.click("/view/slots/toolbar/children/1");
  t.confirm(true);
  t.respond({ invocation: "succeeded", commitCount: 0 });
  t.click("/view/slots/toolbar/children/0");
  t.respond({ invocation: "succeeded", commitCount: 2 });
  t.tab(M, 2);
  t.click(`${M}/children/2/items/0/children/2`);
  t.respond({ invocation: "succeeded", commitCount: 1 });
  t.click(`${M}/children/2/items/3/children/2`);
  t.respond({ invocation: "succeeded", commitCount: 1 });
  t.click(`${M}/children/2/items/4/children/2`);
  t.click(`${M}/children/2/items/1/children/3`);
  t.respond({ plan: "confirmationRequired", actionId: "act-10" });
  t.click(`${M}/children/2/items/9/children/2`);
  t.load("items", { items: [] });
  t.type("f", "title", "未提交");
  t.switchRevision(COV, { ...APP(COV), appEpoch: 4, revisionId: "sha256:" + "c".repeat(64) });
  t.click("/view/slots/toolbar/children/0");
  t.confirmNewVersion();
  t.type("f", "title", "敏感");
  t.clearScope();
}));
for (const s of scenarios) emit(`fixtures/v1.0/slot-vectors/scenario-${s.name}.json`, s);

// ------------------------------------------------------------------ v1 records vectors
const v1 = json("fixtures/todo-v1.json");
const v2 = json("fixtures/todo-v2.json");
const appId = v1.manifest.appId;
const recCases = [];
const rc = (name, input, output) => recCases.push({ name, input: enc(input), output: enc(output) });
for (const [n, b] of [["v1", v1], ["v2", v2]]) {
  rc(`defaultDraft:${n}`, { op: "defaultDraft", bundle: b }, rec.defaultDraft(b));
  rc(`list:${n}:plain`, { op: "list", bundle: b, q: "", filters: {}, offset: 0 }, rec.listRequest(appId, b, "", {}, 0));
  rc(`list:${n}:search`, { op: "list", bundle: b, q: "报告", filters: { done: false }, offset: 20 }, rec.listRequest(appId, b, "报告", { done: false }, 20));
}
const noSearch = clone(v2);
delete noSearch.view.searchField;
rc("list:no-search-field", { op: "list", bundle: noSearch, q: "ignored", filters: {}, offset: 0 }, rec.listRequest(appId, noSearch, "ignored", {}, 0));
let f = rec.changeFilter(v2, {}, "done", "true");
rc("filter:bool-true", { op: "changeFilter", bundle: v2, filters: {}, key: "done", value: "true" }, f);
rc("filter:enum", { op: "changeFilter", bundle: v2, filters: f, key: "priority", value: "high" }, (f = rec.changeFilter(v2, f, "priority", "high")));
rc("filter:clear", { op: "changeFilter", bundle: v2, filters: f, key: "done", value: "" }, rec.changeFilter(v2, f, "done", ""));
rc("filter:version-drops-hidden", { op: "keepFilters", bundle: v1, filters: f }, rec.keepFilters(v1, f));
const record = { id: "rec-1", recordVersion: 3, data: { title: "旧", done: false, priority: "high" } };
rc("openEdit:v1-hides-priority", { op: "openEdit", bundle: v1, data: record.data }, rec.openEdit(v1, record.data));
rc("edit:v1-keeps-hidden-priority", { op: "edit", bundle: v1, appEpoch: 5, record, draft: { title: "新", done: false } }, rec.editRequest(appId, 5, record, { title: "新", done: false }, "k"));
rc("edit:unchanged-closes", { op: "edit", bundle: v2, appEpoch: 5, record, draft: { title: "旧", done: false, priority: "high" } }, rec.editRequest(appId, 5, record, { title: "旧", done: false, priority: "high" }, "k"));
rc("edit:v2-priority", { op: "edit", bundle: v2, appEpoch: 6, record, draft: { title: "旧", done: true, priority: "low" } }, rec.editRequest(appId, 6, record, { title: "旧", done: true, priority: "low" }, "k"));
rc("create:v2-defaults", { op: "create", appEpoch: 6, draft: rec.defaultDraft(v2) }, rec.createRequest(appId, 6, rec.defaultDraft(v2), "k"));
rc("create:drops-undefined", { op: "create", appEpoch: 6, draft: { title: "x", n: undefined } }, rec.createRequest(appId, 6, { title: "x", n: undefined }, "k"));
rc("delete", { op: "delete", appEpoch: 6, record }, rec.deleteRequest(appId, 6, record, "k"));
rc("rebase:create-v2-to-v1", { op: "rebase", bundle: v1, mode: "create", draft: { title: "草稿", done: true, priority: "low" } }, rec.rebase(v1, "create", { title: "草稿", done: true, priority: "low" }));
rc("rebase:edit-v1-to-v2", { op: "rebase", bundle: v2, mode: "edit", draft: { title: "草稿" } }, rec.rebase(v2, "edit", { title: "草稿" }));
rc("deploy:switch-back", { op: "deploy", appEpoch: 6, revisionId: "sha256:" + "d".repeat(64) }, rec.deployRequest(appId, 6, "sha256:" + "d".repeat(64), "k"));
const intField = { type: "integer", label: "数量", minimum: 1, maximum: 10 };
const withInt = clone(v2);
withInt.data.fields.n = intField;
withInt.data.fields.note = { type: "string", label: "备注", maxLength: 3 };
withInt.view.formFields.push("n", "note");
for (const draft of [{ title: "" }, { title: "😀".repeat(200) }, { title: "😀".repeat(201) }, { title: "ok", priority: "urgent" }, { title: "ok", n: 0 }, { title: "ok", n: 11 }, { title: "ok", n: 1.5 }, { title: "ok", n: 5, note: "中文字" }, { title: "ok", note: "中文字多" }, { title: "ok", done: "true" }, { done: false }]) {
  rc(`issues:${JSON.stringify(draft).slice(0, 60)}`, { op: "issues", bundle: withInt, draft }, rec.localIssues(withInt, draft));
}
for (const [fld, raw] of [[intField, ""], [intField, "7"], [intField, "-3"], [{ type: "boolean", label: "b" }, true], [{ type: "string", label: "s", maxLength: 5 }, "a"]]) {
  rc(`fieldInput:${fld.type}:${String(raw)}`, { op: "fieldInput", field: fld, raw }, rec.fieldInput(fld, raw));
}
rc("display:bool", { op: "display", field: { type: "boolean", label: "b" }, value: true }, rec.displayValue({ type: "boolean", label: "b" }, true));
rc("display:bool-false", { op: "display", field: { type: "boolean", label: "b" }, value: false }, rec.displayValue({ type: "boolean", label: "b" }, false));
rc("display:missing", { op: "display", field: { type: "string", label: "s", maxLength: 3 }, value: undefined }, rec.displayValue({ type: "string", label: "s", maxLength: 3 }, undefined));
rc("display:int", { op: "display", field: intField, value: 12 }, rec.displayValue(intField, 12));
rc("key:network", { op: "keyAfter", outcome: "network" }, rec.keyAfter("network"));
rc("key:server", { op: "keyAfter", outcome: "server" }, rec.keyAfter("server"));
emit("fixtures/v1.0/slot-vectors/records.json", { appId, bundles: { v1, v2 }, cases: recCases });

// ------------------------------------------------------------------ v4 page flows + native shell actions
const actions = [];
const act = (name, args) => actions.push({ name, args, request: sh.shellAction(name, args) });
for (const name of Object.keys(sh.SHELL_ACTIONS)) {
  const args = { workspaceId: "44444444-4444-4444-8444-444444444444", userId: "22222222-2222-4222-8222-222222222222", appId, runId: "run-1", conversationId: "conv-1", compactionId: "cmp-1", policyId: "pol-1", version: 2, policyHash: "sha256:" + "e".repeat(64), jobId: "job-1", targetKind: "app", targetId: appId, proposalId: "prop-1", proposalHash: "sha256:" + "f".repeat(64), baseAppEpoch: 4, appEpoch: 4, revisionId: "sha256:" + "1".repeat(64), deploymentId: "dep-1", action: "restart", id: "n-1", actionId: "act-1", planHash: "sha256:" + "2".repeat(64), decision: "confirmed_applied", note: "已检查", operationId: "op-1", ticket: "ticket-1", releaseId: "rel-1", manifestHash: "sha256:" + "3".repeat(64), backupId: "bk-1", targetId2: "usb", mode: "same-machine", restoreId: "rs-1", scope: "workspace", cursor: 17, expectedClientEpoch: 2, role: "editor", expectedMemberVersion: 3, confirm: true, intent: "做一个记账应用", targetAppId: null, displayName: "家庭", userName: "alice", actionKind: "audio.volume.set", params: { percent: 40 } };
  act(name, args);
}
act("runs.submit", { intent: "改成按周显示", targetAppId: appId, expectedAppEpoch: 4 });
for (const kind of sh.HARDWARE_ACTIONS) act("machine.plan", { actionKind: kind, params: kind === "display.mode.set" ? { output: "Virtual-1", mode: "1920x1080@60", scale: 1, revertAfterSeconds: sh.DISPLAY_REVERT_SECONDS } : {} });
let bad = null;
try {
  sh.shellAction("machine.plan", { actionKind: "dbus.call", params: {} });
} catch (e) {
  bad = String(e.message);
}
const states = [{ status: 202 }, { state: "queued" }, { state: "running" }, { state: "awaiting_confirmation" }, { phase: "awaiting_confirmation" }, { state: "succeeded" }, { state: "indeterminate" }, { state: "failed" }, { error: { code: "EFFECT_UNKNOWN" } }, { error: { code: "PLAN_STALE" } }, { state: "cancelled", error: { code: "CANCELLED" } }, { state: "failed", error: { code: "INTERNAL" } }, { state: "cancelled_no_effect" }, { state: "dispatching" }, { state: "reconciling" }].map((r) => ({ input: r, state: sh.displayState(r) }));
const errors = ["NOT_FOUND_OR_FORBIDDEN", "SESSION_LOCKED", "SESSION_STALE", "MEMBERSHIP_REVOKED", "CLIENT_EPOCH_STALE", "PLAN_STALE", "EFFECT_UNKNOWN", "BROKER_UNAVAILABLE", "MODEL_UNAVAILABLE", "HOST_UNAVAILABLE", "SOME_NEW_CODE"].map((code) => ({ code, text: sv.describeError(code, "原始消息"), policy: sv.errorPolicy(code) }));
emit("fixtures/v1.0/slot-vectors/shell-actions.json", { actions, rejected: { name: "machine.plan", args: { actionKind: "dbus.call" }, error: bad }, states, errors });

console.log(check ? (drift ? `${drift} file(s) differ` : "slot vectors up to date") : `wrote ${validation.length} validation cases, ${scenarios.length} scenarios, ${recCases.length} record cases, ${actions.length} actions`);
process.exit(drift ? 1 : 0);
