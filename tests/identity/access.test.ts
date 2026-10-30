import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  admitReleaseSequence,
  admitWriteProtocol,
  checkWorkspaceWrite,
  decodeNativeFrame,
  encodeNativeFrame,
  highWaterAfterRollback,
  parseForwardBody,
  parseNativeRequest,
  manifestDigest,
  parseStrictJson,
  sealWorkspaceWrite,
  verifyManifestSignature,
  type ReleaseManifest,
} from "@agentos/contracts";
import { AgentOsError } from "@agentos/contracts";
import { decide, principalDomain, runMayContinue, userFromPeer } from "@agentos/core";

const HASH = `sha256:${"ab".repeat(32)}`;
const WS = "44444444-4444-4444-8444-444444444444";
const USER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const REQ = "55555555-5555-4555-8555-555555555555";
const MACHINE = "11111111-1111-4111-8111-111111111111";

function base(over: Partial<Parameters<typeof decide>[0]> = {}) {
  return {
    memberRole: "editor" as const,
    memberState: "active" as const,
    memberVersion: 3,
    presentedMemberVersion: 3,
    machineAdmin: false,
    action: "write" as const,
    actorUserId: USER,
    taskOwnerUserId: USER,
    sessionBound: true,
    sessionEpoch: 2,
    currentSessionEpoch: 2,
    locked: false,
    accountDisabled: false,
    ...over,
  };
}

function code(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    return e instanceof AgentOsError ? e.code : "OTHER";
  }
  return "OK";
}

const ALLOWED: Record<"viewer" | "editor" | "owner", string[]> = {
  viewer: ["read"],
  editor: ["read", "write", "read_own_task", "cancel_own_task", "suggest_policy"],
  owner: ["read", "write", "read_own_task", "read_any_task", "cancel_own_task", "cancel_any_task", "suggest_policy", "approve_policy", "manage_workspace"],
};

describe("v1 access", () => {
  it("follows the role matrix and does not give a machine admin a data read", () => {
    const actions = ["read", "write", "read_own_task", "read_any_task", "cancel_own_task", "cancel_any_task", "suggest_policy", "approve_policy", "manage_workspace", "machine_admin"] as const;
    for (const role of ["viewer", "editor", "owner"] as const) {
      for (const action of actions) {
        const result = code(() => decide(base({ memberRole: role, action })));
        const want = ALLOWED[role].includes(action) ? "OK" : action === "machine_admin" ? "NOT_FOUND_OR_FORBIDDEN" : "FORBIDDEN";
        expect(result, `${role} ${action}`).toBe(want);
      }
    }
    expect(code(() => decide(base()))).toBe("OK");
    expect(code(() => decide(base({ memberRole: "viewer" })))).toBe("FORBIDDEN");
    expect(code(() => decide(base({ memberRole: "owner", action: "manage_workspace" })))).toBe("OK");
    expect(code(() => decide(base({ memberRole: "editor", action: "approve_policy" })))).toBe("FORBIDDEN");
    expect(code(() => decide(base({ memberRole: "editor", action: "read_any_task" })))).toBe("FORBIDDEN");
    expect(code(() => decide(base({ memberRole: "editor", action: "read_own_task", taskOwnerUserId: OTHER })))).toBe("FORBIDDEN");
    expect(code(() => decide(base({ memberRole: "editor", action: "read_own_task" })))).toBe("OK");
    expect(code(() => decide(base({ memberRole: "owner", action: "cancel_any_task" })))).toBe("OK");
    expect(code(() => decide(base({ memberRole: null, memberState: null, action: "read", machineAdmin: true })))).toBe("NOT_FOUND_OR_FORBIDDEN");
    expect(code(() => decide(base({ action: "machine_admin", machineAdmin: true, memberRole: null, memberState: null })))).toBe("OK");
    expect(code(() => decide(base({ action: "machine_admin" })))).toBe("NOT_FOUND_OR_FORBIDDEN");
  });

  it("rejects a stale session, a lock, a disabled account, and a revoked member", () => {
    expect(code(() => decide(base({ sessionBound: false })))).toBe("SESSION_REQUIRED");
    expect(code(() => decide(base({ sessionEpoch: 1 })))).toBe("SESSION_STALE");
    expect(code(() => decide(base({ locked: true, action: "manage_workspace", memberRole: "owner" })))).toBe("SESSION_LOCKED");
    expect(code(() => decide(base({ locked: true, action: "write" })))).toBe("OK");
    expect(code(() => decide(base({ accountDisabled: true })))).toBe("MEMBERSHIP_REVOKED");
    expect(code(() => decide(base({ memberState: "revoking" })))).toBe("MEMBERSHIP_REVOKED");
    expect(code(() => decide(base({ presentedMemberVersion: 2 })))).toBe("MEMBERSHIP_REVOKED");
  });

  it("keeps an accepted run after logout and stops it when membership or the account changes", () => {
    const run = { runMemberVersion: 3, membership: { state: "active" as const, memberVersion: 3 }, accountDisabled: false };
    expect(runMayContinue(run)).toBe(true);
    expect(runMayContinue({ ...run, accountDisabled: true })).toBe(false);
    expect(runMayContinue({ ...run, membership: { state: "revoked", memberVersion: 4 } })).toBe(false);
    expect(runMayContinue({ ...run, membership: { state: "active", memberVersion: 4 } })).toBe(false);
    expect(runMayContinue({ ...run, membership: null })).toBe(false);
  });

  it("binds the login uid recorded for the account", () => {
    const users = [
      { loginUid: 10000, userId: USER, loginName: "ada", state: "active" as const },
      { loginUid: 10001, userId: OTHER, loginName: "bea", state: "active" as const },
    ];
    expect(userFromPeer(10000, users).userId).toBe(USER);
    expect(code(() => userFromPeer(10001, [{ ...users[1]!, state: "disabled" }]))).toBe("SESSION_REQUIRED");
    expect(code(() => userFromPeer(42, users))).toBe("SESSION_REQUIRED");
  });

  it("uses a new principal domain and leaves the legacy domain literal", () => {
    expect(principalDomain({ kind: "legacy" })).toBe("user:local");
    expect(principalDomain({ kind: "user", userId: USER, workspaceId: WS })).toBe(`user:${USER}:workspace:${WS}`);
  });
});

