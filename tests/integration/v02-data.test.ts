import { describe, expect, it } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { AgentOsError, type AppBundle } from "@agentos/contracts";
import { InvocationService, RuntimeCatalogService, AppRuntimeService, commitMutations, openCore, requestHash, type Core, type RuntimeContext } from "@agentos/core";
import { codeFixture } from "../fixtures-v02.js";
import { tmpDir } from "../helpers.js";

const root = path.resolve(import.meta.dirname, "../..");
const v1 = JSON.parse(readFileSync(path.join(root, "fixtures/todo-v1.json"), "utf8")) as AppBundle;
const v2 = JSON.parse(readFileSync(path.join(root, "fixtures/todo-v2.json"), "utf8")) as AppBundle;
const catalog = new RuntimeCatalogService(JSON.parse(readFileSync(path.join(root, "runtime/catalog/catalog.json"), "utf8")), "linux/amd64");
const APP = v1.manifest.appId;
const user = { kind: "app" as const, appId: APP, viaUser: true };

function setup(): Core {
  const core = openCore(path.join(tmpDir(), "os.sqlite"));
  core.apps.extraCheck = catalog.check;
  core.apps.seedActivated(v1);
  return core;
}
const epochs = (core: Core) => core.store.get<{ epoch: number; data_epoch: number }>("SELECT epoch, data_epoch FROM apps WHERE id = ?", APP)!;
/** Data activation of a revision (the database half of a deployment). */
function activate(core: Core, bundle: unknown) {
  return core.store.tx(() => {
    const { revisionId } = core.apps.stage(APP, bundle, null);
    return core.apps.activateInTx(APP, revisionId, core.apps.requireApp(APP).epoch, { historicalOnly: false, runId: null });
  });
}
function switchTo(core: Core, revisionId: string) {
  return core.store.tx(() => core.apps.activateInTx(APP, revisionId, core.apps.requireApp(APP).epoch, { historicalOnly: true, runId: null }));
}
const rows = (core: Core) => core.store.all<{ id: string; version: number; data_json: string }>("SELECT id, version, data_json FROM records WHERE app_id = ? ORDER BY created_at, id", APP).map((r) => ({ id: r.id, version: r.version, data: JSON.parse(r.data_json) as Record<string, unknown> }));

describe("V2-D01 v1 → v2 → v1 → v2 keeps data", () => {
  it("new field data survives, the old version creates with defaults, partial updates keep hidden fields, deletes stay deleted", () => {
    const core = setup();
    const a = core.store.tx(() => core.records.create(user, APP, 1, { title: "A" }));
    const v1rev = core.apps.requireApp(APP).active_revision_id!;
    const hours = codeFixture("todo-kanban-hours");
    const r2 = activate(core, hours);
    expect(r2.changed).toBe(true);
    expect(rows(core)[0]!.data).toEqual({ title: "A", done: false, priority: "normal", estimate_minutes: 0 });
    // code version writes estimates through a committed plan
    const ep = epochs(core);
    core.store.tx(() =>
      commitMutations(core.store, {
        appId: APP, bundle: hours, command: hours.commands.setEstimate!, contract: core.apps.contractOf(core.apps.requireApp(APP)), expectedDataEpoch: ep.data_epoch,
        mutations: [{ kind: "update", recordId: a.id, expectedRecordVersion: rows(core)[0]!.version, changes: { estimate_minutes: 30 } }],
      }),
    );
    const b = rows(core);
    expect(b[0]!.data.estimate_minutes).toBe(30);
    // back to v1: edit the title (partial update keeps the hidden estimate), create a record (defaults fill hidden fields)
    switchTo(core, v1rev);
    const appEpoch = core.apps.requireApp(APP).epoch;
    core.store.tx(() => core.records.update(user, APP, a.id, appEpoch, b[0]!.version, { title: "A2" }));
    const c = core.store.tx(() => core.records.create(user, APP, appEpoch, { title: "C" }));
    const d = core.store.tx(() => core.records.create(user, APP, appEpoch, { title: "D" }));
    core.store.tx(() => core.records.remove(user, APP, d.id, appEpoch, 1));
    // forward again to the code version (historical switch)
    switchTo(core, r2.revisionId);
    const now = rows(core);
    expect(now.map((r) => r.data)).toEqual([
      { title: "A2", done: false, priority: "normal", estimate_minutes: 30 },
      { title: "C", done: false, priority: "normal", estimate_minutes: 0 },
    ]);
    expect(now.some((r) => r.id === d.id)).toBe(false);
    expect(c.data).toEqual({ title: "C", done: false });
  });
});

