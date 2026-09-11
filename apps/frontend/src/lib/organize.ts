/**
 * 整理页的展示映射：run 状态、置信度、动作的文案与配色。
 */
import type { OrganizeAction, OrganizeConfidence, OrganizeRunStatus, OrganizeTrigger } from "@openstrm/shared";
import type { StatusTone } from "@/components/status-badge";

export const RUN_STATUS_META: Record<OrganizeRunStatus, { label: string; tone: StatusTone; pulse?: boolean }> = {
  planning: { label: "识别中", tone: "info", pulse: true },
  ready: { label: "待执行", tone: "brand" },
  applying: { label: "执行中", tone: "info", pulse: true },
  done: { label: "已完成", tone: "success" },
  failed: { label: "失败", tone: "danger" },
  cancelled: { label: "已取消", tone: "warning" },
  reverting: { label: "撤销中", tone: "info", pulse: true },
  reverted: { label: "已撤销", tone: "neutral" },
};

export const CONFIDENCE_META: Record<OrganizeConfidence, { label: string; tone: StatusTone; hint: string }> = {
  high: { label: "把握大", tone: "success", hint: "有 id 证据，或标题和年份都对上" },
  medium: { label: "基本对", tone: "warning", hint: "标题对上但年份缺或差一年，建议看一眼" },
  low: { label: "拿不准", tone: "danger", hint: "只是搜索结果里最像的，请确认" },
  none: { label: "没识别", tone: "neutral", hint: "TMDB 上搜不到，换个关键词搜或手填" },
};

export const ACTION_META: Record<OrganizeAction, { label: string; tone: StatusTone }> = {
  keep: { label: "不变", tone: "neutral" },
  rename: { label: "改名", tone: "brand" },
  move: { label: "移动", tone: "info" },
  mkdir: { label: "建目录", tone: "neutral" },
  rmdir: { label: "删空目录", tone: "neutral" },
  skip: { label: "跳过", tone: "neutral" },
  conflict: { label: "冲突", tone: "danger" },
};

export const TRIGGER_LABEL: Record<OrganizeTrigger, string> = {
  manual: "手动",
  share: "转存",
  follow: "追更",
  offline: "云下载",
  monitor: "监控",
};

export const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
export const dirName = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** 进行中的状态：页面要轮询 */
export const isBusyStatus = (s: OrganizeRunStatus): boolean => s === "planning" || s === "applying" || s === "reverting";
