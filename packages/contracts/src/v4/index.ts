/**
 * v0.4 platform task / maintenance contracts (spec §6, §7, §9, §11–§14, §21, §22). This is NOT AppBundle formatVersion 4:
 * app bundles stay formatVersion 1/2/3 with ABI 1/2 and the existing runtimeLock.
 */

export const SCHEDULER_PROTOCOL_VERSION = 1;
/** Agent tool set recorded in os.sqlite meta and the agent.sqlite workspace doc. 4 = v0.4 role-scoped tool sets. */
export const TOOLSET_VERSION_V4 = 4;

export type RunMode = "build" | "system_plan" | "maintenance_diagnose" | "maintenance_refactor";
export const RUN_MODES: readonly RunMode[] = ["build", "system_plan", "maintenance_diagnose", "maintenance_refactor"];
export const FOREGROUND_MODES: readonly RunMode[] = ["build", "system_plan"];
export const BACKGROUND_MODES: readonly RunMode[] = ["maintenance_diagnose", "maintenance_refactor"];

export type AgentProfileId = "builder" | "system-planner" | "maintenance-analyst" | "maintenance-refactor" | "compaction";

export type SchedulingState = "waiting_slot" | "waiting_target" | "waiting_build" | "waiting_model" | "dispatching" | "active" | "draining" | "done";
export const SCHEDULING_STATES: readonly SchedulingState[] = ["waiting_slot", "waiting_target", "waiting_build", "waiting_model", "dispatching", "active", "draining", "done"];

/** Default budgets per category (spec §9.3). */
export interface ModeBudget {
  maxModelRequests: number;
  maxToolTasks: number;
  /** stage attempts (build), invalid plan attempts (system_plan), reports (diagnose), candidate attempts (refactor) */
  maxStageAttempts: number;
  deadlineMs: number;
  maxOutputTokens: number;
}
export const MODE_BUDGETS: Record<RunMode, ModeBudget> = {
  build: { maxModelRequests: 12, maxToolTasks: 50, maxStageAttempts: 3, deadlineMs: 900_000, maxOutputTokens: 16384 },
  system_plan: { maxModelRequests: 6, maxToolTasks: 20, maxStageAttempts: 3, deadlineMs: 180_000, maxOutputTokens: 16384 },
  maintenance_diagnose: { maxModelRequests: 3, maxToolTasks: 10, maxStageAttempts: 1, deadlineMs: 120_000, maxOutputTokens: 8192 },
  maintenance_refactor: { maxModelRequests: 6, maxToolTasks: 25, maxStageAttempts: 2, deadlineMs: 300_000, maxOutputTokens: 8192 },
};
export const COMPACTION_BUDGET = { maxModelRequests: 1, deadlineMs: 120_000, maxOutputTokens: 8192 };

/** Workspace limits (spec §7.3, §9.3, §24.1). */
export const V4_LIMITS = {
  foregroundSlots: 2,
  foregroundQueue: 16,
  queueDeadlineMs: 3_600_000,
  backgroundModelSlots: 1,
  globalModelPermits: 2,
  modelRequestsPer24h: 128,
  backgroundModelRequestsPer24h: 8,
  backgroundOutputTokensPer24h: 65536,
  foregroundMaxOutputTokens: 16384,
  backgroundMaxOutputTokens: 8192,
  maintenanceExecSlots: 1,
  maxEnabledPolicies: 32,
  maxPendingJobs: 64,
  minIntervalSeconds: 60,
  maxIntervalSeconds: 86_400,
  serviceSampleMs: 15_000,
  serviceFreshSamples: 3,
  eventCoalesceMs: 5_000,
  maintenanceExecMs: 120_000,
  refactorExecMs: 300_000,
  recoveryPerHour: 2,
  recoveryPer24h: 3,
  recoveryCooldownMs: 600_000,
  circuitAfterFailures: 3,
  recoveryObserveMs: 60_000,
  gcBatchObjects: 100,
  gcBatchBytes: 256 * 1024 * 1024,
  gcBatchMs: 10_000,
  cacheBudgetBytes: 10 * 1024 * 1024 * 1024,
  cacheTriggerRatio: 0.8,
  cacheTargetRatio: 0.6,
  diagnosisEvidenceBytes: 64 * 1024,
  proposalsPerApp: 2,
  proposalsPerWorkspace: 8,
  proposalRetentionMs: 7 * 86_400_000,
  compactionsWorkspace: 1,
  observationSamplesMax: 10_000,
  observationSamplesMs: 86_400_000,
  misfireStaleMs: 600_000,
  clockJumpMs: 300_000,
  stagingGraceMs: 3_600_000,
  logRetentionMs: 7 * 86_400_000,
  logRetentionBytes: 100 * 1024 * 1024,
  policyDefaultDays: 30,
  policyMaxDays: 365,
  archiveIdleDays: 30,
} as const;

