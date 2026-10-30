import { describe, expect, it } from "vitest";
import { AgentOsError } from "@agentos/contracts";
import { MachineDirectory, chooseWaiter } from "@agentos/core";
import { tmpDir } from "../helpers.js";
import path from "node:path";

const BOOT = "11111111-1111-4111-8111-111111111111";
const BOOT2 = "99999999-9999-4999-8999-999999999999";
const PROV_A = "22222222-2222-4222-8222-222222222222";
const PROV_B = "33333333-3333-4333-8333-333333333333";
const PROV_C = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_A = "44444444-4444-4444-8444-444444444444";
const STORE_B = "55555555-5555-4555-8555-555555555555";
const CREATE_A = "66666666-6666-4666-8666-666666666666";
const CREATE_B = "77777777-7777-4777-8777-777777777777";
const HASH = `sha256:${"ab".repeat(32)}`;
const HASH2 = `sha256:${"cd".repeat(32)}`;

function code(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    return e instanceof AgentOsError ? e.code : `OTHER:${e instanceof Error ? e.message : e}`;
  }
  return "OK";
}

function open(now = 1_700_000_000_000): { dir: MachineDirectory; file: string; setNow: (n: number) => void } {
  const folder = tmpDir("agentos-machine-");
  let t = now;
  const dir = MachineDirectory.open(path.join(folder, "machine.sqlite"), { now: () => t });
  return { dir, file: path.join(folder, "machine.sqlite"), setNow: (n) => { t = n; } };
}

