import { AsyncLocalStorage } from "node:async_hooks";
import { AgentOsError, memberAllows, type MemberRole, type WorkspaceAction } from "@agentos/contracts";
import type { Store } from "../persistence/store.js";

/**
 * Trusted request identity (spec §6.2 WorkspacePrincipal). Set only by the Host's gateway bridge, from the envelope
 * the root session-gateway built after SO_PEERCRED + logind + machine membership checks. Never from a request body.
 */
export interface WorkspaceIdentity {
  kind: "user";
  userId: string;
  workspaceId: string;
  storeUUID: string;
  memberVersion: number;
  role: MemberRole;
  sessionId: string;
  sessionEpoch: number;
  workspaceIncarnation: number;
  requestId: string;
}

export const identityContext = new AsyncLocalStorage<WorkspaceIdentity>();

export function currentIdentity(): WorkspaceIdentity | undefined {
  return identityContext.getStore();
}

/** New v1.0 receipts live in `user:<userId>:workspace:<workspaceId>`; legacy rows keep `user:local` (spec §15.2). */
export function userDomain(): string {
  const id = currentIdentity();
  return id ? `user:${id.userId}:workspace:${id.workspaceId}` : "user:local";
}

/** Capability → member action (spec §7.1). Unlisted capabilities default to `write`. */
const CAP_ACTION: Record<string, WorkspaceAction> = {
  "system.info": "read",
  "apps.list": "read",
  "apps.get": "read",
  "services.read": "read",
  "runtime.catalog": "read",
  "deployments.read": "read",
  "records.read": "read",
  "runs.cancel": "cancel_own_task",
  "grants.manage": "manage_workspace",
  "system.grants.manage": "manage_workspace",
  "system.resources.manage": "manage_workspace",
  "system.actions.confirm": "approve_policy",
  "system.actions.manage": "manage_workspace",
  "maintenance.policies.manage": "approve_policy",
  "maintenance.control": "approve_policy",
  "maintenance.jobs.manage": "approve_policy",
  "maintenance.checks": "suggest_policy",
  "proposals.decide": "approve_policy",
  "settings.budgets": "manage_workspace",
  "conversations.compact": "write",
};

export function actionOf(capability: string): WorkspaceAction {
  return CAP_ACTION[capability] ?? "write";
}

/**
 * Membership check against the Host's mirror of the machine directory (membership_mirror). Run at admission and
 * again inside the commit transaction: a revocation applied in between rejects the commit (spec §7.3, V1-I06).
 */
export function checkMember(store: Store, action: WorkspaceAction, opts: { taskOwnerUserId?: string | null } = {}): void {
  const id = currentIdentity();
  if (!id) return;
  const meta = store.get<{ workspace_id: string | null; store_uuid: string }>("SELECT workspace_id, store_uuid FROM meta WHERE id = 1");
  if (!meta || meta.workspace_id !== id.workspaceId || meta.store_uuid !== id.storeUUID) throw new AgentOsError("NOT_FOUND_OR_FORBIDDEN" as never, "not found");
  const m = store.get<{ member_version: number; role: MemberRole; state: string }>("SELECT member_version, role, state FROM membership_mirror WHERE user_id = ?", id.userId);
  if (!m) throw new AgentOsError("REGISTRY_NOT_SYNCED" as never, "membership is not synced to this workspace yet");
  if (m.state !== "active") throw new AgentOsError("MEMBERSHIP_REVOKED" as never, "membership was revoked");
  if (m.member_version !== id.memberVersion) throw new AgentOsError("MEMBERSHIP_REVOKED" as never, "membership changed; reload");
  let act = action;
  if (action === "cancel_own_task" || action === "read_own_task") {
    const own = opts.taskOwnerUserId !== undefined && opts.taskOwnerUserId === id.userId;
    if (!own) act = action === "cancel_own_task" ? "cancel_any_task" : "read_any_task";
  }
  if (!memberAllows(m.role, act)) throw new AgentOsError("NOT_FOUND_OR_FORBIDDEN" as never, "not found");
}
