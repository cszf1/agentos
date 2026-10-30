// Requests the native Shell pages produce (spec §11, §16.1). Every page action maps to exactly one native route or one
// registered workspace.forward route; there is no free-form method/path. Shared with the C++ Shell via vectors.
import { NATIVE_ROUTES, WRITE_ROUTES, type NativeRouteId } from "./native-rpc.js";
import { forward } from "./slot-vectors.js";

export interface ShellRequest {
  methodId: NativeRouteId;
  params: Record<string, unknown>;
  body: unknown;
  /** set for workspace.forward */
  routeId?: string;
  write: boolean;
}

type A = Record<string, unknown>;
const s = (v: unknown) => String(v);
const fw = (routeId: string, params: Record<string, string>, body: unknown): ShellRequest => {
  const f = forward(routeId, params, body, "");
  return { methodId: "workspace.forward", routeId, params: f.params, body: f.body, write: true };
};
const native = (methodId: NativeRouteId, params: Record<string, unknown> = {}, body: unknown = null): ShellRequest => {
  if (!(NATIVE_ROUTES as readonly string[]).includes(methodId)) throw new Error(`unknown native route ${methodId}`);
  return { methodId, params, body, write: WRITE_ROUTES.has(methodId) };
};

/** Hardware/session controls (spec §12.1); each goes through machine.actions.plan, never a direct D-Bus call. */
export const HARDWARE_ACTIONS = [
  "network.wifi.connect",
  "network.wifi.disconnect",
  "audio.volume.set",
  "audio.mute.set",
  "audio.output.select",
  "display.brightness.set",
  "display.mode.set",
  "display.revert",
  "time.timezone.set",
  "time.ntp.set",
  "session.lock",
  "session.logout",
  "power.reboot",
  "power.shutdown",
] as const;
export const DISPLAY_REVERT_SECONDS = 15;