describe("V2-D02 data_epoch and record.version on every write path", () => {
  it("CRUD, backfill and batch commits each bump data_epoch once; failures and no-op batches do not", () => {
    const core = setup();
    let e = epochs(core);
    expect(e.data_epoch).toBe(0);
    const a = core.store.tx(() => core.records.create(user, APP, 1, { title: "A" }));
    expect(epochs(core).data_epoch).toBe(1);
    core.store.tx(() => core.records.update(user, APP, a.id, 1, 1, { done: true }));
    expect(epochs(core).data_epoch).toBe(2);
    expect(() => core.store.tx(() => core.records.update(user, APP, a.id, 1, 1, { done: false }))).toThrow(/changed/);
    expect(epochs(core).data_epoch).toBe(2);
    const b = core.store.tx(() => core.records.create(user, APP, 1, { title: "B" }));
    core.store.tx(() => core.records.remove(user, APP, b.id, 1, 1));
    expect(epochs(core).data_epoch).toBe(4);
    activate(core, v2); // backfill priority on 1 record
    e = epochs(core);
    expect(e.data_epoch).toBe(5);
    expect(rows(core)[0]!.version).toBe(3);
    const k = codeFixture("todo-kanban");
    activate(core, k); // no new field → no backfill
    expect(epochs(core).data_epoch).toBe(5);
    const contract = core.apps.contractOf(core.apps.requireApp(APP));
    // a batch whose updates change nothing commits nothing and keeps the epoch
    const r = core.store.tx(() => commitMutations(core.store, { appId: APP, bundle: k, command: k.commands.completeMany!, contract, expectedDataEpoch: 5, mutations: [{ kind: "update", recordId: a.id, expectedRecordVersion: 3, changes: { done: true } }] }));
    expect(r.changed).toBe(false);
    expect(epochs(core).data_epoch).toBe(5);
    core.store.tx(() => commitMutations(core.store, { appId: APP, bundle: k, command: k.commands.add!, contract, expectedDataEpoch: 5, mutations: [{ kind: "create", localKey: "x", data: { title: "X" } }, { kind: "create", localKey: "y", data: { title: "Y" } }] }));
    expect(epochs(core).data_epoch).toBe(6);
    expect(rows(core).filter((x) => x.data.title === "X")[0]!.version).toBe(1);
  });
});

