import { Store, systemClock, type Clock } from "./persistence/store.js";
import { AppService } from "./apps/app-service.js";
import { RecordService } from "./records/record-service.js";
import { RunService, DEFAULT_RUN_SETTINGS, type RunSettings } from "./runs/run-service.js";
import { CapabilityGateway } from "./capabilities/gateway.js";
import { AgentOps } from "./runs/agent-ops.js";
import { UserActions } from "./user-actions.js";

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

export interface Core {
  store: Store;
  gateway: CapabilityGateway;
  apps: AppService;
  records: RecordService;
  runs: RunService;
  agentOps: AgentOps;
  user: UserActions;
}

export function openCore(file: string, opts: { clock?: Clock; runSettings?: Partial<RunSettings> } = {}): Core {
  const store = Store.open(file, opts.clock ?? systemClock);
  const gateway = new CapabilityGateway(store);
  const apps = new AppService(store);
  const records = new RecordService(store, apps);
  const runs = new RunService(store, apps, { ...DEFAULT_RUN_SETTINGS, ...(opts.runSettings ?? {}) });
  const agentOps = new AgentOps(store, gateway, apps, runs);
  const user = new UserActions(store, gateway, apps, records, runs);
  return { store, gateway, apps, records, runs, agentOps, user };
}
