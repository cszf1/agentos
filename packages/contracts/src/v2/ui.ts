import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { RESERVED_KEYS, type ValidationIssue } from "../bundle.js";

/**
 * Slot Tree UI protocol (spec §9). Pure data: a fixed component set with one props schema each, typed bindings that
 * read JSON Pointers from query results, form state, selections or the current item. No expressions, no HTML, no CSS,
 * no URLs. The tree is fixed per revision; query results only fill values.
 */
export const UI_LIMITS = {
  maxNodes: 256,
  maxDepth: 12,
  maxChildren: 64,
  maxSeries: 8,
  maxPointsPerSeries: 500,
  minRefreshSeconds: 5,
  maxRefreshSeconds: 3600,
  maxDataSources: 8,
} as const;

export const SLOT_NAMES = ["main", "toolbar", "aside"] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

export const IDENT_PATTERN = "^[A-Za-z][A-Za-z0-9_]{0,63}$";
export const POINTER_PATTERN = "^(/[A-Za-z0-9_-]{1,64}){0,8}$";
const IDENT_RE = new RegExp(IDENT_PATTERN);
const POINTER_RE = new RegExp(POINTER_PATTERN);

export type Pointer = string;
export type Binding =
  | { $bind: { from: "query"; source: string; pointer: Pointer } }
  | { $bind: { from: "form"; formId: string; pointer: Pointer } }
  | { $bind: { from: "selection"; selectionId: string } }
  | { $bind: { from: "item"; pointer: Pointer } };
export type Scalar = string | number | boolean | null;

export interface SlotNode {
  type: ComponentType;
  props?: Record<string, unknown>;
  children?: SlotNode[];
  visibleWhen?: { value: Binding; op: "exists" } | { value: Binding; op: "eq"; equals: Scalar };
}

export interface DataSource {
  queryId: string;
  input?: Record<string, unknown>;
}

export interface SlotTreeView {
  kind: "slot-tree-v1" | "slot-tree-v2";
  dataSources: Record<string, DataSource>;
  slots: Partial<Record<SlotName, SlotNode>> & { main: SlotNode };
  refresh?: { intervalSeconds: number };
}

const bindingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["$bind"],
  properties: {
    $bind: {
      oneOf: [
        { type: "object", additionalProperties: false, required: ["from", "source", "pointer"], properties: { from: { const: "query" }, source: { type: "string", pattern: IDENT_PATTERN }, pointer: { type: "string", pattern: POINTER_PATTERN } } },
        { type: "object", additionalProperties: false, required: ["from", "formId", "pointer"], properties: { from: { const: "form" }, formId: { type: "string", pattern: IDENT_PATTERN }, pointer: { type: "string", pattern: POINTER_PATTERN } } },
        { type: "object", additionalProperties: false, required: ["from", "selectionId"], properties: { from: { const: "selection" }, selectionId: { type: "string", pattern: IDENT_PATTERN } } },
        { type: "object", additionalProperties: false, required: ["from", "pointer"], properties: { from: { const: "item" }, pointer: { type: "string", pattern: POINTER_PATTERN } } },
      ],
    },
  },
} as const;
const text = (max: number) => ({ type: "string", maxLength: max });
const textValue = { anyOf: [text(1024), { $ref: "#/$defs/binding" }] };
const numberOrText = { anyOf: [{ type: "number" }, text(256), { $ref: "#/$defs/binding" }] };
const ident = { type: "string", pattern: IDENT_PATTERN };
const pointer = { type: "string", pattern: POINTER_PATTERN };
const gap = { enum: ["sm", "md", "lg"] };
const labelled = { type: "object", additionalProperties: false, required: ["pointer", "label"], properties: { pointer, label: text(80) } };