describe("V2-D03 batch atomicity", () => {
  it("an invalid item N leaves no partial records, counters or success receipt", () => {
    const core = setup();
    const k = codeFixture("todo-kanban");
    activate(core, k);
    const contract = core.apps.contractOf(core.apps.requireApp(APP));
    const before = { rows: rows(core), e: epochs(core), ops: core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM operations")!.n };
    const mutations = [
      { kind: "create" as const, localKey: "a", data: { title: "ok 1" } },
      { kind: "create" as const, localKey: "b", data: { title: "ok 2" } },
      { kind: "create" as const, localKey: "c", data: { title: "" } },
    ];
    expect(() => core.store.tx(() => commitMutations(core.store, { appId: APP, bundle: k, command: k.commands.add!, contract, expectedDataEpoch: before.e.data_epoch, mutations }))).toThrow(AgentOsError);
    expect(rows(core)).toEqual(before.rows);
    expect(epochs(core)).toEqual(before.e);
    expect(core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM operations")!.n).toBe(before.ops);
    // the same plan, valid, commits all three at once with one epoch step
    mutations[2]!.data.title = "ok 3";
    const r = core.store.tx(() => commitMutations(core.store, { appId: APP, bundle: k, command: k.commands.add!, contract, expectedDataEpoch: before.e.data_epoch, mutations }));
    expect(Object.keys(r.created)).toEqual(["a", "b", "c"]);
    expect(epochs(core).data_epoch).toBe(before.e.data_epoch + 1);
    // a stale data epoch is refused before anything is written
    expect(() => core.store.tx(() => commitMutations(core.store, { appId: APP, bundle: k, command: k.commands.add!, contract, expectedDataEpoch: before.e.data_epoch, mutations: [{ kind: "create", localKey: "z", data: { title: "z" } }] }))).toThrow(/DATA_EPOCH_STALE|records changed/);
  });
});

describe("V2-D07 write permissions and hidden fields", () => {
  it("undeclared operations, fields outside writableFields and historical hidden fields are refused", () => {
    const core = setup();
    const k = codeFixture("todo-kanban"); // older code revision: no estimate_minutes
    const kr = activate(core, k);
    activate(core, codeFixture("todo-kanban-hours"));
    switchTo(core, kr.revisionId);
    const contract = core.apps.contractOf(core.apps.requireApp(APP));
    const a = core.store.tx(() => commitMutations(core.store, { appId: APP, bundle: k, command: k.commands.add!, contract, expectedDataEpoch: epochs(core).data_epoch, mutations: [{ kind: "create", localKey: "a", data: { title: "A" } }] }));
    const id = a.created.a!;
    const ep = () => epochs(core).data_epoch;
    const tryPlan = (command: keyof typeof k.commands, m: unknown[]) => {
      try {
        core.store.tx(() => commitMutations(core.store, { appId: APP, bundle: k, command: k.commands[command]!, contract, expectedDataEpoch: ep(), mutations: m as never }));
        return "ok";
      } catch (e) {
        return (e as AgentOsError).code;
      }
    };
    expect(tryPlan("completeMany", [{ kind: "delete", recordId: id, expectedRecordVersion: 1 }])).toBe("INVALID_MUTATION");
    expect(tryPlan("completeMany", [{ kind: "update", recordId: id, expectedRecordVersion: 1, changes: { title: "hijack" } }])).toBe("INVALID_MUTATION");
    expect(tryPlan("add", [{ kind: "create", localKey: "h", data: { title: "H", estimate_minutes: 5 } }])).toBe("INVALID_MUTATION");
    expect(tryPlan("completeMany", [{ kind: "update", recordId: id, expectedRecordVersion: 1, changes: { done: true } }, { kind: "update", recordId: id, expectedRecordVersion: 1, changes: { done: true } }])).toBe("INVALID_MUTATION");
    expect(tryPlan("completeMany", [{ kind: "update", recordId: id, expectedRecordVersion: 9, changes: { done: true } }])).toBe("RECORD_VERSION_STALE");
    expect(tryPlan("completeMany", [{ kind: "update", recordId: id, expectedRecordVersion: 1, changes: { done: true } }])).toBe("ok");
    expect(rows(core).find((r) => r.id === id)!.data).toEqual({ title: "A", done: true, priority: "normal", estimate_minutes: 0 });
  });
  it("the records API refuses direct writes to an active code version (after receipts and epoch checks)", () => {
    const core = setup();
    activate(core, codeFixture("todo-kanban"));
    const e = core.apps.requireApp(APP).epoch;
    expect(() => core.store.tx(() => core.records.create(user, APP, e, { title: "x" }))).toThrow(/use its queries and commands/);
    expect(() => core.store.tx(() => core.records.create(user, APP, e - 1, { title: "x" }))).toThrow(/version changed/);
  });
});

describe("V2-D04 command acceptance is idempotent", () => {
  it("same key + same body returns the same invocation; a different body conflicts", () => {
    const core = setup();
    activate(core, codeFixture("todo-kanban"));
    core.store.tx(() => core.store.run("INSERT INTO app_runtime (app_id, enabled, active_instance_id, generation, health, control_epoch, restart_count, updated_at) VALUES (?, 1, NULL, 0, 'recovering', 0, 0, ?)", APP, new Date().toISOString()));
    const ctx = { store: core.store, apps: core.apps } as unknown as RuntimeContext;
    const inv = new InvocationService(ctx, new AppRuntimeService(ctx));
    const e = core.apps.requireApp(APP).epoch;
    const key = randomUUID();
    const accept = (input: unknown) =>
      core.gateway.write("apps.command", { principal: { kind: "user" }, operationKey: key, requestHash: requestHash({ input: input as never }) }, () => ({
        status: 202,
        body: inv.acceptInTx({ kind: "user" }, APP, "add", input, e, key),
      }));
    const first = accept({ title: "x" });
    const again = accept({ title: "x" });
    expect(again.replayed).toBe(true);
    expect(again.body.invocationId).toBe(first.body.invocationId);
    expect(() => accept({ title: "y" })).toThrow(/different request/);
    expect(core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM invocations")!.n).toBe(1);
    // schema-invalid input is refused synchronously with a path
    expect(() =>
      core.gateway.write("apps.command", { principal: { kind: "user" }, operationKey: randomUUID(), requestHash: "h" }, () => ({ status: 202, body: inv.acceptInTx({ kind: "user" }, APP, "add", { title: 5 }, e, "k2") })),
    ).toThrow(/input/);
  });
});
