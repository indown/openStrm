import { AlertCircle, CheckCircle2, Clock, XCircle, type LucideIcon } from "lucide-react";
import type { TaskExecutionSummary } from "@openstrm/shared";
import type { StatusTone } from "@/components/status-badge";

export type RunStatus = TaskExecutionSummary["status"];

/** 一次执行的状态怎么显示：任务、历史、日志三页共用这一份，别各抄各的 */
export const RUN_STATUS: Record<RunStatus, { label: string; tone: StatusTone; icon: LucideIcon }> = {
  running: { label: "运行中", tone: "info", icon: Clock },
  completed: { label: "成功", tone: "success", icon: CheckCircle2 },
  failed: { label: "失败", tone: "danger", icon: XCircle },
  cancelled: { label: "已取消", tone: "warning", icon: AlertCircle },
};
