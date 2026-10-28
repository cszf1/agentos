/**
 * Fixed provider capability registry (spec §7). This is platform code: the model and apps can only choose a listed
 * capability and fill parameters inside its schema. The Rust broker carries the same table
 * (native/crates/protocol/src/params.rs); fixtures/v0.3/protocol/vectors.json checks both against the same vectors.
 */
export type ResourceKind = "import-root" | "managed-root" | "service" | "lab-network" | "host-network" | "serial" | "telemetry";
export type ReplayClass = "read-only" | "owned-atomic" | "convergent" | "non-replayable";
export type ExecutionClass = "provider-user" | "broker:file" | "broker:service" | "broker:network" | "broker:serial" | "telemetry";

export interface CapabilityDecl {
  capabilityId: string;
  contractVersion: 1;
  provider: "file" | "service" | "network" | "device" | "telemetry";
  mode: "read" | "write";
  resourceKinds: ResourceKind[];
  replayClass: ReplayClass;
  /** Where a read or an effect runs; depends on the resource kind for reads of files. */
  execution: Partial<Record<ResourceKind, ExecutionClass>>;
  /** Parameter schema (documentation + AJV); the authoritative check is checkProviderParams. */
  inputSchema: Record<string, unknown>;
  outputLimits: Record<string, number>;
  /** Fields of the result an app/model may see. */
  visibleFields: string[];
  /** Whether a standing grant may let it run without per-plan confirmation (spec §8.3). */
  standingAllowed: "always" | "with-explicit-bounds" | "never";
  /** Cross-app service contexts never get provider reads in v0.3 (spec §8.2). */
  crossAppService: false;
  autoExecutable: boolean;
  events: string[];
  lifecycle: { prepareMs: number; dispatchMs: number; verifyMs: number; cancel: string; reconcile: string };
  preconditions: string;
  evidence: string;
  compensation: string | null;
  diagnosticRedLines: string[];
}

const S = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", additionalProperties: false, required, properties: props });
const relPath = { type: "string", maxLength: 1024 };
const LC_READ = { prepareMs: 0, dispatchMs: 750, verifyMs: 0, cancel: "not applicable", reconcile: "re-read; returns a new observation" };