export const SHELL_ACTIONS: Record<string, (a: A) => ShellRequest> = {
  // session / workspaces / members (native routes)
  "session.bind": () => native("session.bind"),
  "session.status": () => native("session.status"),
  "session.end": () => native("session.end"),
  "workspaces.list": () => native("workspaces.list"),
  "workspaces.get": (a) => native("workspaces.get", { workspaceId: a.workspaceId }),
  "workspaces.create": (a) => native("workspaces.create", {}, { displayName: a.displayName }),
  "workspaces.start": (a) => native("workspaces.start", { workspaceId: a.workspaceId }),
  "workspaces.stop": (a) => native("workspaces.stop", { workspaceId: a.workspaceId }),
  "workspaces.archive": (a) => native("workspaces.archive", { workspaceId: a.workspaceId }),
  "workspaces.attach": (a) => native("workspaces.attach", { workspaceId: a.workspaceId }, { expectedClientEpoch: a.expectedClientEpoch }),
  "members.list": (a) => native("members.list", { workspaceId: a.workspaceId }),
  "members.setRole": (a) => native("members.setRole", { workspaceId: a.workspaceId, userId: a.userId }, { role: a.role, expectedMemberVersion: a.expectedMemberVersion }),
  "members.revoke": (a) => native("members.revoke", { workspaceId: a.workspaceId, userId: a.userId }, { expectedMemberVersion: a.expectedMemberVersion }),
  "members.transferOwner": (a) => native("members.transferOwner", { workspaceId: a.workspaceId, userId: a.userId }, { expectedMemberVersion: a.expectedMemberVersion, confirm: a.confirm }),
  "events.subscribe": (a) => native("events.subscribe", { workspaceId: a.workspaceId }, { cursor: a.cursor }),
  "events.ack": (a) => native("events.ack", { workspaceId: a.workspaceId }, { cursor: a.cursor }),
  // machine
  "machine.status": () => native("machine.status"),
  "machine.capabilities": () => native("machine.capabilities"),
  "machine.plan": (a) => native("machine.actions.plan", {}, { actionKind: a.actionKind, params: a.params ?? {} }),
  "machine.confirm": (a) => native("machine.actions.confirm", { operationId: a.operationId }, { planHash: a.planHash, ticket: a.ticket }),
  "machine.get": (a) => native("machine.actions.get", { operationId: a.operationId }),
  "machine.cancel": (a) => native("machine.actions.cancel", { operationId: a.operationId }),
  "machine.users.create": (a) => native("machine.users.create", {}, { userName: a.userName, displayName: a.displayName }),
  "machine.users.disable": (a) => native("machine.users.disable", { userId: a.userId }),
  "updates.check": () => native("updates.check"),
  "updates.prepare": (a) => native("updates.prepare", {}, { releaseId: a.releaseId, manifestHash: a.manifestHash }),
  "updates.activate": (a) => native("updates.activate", {}, { releaseId: a.releaseId }),
  "updates.status": () => native("updates.status"),
  "updates.cancel": (a) => native("updates.cancel", {}, { releaseId: a.releaseId }),
  "backups.create": (a) => native("backups.create", { workspaceId: a.workspaceId }, { scope: a.scope ?? "workspace" }),
  "backups.list": (a) => native("backups.list", { workspaceId: a.workspaceId }),
  "backups.export": (a) => native("backups.export", { backupId: a.backupId }, { targetId: a.targetId }),
  "backups.inspect": (a) => native("backups.inspect", { backupId: a.backupId }),
  "restores.plan": (a) => native("restores.plan", {}, { backupId: a.backupId, mode: a.mode }),
  "restores.confirm": (a) => native("restores.confirm", { restoreId: a.restoreId }, { planHash: a.planHash }),
  "restores.status": (a) => native("restores.status", { restoreId: a.restoreId }),
  "diagnostics.collect": (a) => native("diagnostics.collect", {}, { scope: a.scope, redaction: a.redaction ?? "default" }),
  // workspace.forward (registered Host routes)
  "apps.get": (a) => fw("apps.get", { appId: s(a.appId) }, null),
  "apps.revisions": (a) => fw("apps.revisions.list", { appId: s(a.appId) }, null),
  "apps.lifecycle": (a) => fw("apps.lifecycle.list", { appId: s(a.appId) }, null),
  "app.archive": (a) => fw("apps.archive.post", { appId: s(a.appId) }, { expectedAppEpoch: a.appEpoch }),
  "app.restore": (a) => fw("apps.restore.post", { appId: s(a.appId) }, {}),
  "app.deploy": (a) => fw("apps.deployments.post", { appId: s(a.appId) }, { revisionId: a.revisionId, expectedAppEpoch: a.appEpoch }),
  "deployment.get": (a) => fw("deployments.get", { deploymentId: s(a.deploymentId) }, null),
  "app.runtime": (a) => fw(`apps.runtime.${s(a.action)}.post`, { appId: s(a.appId) }, { expectedAppEpoch: a.appEpoch }),
  "state": () => fw("state.list", {}, null),
  "system": () => fw("system.list", {}, null),
  "runs.list": () => fw("runs.list", {}, { limit: 30 }),
  "runs.get": (a) => fw("runs.get", { runId: s(a.runId) }, null),
  "runs.submit": (a) => fw("runs.post", {}, a.targetAppId ? { intent: a.intent, targetAppId: a.targetAppId, expectedAppEpoch: a.expectedAppEpoch } : { intent: a.intent, targetAppId: null }),
  "runs.cancel": (a) => fw("runs.cancel.post", { runId: s(a.runId) }, {}),
  "runs.transcript": (a) => fw("runs.transcript.list", { runId: s(a.runId) }, null),
  "conversation.compact": (a) => fw("conversations.compactions.post", { id: s(a.conversationId) }, {}),
  "compaction.cancel": (a) => fw("compactions.cancel.post", { id: s(a.compactionId) }, {}),
  "maintenance.state": () => fw("maintenance.state.list", {}, null),
  "maintenance.policies": () => fw("maintenance.policies.list", {}, null),
  "maintenance.jobs": () => fw("maintenance.jobs.list", {}, { limit: 30 }),
  "maintenance.pause": () => fw("maintenance.control.post", {}, { action: "pause" }),
  "maintenance.resume": () => fw("maintenance.control.post", {}, { action: "resume" }),
  "maintenance.policy.approve": (a) => fw("maintenance.policies.approve.post", { id: s(a.policyId) }, { version: a.version, policyHash: a.policyHash }),
  "maintenance.policy.pause": (a) => fw("maintenance.policies.pause.post", { id: s(a.policyId) }, {}),
  "maintenance.job.cancel": (a) => fw("maintenance.jobs.cancel.post", { id: s(a.jobId) }, {}),
  "maintenance.circuit.reset": (a) => fw("maintenance.circuits.reset.post", {}, { targetKind: a.targetKind, targetId: a.targetId }),
  "incidents": () => fw("health.incidents.list", {}, { open: 1 }),
  "notifications": () => fw("notifications.list", {}, null),
  "notification.read": (a) => fw("notifications.read.post", { id: s(a.id) }, {}),
  "proposals": () => fw("proposals.list", {}, null),
  "proposal.accept": (a) => fw("proposals.accept.post", { id: s(a.proposalId) }, { proposalHash: a.proposalHash, expectedAppEpoch: a.baseAppEpoch }),
  "proposal.reject": (a) => fw("proposals.reject.post", { id: s(a.proposalId) }, {}),
  "systemAction.get": (a) => fw("systemactions.get", { actionId: s(a.actionId) }, null),
  "systemAction.confirm": (a) => fw("systemactions.confirm.post", { actionId: s(a.actionId) }, { planHash: a.planHash }),
  "systemAction.cancel": (a) => fw("systemactions.cancel.post", { actionId: s(a.actionId) }, { reason: "用户取消" }),
  "systemAction.resolve": (a) => fw("systemactions.resolve.post", { actionId: s(a.actionId) }, { decision: a.decision, note: a.note, releaseQuarantine: a.decision !== "accept_unknown" }),
  "systemAction.compensate": (a) => fw("systemactions.compensations.post", { actionId: s(a.actionId) }, {}),
  "systemOperations": () => fw("systemoperations.list", {}, null),
  "runtime.catalog": () => fw("runtime.catalog.list", {}, null),
  "app.runtimeStatus": (a) => fw("apps.runtime.list", { appId: s(a.appId) }, null),
};