export interface AgentProfile {
  id: AgentProfileId;
  title: string;
  modes: RunMode[];
  tools: string[];
  background: boolean;
  budget: ModeBudget | typeof COMPACTION_BUDGET;
}

/** Role templates and their only tools (spec §21.3). No exec, grant, spawn, shell, url fetch or self-scheduling tool exists. */
export const AGENT_PROFILES: Record<AgentProfileId, AgentProfile> = {
  builder: {
    id: "builder", title: "应用构建", modes: ["build"], background: false, budget: MODE_BUDGETS.build,
    tools: ["system_info", "app_list", "app_get", "runtime_catalog", "service_catalog", "app_stage", "app_validate", "app_prepare", "app_prepare_status", "app_activate"],
  },
  "system-planner": {
    id: "system-planner", title: "系统计划", modes: ["system_plan"], background: false, budget: MODE_BUDGETS.system_plan,
    tools: ["system_info", "app_list", "system_resource_list", "system_read", "system_plan"],
  },
  "maintenance-analyst": {
    id: "maintenance-analyst", title: "维护诊断", modes: ["maintenance_diagnose"], background: true, budget: MODE_BUDGETS.maintenance_diagnose,
    tools: ["maintenance_context", "incident_get", "maintenance_report"],
  },
  "maintenance-refactor": {
    id: "maintenance-refactor", title: "优化候选", modes: ["maintenance_refactor"], background: true, budget: MODE_BUDGETS.maintenance_refactor,
    tools: ["target_app_get", "candidate_stage", "candidate_validate", "candidate_check", "candidate_check_status", "proposal_submit"],
  },
  compaction: { id: "compaction", title: "会话摘要", modes: [], background: true, budget: COMPACTION_BUDGET, tools: [] },
};

export function profileForMode(mode: RunMode): AgentProfileId {
  switch (mode) {
    case "build":
      return "builder";
    case "system_plan":
      return "system-planner";
    case "maintenance_diagnose":
      return "maintenance-analyst";
    case "maintenance_refactor":
      return "maintenance-refactor";
  }
}

// ---------------------------------------------------------------- maintenance (spec §11–§14)

export type MaintenanceMode = "observe" | "suggest" | "automatic";
export type MaintenanceTemplateId = "app-recovery" | "service-ensure-running" | "cache-gc" | "log-cleanup" | "app-archive" | "session-compaction" | "app-diagnose" | "app-optimize";
export type TriggerKind = "manual" | "interval" | "event";
export type MisfirePolicy = "coalesce-latest";

export interface MaintenanceTemplate {
  id: MaintenanceTemplateId;
  version: number;
  title: string;
  targetKind: "app" | "service" | "workspace" | "conversation";
  /** fixed actions this template may run; only these, never generated steps */
  actions: string[];
  /** actions that may run under mode=automatic (spec §13.1 automatic whitelist) */
  automaticActions: string[];
  usesModel: boolean;
  defaults: Record<string, number>;
  /** inclusive bounds a user may choose within */
  bounds: Record<string, [number, number]>;
  risk: string;
}

