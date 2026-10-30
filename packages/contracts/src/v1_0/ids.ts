const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^sha256:[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

export function isSha256(v: unknown): v is string {
  return typeof v === "string" && SHA.test(v);
}

export function isSessionId(v: unknown): v is string {
  return typeof v === "string" && HEX64.test(v);
}

export function isCommit(v: unknown): v is string {
  return typeof v === "string" && COMMIT.test(v);
}

export function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
}

export function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

export function isUint32(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 0xffff_ffff;
}