export function shellAction(name: string, args: A = {}): ShellRequest {
  const f = SHELL_ACTIONS[name];
  if (!f) throw new Error(`unknown shell action ${name}`);
  const r = f(args);
  if (r.methodId === "machine.actions.plan") {
    const kind = (r.body as A).actionKind;
    if (!(HARDWARE_ACTIONS as readonly string[]).includes(String(kind)) && !String(kind).startsWith("machine.")) throw new Error(`unknown actionKind ${String(kind)}`);
  }
  return r;
}

/** Async action display states (spec §11): never treat 202 or an animation end as done. */
export const ACTION_STATES = ["idle", "accepted", "in_progress", "needs_confirmation", "reconciled", "failed", "unknown"] as const;

/** Map a response/operation state to the displayed state. */
export const FINAL_STATES = ["succeeded", "committed", "reconciled", "applied", "cancelled", "cancelled_no_effect", "failed_no_effect", "expired_no_effect", "no_change", "rejected", "completed", "superseded"];
export function displayState(r: { status?: number; state?: string; phase?: string; error?: { code: string } | null }, extraFinal: string[] = []): (typeof ACTION_STATES)[number] {
  const st = String(r.state ?? r.phase ?? "");
  // an authoritative final state wins over its explanatory error (a cancelled run carries error CANCELLED)
  if (FINAL_STATES.includes(st) || extraFinal.includes(st)) return "reconciled";
  if (r.error) return r.error.code === "EFFECT_UNKNOWN" ? "unknown" : "failed";
  if (["planned", "awaiting_confirmation", "needs_confirmation", "ready"].includes(st)) return "needs_confirmation";
  if (["indeterminate", "unknown"].includes(st)) return "unknown";
  if (["failed"].includes(st)) return "failed";
  if (r.status === 202 || ["accepted", "queued"].includes(st)) return "accepted";
  return "in_progress";
}