/** One props schema per component (spec §9.1: no generic props:any). */
export const COMPONENT_PROPS: Record<string, object> = {
  Stack: { type: "object", additionalProperties: false, properties: { direction: { enum: ["vertical", "horizontal"] }, gap } },
  Grid: { type: "object", additionalProperties: false, required: ["columns"], properties: { columns: { type: "integer", minimum: 1, maximum: 4 }, gap } },
  Tabs: { type: "object", additionalProperties: false, required: ["labels"], properties: { labels: { type: "array", minItems: 1, maxItems: 8, items: text(40) } } },
  Text: { type: "object", additionalProperties: false, required: ["text"], properties: { text: textValue, variant: { enum: ["title", "body", "muted"] } } },
  Alert: { type: "object", additionalProperties: false, required: ["status", "text"], properties: { status: { enum: ["info", "success", "warning", "error"] }, text: textValue } },
  Metric: { type: "object", additionalProperties: false, required: ["label", "value"], properties: { label: text(80), value: numberOrText, unit: text(16) } },
  Table: {
    type: "object",
    additionalProperties: false,
    required: ["items", "columns"],
    properties: {
      items: { $ref: "#/$defs/binding" },
      columns: { type: "array", minItems: 1, maxItems: 12, items: labelled },
      rowId: pointer,
      pageSize: { type: "integer", minimum: 1, maximum: 100 },
      selectionId: ident,
      emptyText: text(200),
    },
  },
  Kanban: {
    type: "object",
    additionalProperties: false,
    required: ["items", "groupPointer", "groups", "cardTitlePointer"],
    properties: {
      items: { $ref: "#/$defs/binding" },
      groupPointer: pointer,
      groups: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: { type: "object", additionalProperties: false, required: ["value", "label"], properties: { value: { type: ["string", "number", "boolean"] }, label: text(80) } },
      },
      cardTitlePointer: pointer,
      cardFields: { type: "array", maxItems: 6, items: labelled },
      rowId: pointer,
      selectionId: ident,
    },
  },
  Form: { type: "object", additionalProperties: false, required: ["formId"], properties: { formId: ident, title: text(80) } },
  TextInput: {
    type: "object",
    additionalProperties: false,
    required: ["name", "label"],
    properties: {
      name: ident,
      label: text(80),
      mode: { enum: ["text", "integer"] },
      required: { type: "boolean" },
      maxLength: { type: "integer", minimum: 1, maximum: 4096 },
      minimum: { type: "integer" },
      maximum: { type: "integer" },
      placeholder: text(80),
    },
  },
  TextArea: { type: "object", additionalProperties: false, required: ["name", "label"], properties: { name: ident, label: text(80), required: { type: "boolean" }, maxLength: { type: "integer", minimum: 1, maximum: 4096 } } },
  Select: {
    type: "object",
    additionalProperties: false,
    required: ["name", "label", "options"],
    properties: {
      name: ident,
      label: text(80),
      required: { type: "boolean" },
      options: { type: "array", minItems: 1, maxItems: 64, items: { type: "object", additionalProperties: false, required: ["value", "label"], properties: { value: text(256), label: text(80) } } },
    },
  },
  Checkbox: { type: "object", additionalProperties: false, required: ["name", "label"], properties: { name: ident, label: text(80) } },
  Button: {
    type: "object",
    additionalProperties: false,
    required: ["label", "command"],
    properties: {
      label: text(40),
      command: ident,
      variant: { enum: ["primary", "secondary", "danger"] },
      confirm: text(200),
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          form: ident,
          selection: { type: "object", additionalProperties: false, required: ["selectionId", "as"], properties: { selectionId: ident, as: ident } },
          constant: { type: "object", maxProperties: 16 },
        },
      },
    },
  },
  BarChart: { $ref: "#/$defs/chart" },
  LineChart: { $ref: "#/$defs/chart" },
  // slot-tree-v2 only (spec §9): asks the Shell to plan a system action; the result and confirmation are Shell UI.
  SystemActionButton: {
    type: "object",
    additionalProperties: false,
    required: ["label", "action"],
    properties: {
      label: text(60),
      action: ident,
      variant: { enum: ["primary", "secondary", "danger"] },
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          form: ident,
          selection: { type: "object", additionalProperties: false, required: ["selectionId", "as"], properties: { selectionId: ident, as: ident } },
          constant: { type: "object", maxProperties: 16 },
        },
      },
    },
  },
};
/**
 * slot-tree-v2 (AppBundle formatVersion 3) list container (review #5): `List` renders its children once per item of
 * an array binding; inside the template `{$bind:{from:"item", pointer}}` reads the current item and a Button /
 * SystemActionButton may pass a field of it as `input.item: {pointer, as}`. v1 schemas and their documents are
 * unchanged (frozen); existing bundles keep their bytes and hashes.
 */
