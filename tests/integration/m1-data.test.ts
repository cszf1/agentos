import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { AgentOsError, bundleHash, checkCompatibility, contractFromBundle, validateBundle, type AppBundle } from "@agentos/contracts";
import { activateHistory, createRecord, fixture, meta, newCore, publishCandidate } from "../helpers.js";

const v1 = fixture("todo-v1.json");
const v2 = fixture("todo-v2.json");
const APP = v1.manifest.appId;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AgentOsError) return e.code;
    throw e;
  }
  return "OK";
}

describe("C: AppBundle contract", () => {
  it("C01 both fixtures are valid and v2 is compatible with v1", () => {
    const r1 = validateBundle(v1, APP, null, "candidate");
    expect(r1.issues).toEqual([]);
    const r2 = validateBundle(v2, APP, contractFromBundle(r1.bundle!), "candidate");
    expect(r2.issues).toEqual([]);
  });

  it("C02 unknown runtime, unknown key, code entry and out-of-range default are rejected; active app unchanged", () => {
    const core = newCore();
    publishCandidate(core, v1);
    const before = core.apps.getApp(APP);
    const bad: unknown[] = [
      { ...v1, manifest: { ...v1.manifest, runtime: "node" } },
      { ...v1, view: { ...v1.view, html: "<script>alert(1)</script>" } },
      { ...v1, manifest: { ...v1.manifest, entry: "index.js" } },
      { ...v1, data: { fields: { ...v1.data.fields, n: { type: "integer", label: "n", minimum: 0, maximum: 3, default: 9 } } } },
    ];
    for (const b of bad) {
      const code = codeOf(() => core.store.tx(() => core.apps.stage(APP, b, null)));
      if (code === "OK") {
        // semantically invalid but structurally fine bundles are staged and then refused at activation
        const { revisionId } = core.store.tx(() => core.apps.stage(APP, b, null));
        expect(core.apps.validate(APP, revisionId).valid).toBe(false);
        expect(codeOf(() => core.store.tx(() => core.apps.activateInTx(APP, revisionId, core.apps.requireApp(APP).epoch, { historicalOnly: false, runId: null })))).toBe("INVALID_BUNDLE");
      } else {
        expect(code).toBe("INVALID_BUNDLE");
      }
    }
    expect(core.apps.getApp(APP)).toEqual(before);
  });

  it("C03 reports exact field paths for bad references, search type and hidden required field", () => {
    const b = structuredClone(v1) as AppBundle;
    b.view.columns = ["title", "missing"];
    b.view.searchField = "done";
    b.view.formFields = ["done"];
    const issues = validateBundle(b, APP, null, "candidate").issues;
    const paths = issues.map((i) => i.path);
    expect(paths).toContain("/view/columns/1");
    expect(paths).toContain("/view/searchField");
    expect(paths).toContain("/data/fields/title");
  });

  it("C04 changing an existing field or dropping one is SCHEMA_INCOMPATIBLE", () => {
    const core = newCore();
    publishCandidate(core, v1);
    const variants: AppBundle[] = [];
    const t = structuredClone(v2) as AppBundle;
    (t.data.fields as Record<string, unknown>).done = { type: "enum", label: "完成", values: ["y", "n"], default: "n" };
    variants.push(t);
    const d = structuredClone(v2) as AppBundle;
    (d.data.fields.done as { default?: boolean }).default = true;
    variants.push(d);
    const drop = structuredClone(v2) as AppBundle;
    delete (drop.data.fields as Record<string, unknown>).done;
    drop.view = { ...drop.view, columns: ["title", "priority"], formFields: ["title", "priority"], filters: ["priority"] };
    variants.push(drop);
    const prio = structuredClone(v2) as AppBundle;
    publishCandidate(core, prio);
    const enumChange = structuredClone(v2) as AppBundle;
    (enumChange.data.fields.priority as { values: string[] }).values = ["low", "normal", "high", "urgent"];
    variants.push(enumChange);
    for (const b of variants) {
      const { revisionId } = core.store.tx(() => core.apps.stage(APP, b, null));
      const epoch = core.apps.requireApp(APP).epoch;
      expect(codeOf(() => core.store.tx(() => core.apps.activateInTx(APP, revisionId, epoch, { historicalOnly: false, runId: null })))).toBe("SCHEMA_INCOMPATIBLE");
    }
    expect(checkCompatibility(v1, contractFromBundle(v2), "candidate").map((i) => i.code)).toContain("SCHEMA_INCOMPATIBLE");
  });

  it("C05 an unpublished candidate cannot be used through the history switch and is not listed", () => {
    const core = newCore();
    publishCandidate(core, v1);
    const { revisionId } = core.store.tx(() => core.apps.stage(APP, v2, null));
    expect(core.apps.listRevisions(APP).map((r) => r.revisionId)).toEqual([bundleHash(v1)]);
    expect(codeOf(() => activateHistory(core, APP, revisionId))).toBe("NOT_FOUND");
    expect(core.apps.requireApp(APP).active_revision_id).toBe(bundleHash(v1));
  });
});