describe("machine directory", () => {
  it("keeps one machine identity and does not adopt an existing account name", () => {
    const { dir, file } = open();
    const first = dir.ensureInstall(BOOT);
    expect(dir.ensureInstall(BOOT).machineInstallId).toBe(first.machineInstallId);
    expect(code(() => dir.ensureInstall(BOOT2))).toBe("IDEMPOTENCY_CONFLICT");
    const ada = dir.provisionUser(PROV_A, { loginName: "ada", role: "admin" });
    dir.close();
    const again = MachineDirectory.open(file);
    const same = again.provisionUser(PROV_A, { loginName: "ada", role: "admin" });
    expect(same).toEqual(ada);
    expect(code(() => again.provisionUser(PROV_B, { loginName: "ada", role: "user" }))).toBe("NAME_TAKEN");
    again.disableUser(ada.userId);
    expect(code(() => again.provisionUser(PROV_C, { loginName: "ada", role: "user" }))).toBe("NAME_TAKEN");
    expect(again.provisionUser(PROV_B, { loginName: "bea", role: "user" }).loginUid).not.toBe(ada.loginUid);
    again.close();
  });

  it("hides a half-created workspace and keeps the other workspace when one stops", () => {
    const { dir } = open();
    dir.ensureInstall(BOOT);
    const ada = dir.provisionUser(PROV_A, { loginName: "ada", role: "user" });
    const bea = dir.provisionUser(PROV_B, { loginName: "bea", role: "user" });
    const partial = dir.applyWorkspaceStep(CREATE_A, "account", { ownerUserId: ada.userId, storeUUID: STORE_A });
    expect(partial.state).toBe("creating");
    expect(dir.listVisible(ada.userId)).toEqual([]);
    expect(dir.listVisible(bea.userId)).toEqual([]);
    const wsA = dir.createWorkspace(CREATE_A, { ownerUserId: ada.userId, storeUUID: STORE_A });
    const wsB = dir.createWorkspace(CREATE_B, { ownerUserId: bea.userId, storeUUID: STORE_B });
    expect(wsA.state).toBe("stopped");
    expect(wsA.executionUid).not.toBe(wsB.executionUid);
    expect(dir.listVisible(ada.userId).map((w) => w.workspaceId)).toEqual([wsA.workspaceId]);
    expect(dir.listVisible(bea.userId).map((w) => w.workspaceId)).toEqual([wsB.workspaceId]);
    expect(code(() => dir.createWorkspace("88888888-8888-4888-8888-888888888888", { ownerUserId: ada.userId, storeUUID: STORE_A }))).toBe("STORE_ALREADY_REGISTERED");
    dir.startWorkspace(wsA.workspaceId);
    dir.startWorkspace(wsB.workspaceId);
    dir.stopWorkspace(wsA.workspaceId);
    expect(dir.listVisible(bea.userId)[0]!.state).toBe("running");
    expect(dir.listVisible(ada.userId)[0]!.state).toBe("stopped");
    dir.close();
  });

  it("revokes future writes, keeps the revocation incomplete until every ack, and refuses the last owner", () => {
    const { dir } = open();
    dir.ensureInstall(BOOT);
    const ada = dir.provisionUser(PROV_A, { loginName: "ada", role: "user" });
    const bea = dir.provisionUser(PROV_B, { loginName: "bea", role: "user" });
    const ws = dir.createWorkspace(CREATE_A, { ownerUserId: ada.userId, storeUUID: STORE_A });
    dir.setRole(ada.userId, ws.workspaceId, bea.userId, "viewer");
    const editor = dir.setRole(ada.userId, ws.workspaceId, bea.userId, "editor");
    expect(editor.memberVersion).toBe(2);
    dir.authorize({ actorUserId: bea.userId, workspaceId: ws.workspaceId, action: "write", presentedMemberVersion: 2, sessionEpoch: 1, currentSessionEpoch: 1, locked: false, taskOwnerUserId: null });
    const rev = dir.revokeMember(ada.userId, "12121212-1212-4121-8121-121212121212", ws.workspaceId, bea.userId);
    expect(rev.state).toBe("revoking");
    expect(code(() => dir.authorize({ actorUserId: bea.userId, workspaceId: ws.workspaceId, action: "write", presentedMemberVersion: rev.newVersion, sessionEpoch: 1, currentSessionEpoch: 1, locked: false, taskOwnerUserId: null }))).toBe("MEMBERSHIP_REVOKED");
    const mid = dir.ackRevocation(rev.revocationId, "gateway");
    expect(mid.state).toBe("revoking");
    dir.ackRevocation(rev.revocationId, "host");
    const done = dir.ackRevocation(rev.revocationId, "broker");
    expect(done.state).toBe("revoked");
    expect(code(() => dir.revokeMember(ada.userId, "13131313-1313-4131-8131-131313131313", ws.workspaceId, ada.userId))).toBe("INVALID_REQUEST");
    dir.close();
  });

  it("does not let one workspace take both model slots while another is waiting, and a restart does not free them", () => {
    const { dir } = open();
    dir.ensureInstall(BOOT);
    const ada = dir.provisionUser(PROV_A, { loginName: "ada", role: "user" });
    const bea = dir.provisionUser(PROV_B, { loginName: "bea", role: "user" });
    const wsA = dir.createWorkspace(CREATE_A, { ownerUserId: ada.userId, storeUUID: STORE_A });
    const wsB = dir.createWorkspace(CREATE_B, { ownerUserId: bea.userId, storeUUID: STORE_B });
    const common = { executionEpoch: 1, ownerKind: "user", resourceClass: "model" as const, bodyHash: HASH, memberVersion: 1, background: false };
    const a1 = dir.reservePermit({ ...common, workspaceId: wsA.workspaceId, ownerId: ada.userId, attemptId: "a1" });
    const b1 = dir.reservePermit({ ...common, workspaceId: wsB.workspaceId, ownerId: bea.userId, attemptId: "b1" });
    expect(a1.state).toBe("reserved");
    expect(b1.state).toBe("reserved");
    const a2 = dir.reservePermit({ ...common, workspaceId: wsA.workspaceId, ownerId: ada.userId, attemptId: "a2" });
    expect(a2.state).toBe("queued");
    expect(dir.reservePermit({ ...common, workspaceId: wsA.workspaceId, ownerId: ada.userId, attemptId: "a1" }).permitId).toBe(a1.permitId);
    expect(code(() => dir.reservePermit({ ...common, workspaceId: wsA.workspaceId, ownerId: ada.userId, attemptId: "a1", bodyHash: HASH2 }))).toBe("IDEMPOTENCY_CONFLICT");
    expect(dir.reconcilePermits()).toBe(2);
    expect(dir.heldSlots("model")).toBe(2);
    expect(dir.reservePermit({ ...common, workspaceId: wsA.workspaceId, ownerId: ada.userId, attemptId: "a2" }).state).toBe("queued");
    expect(code(() => dir.confirmSlot(a1.permitId, "unused", false))).toBe("PERMIT_RECONCILING");
    expect(dir.confirmSlot(a1.permitId, "unknown", true).usageStatus).toBe("unknown");
    expect(dir.chargedPermits()).toBe(1);
    expect(dir.heldSlots("model")).toBe(1);
    dir.close();
  });

  it("refuses an older release sequence and does not lower the high water on known-good rollback", () => {
    const { dir } = open();
    dir.ensureInstall(BOOT);
    const rel1 = "14141414-1414-4141-8141-141414141414";
    const rel2 = "15151515-1515-4151-8151-151515151515";
    dir.acceptRelease({ releaseId: rel1, sequence: 1, manifestHash: HASH, migrationClass: "none" });
    expect(code(() => dir.acceptRelease({ releaseId: "16161616-1616-4161-8161-161616161616", sequence: 1, manifestHash: HASH, migrationClass: "none" }))).toBe("RELEASE_REPLAYED");
    expect(code(() => dir.acceptRelease({ releaseId: rel2, sequence: 2, manifestHash: HASH2, migrationClass: "offline_breaking" }))).toBe("MIGRATION_REQUIRED");
    dir.acceptRelease({ releaseId: rel2, sequence: 2, manifestHash: HASH2, migrationClass: "compatible_expand" });
    const update = "17171717-1717-4171-8171-171717171717";
    dir.openUpdate(update, rel2);
    for (const state of ["verified", "downloading", "staged", "waiting_confirmation", "quiescing", "armed", "trial_boot", "validating", "committed"] as const) {
      dir.advanceUpdate(update, state);
    }
    const rolled = dir.rollbackKnownGood();
    expect(rolled.releaseId).toBe(rel2);
    expect(rolled.highWater).toBe(2);
    expect(dir.acceptedSequence()).toBe(2);
    dir.close();
  });

  it("keeps current revocations during restore and stores a legacy receipt hash unchanged", () => {
    const { dir } = open();
    dir.ensureInstall(BOOT);
    const ada = dir.provisionUser(PROV_A, { loginName: "ada", role: "admin" });
    const bea = dir.provisionUser(PROV_B, { loginName: "bea", role: "user" });
    const ws = dir.createWorkspace(CREATE_A, { ownerUserId: ada.userId, storeUUID: STORE_A });
    dir.setRole(ada.userId, ws.workspaceId, bea.userId, "viewer");
    const rev = dir.revokeMember(ada.userId, "18181818-1818-4181-8181-181818181818", ws.workspaceId, bea.userId);
    const setId = "19191919-1919-4191-8191-191919191919";
    dir.createCheckpoint(setId);
    expect(code(() => dir.planRestore("1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a", setId, "same-machine"))).toBe("CHECKPOINT_INCOMPLETE");
    dir.completeCheckpoint(setId, HASH);
    const restoreId = "1b1b1b1b-1b1b-41b1-81b1-1b1b1b1b1b1b";
    dir.planRestore(restoreId, setId, "same-machine");
    expect(dir.businessWritesOpen()).toBe(false);
    expect(code(() => dir.reservePermit({
      workspaceId: ws.workspaceId, executionEpoch: 1, ownerKind: "user", ownerId: ada.userId, attemptId: "z", resourceClass: "model", bodyHash: HASH, memberVersion: 1, background: false,
    }))).toBe("RESTORE_IN_PROGRESS");
    const applied = dir.applyMemberSnapshot(ws.workspaceId, [
      { userId: bea.userId, role: "editor", state: "active" },
      { userId: ada.userId, role: "viewer", state: "active" },
    ]);
    expect(applied.rejected).toEqual([bea.userId, ada.userId]);
    expect(applied.members.find((m) => m.userId === bea.userId)).toMatchObject({ state: "revoking", memberVersion: rev.newVersion });
    expect(applied.members.find((m) => m.userId === ada.userId)?.role).toBe("owner");
    for (const state of ["verified", "quiescing", "staging", "replacing", "reconciling", "complete"] as const) dir.advanceRestore(restoreId, state);
    expect(dir.businessWritesOpen()).toBe(true);
    const imported = dir.importLegacy({ importId: CREATE_B, ownerUserId: ada.userId, storeUUID: STORE_B, receiptHash: HASH });
    expect(imported.legacyPolicyState).toBe("paused_needs_review");
    expect(dir.legacyBinding(STORE_B)).toEqual({ receiptHash: HASH, legacyPrincipal: "user:local" });
    expect(code(() => dir.importLegacy({ importId: "1c1c1c1c-1c1c-41c1-81c1-1c1c1c1c1c1c", ownerUserId: ada.userId, storeUUID: STORE_B, receiptHash: HASH2 }))).toBe("STORE_ALREADY_REGISTERED");
    dir.close();
  });
});

describe("model permit choice", () => {
  it("gives the waiting workspace the next slot", () => {
    const choice = chooseWaiter(
      [
        { workspaceId: "a", seq: 1, background: false },
        { workspaceId: "b", seq: 2, background: false },
      ],
      [{ workspaceId: "a", background: false }],
      1,
    );
    expect(choice?.workspaceId).toBe("b");
    expect(chooseWaiter([{ workspaceId: "a", seq: 3, background: false }], [{ workspaceId: "a", background: false }], 1)?.workspaceId).toBe("a");
    expect(chooseWaiter([{ workspaceId: "a", seq: 4, background: true }], [{ workspaceId: "b", background: false }], 1)).toBeNull();
  });
});
