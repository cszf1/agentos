// Generated from the Host route table; scripts/export-contracts.mjs --check keeps docs/contracts/forward-routes.json in step.
// workspace.forward carries only a routeId from this table plus path params; the gateway never accepts a URL, method or header.
export interface ForwardRoute { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; write: boolean }
export const FORWARD_ROUTES: Readonly<Record<string, ForwardRoute>> = {
  "agentprofiles.list": { method: "GET", path: "/api/agent-profiles", write: false },
  "apps.activate.post": { method: "POST", path: "/api/apps/:appId/activate", write: true },
  "apps.archive.post": { method: "POST", path: "/api/apps/:appId/archive", write: true },
  "apps.commands.post": { method: "POST", path: "/api/apps/:appId/commands/:commandId", write: true },
  "apps.deployments.post": { method: "POST", path: "/api/apps/:appId/deployments", write: true },
  "apps.get": { method: "GET", path: "/api/apps/:appId", write: false },
  "apps.imports.list": { method: "GET", path: "/api/apps/:appId/imports", write: false },
  "apps.lifecycle.list": { method: "GET", path: "/api/apps/:appId/lifecycle", write: false },
  "apps.queries.post": { method: "POST", path: "/api/apps/:appId/queries/:queryId", write: true },
  "apps.records.delete": { method: "DELETE", path: "/api/apps/:appId/records/:recordId", write: true },
  "apps.records.list": { method: "GET", path: "/api/apps/:appId/records", write: false },
  "apps.records.patch": { method: "PATCH", path: "/api/apps/:appId/records/:recordId", write: true },
  "apps.records.post": { method: "POST", path: "/api/apps/:appId/records", write: true },
  "apps.restore.post": { method: "POST", path: "/api/apps/:appId/restore", write: true },
  "apps.revisions.list": { method: "GET", path: "/api/apps/:appId/revisions", write: false },
  "apps.runtime.list": { method: "GET", path: "/api/apps/:appId/runtime", write: false },
  "apps.runtime.restart.post": { method: "POST", path: "/api/apps/:appId/runtime/restart", write: true },
  "apps.runtime.start.post": { method: "POST", path: "/api/apps/:appId/runtime/start", write: true },
  "apps.runtime.stop.post": { method: "POST", path: "/api/apps/:appId/runtime/stop", write: true },
  "apps.systemactions.post": { method: "POST", path: "/api/apps/:appId/system-actions/:handlerId", write: true },
  "apps.systembindings.list": { method: "GET", path: "/api/apps/:appId/system-bindings", write: false },
  "compactions.cancel.post": { method: "POST", path: "/api/compactions/:id/cancel", write: true },
  "conversations.compactions.list": { method: "GET", path: "/api/conversations/:id/compactions", write: false },
  "conversations.compactions.post": { method: "POST", path: "/api/conversations/:id/compactions", write: true },
  "deployments.get": { method: "GET", path: "/api/deployments/:deploymentId", write: false },
  "health.incidents.list": { method: "GET", path: "/api/health/incidents", write: false },
  "invocations.get": { method: "GET", path: "/api/invocations/:invocationId", write: false },
  "maintenance.checks.post": { method: "POST", path: "/api/maintenance/checks", write: true },
  "maintenance.circuits.reset.post": { method: "POST", path: "/api/maintenance/circuits/reset", write: true },
  "maintenance.clock.recheck.post": { method: "POST", path: "/api/maintenance/clock/recheck", write: true },
  "maintenance.control.post": { method: "POST", path: "/api/maintenance/control", write: true },
  "maintenance.jobs.approve.post": { method: "POST", path: "/api/maintenance/jobs/:id/approve", write: true },
  "maintenance.jobs.cancel.post": { method: "POST", path: "/api/maintenance/jobs/:id/cancel", write: true },
  "maintenance.jobs.get": { method: "GET", path: "/api/maintenance/jobs/:id", write: false },
  "maintenance.jobs.list": { method: "GET", path: "/api/maintenance/jobs", write: false },
  "maintenance.policies.approve.post": { method: "POST", path: "/api/maintenance/policies/:id/approve", write: true },
  "maintenance.policies.list": { method: "GET", path: "/api/maintenance/policies", write: false },
  "maintenance.policies.pause.post": { method: "POST", path: "/api/maintenance/policies/:id/pause", write: true },
  "maintenance.policies.post": { method: "POST", path: "/api/maintenance/policies", write: true },
  "maintenance.reports.list": { method: "GET", path: "/api/maintenance/reports", write: false },
  "maintenance.settings.post": { method: "POST", path: "/api/maintenance/settings", write: true },
  "maintenance.state.list": { method: "GET", path: "/api/maintenance/state", write: false },
  "maintenance.templates.list": { method: "GET", path: "/api/maintenance/templates", write: false },
  "notifications.list": { method: "GET", path: "/api/notifications", write: false },
  "notifications.read.post": { method: "POST", path: "/api/notifications/:id/read", write: true },
  "observations.list": { method: "GET", path: "/api/observations", write: false },
  "proposals.accept.post": { method: "POST", path: "/api/proposals/:id/accept", write: true },
  "proposals.list": { method: "GET", path: "/api/proposals", write: false },
  "proposals.reject.post": { method: "POST", path: "/api/proposals/:id/reject", write: true },
  "providergrants.list": { method: "GET", path: "/api/provider-grants", write: false },
  "providergrants.post": { method: "POST", path: "/api/provider-grants", write: true },
  "providergrants.revoke.post": { method: "POST", path: "/api/provider-grants/:grantId/revoke", write: true },
  "providers.list": { method: "GET", path: "/api/providers", write: false },
  "runs.cancel.post": { method: "POST", path: "/api/runs/:runId/cancel", write: true },
  "runs.get": { method: "GET", path: "/api/runs/:runId", write: false },
  "runs.list": { method: "GET", path: "/api/runs", write: false },
  "runs.post": { method: "POST", path: "/api/runs", write: true },
  "runs.transcript.list": { method: "GET", path: "/api/runs/:runId/transcript", write: false },
  "runtime.catalog.list": { method: "GET", path: "/api/runtime/catalog", write: false },
  "servicegrants.list": { method: "GET", path: "/api/service-grants", write: false },
  "servicegrants.post": { method: "POST", path: "/api/service-grants", write: true },
  "servicegrants.revoke.post": { method: "POST", path: "/api/service-grants/:grantId/revoke", write: true },
  "services.list": { method: "GET", path: "/api/services", write: false },
  "state.list": { method: "GET", path: "/api/state", write: false },
  "system.list": { method: "GET", path: "/api/system", write: false },
  "systemactions.cancel.post": { method: "POST", path: "/api/system-actions/:actionId/cancel", write: true },
  "systemactions.compensations.post": { method: "POST", path: "/api/system-actions/:actionId/compensations", write: true },
  "systemactions.confirm.post": { method: "POST", path: "/api/system-actions/:actionId/confirm", write: true },
  "systemactions.get": { method: "GET", path: "/api/system-actions/:actionId", write: false },
  "systemactions.resolve.post": { method: "POST", path: "/api/system-actions/:actionId/resolve", write: true },
  "systemoperations.list": { method: "GET", path: "/api/system-operations", write: false },
  "systemresources.importroots.post": { method: "POST", path: "/api/system-resources/import-roots", write: true },
  "systemresources.list": { method: "GET", path: "/api/system-resources", write: false },
  "systemresources.maintenancecontrol.post": { method: "POST", path: "/api/system-resources/:id/maintenance-control", write: true },
  "systemresources.read.post": { method: "POST", path: "/api/system-resources/:resourceId/read", write: true },
};

export function forwardPath(routeId: string, params: Record<string, unknown>): { method: ForwardRoute["method"]; path: string; write: boolean } {
  const r = FORWARD_ROUTES[routeId];
  if (!r) throw new Error("routeId is not registered");
  const used = new Set<string>();
  const path = r.path.replace(/:(\w+)/g, (_m, name: string) => {
    const v = params[name];
    if (typeof v !== "string" || !/^[A-Za-z0-9_\-.]{1,128}$/.test(v)) throw new Error(`path param ${name} is invalid`);
    used.add(name);
    return v;
  });
  for (const k of Object.keys(params)) if (!used.has(k)) throw new Error(`unknown path param ${k}`);
  return { method: r.method, path, write: r.write };
}
