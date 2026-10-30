export type MemberRole = "viewer" | "editor" | "owner";

export type WorkspaceAction =
  | "read"
  | "write"
  | "read_own_task"
  | "read_any_task"
  | "cancel_own_task"
  | "cancel_any_task"
  | "suggest_policy"
  | "approve_policy"
  | "manage_workspace"
  | "machine_admin";

const MATRIX: Record<WorkspaceAction, ReadonlySet<MemberRole>> = {
  read: new Set(["viewer", "editor", "owner"]),
  write: new Set(["editor", "owner"]),
  read_own_task: new Set(["editor", "owner"]),
  read_any_task: new Set(["owner"]),
  cancel_own_task: new Set(["editor", "owner"]),
  cancel_any_task: new Set(["owner"]),
  suggest_policy: new Set(["editor", "owner"]),
  approve_policy: new Set(["owner"]),
  manage_workspace: new Set(["owner"]),
  machine_admin: new Set(),
};

export function memberAllows(role: MemberRole, action: WorkspaceAction): boolean {
  return MATRIX[action].has(role);
}

export const PRIVILEGED_ACTIONS: ReadonlySet<WorkspaceAction> = new Set([
  "approve_policy",
  "manage_workspace",
  "machine_admin",
]);
