import { AgentOsError, canonicalJson, sha256Hex, type Capability } from "@agentos/contracts";
import { iso, type Store } from "../persistence/store.js";

/**
 * Who is calling. Built only by the host (HTTP session) or the Pi adapter (tool context);
 * never accepted from a model or a browser payload.
 */
export type Principal =
  | { kind: "user" }
  | { kind: "run"; runId: string; piTaskId: string; toolName: string }
  | { kind: "app"; appId: string; viaUser: boolean };

export function principalKey(p: Principal): string {
  switch (p.kind) {
    case "user":
      return "user:local";
    case "run":
      return `run:${p.runId}`;
    case "app":
      return p.viaUser ? "user:local" : `app:${p.appId}`;
  }
}

/** Domain capabilities and the principals the fixed local policy lets call them. */
export const CAPABILITY_POLICY: Record<string, ReadonlyArray<Principal["kind"]>> = {
  "system.info": ["user", "run"],
  "apps.list": ["user", "run"],
  "apps.get": ["user", "run"],
  "apps.activate.history": ["user"],
  "apps.stage": ["run"],
  "apps.validate": ["run"],
  "apps.activate.agent": ["run"],
  "runs.submit": ["user"],
  "runs.cancel": ["user"],
  "records.read": ["app"],
  "records.write": ["app"],
  // v0.2
  "apps.runtime.control": ["user"],
  "apps.command": ["user"],
  "apps.query": ["user"],
  "grants.manage": ["user"],
  "services.read": ["user", "run"],
  "runtime.catalog": ["user", "run"],
  "deployments.read": ["user", "run"],
  "apps.prepare.agent": ["run"],
};

export function authorize(capability: string, p: Principal): void {
  const allowed = CAPABILITY_POLICY[capability];
  if (allowed === undefined || !allowed.includes(p.kind)) {
    throw new AgentOsError("FORBIDDEN", `${p.kind} principal may not call ${capability}`);
  }
}

/** Records grants: manifest capabilities are a request; the host grants only the app's own private records. */
export function grantRecords(p: Principal, appId: string, requested: readonly Capability[], need: Capability): void {
  if (p.kind !== "app") throw new AgentOsError("FORBIDDEN", "only an app principal may access records");
  if (p.appId !== appId) throw new AgentOsError("FORBIDDEN", "apps may only access their own records");
  if (!requested.includes(need)) throw new AgentOsError("FORBIDDEN", `app did not request ${need}`);
}

export interface WriteRequest {
  principal: Principal;
  operationKey: string;
  /** Hash of method, normalized path, principal and canonical body (HTTP), or tool args (Pi). */
  requestHash: string;
  /** Checked inside the transaction before the receipt lookup (HTTP sessions only). */
  clientEpoch?: number;
}

export interface WriteResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

export function requestHash(parts: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(parts));
}

/** Domain errors that are final answers for an operation and may be stored as its receipt. */
const RECEIPT_ERRORS = new Set([
  "FORBIDDEN", "NOT_FOUND", "RUN_BUSY", "APP_EPOCH_STALE", "RECORD_VERSION_STALE", "ALREADY_APPLIED",
  "INVALID_BUNDLE", "SCHEMA_INCOMPATIBLE", "INVALID_RECORD", "LIMIT_EXCEEDED", "INVALID_REQUEST",
  "INVALID_CODE_BUNDLE", "SOURCE_PATH_INVALID", "UNKNOWN_HANDLER", "INVALID_SLOT_TREE", "DEPENDENCY_NOT_ALLOWED",
  "DEPLOYMENT_REQUIRED", "SERVICE_CONTRACT_MISMATCH", "PREPARE_FAILED", "PREPARE_EXPIRED", "DATA_EPOCH_STALE",
]);

/**
 * The single write path (spec §9): identity/client epoch → receipt → same key different hash 409 →
 * existing receipt replays → fences/CAS and business change → receipt + events → COMMIT.
 */
export class CapabilityGateway {
  constructor(private readonly store: Store) {}

  write<T>(capability: string, req: WriteRequest, fn: () => { status: number; body: T }): WriteResult<T> {
    authorize(capability, req.principal);
    const pkey = principalKey(req.principal);
    const s = this.store;
    const result = s.tx((): WriteResult<T> | { error: AgentOsError } => {
      if (req.clientEpoch !== undefined) {
        const epoch = s.meta().client_epoch;
        if (req.clientEpoch !== epoch) {
          throw new AgentOsError("CLIENT_EPOCH_STALE", "this page belongs to an older workspace state; reload", { clientEpoch: epoch });
        }
      }
      const prior = s.get<{ request_hash: string; status_code: number; result_json: string }>(
        "SELECT request_hash, status_code, result_json FROM operations WHERE principal = ? AND operation_key = ?",
        pkey,
        req.operationKey,
      );
      if (prior !== undefined) {
        if (prior.request_hash !== req.requestHash) {
          throw new AgentOsError("REQUEST_CONFLICT", "this idempotency key was used for a different request");
        }
        const stored = JSON.parse(prior.result_json) as { ok: true; body: T } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };
        if (!stored.ok) {
          throw new AgentOsError(stored.error.code as never, stored.error.message, { ...(stored.error.details ?? {}), replayed: true });
        }
        return { status: prior.status_code, body: stored.body, replayed: true };
      }
      let out: { status: number; body: T };
      try {
        out = s.savepoint(fn);
      } catch (e) {
        if (e instanceof AgentOsError && RECEIPT_ERRORS.has(e.code)) {
          s.run(
            "INSERT INTO operations (principal, operation_key, request_hash, status_code, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            pkey, req.operationKey, req.requestHash, e.status,
            JSON.stringify({ ok: false, error: { code: e.code, message: e.message, details: e.details } }),
            iso(s.clock.now()),
          );
          // Commit the error receipt, then report the error.
          return { error: e };
        }
        throw e;
      }
      s.run(
        "INSERT INTO operations (principal, operation_key, request_hash, status_code, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        pkey, req.operationKey, req.requestHash, out.status, JSON.stringify({ ok: true, body: out.body }), iso(s.clock.now()),
      );
      return { status: out.status, body: out.body, replayed: false };
    });
    if ("error" in result) throw result.error;
    return result;
  }
}
