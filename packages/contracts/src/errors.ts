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

const RETRYABLE: ReadonlySet<string> = new Set(["STORE_UNAVAILABLE", "MODEL_UNAVAILABLE", "RUN_BUSY"]);

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