export const LIST_LIMITS = { maxItems: 100, defaultItems: 50, maxTemplateNodes: 24 } as const;
const itemInput = { type: "object", additionalProperties: false, required: ["pointer", "as"], properties: { pointer, as: ident } };
function withItemInput(schema: object): object {
  const s = JSON.parse(JSON.stringify(schema)) as { properties: { input: { properties: Record<string, unknown> } } };
  s.properties.input.properties.item = itemInput;
  return s;
}
const V2_PROPS: Record<string, object> = {
  ...COMPONENT_PROPS,
  Button: withItemInput(COMPONENT_PROPS.Button!),
  SystemActionButton: withItemInput(COMPONENT_PROPS.SystemActionButton!),
  List: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: { $ref: "#/$defs/binding" },
      rowId: pointer,
      maxItems: { type: "integer", minimum: 1, maximum: LIST_LIMITS.maxItems },
      direction: { enum: ["vertical", "horizontal"] },
      gap,
      emptyText: text(200),
    },
  },
};
const V2_ONLY = new Set<string>(["SystemActionButton", "List"]);
export type ComponentType = keyof typeof COMPONENT_PROPS;
/** slot-tree-v1 components (frozen); v2 adds SystemActionButton. */
export const COMPONENT_TYPES = Object.keys(COMPONENT_PROPS).filter((k) => k !== "SystemActionButton") as ComponentType[];
export const COMPONENT_TYPES_V2 = Object.keys(V2_PROPS) as ComponentType[];
const CONTAINERS = new Set<string>(["Stack", "Grid", "Tabs", "Form", "List"]);
const INPUTS = new Set<string>(["TextInput", "TextArea", "Select", "Checkbox"]);

const chartSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data", "xPointer", "series"],
  properties: {
    data: { $ref: "#/$defs/binding" },
    xPointer: pointer,
    series: { type: "array", minItems: 1, maxItems: UI_LIMITS.maxSeries, items: labelled },
    title: text(80),
  },
};

const ajv = new Ajv2020({ allErrors: false, strict: false, coerceTypes: false, useDefaults: false });
const propValidators: Record<string, ValidateFunction> = {};
for (const [name, schema] of Object.entries(COMPONENT_PROPS)) {
  propValidators[name] = ajv.compile({ $defs: { binding: bindingSchema, chart: chartSchema }, ...schema });
}
const propValidatorsV2: Record<string, ValidateFunction> = { ...propValidators };
for (const name of ["Button", "SystemActionButton", "List"]) {
  propValidatorsV2[name] = ajv.compile({ $defs: { binding: bindingSchema, chart: chartSchema }, ...V2_PROPS[name]! });
}
const bindingValidator = ajv.compile(bindingSchema);

/** JSON Schema documents for docs/contracts (one per component plus the binding). */
export function slotTreeSchemaDocument(version: 1 | 2 = 1): object {
  const props = version === 2 ? V2_PROPS : Object.fromEntries(Object.entries(COMPONENT_PROPS).filter(([k]) => k !== "SystemActionButton"));
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `urn:agentos:slot-tree:v${version}`,
    title: `AgentOS Slot Tree v${version} component props`,
    $defs: { binding: bindingSchema, chart: chartSchema, ...props },
  };
}

export function isBinding(v: unknown): v is Binding {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.hasOwn(v, "$bind");
}

/** Read a restricted JSON Pointer over own properties only (no prototype access, no evaluation). */
export function readPointer(root: unknown, ptr: string): unknown {
  if (!POINTER_RE.test(ptr)) return undefined;
  if (ptr === "") return root;
  let cur: unknown = root;
  for (const seg of ptr.slice(1).split("/")) {
    if (RESERVED_KEYS.has(seg)) return undefined;
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]{0,5})$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
    } else if (cur !== null && typeof cur === "object") {
      if (!Object.hasOwn(cur, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    } else return undefined;
  }
  return cur;
}

