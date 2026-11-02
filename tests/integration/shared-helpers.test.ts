import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  asText, defaultRecordDraft, displayRecordValue, editRecordDraft, readPointer, rebaseRecordDraft, COMPONENT_TYPES_V2,
  type AppBundle,
} from "@agentos/contracts";
import { defaultDraft, displayValue, openEdit, rebase } from "../../packages/contracts/src/v1_0/slot-vectors-records.js";
import { SLOT_COMPONENT_TYPES, WEB_ERROR_TEXT, NETWORK_ERROR_TEXT, INVOCATION_TEXT } from "../../packages/contracts/src/view.js";
import { INVOCATION_TEXT as REFERENCE_INVOCATION_TEXT, ERROR_TEXT, describeError } from "../../packages/contracts/src/v1_0/slot-vectors.js";
import { fsyncPath, sha256File } from "../../packages/host/src/fs-utils.js";
import { fixture, tmpDir } from "../helpers.js";

const bundle: AppBundle = {
  ...fixture("todo-v1.json"),
  data: { fields: {
    title: { type: "string", label: "Title", maxLength: 80 },
    done: { type: "boolean", label: "Done" },
    count: { type: "integer", label: "Count", default: 0 },
    choice: { type: "enum", label: "Choice", values: ["first", "second"] },
    hidden: { type: "string", label: "Hidden", maxLength: 80, default: "secret" },
    optional: { type: "integer", label: "Optional" },
  } },
  view: { kind: "records", titleField: "title", columns: ["title"], formFields: ["title", "done", "count", "choice", "optional"], filters: [] },
};

describe("shared record view rules", () => {
  it("keeps form defaults, false and zero without filling optional or hidden fields", () => {
    expect(defaultRecordDraft(bundle)).toEqual({ title: "", done: false, count: 0, choice: "first" });
    const explicit = structuredClone(bundle);
    explicit.data.fields.done = { type: "boolean", label: "Done", default: true };
    explicit.data.fields.choice = { type: "enum", label: "Choice", values: ["first", "second"], default: "second" };
    expect(defaultRecordDraft(explicit)).toMatchObject({ done: true, choice: "second" });
  });

  it("edits only offered fields and does not mutate stored data", () => {
    const data = { title: "", done: false, count: 0, hidden: "keep", optional: undefined };
    expect(editRecordDraft(bundle, data)).toEqual({ title: "", done: false, count: 0 });
    expect(data.hidden).toBe("keep");
    expect(Object.hasOwn(data, "optional")).toBe(true);
  });

  it("rebases create/edit differently while keeping entered values and dropping hidden ones", () => {
    const draft = { title: "draft", done: false, hidden: "not submitted" };
    expect(rebaseRecordDraft(bundle, "create", draft)).toEqual({ title: "draft", done: false, count: 0, choice: "first" });
    expect(rebaseRecordDraft(bundle, "edit", draft)).toEqual({ title: "draft", done: false });
    expect(draft.hidden).toBe("not submitted");
  });

  it("formats values exactly as the existing views and keeps reference-model exports", () => {
    expect(displayRecordValue(bundle.data.fields.done!, true)).toBe("✓");
    expect(displayRecordValue(bundle.data.fields.done!, false)).toBe("—");
    expect(displayRecordValue(bundle.data.fields.count!, 0)).toBe("0");
    expect(displayRecordValue(bundle.data.fields.title!, undefined)).toBe("");
    expect(defaultDraft).toBe(defaultRecordDraft);
    expect(displayValue).toBe(displayRecordValue);
    expect(openEdit).toBe(editRecordDraft);
    expect(rebase).toBe(rebaseRecordDraft);
  });
});

describe("shared Slot value helpers", () => {
  it("keeps the browser component catalogue in sync with the protocol", () => {
    expect([...SLOT_COMPONENT_TYPES]).toEqual(COMPONENT_TYPES_V2);
    expect(new Set(SLOT_COMPONENT_TYPES).size).toBe(SLOT_COMPONENT_TYPES.length);
  });

  it("keeps restricted own-property JSON pointers", () => {
    expect(readPointer({ a: [false, 0, ""] }, "/a/1")).toBe(0);
    expect(readPointer({ a: [false] }, "/a/01")).toBeUndefined();
    expect(readPointer(Object.create({ inherited: "hidden" }), "/inherited")).toBeUndefined();
    for (const key of ["__proto__", "constructor", "prototype"]) expect(readPointer(JSON.parse(`{"${key}":"hidden"}`), `/${key}`)).toBeUndefined();
    expect(readPointer({ a: 1 }, "/a/../a")).toBeUndefined();
  });

  it("keeps missing, scalar, JSON and circular text conversion unchanged", () => {
    expect([undefined, null, false, 0, -0, "<b>x</b>"].map(asText)).toEqual(["", "", "false", "0", "0", "<b>x</b>"]);
    expect(asText({ b: [1, "a"] })).toBe('{"b":[1,"a"]}');
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(asText(circular)).toBe("");
  });
});

describe("shared error display messages", () => {
  it("keeps the former web messages and the network text in the error policy the native Shell embeds", () => {
    // the web client is gone; its describeError() texts live on in ERROR_TEXT, which the generated error-policy.json
    // carries to the native Shell (desktop/tests/slot_vectors.cpp checks describeError() for every code there)
    const policy = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../fixtures/v1.0/slot-vectors/error-policy.json"), "utf8")) as { errorText: Record<string, string>; networkText: string };
    for (const [code, text] of Object.entries(WEB_ERROR_TEXT)) {
      expect(ERROR_TEXT[code]).toBe(text);
      expect(policy.errorText[code]).toBe(text);
      expect(describeError(code, "server detail")).toBe(`${text}（${code}）`);
    }
    expect(policy.networkText).toBe(NETWORK_ERROR_TEXT);
    expect(describeError("SOME_NEW_CODE", "server detail")).toBe("server detail（SOME_NEW_CODE）");
  });

  it("keeps the reference model's invocation messages", () => {
    expect(REFERENCE_INVOCATION_TEXT).toEqual(INVOCATION_TEXT);
    expect(INVOCATION_TEXT.INVALID_MUTATION).toBe("应用返回了不允许的修改，已整体拒绝");
    expect(INVOCATION_TEXT.APP_TIMEOUT).toBe("应用执行超时，已被停止，没有写入任何内容");
  });
});

describe("shared backup filesystem helpers", () => {
  it("keeps SHA-256 bytes and missing-file failures", () => {
    const file = path.join(tmpDir(), "input");
    fs.writeFileSync(file, "abc");
    expect(sha256File(file)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(() => sha256File(`${file}-missing`)).toThrow();
    expect(() => fsyncPath(`${file}-missing`)).toThrow();
  });

  it("closes the descriptor and propagates sync failure", () => {
    const file = path.join(tmpDir(), "input");
    fs.writeFileSync(file, "abc");
    const close = vi.spyOn(fs, "closeSync");
    const failure = new Error("sync failed");
    const sync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw failure; });
    try {
      expect(() => fsyncPath(file)).toThrow(failure);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      sync.mockRestore();
      close.mockRestore();
    }
  });
});