export const CAPABILITIES: readonly CapabilityDecl[] = [
  {
    capabilityId: "file.list", contractVersion: 1, provider: "file", mode: "read", resourceKinds: ["import-root", "managed-root"], replayClass: "read-only",
    execution: { "import-root": "provider-user", "managed-root": "broker:file" },
    inputSchema: S({ path: relPath, cursor: { type: "string", maxLength: 512 }, limit: { type: "integer", minimum: 1, maximum: 200 } }),
    outputLimits: { entries: 200 }, visibleFields: ["path", "entries", "nextCursor"], standingAllowed: "always", crossAppService: false, autoExecutable: true,
    events: ["file_changed", "root_gone", "overflow"], lifecycle: LC_READ, preconditions: "root identity (dev/inode) unchanged", evidence: "directory listing with dirVersion", compensation: null,
    diagnosticRedLines: ["absolute root path is never shown to apps"],
  },
  {
    capabilityId: "file.stat", contractVersion: 1, provider: "file", mode: "read", resourceKinds: ["import-root", "managed-root"], replayClass: "read-only",
    execution: { "import-root": "provider-user", "managed-root": "broker:file" },
    inputSchema: S({ path: relPath }), outputLimits: {}, visibleFields: ["path", "kind", "size", "mtimeMs", "supported"], standingAllowed: "always", crossAppService: false, autoExecutable: true,
    events: [], lifecycle: LC_READ, preconditions: "root identity unchanged", evidence: "fstat of the opened entry", compensation: null, diagnosticRedLines: [],
  },
  {
    capabilityId: "file.read_text", contractVersion: 1, provider: "file", mode: "read", resourceKinds: ["import-root", "managed-root"], replayClass: "read-only",
    execution: { "import-root": "provider-user", "managed-root": "broker:file" },
    inputSchema: S({ path: relPath, maxBytes: { type: "integer", minimum: 1, maximum: 262144 } }, ["path"]),
    outputLimits: { bytes: 262144 }, visibleFields: ["path", "content", "truncated", "size", "version"], standingAllowed: "always", crossAppService: false, autoExecutable: true,
    events: [], lifecycle: LC_READ, preconditions: "regular file, one link, strict UTF-8, unchanged during the read", evidence: "content hash of the whole file", compensation: null,
    diagnosticRedLines: ["file content never enters the generic event log"],
  },
  {
    capabilityId: "file.changes", contractVersion: 1, provider: "file", mode: "read", resourceKinds: ["import-root", "managed-root"], replayClass: "read-only",
    execution: { "import-root": "provider-user", "managed-root": "provider-user" },
    inputSchema: S({ sinceSeq: { type: "integer", minimum: 0 } }), outputLimits: { events: 200 }, visibleFields: ["changes", "gap", "lastSeq"], standingAllowed: "always", crossAppService: false, autoExecutable: true,
    events: ["file_changed"], lifecycle: LC_READ, preconditions: "none", evidence: "inotify cursor with gap flag", compensation: null, diagnosticRedLines: [],
  },
  {
    capabilityId: "file.write_text_atomic", contractVersion: 1, provider: "file", mode: "write", resourceKinds: ["managed-root"], replayClass: "owned-atomic",
    execution: { "managed-root": "broker:file" },
    inputSchema: S({ path: relPath, content: { type: "string", maxLength: 131072 }, expectedVersion: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" }, expectedAbsent: { const: true } }, ["path", "content"]),
    outputLimits: { bytes: 131072 }, visibleFields: ["path", "version"], standingAllowed: "always", crossAppService: false, autoExecutable: false,
    events: ["file_changed"], lifecycle: { prepareMs: 0, dispatchMs: 5000, verifyMs: 5000, cancel: "wins before publication (temp removed, target unchanged)", reconcile: "compare old/new hash, temp and logged phase" },
    preconditions: "expectedAbsent or expectedVersion (content hash); single writer (file worker UID owns the managed root)", evidence: "target content hash after rename + fsync of the directory",
    compensation: "new plan restoring the previous content when the current hash still equals this operation's result", diagnosticRedLines: ["content is not logged"],
  },
  {
    capabilityId: "service.describe", contractVersion: 1, provider: "service", mode: "read", resourceKinds: ["service"], replayClass: "read-only",
    execution: { service: "provider-user" }, inputSchema: S({}), outputLimits: {}, visibleFields: ["unit", "activeState", "subState", "invocationId", "CPUQuotaPerSecUSec", "MemoryMax", "activeEnterTimestampUs"],
    standingAllowed: "always", crossAppService: false, autoExecutable: true, events: ["service_changed"], lifecycle: LC_READ, preconditions: "catalog unit", evidence: "systemd properties read now", compensation: null, diagnosticRedLines: [],
  },
  {
    capabilityId: "service.metrics", contractVersion: 1, provider: "service", mode: "read", resourceKinds: ["service"], replayClass: "read-only",
    execution: { service: "provider-user" }, inputSchema: S({}), outputLimits: {}, visibleFields: ["activeState", "metrics"], standingAllowed: "always", crossAppService: false, autoExecutable: true,
    events: [], lifecycle: LC_READ, preconditions: "catalog unit", evidence: "cgroup v2 cpu.stat / memory.current / pids.current", compensation: null,
    diagnosticRedLines: ["no command lines, environment or memory of other processes"],
  },
  {
    capabilityId: "service.ensure_state", contractVersion: 1, provider: "service", mode: "write", resourceKinds: ["service"], replayClass: "convergent",
    execution: { service: "broker:service" }, inputSchema: S({ state: { enum: ["running", "stopped"] } }, ["state"]), outputLimits: {}, visibleFields: ["activeState", "subState", "invocationId"],
    standingAllowed: "always", crossAppService: false, autoExecutable: false, events: ["service_changed"],
    lifecycle: { prepareMs: 0, dispatchMs: 15000, verifyMs: 15000, cancel: "wins before the job request", reconcile: "read job/InvocationID/actual state; repeat only when the catalog marks the unit safe to restart" },
    preconditions: "unit loaded from the catalog fragment; no restart verb exists", evidence: "JobRemoved result + ActiveState/SubState/InvocationID read after the job",
    compensation: "a new ensure_state plan with the opposite state (program side effects are not undone)", diagnosticRedLines: [],
  },
  {
    capabilityId: "service.set_limit", contractVersion: 1, provider: "service", mode: "write", resourceKinds: ["service"], replayClass: "convergent",
    execution: { service: "broker:service" }, inputSchema: S({ property: { enum: ["CPUQuotaPerSecUSec", "MemoryMax"] }, value: { type: "integer", minimum: 0 } }, ["property", "value"]),
    outputLimits: {}, visibleFields: ["property", "value", "previous", "cgroup"], standingAllowed: "with-explicit-bounds", crossAppService: false, autoExecutable: false, events: ["service_changed"],
    lifecycle: { prepareMs: 0, dispatchMs: 8000, verifyMs: 8000, cancel: "wins before SetUnitProperties", reconcile: "read the property and cgroup file; runtime values are not persisted across boots" },
    preconditions: "one runtime property; value inside install caps ∩ grant bounds", evidence: "property read back + cgroup cpu.max/memory.max",
    compensation: "new plan restoring the previous value when the current value still equals this result", diagnosticRedLines: [],
  },
  {
    capabilityId: "network.snapshot", contractVersion: 1, provider: "network", mode: "read", resourceKinds: ["host-network", "lab-network"], replayClass: "read-only",
    execution: { "host-network": "provider-user", "lab-network": "broker:network" }, inputSchema: S({}), outputLimits: {}, visibleFields: ["links", "addresses", "routes"],
    standingAllowed: "always", crossAppService: false, autoExecutable: true, events: [], lifecycle: LC_READ, preconditions: "none", evidence: "rtnetlink dump", compensation: null, diagnosticRedLines: ["ifindex is only an observation"],
  },
  {
    capabilityId: "network.policy_status", contractVersion: 1, provider: "network", mode: "read", resourceKinds: ["lab-network"], replayClass: "read-only",
    execution: { "lab-network": "broker:network" }, inputSchema: S({}), outputLimits: {}, visibleFields: ["activeProfile", "ruleHash", "ruleCount", "probe"], standingAllowed: "always",
    crossAppService: false, autoExecutable: true, events: [], lifecycle: LC_READ, preconditions: "lab namespace present", evidence: "own table rule hash (no counters) + traffic probe", compensation: null, diagnosticRedLines: [],
  },
  {
    capabilityId: "network.apply_profile", contractVersion: 1, provider: "network", mode: "write", resourceKinds: ["lab-network"], replayClass: "convergent",
    execution: { "lab-network": "broker:network" }, inputSchema: S({ profileId: { enum: ["local-allow", "local-deny"] } }, ["profileId"]), outputLimits: {}, visibleFields: ["profileId", "ruleHash", "probe"],
    standingAllowed: "with-explicit-bounds", crossAppService: false, autoExecutable: false, events: [],
    lifecycle: { prepareMs: 0, dispatchMs: 5000, verifyMs: 5000, cancel: "wins before the batch commit", reconcile: "compare own-table rule hash and probe traffic; never flush the global ruleset" },
    preconditions: "namespace incarnation and catalog hash unchanged", evidence: "normalized rule hash + real TCP probe in the lab namespace",
    compensation: "new plan applying the previous profile when the current rule hash still equals this result", diagnosticRedLines: ["no nft text or table names from requests"],
  },
  {
    capabilityId: "device.list", contractVersion: 1, provider: "device", mode: "read", resourceKinds: ["serial"], replayClass: "read-only",
    execution: { serial: "provider-user" }, inputSchema: S({}), outputLimits: { devices: 32 }, visibleFields: ["devices"], standingAllowed: "always", crossAppService: false, autoExecutable: true,
    events: ["device_add", "device_remove"], lifecycle: LC_READ, preconditions: "none", evidence: "udev metadata", compensation: null, diagnosticRedLines: [],
  },
  {
    capabilityId: "serial.status", contractVersion: 1, provider: "device", mode: "read", resourceKinds: ["serial"], replayClass: "read-only",
    execution: { serial: "broker:serial" }, inputSchema: S({}), outputLimits: { samples: 20 }, visibleFields: ["connected", "session", "samples"], standingAllowed: "always", crossAppService: false, autoExecutable: true,
    events: [], lifecycle: LC_READ, preconditions: "never opens the port", evidence: "udev identity + cached session", compensation: null, diagnosticRedLines: [],
  },
  {
    capabilityId: "serial.exchange", contractVersion: 1, provider: "device", mode: "write", resourceKinds: ["serial"], replayClass: "non-replayable",
    execution: { serial: "broker:serial" },
    inputSchema: S({ command: { enum: ["SAMPLE", "ECHO"] }, count: { type: "integer", minimum: 1, maximum: 8 }, text: { type: "string", pattern: "^[A-Za-z0-9 _-]{1,64}$" } }, ["command"]),
    outputLimits: { frameBytes: 256, responseBytes: 4096 }, visibleFields: ["reqId", "response", "fields"], standingAllowed: "with-explicit-bounds", crossAppService: false, autoExecutable: false, events: [],
    lifecycle: { prepareMs: 0, dispatchMs: 2000, verifyMs: 0, cancel: "wins before the port is opened", reconcile: "dispatch_started without a matching response stays indeterminate; never resent" },
    preconditions: "device identity (devnum + connection generation) unchanged", evidence: "a response matching the request id", compensation: null, diagnosticRedLines: ["raw frames are not logged"],
  },
  {
    capabilityId: "telemetry.summary", contractVersion: 1, provider: "telemetry", mode: "read", resourceKinds: ["service", "telemetry"], replayClass: "read-only",
    execution: { service: "telemetry", telemetry: "telemetry" }, inputSchema: S({}), outputLimits: {}, visibleFields: ["available", "counts", "gap", "kernelDrops", "userDrops"], standingAllowed: "always",
    crossAppService: false, autoExecutable: true, events: ["exec", "exit"], lifecycle: LC_READ, preconditions: "none", evidence: "collector status + cursor", compensation: null, diagnosticRedLines: ["no argv/env/content"],
  },
  {
    capabilityId: "telemetry.events", contractVersion: 1, provider: "telemetry", mode: "read", resourceKinds: ["service", "telemetry"], replayClass: "read-only",
    execution: { service: "telemetry", telemetry: "telemetry" }, inputSchema: S({ sinceSeq: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 500 } }), outputLimits: { events: 500 },
    visibleFields: ["events", "gap", "lastSeq"], standingAllowed: "always", crossAppService: false, autoExecutable: true, events: ["exec", "exit"], lifecycle: LC_READ, preconditions: "none",
    evidence: "events with sourceEpoch/sourceSeq; gaps explicit", compensation: null, diagnosticRedLines: ["missing events never imply success"],
  },
];

export const CATALOG_VERSION = 1;

export function capabilityDecl(id: string): CapabilityDecl | undefined {
  return CAPABILITIES.find((c) => c.capabilityId === id);
}

export class ParamError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const SAFE = Number.MAX_SAFE_INTEGER;

/** Spec §13.2 path rules (identical to Rust check_rel_path). */
export function checkRelPath(p: string, allowRoot: boolean): string[] {
  if (p === "") {
    if (allowRoot) return [];
    throw new ParamError("PATH_SCOPE_VIOLATION", "a file path is required");
  }
  if (Buffer.byteLength(p, "utf8") > 1024) throw new ParamError("PATH_SCOPE_VIOLATION", "path too long");
  if (p.includes("\0") || p.includes("\\")) throw new ParamError("PATH_SCOPE_VIOLATION", "NUL or backslash in path");
  if (p.startsWith("/")) throw new ParamError("PATH_SCOPE_VIOLATION", "absolute paths are not allowed");
  const segs: string[] = [];
  for (const s of p.split("/")) {
    if (s === "") throw new ParamError("PATH_SCOPE_VIOLATION", "empty path segment");
    if (s === "." || s === "..") throw new ParamError("PATH_SCOPE_VIOLATION", "dot segments are not allowed");
    if (Buffer.byteLength(s, "utf8") > 255) throw new ParamError("PATH_SCOPE_VIOLATION", "path segment too long");
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (c < 0x20 || c === 0x7f) throw new ParamError("PATH_SCOPE_VIOLATION", "control characters in path");
    }
    segs.push(s);
  }
  if (segs.length > 16) throw new ParamError("PATH_SCOPE_VIOLATION", "path too deep");
  return segs;
}