export interface SlotTreeContext {
  queries: Record<string, { inputSchema: unknown }>;
  commands: Record<string, unknown>;
  /** v2 only: system action handler ids. */
  systemActions?: Record<string, unknown>;
  viewKind?: "slot-tree-v1" | "slot-tree-v2";
}

export interface SlotTreeFacts {
  /** formId -> input names declared inside that form */
  forms: Map<string, Set<string>>;
  /** button bindings: command and the form it reads */
  buttons: { command: string; form?: string; path: string }[];
  selections: Set<string>;
}

/** Validate the view of a CodeBundle. Returns issues plus facts the bundle semantics use (forms, buttons). */
export function checkSlotTree(view: unknown, ctx: SlotTreeContext, root = "/view"): { issues: ValidationIssue[]; facts: SlotTreeFacts } {
  const issues: ValidationIssue[] = [];
  const facts: SlotTreeFacts = { forms: new Map(), buttons: [], selections: new Set() };
  const add = (path: string, message: string, code = "INVALID_SLOT_TREE") => {
    if (issues.length < 40) issues.push({ path, code, message });
  };
  if (view === null || typeof view !== "object" || Array.isArray(view)) {
    add(root, "view must be an object");
    return { issues, facts };
  }
  const v = view as Record<string, unknown>;
  for (const k of Object.keys(v)) if (!["kind", "dataSources", "slots", "refresh"].includes(k)) add(`${root}/${k}`, `unknown view field "${k}"`);
  const wantKind = ctx.viewKind ?? "slot-tree-v1";
  if (v.kind !== wantKind) add(`${root}/kind`, `view.kind must be "${wantKind}"`);
  // data sources
  const sources = v.dataSources;
  const sourceNames = new Set<string>();
  if (sources === null || typeof sources !== "object" || Array.isArray(sources)) add(`${root}/dataSources`, "dataSources must be an object");
  else {
    const entries = Object.entries(sources as Record<string, unknown>);
    if (entries.length > UI_LIMITS.maxDataSources) add(`${root}/dataSources`, `at most ${UI_LIMITS.maxDataSources} data sources`);
    for (const [name, ds] of entries) {
      const p = `${root}/dataSources/${name}`;
      if (!IDENT_RE.test(name) || RESERVED_KEYS.has(name)) add(p, "data source names are ASCII identifiers");
      sourceNames.add(name);
      if (ds === null || typeof ds !== "object" || Array.isArray(ds)) {
        add(p, "data source must be an object");
        continue;
      }
      const d = ds as Record<string, unknown>;
      for (const k of Object.keys(d)) if (k !== "queryId" && k !== "input") add(`${p}/${k}`, `unknown field "${k}"`);
      if (typeof d.queryId !== "string" || !Object.hasOwn(ctx.queries, d.queryId)) add(`${p}/queryId`, `query "${String(d.queryId)}" is not declared`, "UNKNOWN_HANDLER");
      if (d.input !== undefined && (d.input === null || typeof d.input !== "object" || Array.isArray(d.input))) add(`${p}/input`, "input must be an object");
    }
  }
  if (v.refresh !== undefined) {
    const r = v.refresh as Record<string, unknown> | null;
    const s = r && typeof r === "object" ? r.intervalSeconds : undefined;
    if (!r || Object.keys(r).some((k) => k !== "intervalSeconds") || !Number.isSafeInteger(s) || (s as number) < UI_LIMITS.minRefreshSeconds || (s as number) > UI_LIMITS.maxRefreshSeconds) {
      add(`${root}/refresh`, `refresh.intervalSeconds must be an integer ${UI_LIMITS.minRefreshSeconds}..${UI_LIMITS.maxRefreshSeconds}`);
    }
  }
  const slots = v.slots;
  if (slots === null || typeof slots !== "object" || Array.isArray(slots)) {
    add(`${root}/slots`, "slots must be an object");
    return { issues, facts };
  }
  for (const k of Object.keys(slots)) if (!(SLOT_NAMES as readonly string[]).includes(k)) add(`${root}/slots/${k}`, `apps only control the slots ${SLOT_NAMES.join(", ")}`);
  if (!Object.hasOwn(slots, "main")) add(`${root}/slots/main`, "the main slot is required");

  let nodes = 0;
  const bindings: { b: Binding; path: string; inItem: boolean; formId: string | null }[] = [];
  const selectionUses: { id: string; path: string }[] = [];
  const formRefs: { id: string; path: string }[] = [];
  const collectBindings = (value: unknown, path: string, inItem: boolean, formId: string | null, depth = 0) => {
    if (depth > 6) return;
    if (isBinding(value)) {
      if (!bindingValidator(value)) add(path, "invalid binding");
      else bindings.push({ b: value, path, inItem, formId });
      return;
    }
    if (Array.isArray(value)) value.forEach((x, i) => collectBindings(x, `${path}/${i}`, inItem, formId, depth + 1));
    else if (value !== null && typeof value === "object") for (const [k, x] of Object.entries(value)) collectBindings(x, `${path}/${k}`, inItem, formId, depth + 1);
  };
  /** listPath: the enclosing List (null outside a list item); templateNodes counts the nodes of that template. */
  let templateNodes = 0;
  const walk = (node: unknown, path: string, depth: number, formId: string | null, listPath: string | null = null) => {
    const inItem = listPath !== null;
    if (inItem && ++templateNodes === LIST_LIMITS.maxTemplateNodes + 1) add(listPath, `a list item template holds at most ${LIST_LIMITS.maxTemplateNodes} nodes`);
    nodes++;
    if (nodes > UI_LIMITS.maxNodes) {
      if (nodes === UI_LIMITS.maxNodes + 1) add(path, `the tree holds at most ${UI_LIMITS.maxNodes} nodes`);
      return;
    }
    if (depth > UI_LIMITS.maxDepth) return add(path, `the tree is at most ${UI_LIMITS.maxDepth} levels deep`);
    if (node === null || typeof node !== "object" || Array.isArray(node)) return add(path, "node must be an object");
    const n = node as Record<string, unknown>;
    for (const k of Object.keys(n)) if (!["type", "props", "children", "visibleWhen"].includes(k)) add(`${path}/${k}`, `unknown node field "${k}"`);
    const type = n.type;
    if (typeof type !== "string" || !Object.hasOwn(wantKind === "slot-tree-v2" ? V2_PROPS : COMPONENT_PROPS, type)) return add(`${path}/type`, `unknown component "${String(type)}"`);
    if (V2_ONLY.has(type) && wantKind !== "slot-tree-v2") return add(`${path}/type`, `${type} needs slot-tree-v2 (formatVersion 3)`);
    const props = n.props ?? {};
    const validate = (wantKind === "slot-tree-v2" ? propValidatorsV2 : propValidators)[type]!;
    if (!validate(props)) {
      const e = validate.errors?.[0];
      add(`${path}/props${e?.instancePath ?? ""}`, `${type}: ${e?.message ?? "invalid props"}`);
      return;
    }
    const p = props as Record<string, unknown>;
    if (n.visibleWhen !== undefined) {
      const w = n.visibleWhen as Record<string, unknown> | null;
      const okShape =
        w !== null && typeof w === "object" && isBinding(w.value) &&
        ((w.op === "exists" && Object.keys(w).length === 2) ||
          (w.op === "eq" && Object.keys(w).length === 3 && (w.equals === null || ["string", "number", "boolean"].includes(typeof w.equals))));
      if (!okShape) add(`${path}/visibleWhen`, "visibleWhen supports {value, op:'exists'} and {value, op:'eq', equals: scalar}");
      else collectBindings(w!.value, `${path}/visibleWhen/value`, inItem, formId);
    }
    const itemScoped = type === "Table" || type === "Kanban";
    collectBindings(p, `${path}/props`, inItem, formId);
    if (type === "List" && inItem) add(path, "lists cannot be nested");
    if (itemScoped) {
      // columns/cards read the current item through their pointers (an implicit item binding)
      if (typeof p.selectionId === "string") {
        if (inItem) add(`${path}/props/selectionId`, "a selection cannot be declared inside a list item (it would repeat per item)");
        if (facts.selections.has(p.selectionId)) add(`${path}/props/selectionId`, `selection "${p.selectionId}" is declared twice`);
        facts.selections.add(p.selectionId);
      }
    }
    if (type === "Form") {
      if (inItem) add(path, "forms cannot be inside a list item (form ids would repeat per item)");
      if (formId !== null) add(path, "forms cannot be nested");
      const id = p.formId as string;
      if (facts.forms.has(id)) add(`${path}/props/formId`, `form "${id}" is declared twice`);
      facts.forms.set(id, new Set());
      formId = id;
    }
    if (INPUTS.has(type)) {
      if (inItem) add(path, `${type} cannot be inside a list item (input names would repeat per item)`);
      else if (formId === null) add(path, `${type} must be inside a Form`);
      else {
        const names = facts.forms.get(formId)!;
        const name = p.name as string;
        if (names.has(name)) add(`${path}/props/name`, `input "${name}" appears twice in form "${formId}"`);
        names.add(name);
      }
    }
    if (type === "Button") {
      const cmd = p.command as string;
      if (!Object.hasOwn(ctx.commands, cmd)) add(`${path}/props/command`, `command "${cmd}" is not declared`, "UNKNOWN_HANDLER");
      const input = (p.input ?? {}) as { form?: string; selection?: { selectionId: string }; item?: unknown };
      if (input.form !== undefined) formRefs.push({ id: input.form, path: `${path}/props/input/form` });
      if (input.selection !== undefined) selectionUses.push({ id: input.selection.selectionId, path: `${path}/props/input/selection` });
      if (input.item !== undefined && !inItem) add(`${path}/props/input/item`, "input.item is only valid inside a list item");
      facts.buttons.push({ command: cmd, form: input.form, path });
    }
    if (type === "SystemActionButton") {
      const act = p.action as string;
      if (!ctx.systemActions || !Object.hasOwn(ctx.systemActions, act)) add(`${path}/props/action`, `system action "${act}" is not declared`, "UNKNOWN_HANDLER");
      const input = (p.input ?? {}) as { form?: string; selection?: { selectionId: string }; item?: unknown };
      if (input.form !== undefined) formRefs.push({ id: input.form, path: `${path}/props/input/form` });
      if (input.selection !== undefined) selectionUses.push({ id: input.selection.selectionId, path: `${path}/props/input/selection` });
      if (input.item !== undefined && !inItem) add(`${path}/props/input/item`, "input.item is only valid inside a list item");
    }
    const children = n.children;
    if (children !== undefined) {
      if (!CONTAINERS.has(type)) return add(`${path}/children`, `${type} has no children`);
      if (!Array.isArray(children)) return add(`${path}/children`, "children must be an array");
      if (children.length > UI_LIMITS.maxChildren) add(`${path}/children`, `at most ${UI_LIMITS.maxChildren} children`);
      if (type === "Tabs" && children.length !== (p.labels as unknown[]).length) add(`${path}/children`, "Tabs needs one child per label");
      if (type === "List" && children.length === 0) add(`${path}/children`, "List needs an item template (at least one child)");
      if (type === "List" && !inItem) templateNodes = 0;
      const childList = type === "List" ? path : listPath;
      children.forEach((c, i) => walk(c, `${path}/children/${i}`, depth + 1, formId, childList));
    } else if (type === "Tabs") add(`${path}/children`, "Tabs needs one child per label");
    else if (type === "List") add(`${path}/children`, "List needs an item template (at least one child)");
  };
  for (const name of SLOT_NAMES) {
    const node = (slots as Record<string, unknown>)[name];
    if (node !== undefined) walk(node, `${root}/slots/${name}`, 1, null);
  }
  for (const { b, path, inItem } of bindings) {
    const src = b.$bind;
    if (src.from === "query" && !sourceNames.has(src.source)) add(path, `data source "${src.source}" is not declared`);
    if (src.from === "form" && !facts.forms.has(src.formId)) add(path, `form "${src.formId}" is not declared`);
    if (src.from === "selection" && !facts.selections.has(src.selectionId)) add(path, `selection "${src.selectionId}" is not declared`);
    if (src.from === "item" && !inItem) add(path, "item bindings are only valid inside a list item");
  }
  for (const s of selectionUses) if (!facts.selections.has(s.id)) add(s.path, `selection "${s.id}" is not declared`);
  for (const f of formRefs) if (!facts.forms.has(f.id)) add(f.path, `form "${f.id}" is not declared`);
  return { issues, facts };
}
