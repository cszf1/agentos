/**
 * @agentos/app-sdk v2 (ABI 2). ABI-1 images keep the frozen v1 SDK (runtime/frozen/abi1/sdk); this version adds the
 * provider read interface and system-action plans for formatVersion 3 apps.
 *
 * Original v1 text: @agentos/app-sdk v1 (ABI 1). The only module a generated app needs. It gives handler types, the read-only call
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

/** ABI 2: the uniform envelope of a provider read (spec §10). quality "unavailable" + data.simulated in previews. */
export interface ObservationEnvelope<T = unknown> {
  readonly resourceId: string;
  readonly resourceGeneration: number;
  readonly observedAt: string;
  readonly observationId: string;
  readonly resourceVersion: string | null;
  readonly data: T | null;
  readonly quality: "fresh" | "stale" | "gap" | "unavailable";
}

/** Reads of the resources the user connected to this app's bindings; only declared reads, at most 4 per call. */
export interface Providers {
  read<T = unknown>(bindingAlias: string, capabilityId: string, params?: Record<string, unknown>): Promise<ObservationEnvelope<T>>;
}

export interface QueryContext extends BaseContext {
  readonly services: Services;
  /** ABI 2 only (formatVersion 3 apps): declared provider reads. */
  readonly providers: Providers;
}

/** System-action handlers read declared observations and return ONE plan; they never perform effects. */
export interface SystemActionContext extends BaseContext {
  readonly providers: Providers;
}

export interface SystemPlan<P = Record<string, unknown>> {
  bindingAlias: string;
  capabilityId: string;
  params: P;
  observationIds: string[];
  preview: unknown;
}

export type SystemActionHandler<I = any> = (input: I, ctx: SystemActionContext) => SystemPlan | Promise<SystemPlan>;

export function defineSystemActions<T extends Record<string, SystemActionHandler>>(a: T): T {
  return a;
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

export const SDK_ABI_VERSION = 2;

declare global {
  // Minimal console for diagnostics (bounded by the host). Apps get no DOM and no Node APIs.
  var console: { log(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
  // Timers exist inside the sandbox but are not a reliable scheduler: nothing may depend on them outliving a call.
  function setTimeout(fn: () => void, ms?: number): unknown;
  function clearTimeout(handle: unknown): void;
}
