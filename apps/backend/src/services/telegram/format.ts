/**
 * Telegram 消息的文案与小工具。所有插进 HTML 的用户数据（路径、文件名、错误原文）都必须过 esc：
 * 名字里一个 `<` 就能让整条消息发不出去（can't parse entities）。
 */
import type { TaskDefinition, TaskExecutionSummary } from "@openstrm/shared";

export function esc(text: unknown): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export type TaskRef = Pick<TaskDefinition, "id" | "originPath" | "targetPath" | "account">;

export function taskLabel(task: Pick<TaskDefinition, "originPath" | "targetPath">): string {
  return `${task.originPath} → ${task.targetPath}`;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

export function relative(ms: number): string {
  const d = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
}

export const RUN_STATUS: Record<TaskExecutionSummary["status"], { icon: string; label: string }> = {
  running: { icon: "🔄", label: "运行中" },
  completed: { icon: "✅", label: "成功" },
  failed: { icon: "❌", label: "失败" },
  cancelled: { icon: "⏹", label: "已取消" },
};

/** 一次执行的一句话：状态 + 数量 + 时间 */
export function describeRun(run: TaskExecutionSummary): string {
  const s = RUN_STATUS[run.status];
  const parts = [`${s.icon} ${s.label}`];
  if (run.status === "failed" && run.summary.errorMessage) parts.push(esc(run.summary.errorMessage));
  else if (run.status !== "running") {
    parts.push(`${run.summary.downloadedFiles}/${run.summary.totalFiles} 个文件`);
    if (run.summary.failedFiles) parts.push(`失败 ${run.summary.failedFiles}`);
  }
  parts.push(relative(run.startTime));
  return parts.join(" · ");
}

/** 文本超过 Telegram 的 4096 上限时截断，宁可少显示几行也别整条发不出去 */
export function clamp(text: string, max = 3800): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断）`;
}

export function shortName(name: string, max = 48): string {
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}
