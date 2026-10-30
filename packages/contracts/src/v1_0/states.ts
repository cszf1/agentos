export const WORKSPACE_STATES = [
  "creating",
  "stopped",
  "starting",
  "running",
  "quiescing",
  "recovery_required",
  "archived",
] as const;
export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

export const PERMIT_STATES = ["queued", "reserved", "in_use", "released", "reconciling", "revoked"] as const;
export type PermitState = (typeof PERMIT_STATES)[number];

export const UPDATE_STATES = [
  "discovered",
  "verified",
  "downloading",
  "staged",
  "waiting_confirmation",
  "quiescing",
  "armed",
  "trial_boot",
  "validating",
  "committed",
  "cancelled",
  "failed_no_switch",
  "rollback_pending",
  "rolled_back",
  "needs_attention",
] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];

export const RESTORE_STATES = [
  "planned",
  "verified",
  "quiescing",
  "staging",
  "replacing",
  "reconciling",
  "complete",
  "recovery_required",
] as const;
export type RestoreState = (typeof RESTORE_STATES)[number];

export const UPDATE_CLOSED: ReadonlySet<UpdateState> = new Set(["cancelled", "failed_no_switch", "rolled_back", "committed"]);

const MACHINE_STATES: Record<string, ReadonlySet<string>> = {
  workspace: new Set(WORKSPACE_STATES),
  permit: new Set(PERMIT_STATES),
  update: new Set(UPDATE_STATES),
  restore: new Set(RESTORE_STATES),
};

const MACHINE_EDGES: Record<string, Record<string, readonly string[]>> = {
  workspace: {
    creating: ["stopped", "recovery_required"],
    stopped: ["starting", "archived"],
    starting: ["running", "recovery_required", "stopped"],
    running: ["quiescing", "recovery_required"],
    quiescing: ["stopped", "recovery_required"],
    recovery_required: ["stopped"],
    archived: [],
  },
  permit: {
    queued: ["reserved", "revoked"],
    reserved: ["in_use", "revoked", "reconciling"],
    in_use: ["released", "reconciling"],
    reconciling: ["released", "revoked"],
    released: [],
    revoked: [],
  },
  update: {
    discovered: ["verified", "failed_no_switch"],
    verified: ["downloading", "failed_no_switch", "cancelled"],
    downloading: ["staged", "failed_no_switch", "cancelled"],
    staged: ["waiting_confirmation", "failed_no_switch", "cancelled"],
    waiting_confirmation: ["quiescing", "cancelled"],
    quiescing: ["armed", "needs_attention"],
    armed: ["trial_boot"],
    trial_boot: ["validating", "rollback_pending"],
    validating: ["committed", "rollback_pending", "needs_attention"],
    rollback_pending: ["rolled_back"],
    needs_attention: ["cancelled"],
    committed: [],
    cancelled: [],
    failed_no_switch: [],
    rolled_back: [],
  },
  restore: {
    planned: ["verified", "recovery_required"],
    verified: ["quiescing", "recovery_required"],
    quiescing: ["staging", "recovery_required"],
    staging: ["replacing", "recovery_required"],
    replacing: ["reconciling", "recovery_required"],
    reconciling: ["complete", "recovery_required"],
    complete: [],
    recovery_required: [],
  },
};

export function assertTransition(machine: "workspace" | "permit" | "update" | "restore", from: string, to: string): void {
  const states = MACHINE_STATES[machine]!;
  if (!states.has(from) || !states.has(to)) throw new Error(`unknown ${machine} state`);
  const next = MACHINE_EDGES[machine]![from] ?? [];
  if (!next.includes(to)) throw new Error(`${machine} cannot move ${from} → ${to}`);
}
