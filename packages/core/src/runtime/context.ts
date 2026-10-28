import type { Store } from "../persistence/store.js";
import type { AppService } from "../apps/app-service.js";
import type { RecordService } from "../records/record-service.js";
import type { CapabilityGateway } from "../capabilities/gateway.js";
import type { ArtifactStore } from "../builds/artifact-store.js";
import type { BuildService } from "../builds/build-service.js";
import type { RuntimeCatalogService } from "./catalog-service.js";
import type { RuntimeDriver } from "./driver.js";
import type { InstanceHost } from "./instances.js";

export type Logger = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

/** Shared dependencies of the v0.2 runtime services. */
export interface RuntimeContext {
  store: Store;
  gateway: CapabilityGateway;
  apps: AppService;
  records: RecordService;
  catalog: RuntimeCatalogService;
  artifacts: ArtifactStore;
  builds: BuildService;
  /** null when the container runtime is unavailable (code apps then answer SANDBOX_UNAVAILABLE). */
  driver: RuntimeDriver | null;
  instances: InstanceHost | null;
  bootId: string;
  storeUUID: string;
  log: Logger;
}
