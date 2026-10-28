/**
 * RuntimeDriver (spec §6): the only path from the domain to the container engine. Inputs are typed configurations
 * built by the host from fixed policy; outputs are structured states. It never accepts command lines or mount paths
 * from a model or an app.
 */
export type ContainerRole = "app" | "preview" | "build";

export interface ContainerLabels {
  "agentos.store": string;
  "agentos.role": ContainerRole;
  "agentos.app": string;
  "agentos.revision": string;
  "agentos.instance": string;
  "agentos.boot": string;
}

export interface ContainerSpec {
  /** Host-chosen, persisted before the create call. */
  name: string;
  image: string;
  role: ContainerRole;
  labels: ContainerLabels;
  /** Read-only artifact directory mounted at /app (app/preview) or source dir at /src (build). */
  readOnlyMount: { hostPath: string; containerPath: "/app" | "/src" };
  /** Per-instance bridge directory (0700) mounted at /run/agentos. */
  bridgeDir: string;
  command: string[];
  env: Record<string, string>;
  limits: { memoryBytes: number; cpus: number; pids: number; tmpfsBytes: number };
}

export type ObservedContainerState = "absent" | "created" | "running" | "exited" | "unknown";

export interface ContainerStatus {
  id: string;
  name: string;
  state: ObservedContainerState;
  exitCode: number | null;
  oomKilled: boolean;
  labels: Record<string, string>;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface EnvironmentReport {
  ok: boolean;
  rootless: boolean;
  cgroupVersion: string;
  cgroupControllers: string[];
  seccomp: boolean;
  apparmor: boolean;
  selinux: boolean;
  ociRuntime: string;
  podmanVersion: string;
  kernel: string;
  platform: string;
  problems: string[];
  /** Non-fatal findings (e.g. an engine version with a known CVE that AgentOS mitigates itself). */
  warnings?: string[];
}

export interface ImageStatus {
  name: string;
  present: boolean;
  id?: string;
  labels?: Record<string, string>;
  architecture?: string;
  /** The image config's Env entries, exactly as stored (validated before any container is created). */
  env?: string[];
}

export interface RuntimeDriver {
  /** Check the environment (rootless, cgroup v2 controllers, seccomp, engine reachable). */
  checkEnvironment(): Promise<EnvironmentReport>;
  /** Make sure a platform image exists locally (build it from its recipe when allowed). */
  ensureImage(image: { name: string; recipeHash: string; role: "builder" | "runtime"; profileId: string }, opts: { allowBuild: boolean }): Promise<ImageStatus>;
  inspectImage(name: string): Promise<ImageStatus>;
  create(spec: ContainerSpec): Promise<{ id: string }>;
  start(idOrName: string): Promise<void>;
  inspect(idOrName: string): Promise<ContainerStatus>;
  stop(idOrName: string, timeoutSeconds: number): Promise<void>;
  kill(idOrName: string): Promise<void>;
  remove(idOrName: string): Promise<void>;
  /** Containers carrying this store's label. */
  list(storeUUID: string): Promise<ContainerStatus[]>;
  /** Bounded tail of a container's log (diagnostics only). */
  diagnostics(idOrName: string, maxBytes: number): Promise<string>;
  /** Platform images this host built (label agentos.recipe), by name. */
  listPlatformImages(): Promise<string[]>;
  removeImage(name: string): Promise<void>;
  /** Save an image as an OCI archive file (cold backup) and load one back (restore). */
  exportImage(name: string, file: string): Promise<void>;
  importImage(file: string): Promise<string[]>;
  /** Wait until the container exits or timeout; returns the final status. */
  wait(idOrName: string, timeoutMs: number): Promise<ContainerStatus>;
}