describe("v1 native rpc and protocol 3", () => {
  it("rejects duplicate keys, unknown fields, and a forward that looks like a URL", () => {
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow(/duplicate/);
    expect(parseStrictJson('{"b":1,"a":2}')).toEqual({ b: 1, a: 2 });
    const ok = JSON.stringify({
      requestId: REQ,
      workspaceId: WS,
      clientEpoch: 1,
      sessionEpoch: 2,
      methodId: "workspaces.list",
    });
    expect(parseNativeRequest(ok).methodId).toBe("workspaces.list");
    expect(() => parseNativeRequest(ok.replace("}", ',"url":"http://x"}'))).toThrow(/unknown field/);
    expect(() => parseNativeRequest(ok.replace('"workspaces.list"', '"workspaces.create"'))).toThrow(/idempotency/);
    expect(() => parseForwardBody({ routeId: "https://evil", params: {}, body: null })).toThrow(/URL/);
    expect(() => parseForwardBody({ routeId: "records.create", url: "/api", params: {}, body: {} })).toThrow(/cannot carry/);
    expect(parseForwardBody({ routeId: "records.create", params: { appId: "a" }, body: { n: 1 } }).routeId).toBe("records.create");
  });

  it("frames a payload and refuses an oversized length", () => {
    const frame = encodeNativeFrame(Buffer.from("{\"a\":1}"));
    expect(Buffer.from(decodeNativeFrame(frame)).toString()).toBe("{\"a\":1}");
    const bad = Buffer.alloc(4);
    bad.writeUInt32BE(5, 0);
    expect(() => decodeNativeFrame(bad)).toThrow(/mismatch/);
    const huge = Buffer.alloc(4);
    huge.writeUInt32BE(4 * 1024 * 1024 + 1, 0);
    expect(() => decodeNativeFrame(huge)).toThrow(/too large/);
  });

  it("seals a protocol 3 write and rejects protocol 1 once the minimum is 3", () => {
    const sealed = sealWorkspaceWrite({
      machineInstallId: MACHINE,
      workspaceId: WS,
      storeUUID: "66666666-6666-4666-8666-666666666666",
      workspaceIncarnation: 2,
      executionUid: 20000,
      principalKind: "user",
      userId: USER,
      memberVersion: 1,
      runId: null,
      executionEpoch: 1,
      machineControlEpoch: 1,
      requestId: REQ,
      deadline: 1_700_000_000_000,
      body: { hello: "世界", n: 1 },
    });
    const checked = checkWorkspaceWrite(JSON.stringify(sealed));
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.write.requestHash).toBe(sealed.requestHash);
    const tampered = { ...sealed, memberVersion: 9 };
    const bad = checkWorkspaceWrite(JSON.stringify(tampered));
    expect(bad.ok).toBe(false);
    expect(admitWriteProtocol(3, 1)).toBe("rejected");
    expect(admitWriteProtocol(3, 2)).toBe("rejected");
    expect(admitWriteProtocol(1, 1)).toBe("ok");
    expect(admitWriteProtocol(3, 3)).toBe("ok");
    expect(sealed.requestHash.startsWith("sha256:")).toBe(true);
    expect(HASH).toMatch(/^sha256:/);
  });
});

describe("v1 release admission", () => {
  const manifest: ReleaseManifest = {
    formatVersion: 1,
    releaseId: MACHINE,
    releaseSequence: 2,
    version: "1.0.1",
    channel: "stable",
    publishedAt: 1_700_000_000_000,
    expiresAt: 1_800_000_000_000,
    supportUntil: 1_800_000_000_000,
    sourceCommit: "a".repeat(40),
    flakeLockHash: HASH,
    nixpkgsRevision: "b".repeat(40),
    platform: "x86_64-linux",
    hardwareProfiles: ["qemu-virtio"],
    baseClosureHash: HASH,
    closureContentHashes: [HASH],
    kernelVersion: "6.12.1",
    initrdHash: HASH,
    ociDigests: [`sha256:${"cd".repeat(32)}`],
    sbomHash: HASH,
    migrationClass: "compatible_expand",
    healthProfile: "v1",
    minRecoveryVersion: "1.0.0",
  };

  it("rejects a bad signature, an expired manifest, a replay, and a breaking migration", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => verifyManifestSignature(manifest, Buffer.from("nope").toString("base64"), pem, manifest.publishedAt)).toThrow(/signature/);
    const signature = sign(null, Buffer.from(manifestDigest(manifest).slice("sha256:".length), "hex"), privateKey).toString("base64");
    expect(() => verifyManifestSignature(manifest, signature, pem, manifest.expiresAt + 1)).toThrow(/expired/);
    verifyManifestSignature(manifest, signature, pem, manifest.publishedAt);
    expect(admitReleaseSequence(2, 2, "none")).toBe("replay");
    expect(admitReleaseSequence(3, 2, "offline_breaking")).toBe("breaking");
    expect(admitReleaseSequence(3, 2, "compatible_expand")).toBe("accept");
    expect(highWaterAfterRollback(4)).toBe(4);
  });
});