function obj(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new ParamError("INVALID_SYSTEM_PLAN", "params must be an object");
  return v as Record<string, unknown>;
}
function only(m: Record<string, unknown>, allowed: string[]) {
  for (const k of Object.keys(m)) if (!allowed.includes(k)) throw new ParamError("INVALID_SYSTEM_PLAN", `unknown parameter "${k}"`);
}
function int(m: Record<string, unknown>, k: string): number | undefined {
  const v = m[k];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > SAFE) throw new ParamError("INVALID_SYSTEM_PLAN", `${k} must be a non-negative integer`);
  return v;
}
function str(m: Record<string, unknown>, k: string): string | undefined {
  const v = m[k];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ParamError("INVALID_SYSTEM_PLAN", `${k} must be a string`);
  return v;
}
const HASH = /^sha256:[0-9a-f]{64}$/;

/** Validate and normalize capability parameters — identical rules and output to the Rust check_params. */
export function checkProviderParams(cap: string, v: unknown): Record<string, unknown> {
  const m = obj(v);
  const out: Record<string, unknown> = {};
  switch (cap) {
    case "file.list": {
      only(m, ["path", "cursor", "limit"]);
      const p = str(m, "path") ?? "";
      checkRelPath(p, true);
      out.path = p;
      const limit = int(m, "limit") ?? 200;
      if (limit === 0 || limit > 200) throw new ParamError("INVALID_SYSTEM_PLAN", "limit must be 1..200");
      out.limit = limit;
      const c = str(m, "cursor");
      if (c !== undefined) {
        if (Buffer.byteLength(c, "utf8") > 512) throw new ParamError("INVALID_SYSTEM_PLAN", "cursor too long");
        out.cursor = c;
      }
      break;
    }
    case "file.stat": {
      only(m, ["path"]);
      const p = str(m, "path") ?? "";
      checkRelPath(p, true);
      out.path = p;
      break;
    }
    case "file.read_text": {
      only(m, ["path", "maxBytes"]);
      const p = str(m, "path");
      if (p === undefined) throw new ParamError("INVALID_SYSTEM_PLAN", "path is required");
      checkRelPath(p, false);
      const mb = int(m, "maxBytes") ?? 262144;
      if (mb === 0 || mb > 262144) throw new ParamError("INVALID_SYSTEM_PLAN", "maxBytes must be 1..262144");
      out.path = p;
      out.maxBytes = mb;
      break;
    }
    case "file.changes":
      only(m, ["sinceSeq"]);
      out.sinceSeq = int(m, "sinceSeq") ?? 0;
      break;
    case "file.write_text_atomic": {
      only(m, ["path", "content", "expectedVersion", "expectedAbsent"]);
      const p = str(m, "path");
      if (p === undefined) throw new ParamError("INVALID_SYSTEM_PLAN", "path is required");
      checkRelPath(p, false);
      const c = str(m, "content");
      if (c === undefined) throw new ParamError("INVALID_SYSTEM_PLAN", "content is required");
      if (Buffer.byteLength(c, "utf8") > 131072) throw new ParamError("LIMIT_EXCEEDED", "content exceeds 131072 bytes");
      const ev = str(m, "expectedVersion");
      if (ev !== undefined && !HASH.test(ev)) throw new ParamError("INVALID_SYSTEM_PLAN", "expectedVersion must be sha256:<hex>");
      let ea = false;
      if (m.expectedAbsent !== undefined) {
        if (m.expectedAbsent !== true) throw new ParamError("INVALID_SYSTEM_PLAN", "expectedAbsent must be true when present");
        ea = true;
      }
      if ((ev !== undefined) === ea) throw new ParamError("INVALID_SYSTEM_PLAN", "give exactly one of expectedVersion or expectedAbsent");
      out.path = p;
      out.content = c;
      if (ev !== undefined) out.expectedVersion = ev;
      else out.expectedAbsent = true;
      break;
    }
    case "service.describe":
    case "service.metrics":
    case "network.snapshot":
    case "network.policy_status":
    case "device.list":
    case "serial.status":
    case "telemetry.summary":
      only(m, []);
      break;
    case "telemetry.events": {
      only(m, ["sinceSeq", "limit"]);
      out.sinceSeq = int(m, "sinceSeq") ?? 0;
      const l = int(m, "limit") ?? 100;
      if (l === 0 || l > 500) throw new ParamError("INVALID_SYSTEM_PLAN", "limit must be 1..500");
      out.limit = l;
      break;
    }
    case "service.ensure_state": {
      only(m, ["state"]);
      const s = str(m, "state");
      if (s !== "running" && s !== "stopped") throw new ParamError("INVALID_SYSTEM_PLAN", "state must be running or stopped");
      out.state = s;
      break;
    }
    case "service.set_limit": {
      only(m, ["property", "value"]);
      const p = str(m, "property");
      if (p === undefined) throw new ParamError("INVALID_SYSTEM_PLAN", "property is required");
      if (p !== "CPUQuotaPerSecUSec" && p !== "MemoryMax") throw new ParamError("INVALID_SYSTEM_PLAN", "property must be CPUQuotaPerSecUSec or MemoryMax");
      const val = int(m, "value");
      if (val === undefined) throw new ParamError("INVALID_SYSTEM_PLAN", "value must be an integer");
      out.property = p;
      out.value = val;
      break;
    }
    case "network.apply_profile": {
      only(m, ["profileId"]);
      const s = str(m, "profileId");
      if (s !== "local-allow" && s !== "local-deny") throw new ParamError("NETWORK_SCOPE_DENIED", "profileId must be one of the installed profiles");
      out.profileId = s;
      break;
    }
    case "serial.exchange": {
      only(m, ["command", "count", "text"]);
      const c = str(m, "command");
      if (c === "SAMPLE") {
        if (m.text !== undefined) throw new ParamError("INVALID_SYSTEM_PLAN", "SAMPLE takes count only");
        const n = int(m, "count") ?? 1;
        if (n === 0 || n > 8) throw new ParamError("INVALID_SYSTEM_PLAN", "count must be 1..8");
        out.command = "SAMPLE";
        out.count = n;
      } else if (c === "ECHO") {
        if (m.count !== undefined) throw new ParamError("INVALID_SYSTEM_PLAN", "ECHO takes text only");
        const t = str(m, "text");
        if (t === undefined) throw new ParamError("INVALID_SYSTEM_PLAN", "text is required");
        if (t.length === 0 || t.length > 64 || !/^[A-Za-z0-9 _-]+$/.test(t)) throw new ParamError("INVALID_SYSTEM_PLAN", "text must be 1..64 of [A-Za-z0-9 _-]");
        out.command = "ECHO";
        out.text = t;
      } else throw new ParamError("INVALID_SYSTEM_PLAN", "command must be SAMPLE or ECHO");
      break;
    }
    default:
      throw new ParamError("CAPABILITY_VERSION_UNSUPPORTED", "unknown capability");
  }
  return out;
}

/** Demo-catalog CPU semantics (spec §14): percent of ONE logical CPU ↔ CPUQuotaPerSecUSec. */
export const cpuPercentToUsec = (pct: number) => Math.round(pct * 10000);
export const usecToCpuPercent = (usec: number) => usec / 10000;