describe("D: data, versions and idempotency", () => {
  it("D01 v1 → v2 → v1 → v2 keeps high, hidden fields and backfills normal", () => {
    const core = newCore();
    publishCandidate(core, v1);
    const a = createRecord(core, APP, { title: "买牛奶" });
    const b = createRecord(core, APP, { title: "写周报", done: true });
    expect(a.data).toEqual({ title: "买牛奶", done: false });
    publishCandidate(core, v2);
    let page = core.records.list({ kind: "app", appId: APP, viaUser: true }, APP, {});
    expect(page.items.map((r) => r.data.priority)).toEqual(["normal", "normal"]);
    const target = page.items.find((r) => r.id === a.id)!;
    core.user.updateRecord(meta("hi"), APP, a.id, page.appEpoch, target.recordVersion, { priority: "high" });
    activateHistory(core, APP, bundleHash(v1));
    page = core.records.list({ kind: "app", appId: APP, viaUser: true }, APP, {});
    expect(Object.keys(page.items[0]!.data).sort()).toEqual(["done", "title"]);
    const a1 = page.items.find((r) => r.id === a.id)!;
    core.user.updateRecord(meta("t"), APP, a.id, page.appEpoch, a1.recordVersion, { title: "买牛奶和面包" });
    const c = createRecord(core, APP, { title: "新任务" });
    activateHistory(core, APP, bundleHash(v2));
    page = core.records.list({ kind: "app", appId: APP, viaUser: true }, APP, {});
    const byId = Object.fromEntries(page.items.map((r) => [r.id, r.data]));
    expect(byId[a.id]).toEqual({ title: "买牛奶和面包", done: false, priority: "high" });
    expect(byId[b.id]).toEqual({ title: "写周报", done: true, priority: "normal" });
    expect(byId[c.id]).toEqual({ title: "新任务", done: false, priority: "normal" });
    // filters & search on v2
    expect(core.records.list({ kind: "app", appId: APP, viaUser: true }, APP, { filters: { priority: "high" } }).items.map((r) => r.id)).toEqual([a.id]);
    expect(core.records.list({ kind: "app", appId: APP, viaUser: true }, APP, { q: "周报" }).total).toBe(1);
  });

  it("D02 same operation key creates exactly one record with the same id/version", () => {
    const core = newCore();
    publishCandidate(core, v1);
    const key = randomUUID();
    const r1 = createRecord(core, APP, { title: "x" }, key);
    const r2 = createRecord(core, APP, { title: "x" }, key);
    expect(r2.id).toBe(r1.id);
    expect(r2.recordVersion).toBe(r1.recordVersion);
    expect(core.records.list({ kind: "app", appId: APP, viaUser: true }, APP, {}).total).toBe(1);
  });

  it("D03 same key with a different body is REQUEST_CONFLICT and writes nothing", () => {
    const core = newCore();
    publishCandidate(core, v1);
    const key = randomUUID();
    createRecord(core, APP, { title: "x" }, key);
    expect(codeOf(() => createRecord(core, APP, { title: "y" }, key))).toBe("REQUEST_CONFLICT");
    expect(core.records.list({ kind: "app", appId: APP, viaUser: true }, APP, {}).total).toBe(1);
  });

  it("D04 stale app epoch or record version is 409 without overwrite", () => {
    const core = newCore();
    publishCandidate(core, v1);
    const r = createRecord(core, APP, { title: "x" });
    const epoch = core.apps.requireApp(APP).epoch;
    core.user.updateRecord(meta(1), APP, r.id, epoch, 1, { title: "y" });
    expect(codeOf(() => core.user.updateRecord(meta(2), APP, r.id, epoch, 1, { title: "z" }))).toBe("RECORD_VERSION_STALE");
    publishCandidate(core, v2);
    expect(codeOf(() => core.user.updateRecord(meta(3), APP, r.id, epoch, 3, { title: "z" }))).toBe("APP_EPOCH_STALE");
    expect(codeOf(() => core.user.createRecord(meta(4), APP, epoch, { title: "z" }))).toBe("APP_EPOCH_STALE");
    expect(core.records.list({ kind: "app", appId: APP, viaUser: true }, APP, {}).items[0]!.data.title).toBe("y");
  });

  it("D05 a new field that pushes a record over 16 KiB rolls the whole activation back", () => {
    const core = newCore();
    const big = structuredClone(v1) as AppBundle;
    (big.data.fields.title as { maxLength: number }).maxLength = 4096;
    big.data.fields.note = { type: "string", label: "备注", maxLength: 4096 };
    big.view.formFields = ["title", "done", "note"];
    publishCandidate(core, big);
    const huge = "长".repeat(2000); // 6000 bytes
    createRecord(core, APP, { title: huge, note: huge });
    const before = { app: core.apps.requireApp(APP), recs: core.store.all("SELECT * FROM records"), ops: core.store.all("SELECT * FROM operations") };
    const grow = structuredClone(big) as AppBundle;
    grow.data.fields.extra = { type: "string", label: "x", maxLength: 4096, default: "多".repeat(1600) };
    const { revisionId } = core.store.tx(() => core.apps.stage(APP, grow, null));
    expect(
      codeOf(() =>
        core.gateway.write("apps.activate.history", { principal: { kind: "user" }, operationKey: randomUUID(), requestHash: "h" }, () => ({
          status: 200,
          body: core.apps.activateInTx(APP, revisionId, before.app.epoch, { historicalOnly: false, runId: null }),
        })),
      ),
    ).toBe("LIMIT_EXCEEDED");
    expect(core.apps.requireApp(APP)).toEqual(before.app);
    expect(core.store.all("SELECT * FROM records")).toEqual(before.recs);
    expect(core.store.get("SELECT first_activated_at FROM revisions WHERE id = ?", revisionId)).toEqual({ first_activated_at: null });
    // the domain error itself is a receipt, but no business row changed
    expect(core.store.all("SELECT * FROM operations").length).toBe(before.ops.length + 1);
  });

  it("D06 cross-app access and unrequested records.write are FORBIDDEN", () => {
    const core = newCore();
    publishCandidate(core, v1);
    const ro = structuredClone(v1) as AppBundle;
    ro.manifest.appId = randomUUID();
    ro.manifest.capabilities = ["records.read"];
    publishCandidate(core, ro);
    const r = createRecord(core, APP, { title: "mine" });
    const other = { kind: "app" as const, appId: ro.manifest.appId, viaUser: true };
    expect(codeOf(() => core.records.list(other, APP, {}))).toBe("FORBIDDEN");
    expect(codeOf(() => core.store.tx(() => core.records.update(other, APP, r.id, 1, 1, { title: "x" })))).toBe("FORBIDDEN");
    expect(codeOf(() => createRecord(core, ro.manifest.appId, { title: "x" }))).toBe("FORBIDDEN");
    expect(codeOf(() => core.records.list({ kind: "user" }, APP, {}))).toBe("FORBIDDEN");
    expect(core.records.list({ kind: "app", appId: APP, viaUser: true }, APP, {}).items[0]!.data.title).toBe("mine");
  });

  it("D07 hidden fields and client ids are refused; hidden data survives", () => {
    const core = newCore();
    publishCandidate(core, v1);
    publishCandidate(core, v2);
    const r = createRecord(core, APP, { title: "x", priority: "high" });
    activateHistory(core, APP, bundleHash(v1));
    const epoch = core.apps.requireApp(APP).epoch;
    expect(codeOf(() => core.user.createRecord(meta(1), APP, epoch, { title: "y", priority: "low" }))).toBe("INVALID_RECORD");
    expect(codeOf(() => core.user.createRecord(meta(2), APP, epoch, { title: "y", id: "abc" }))).toBe("INVALID_RECORD");
    const cur = core.records.list({ kind: "app", appId: APP, viaUser: true }, APP, {}).items[0]!;
    expect(codeOf(() => core.user.updateRecord(meta(3), APP, r.id, epoch, cur.recordVersion, { priority: "low" }))).toBe("INVALID_RECORD");
    const full = JSON.parse(core.store.get<{ data_json: string }>("SELECT data_json FROM records WHERE id = ?", r.id)!.data_json);
    expect(full.priority).toBe("high");
  });

  it("missing required field and type mismatch report paths", () => {
    const core = newCore();
    publishCandidate(core, v1);
    const epoch = core.apps.requireApp(APP).epoch;
    try {
      core.user.createRecord(meta(1), APP, epoch, { done: "yes" });
      throw new Error("expected failure");
    } catch (e) {
      expect((e as AgentOsError).code).toBe("INVALID_RECORD");
      expect((e as AgentOsError).details?.issues).toEqual([{ path: "/data/done", message: "已完成 must be a boolean" }]);
    }
    try {
      core.user.createRecord(meta(2), APP, epoch, {});
    } catch (e) {
      expect((e as AgentOsError).details?.issues).toEqual([{ path: "/data/title", message: "任务 is required" }]);
    }
  });
});
