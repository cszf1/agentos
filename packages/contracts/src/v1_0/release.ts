import { verify as cryptoVerify } from "node:crypto";
import { domainHash } from "../v3/broker.js";
import { isCommit, isNonNegativeInt, isPositiveInt, isSha256, isUuid } from "./ids.js";
import { parseStrictJson } from "./json.js";

export const RELEASE_DOMAIN = "agentos.release.manifest.v1";
export type MigrationClass = "none" | "compatible_expand" | "offline_breaking";

export interface ReleaseManifest {
  formatVersion: 1;
  releaseId: string;
  releaseSequence: number;
  version: string;
  channel: string;
  publishedAt: number;
  expiresAt: number;
  supportUntil: number;
  sourceCommit: string;
  flakeLockHash: string;
  nixpkgsRevision: string;
  platform: "x86_64-linux";
  hardwareProfiles: string[];
  baseClosureHash: string;
  closureContentHashes: string[];
  kernelVersion: string;
  initrdHash: string;
  ociDigests: string[];
  sbomHash: string;
  migrationClass: MigrationClass;
  healthProfile: string;
  minRecoveryVersion: string;
}

const KEYS: (keyof ReleaseManifest)[] = [
  "formatVersion",
  "releaseId",
  "releaseSequence",
  "version",
  "channel",
  "publishedAt",
  "expiresAt",
  "supportUntil",
  "sourceCommit",
  "flakeLockHash",
  "nixpkgsRevision",
  "platform",
  "hardwareProfiles",
  "baseClosureHash",
  "closureContentHashes",
  "kernelVersion",
  "initrdHash",
  "ociDigests",
  "sbomHash",
  "migrationClass",
  "healthProfile",
  "minRecoveryVersion",
];

function hashList(v: unknown, label: string): string[] {
  if (!Array.isArray(v) || v.length > 64 || v.some((x) => !isSha256(x))) throw new Error(`${label} must be sha256 hashes`);
  return v;
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("manifest must be an object");
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KEYS.includes(key as keyof ReleaseManifest)) throw new Error(`unknown field ${key}`);
  }
  for (const key of KEYS) {
    if (!(key in obj)) throw new Error(`missing ${key}`);
  }
  if (obj.formatVersion !== 1) throw new Error("formatVersion must be 1");
  if (!isUuid(obj.releaseId)) throw new Error("bad releaseId");
  if (!isPositiveInt(obj.releaseSequence)) throw new Error("bad releaseSequence");
  if (typeof obj.version !== "string" || typeof obj.channel !== "string" || typeof obj.healthProfile !== "string" || typeof obj.minRecoveryVersion !== "string") {
    throw new Error("bad text field");
  }
  if (!isNonNegativeInt(obj.publishedAt) || !isNonNegativeInt(obj.expiresAt) || !isNonNegativeInt(obj.supportUntil)) throw new Error("bad time");
  if (obj.expiresAt < obj.publishedAt || obj.supportUntil < obj.publishedAt) throw new Error("bad time order");
  if (!isCommit(obj.sourceCommit) || !isCommit(obj.nixpkgsRevision)) throw new Error("bad revision");
  if (!isSha256(obj.flakeLockHash) || !isSha256(obj.baseClosureHash) || !isSha256(obj.initrdHash) || !isSha256(obj.sbomHash)) throw new Error("bad hash");
  if (obj.platform !== "x86_64-linux") throw new Error("unsupported platform");
  if (!Array.isArray(obj.hardwareProfiles) || obj.hardwareProfiles.length < 1 || obj.hardwareProfiles.some((p) => typeof p !== "string" || p.length < 1)) {
    throw new Error("bad hardware profiles");
  }
  if (obj.migrationClass !== "none" && obj.migrationClass !== "compatible_expand" && obj.migrationClass !== "offline_breaking") {
    throw new Error("bad migration class");
  }
  if (typeof obj.kernelVersion !== "string" || obj.kernelVersion.length < 1) throw new Error("bad kernel");
  if (!Array.isArray(obj.ociDigests) || obj.ociDigests.some((d) => typeof d !== "string" || !d.startsWith("sha256:"))) throw new Error("bad oci digest");
  return {
    formatVersion: 1,
    releaseId: obj.releaseId,
    releaseSequence: obj.releaseSequence,
    version: obj.version,
    channel: obj.channel,
    publishedAt: obj.publishedAt,
    expiresAt: obj.expiresAt,
    supportUntil: obj.supportUntil,
    sourceCommit: obj.sourceCommit,
    flakeLockHash: obj.flakeLockHash,
    nixpkgsRevision: obj.nixpkgsRevision,
    platform: "x86_64-linux",
    hardwareProfiles: obj.hardwareProfiles as string[],
    baseClosureHash: obj.baseClosureHash,
    closureContentHashes: hashList(obj.closureContentHashes, "closureContentHashes"),
    kernelVersion: obj.kernelVersion,
    initrdHash: obj.initrdHash,
    ociDigests: obj.ociDigests as string[],
    sbomHash: obj.sbomHash,
    migrationClass: obj.migrationClass,
    healthProfile: obj.healthProfile,
    minRecoveryVersion: obj.minRecoveryVersion,
  };
}

export function manifestDigest(manifest: ReleaseManifest): string {
  return domainHash(RELEASE_DOMAIN, manifest);
}

export function verifyManifestSignature(manifest: ReleaseManifest, signatureBase64: string, publicKeyPem: string, nowMs: number): void {
  if (nowMs > manifest.expiresAt) throw new Error("manifest expired");
  if (nowMs > manifest.supportUntil) throw new Error("manifest out of support");
  const digest = Buffer.from(manifestDigest(manifest).slice("sha256:".length), "hex");
  const ok = cryptoVerify(null, digest, publicKeyPem, Buffer.from(signatureBase64, "base64"));
  if (!ok) throw new Error("bad signature");
}

export function admitReleaseSequence(sequence: number, highWater: number, migrationClass: MigrationClass): "accept" | "replay" | "breaking" {
  if (migrationClass === "offline_breaking") return "breaking";
  if (sequence <= highWater) return "replay";
  return "accept";
}

export function highWaterAfterRollback(highWater: number): number {
  return highWater;
}

export function parseReleaseText(text: string): ReleaseManifest {
  return parseReleaseManifest(parseStrictJson(text));
}
