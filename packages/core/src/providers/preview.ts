import { createHash } from "node:crypto";
import { usecToCpuPercent } from "@agentos/contracts";
import type { ResourceRow } from "../resources/resource-service.js";

/**
 * Trusted preview (spec §9, §11.2 step 5, §21.2): built by the platform from the frozen parameters and the current
 * observed state — never from text an app or the model wrote. The Shell renders exactly these fields.
 */
export interface TrustedPreview {
  title: string;
  target: string;
  resourceKind: string;
  change: { label: string; from: string | null; to: string }[];
  preconditions: string[];
  reversible: string;
  autoRetry: string;
  risks: string[];
  irreversible: boolean;
}

const mib = (n: number) => `${Math.round((n / 1048576) * 10) / 10} MiB`;

/** The resource's real identity next to its name (unit, namespace, device), so a renamed display name cannot hide it. */
function targetOf(r: ResourceRow): string {
  let id: Record<string, unknown> = {};
  try {
    id = r.identity_json ? (JSON.parse(r.identity_json) as Record<string, unknown>) : {};
  } catch {
    /* none */
  }
  const real = (id.unit ?? id.netns ?? id.path ?? id.devicePath ?? id.catalogKey ?? null) as string | null;
  return real && real !== r.display_name ? `${r.display_name}（${real}）` : r.display_name;
}

export function buildPreview(r: ResourceRow, cap: string, params: Record<string, unknown>, current: Record<string, unknown> | null): TrustedPreview {
  const out = buildPreviewInner(r, cap, params, current);
  if (out.target === r.display_name) out.target = targetOf(r);
  return out;
}

function buildPreviewInner(r: ResourceRow, cap: string, params: Record<string, unknown>, current: Record<string, unknown> | null): TrustedPreview {
  switch (cap) {
    case "file.write_text_atomic": {
      const content = String(params.content ?? "");
      const bytes = Buffer.byteLength(content, "utf8");
      const newVersion = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
      const create = params.expectedAbsent === true;
      return {
        title: create ? `在「${r.display_name}」新建文件 ${String(params.path)}` : `替换「${r.display_name}」中的 ${String(params.path)}`,
        target: `${r.display_name}/${String(params.path)}`,
        resourceKind: r.kind,
        change: [
          { label: "文件", from: create ? "（不存在）" : String(params.expectedVersion ?? "").slice(0, 19), to: `${newVersion.slice(0, 19)}…（${bytes} 字节，${content.split("\n").length} 行）` },
        ],
        preconditions: [create ? "目标文件此刻不存在（不会覆盖已有文件）" : `目标文件内容仍为 ${String(params.expectedVersion).slice(0, 19)}…`, "受管目录由平台文件进程独占写入"],
        reversible: create ? "不提供删除；可再写入新版本" : "可生成“恢复旧内容”的补偿计划（需当前内容仍是本次结果）",
        autoRetry: "中断后只会补完或补记同一次写入，不会写第二次",
        risks: [],
        irreversible: false,
      };
    }
    case "service.ensure_state": {
      const want = params.state === "running" ? "运行" : "停止";
      return {
        title: `将「${r.display_name}」设为${want}`,
        target: r.display_name,
        resourceKind: r.kind,
        change: [{ label: "服务状态", from: current ? String(current.activeState ?? "未知") : null, to: params.state === "running" ? "active" : "inactive" }],
        preconditions: ["只控制安装目录中登记的服务", "没有“重启”动作；已满足目标时不做任何事"],
        reversible: `可再提交“${params.state === "running" ? "停止" : "启动"}”计划；程序启动或停止已产生的效果不会被撤回`,
        autoRetry: "结果不确定时，只有目录标为可安全重复启动的服务才会在原期限内再核对收敛",
        risks: params.state === "stopped" ? ["停止会中断该服务正在处理的请求"] : [],
        irreversible: false,
      };
    }
    case "service.set_limit": {
      const prop = String(params.property);
      const v = Number(params.value);
      const cur = current ? Number(current[prop]) : NaN;
      const fmt = (x: number) => (prop === "CPUQuotaPerSecUSec" ? (Number.isFinite(x) && x < 1e15 ? `${usecToCpuPercent(x)}%（单个逻辑 CPU）` : "不限") : Number.isFinite(x) && x < 1e15 ? mib(x) : "不限");
      const label = prop === "CPUQuotaPerSecUSec" ? "CPU 上限" : "内存上限 MemoryMax";
      const risks: string[] = [];
      if (prop === "MemoryMax") {
        const used = current && typeof current.memoryCurrent === "number" ? (current.memoryCurrent as number) : null;
        risks.push(`当前内存用量 ${used === null ? "未知" : mib(used)}；降低上限可能使进程被回收或 OOM`);
      }
      if (prop === "CPUQuotaPerSecUSec") risks.push("50% 指一个逻辑 CPU 的一半，不是整台机器算力的一半");
      return {
        title: `将「${r.display_name}」的${label}设为 ${fmt(v)}`,
        target: r.display_name,
        resourceKind: r.kind,
        change: [{ label, from: Number.isNaN(cur) ? null : fmt(cur), to: fmt(v) }],
        preconditions: ["运行时设置（不写入永久 unit 文件，主机重启后恢复默认值）", "数值在安装策略与授权范围之内"],
        reversible: "可生成“恢复原值”的补偿计划（需当前值仍是本次结果）",
        autoRetry: "响应丢失时先核对实际值；仍为原值且在原期限内才再设置一次",
        risks,
        irreversible: false,
      };
    }
    case "network.apply_profile":
      return {
        title: `在「${r.display_name}」启用策略 ${String(params.profileId)}`,
        target: r.display_name,
        resourceKind: r.kind,
        change: [{ label: "防火墙 profile", from: current ? String(current.activeProfile ?? "无") : null, to: String(params.profileId) }],
        preconditions: ["只修改专用测试 namespace 中 AgentOS 自有的 nftables 表", "主机网络、SSH、DNS 不受影响"],
        reversible: "可生成恢复上一 profile 的补偿计划",
        autoRetry: "提交结果不确定时核对规则 hash 与测试流量，不会 flush 全局规则",
        risks: params.profileId === "local-deny" ? ["测试路径 10.231.0.2:8080 的流量将被阻断"] : [],
        irreversible: false,
      };
    case "serial.exchange":
      return {
        title: `向「${r.display_name}」发送一帧 ${String(params.command)}`,
        target: r.display_name,
        resourceKind: r.kind,
        change: [{ label: "串口帧", from: null, to: params.command === "SAMPLE" ? `SAMPLE ${String(params.count)}` : `ECHO "${String(params.text)}"` }],
        preconditions: ["设备身份与连接代次未变", "协议 telemetry-echo-v1，115200 8N1，单帧 ≤256 字节"],
        reversible: "不可撤回（串口不提供补偿）",
        autoRetry: "不会自动重发；结果不确定时资源被隔离，需要人工处置",
        risks: ["打开端口可能改变控制线状态", "超时不代表设备没有收到"],
        irreversible: true,
      };
    default:
      return { title: cap, target: r.display_name, resourceKind: r.kind, change: [], preconditions: [], reversible: "未知", autoRetry: "否", risks: [], irreversible: true };
  }
}