export const MAINTENANCE_TEMPLATES: Record<MaintenanceTemplateId, MaintenanceTemplate> = {
  "app-recovery": {
    id: "app-recovery", version: 1, title: "应用故障恢复", targetKind: "app", actions: ["instance.converge"], automaticActions: ["instance.converge"], usesModel: false,
    defaults: { perHour: 2, per24h: 3, cooldownSeconds: 600, circuitAfter: 3, observeSeconds: 60 },
    bounds: { perHour: [1, 2], per24h: [1, 3], cooldownSeconds: [600, 86_400], circuitAfter: [1, 3], observeSeconds: [60, 600] },
    risk: "通过现有运行控制器重新收敛实例；不修改记录、不重放用户命令",
  },
  "service-ensure-running": {
    id: "service-ensure-running", version: 1, title: "受管服务保持运行", targetKind: "service", actions: ["service.ensure_state.running"], automaticActions: ["service.ensure_state.running"], usesModel: false,
    defaults: { perHour: 2, per24h: 3, cooldownSeconds: 600, observeSeconds: 60, sampleSeconds: 15, samples: 3 },
    bounds: { perHour: [1, 2], per24h: [1, 3], cooldownSeconds: [600, 86_400], observeSeconds: [60, 600], sampleSeconds: [15, 300], samples: [3, 10] },
    risk: "仅对登记服务执行 ensure-running；外部 systemctl stop 也会被视为异常（启用前须知）",
  },
  "cache-gc": {
    id: "cache-gc", version: 1, title: "构建缓存清理", targetKind: "workspace", actions: ["gc.delete_unreferenced"], automaticActions: ["gc.delete_unreferenced"], usesModel: false,
    defaults: { triggerPercent: 80, targetPercent: 60, intervalSeconds: 3600 },
    bounds: { triggerPercent: [50, 95], targetPercent: [20, 90], intervalSeconds: [60, 86_400] },
    risk: "只删除未发布、无引用、无 pin 的产物和已确认的孤儿 staging；历史版本永久保护",
  },
  "log-cleanup": {
    id: "log-cleanup", version: 1, title: "诊断日志整理", targetKind: "workspace", actions: ["logs.delete_closed"], automaticActions: ["logs.delete_closed"], usesModel: false,
    defaults: { retentionDays: 7, retentionMiB: 100, intervalSeconds: 86_400 },
    bounds: { retentionDays: [1, 365], retentionMiB: [10, 10_240], intervalSeconds: [3600, 86_400] },
    risk: "只删除本工作区已轮转关闭的诊断日志；数据库、收据和审计不在范围",
  },
  "app-archive": {
    id: "app-archive", version: 1, title: "闲置应用归档", targetKind: "app", actions: ["app.archive"], automaticActions: ["app.archive"], usesModel: false,
    defaults: { idleDays: 30, intervalSeconds: 86_400 },
    bounds: { idleDays: [7, 365], intervalSeconds: [3600, 86_400] },
    risk: "归档可逆：隐藏应用、停止实例、撤销 provider 授权；不删除记录或版本",
  },
  "session-compaction": {
    id: "session-compaction", version: 1, title: "会话摘要", targetKind: "conversation", actions: ["conversation.compact"], automaticActions: [], usesModel: true,
    defaults: {}, bounds: {}, risk: "对指定已结束会话生成摘要；原始记录保留",
  },
  "app-diagnose": {
    id: "app-diagnose", version: 1, title: "后台诊断", targetKind: "app", actions: ["diagnose.report"], automaticActions: [], usesModel: true,
    defaults: {}, bounds: {}, risk: "模型只读固定证据并提交结构化报告",
  },
  "app-optimize": {
    id: "app-optimize", version: 1, title: "优化候选", targetKind: "app", actions: ["candidate.propose"], automaticActions: [], usesModel: true,
    defaults: {}, bounds: {}, risk: "模型只能生成并验证候选，须用户确认后正式发布",
  },
};

export type PolicyState = "pending_approval" | "syncing" | "enabled" | "paused" | "paused_needs_review" | "revoked" | "expired" | "superseded";
export type IncidentState = "open" | "investigating" | "mitigating" | "resolved" | "suppressed" | "needs_attention";
export type JobState =
  | "queued" | "deferred" | "observing" | "diagnosing" | "awaiting_approval" | "ready" | "running" | "verifying" | "reconciling"
  | "succeeded" | "no_change" | "failed_no_effect" | "cancelled" | "expired" | "indeterminate" | "needs_attention";
export const JOB_TERMINAL: readonly JobState[] = ["succeeded", "no_change", "failed_no_effect", "cancelled", "expired", "indeterminate", "needs_attention"];
export type EffectCertainty = "none" | "confirmed" | "partial" | "unknown";

export interface PolicyCreateBody {
  templateId: MaintenanceTemplateId;
  target: { kind: "app" | "service" | "workspace" | "conversation"; id: string };
  mode: MaintenanceMode;
  trigger: { kind: "interval" | "event" | "manual"; intervalSeconds?: number };
  params?: Record<string, number>;
  expiresInDays?: number;
}

/** Minimum v0.4 error set (spec §22.3). */
export const V04_ERROR_CODES = [
  "RUN_QUEUE_FULL", "TARGET_BUSY", "TARGET_CHANGED", "RUN_IDENTITY_MISMATCH", "EXECUTION_EPOCH_STALE", "MODEL_BUDGET_EXCEEDED",
  "MAINTENANCE_DISABLED", "POLICY_VERSION_STALE", "POLICY_SYNC_PENDING", "CLOCK_UNCERTAIN", "CIRCUIT_OPEN", "ARTIFACT_GC_PENDING",
  "PROPOSAL_STALE", "APP_ARCHIVED", "COMPACTION_SCOPE_DENIED",
] as const;
export * from "./broker-v2.js";
