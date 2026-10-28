/**
 * @agentos/app-sdk v1 (ABI 1). The only module a generated app needs. It gives handler types, the read-only call
 * context and the services interface for authorized read-only queries of other apps. It has no publish, grant, Pi,
 * container or database API: a command returns a mutation plan and the host decides whether to commit it.
 */
export type FieldValue = string | number | boolean;

export interface RecordEnvelope {
  readonly id: string;
  readonly recordVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly data: Readonly<Record<string, FieldValue>>;
}

export interface ServiceResult<T> {
  readonly output: T;
  readonly target: { readonly appId: string; readonly revisionId: string; readonly dataEpoch: number };
}

/** Read-only calls to services the user connected to this app's imports. */
export interface Services {
  call<T = unknown>(alias: string, input: unknown): Promise<ServiceResult<T>>;
}

export interface BaseContext {
  readonly callId: string;
  readonly appId: string;
  readonly revisionId: string;
  readonly appEpoch: number;
  readonly dataEpoch: number;
  /** Host-provided logical time (ISO 8601 UTC); use it instead of the wall clock for stored values. */
  readonly logicalTime: string;
  readonly deadline: string;
  /** Snapshot of this app's records as of dataEpoch. */
  readonly records: readonly RecordEnvelope[];
}

export interface QueryContext extends BaseContext {
  readonly services: Services;
}

/** Commands cannot call other apps. */
export type CommandContext = BaseContext;

export type Mutation =
  | { kind: "create"; localKey: string; data: Record<string, FieldValue> }
  | { kind: "update"; recordId: string; expectedRecordVersion: number; changes: Record<string, FieldValue> }
  | { kind: "delete"; recordId: string; expectedRecordVersion: number };

export interface CommandResult<R = unknown> {
  result: R;
  mutations: Mutation[];
}

export type QueryHandler<I = any, O = unknown> = (input: I, ctx: QueryContext) => O | Promise<O>;
export type CommandHandler<I = any, R = unknown> = (input: I, ctx: CommandContext) => CommandResult<R> | Promise<CommandResult<R>>;

/** Identity helpers that only add types. */
export function defineQueries<T extends Record<string, QueryHandler>>(q: T): T {
  return q;
}
export function defineCommands<T extends Record<string, CommandHandler>>(c: T): T {
  return c;
}

export const SDK_ABI_VERSION = 1;

declare global {
  // Minimal console for diagnostics (bounded by the host). Apps get no DOM and no Node APIs.
  var console: { log(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
}
