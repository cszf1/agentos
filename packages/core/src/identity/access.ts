import { AgentOsError, memberAllows, PRIVILEGED_ACTIONS, type MemberRole, type WorkspaceAction } from "@agentos/contracts";

export interface AccessInput {
  memberRole: MemberRole | null;
  memberState: "active" | "revoking" | "revoked" | null;
  memberVersion: number | null;
  presentedMemberVersion: number | null;
  machineAdmin: boolean;
  action: WorkspaceAction;
  actorUserId: string | null;
  taskOwnerUserId: string | null;
  sessionBound: boolean;
  sessionEpoch: number | null;
  currentSessionEpoch: number | null;
  locked: boolean;
  accountDisabled: boolean;
}

export function decide(input: AccessInput): void {
  if (!input.sessionBound) throw new AgentOsError("SESSION_REQUIRED", "a local session is required");
  if (input.sessionEpoch === null || input.currentSessionEpoch === null || input.sessionEpoch !== input.currentSessionEpoch) {
    throw new AgentOsError("SESSION_STALE", "the session epoch is stale");
  }
  if (input.locked && PRIVILEGED_ACTIONS.has(input.action)) throw new AgentOsError("SESSION_LOCKED", "the session is locked");
  if (input.accountDisabled) throw new AgentOsError("MEMBERSHIP_REVOKED", "the account is disabled");
  if (input.action === "machine_admin") {
    if (!input.machineAdmin) throw new AgentOsError("NOT_FOUND_OR_FORBIDDEN", "not allowed");
    return;
  }
  if (input.memberRole === null || input.memberState === null) throw new AgentOsError("NOT_FOUND_OR_FORBIDDEN", "not allowed");
  if (input.memberState !== "active" || input.memberVersion === null || input.presentedMemberVersion !== input.memberVersion) {
    throw new AgentOsError("MEMBERSHIP_REVOKED", "membership is not current");
  }
  if ((input.action === "read_own_task" || input.action === "cancel_own_task") && input.actorUserId !== input.taskOwnerUserId) {
    throw new AgentOsError("FORBIDDEN", "not this member's task");
  }
  if (!memberAllows(input.memberRole, input.action)) throw new AgentOsError("FORBIDDEN", "role does not allow this action");
}

export function runMayContinue(args: {
  runMemberVersion: number;
  membership: { state: "active" | "revoking" | "revoked"; memberVersion: number } | null;
  accountDisabled: boolean;
}): boolean {
  if (args.accountDisabled) return false;
  if (!args.membership || args.membership.state !== "active") return false;
  return args.membership.memberVersion === args.runMemberVersion;
}

export function principalDomain(p: { kind: "legacy" } | { kind: "user"; userId: string; workspaceId: string }): string {
  if (p.kind === "legacy") return "user:local";
  return `user:${p.userId}:workspace:${p.workspaceId}`;
}
