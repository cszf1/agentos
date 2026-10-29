import { Store, systemClock, type Clock } from "./persistence/store.js";
import { AppService } from "./apps/app-service.js";
import { RecordService } from "./records/record-service.js";
import { RunService, DEFAULT_RUN_SETTINGS, type RunSettings } from "./runs/run-service.js";
import { CapabilityGateway } from "./capabilities/gateway.js";
import { AgentOps } from "./runs/agent-ops.js";
import { UserActions } from "./user-actions.js";
import { ModelBudgets } from "./model-budgets/budgets.js";
import { RunScheduler } from "./scheduling/run-scheduler.js";
import { PolicyService } from "./maintenance/policy-service.js";
import { ClockGuard } from "./maintenance/clock-guard.js";
import { IncidentStore, Notifications } from "./health/incidents.js";
import { MaintenanceService } from "./maintenance/jobs.js";
import { HealthMonitor } from "./health/health-monitor.js";

export * from "./persistence/store.js";
export { MIGRATIONS } from "./persistence/migrations.js";
export * from "./apps/app-service.js";
export * from "./records/record-service.js";
export * from "./runs/run-service.js";
export * from "./runs/engine.js";
export * from "./runs/coordinator.js";
export * from "./runs/agent-ops.js";
export * from "./capabilities/gateway.js";
export * from "./providers/system-info.js";
export * from "./faults.js";
export * from "./user-actions.js";
export * from "./model-budgets/budgets.js";
export * from "./scheduling/target-leases.js";
export * from "./scheduling/run-scheduler.js";
export * from "./maintenance/policy-service.js";
export * from "./maintenance/clock-guard.js";
export * from "./maintenance/jobs.js";
export * from "./health/incidents.js";
export * from "./health/health-monitor.js";

export interface Core {
  store: Store;
  gateway: CapabilityGateway;
  apps: AppService;
  records: RecordService;
  runs: RunService;
  agentOps: AgentOps;
  user: UserActions;
  budgets: ModelBudgets;
  scheduler: RunScheduler;
  maintenance: {
    policies: PolicyService;
    clock: ClockGuard;
    incidents: IncidentStore;
    notifications: Notifications;
    jobs: MaintenanceService;
    health: HealthMonitor;
  };
}

export function openCore(file: string, opts: { clock?: Clock; runSettings?: Partial<RunSettings>; mono?: () => number } = {}): Core {
  const store = Store.open(file, opts.clock ?? systemClock);
  const gateway = new CapabilityGateway(store);
  const apps = new AppService(store);
  const records = new RecordService(store, apps);
  const runs = new RunService(store, apps, { ...DEFAULT_RUN_SETTINGS, ...(opts.runSettings ?? {}) });
  const agentOps = new AgentOps(store, gateway, apps, runs);
  const user = new UserActions(store, gateway, apps, records, runs);
  const budgets = new ModelBudgets(store, runs);
  const scheduler = new RunScheduler(store, runs, apps);
  const policies = new PolicyService(store);
  const clock = new ClockGuard(store, opts.mono);
  const incidents = new IncidentStore(store);
  const notifications = new Notifications(store);
  incidents.onNotify = (k, sub, sev, title, detail) => notifications.notify(k, sub, sev, title, detail);
  const jobs = new MaintenanceService(store, policies, clock, incidents);
  const health = new HealthMonitor(store, incidents, jobs);
  policies.targetCheck = (kind, id) => {
    if (kind === "app") {
      const a = store.get<{ id: string; active_revision_id: string | null; contract_json: string }>("SELECT id, active_revision_id, contract_json FROM apps WHERE id = ?", id);
      return a ? { ok: true, contract: { revisionId: a.active_revision_id } } : { ok: false, reason: "app not found" };
    }
    if (kind === "workspace") return id === "workspace" ? { ok: true } : { ok: false, reason: "workspace target id must be \"workspace\"" };
    if (kind === "service") {
      const r = store.get<{ id: string; generation: number; identity_digest: string | null; status: string }>("SELECT id, generation, identity_digest, status FROM system_resources WHERE id = ? AND kind = 'service'", id);
      return r ? { ok: true, contract: { generation: r.generation, identity: r.identity_digest } } : { ok: false, reason: "service resource not registered" };
    }
    if (kind === "conversation") {
      const c = store.get("SELECT 1 FROM agent_conversations WHERE conversation_id = ?", id);
      return c ? { ok: true } : { ok: false, reason: "conversation not found" };
    }
    return { ok: false, reason: "unknown target kind" };
  };
  return { store, gateway, apps, records, runs, agentOps, user, budgets, scheduler, maintenance: { policies, clock, incidents, notifications, jobs, health } };
}
export * from "./runtime/driver.js";
export * from "./runtime/policy.js";
export * from "./runtime/bridge.js";
export * from "./runtime/catalog-service.js";
export * from "./builds/artifact-store.js";
export * from "./builds/build-service.js";
export * from "./runtime/instances.js";
export * from "./records/mutations.js";
export * from "./runtime/context.js";
export * from "./runtime/app-runtime.js";
export * from "./runtime/reconciler.js";
export * from "./deployments/preview.js";
export * from "./deployments/deployment-service.js";
export * from "./invocations/invocation-service.js";
export * from "./inter-app/inter-app-service.js";
export * from "./runtime/system.js";
export * from "./builds/gc.js";
export * from "./system/broker-link.js";
export * from "./system/system-capabilities.js";
export * from "./providers/native-user.js";
export * from "./providers/provider-read-service.js";
export * from "./providers/preview.js";
export * from "./resources/resource-service.js";
export { ProviderGrantService, type GrantView as ProviderGrantView, type GrantRow as ProviderGrantRow } from "./system-grants/grant-service.js";
export * from "./observations/observation-service.js";
export * from "./system-actions/system-action-service.js";
