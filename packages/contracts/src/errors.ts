export const ERROR_STATUS = {
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  REQUEST_CONFLICT: 409,
  RUN_BUSY: 409,
  APP_EPOCH_STALE: 409,
  RECORD_VERSION_STALE: 409,
  CLIENT_EPOCH_STALE: 409,
  ALREADY_APPLIED: 409,
  INVALID_BUNDLE: 422,
  SCHEMA_INCOMPATIBLE: 422,
  INVALID_RECORD: 422,
  INVALID_REQUEST: 422,
  LIMIT_EXCEEDED: 422,
  UNSUPPORTED_MEDIA_TYPE: 415,
  MODEL_UNAVAILABLE: 503,
  STORE_UNAVAILABLE: 503,
  RECOVERY_BLOCKED: 503,
  INTERNAL: 500,
  // v0.2 (spec §19.2): 422 invalid artifact/input, 409 version/state conflict, 403 permission,
  // 429 resource/concurrency admission, 503 runtime/instance unavailable, 504 synchronous query timeout.
  INVALID_CODE_BUNDLE: 422,
  SOURCE_PATH_INVALID: 422,
  UNKNOWN_HANDLER: 422,
  INVALID_SLOT_TREE: 422,
  ABI_MISMATCH: 422,
  DEPENDENCY_NOT_ALLOWED: 422,
  IMAGE_UNAVAILABLE: 503,
  BUILD_FAILED: 422,
  BUILD_TIMEOUT: 422,
  BUILD_NONDETERMINISTIC: 409,
  ARTIFACT_UNAVAILABLE: 503,
  PREPARE_FAILED: 422,
  PREPARE_EXPIRED: 409,
  DEPLOYMENT_BUSY: 409,
  DEPLOYMENT_REQUIRED: 409,
  INSTANCE_NOT_READY: 503,
  SANDBOX_UNAVAILABLE: 503,
  RUNTIME_STOPPED: 503,
  APP_BUSY: 429,
  APP_TIMEOUT: 504,
  APP_RESOURCE_LIMIT: 503,
  INSTANCE_STALE: 409,
  INVALID_MUTATION: 422,
  DATA_EPOCH_STALE: 409,
  INVOCATION_EXPIRED: 409,
  INVOCATION_LIMIT_EXCEEDED: 429,
  GRANT_REQUIRED: 403,
  GRANT_REVOKED: 403,
  SERVICE_CONTRACT_MISMATCH: 409,
  SERVICE_UNAVAILABLE: 503,
  IPC_DEPTH_EXCEEDED: 403,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** Terminal reasons of a run (stored in runs.error_json.code). */
export type RunErrorCode =
  | "CANCELLED"
  | "DEADLINE_EXCEEDED"
  | "BUDGET_EXCEEDED"
  | "NO_APPLICATION_PUBLISHED"
  | "RECOVERY_BLOCKED"
  | "MODEL_UNAVAILABLE"
  | "MODEL_ERROR";

export interface ErrorBody {
  code: ErrorCode | RunErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

const RETRYABLE: ReadonlySet<string> = new Set([
  "STORE_UNAVAILABLE", "MODEL_UNAVAILABLE", "RUN_BUSY", "APP_BUSY", "INSTANCE_NOT_READY", "SERVICE_UNAVAILABLE",
  "DEPLOYMENT_BUSY", "IMAGE_UNAVAILABLE", "SANDBOX_UNAVAILABLE",
]);

export class AgentOsError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AgentOsError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.retryable = RETRYABLE.has(code);
    this.details = details;
  }
  toBody(): ErrorBody {
    const body: ErrorBody = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

export function isAgentOsError(e: unknown): e is AgentOsError {
  return e instanceof AgentOsError;
}
