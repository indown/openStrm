/**
 * 整理页的展示映射：run 状态、置信度、动作的文案与配色。
 */
import type { OrganizeAction, OrganizeConfidence, OrganizeErrorKind, OrganizeRunStatus, OrganizeTrigger } from "@openstrm/shared";
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

/** 失败类别：一句话说清楚为什么、下一步做什么（执行阶段的含义；撤销阶段的文案在失败面板里单独写） */
export const ERROR_KIND_META: Record<Exclude<OrganizeErrorKind, "">, { label: string; tone: StatusTone; hint: string }> = {
  blocked: { label: "网盘拒绝", tone: "danger", hint: "风控或登录失效，整理已停下：到「账号」页处理好之后再重试" },
  transient: { label: "临时失败", tone: "warning", hint: "网络、超时或网盘抖动：执行时已自动重试过一次，再试一次多半就好" },
  stale: { label: "预览后变了", tone: "danger", hint: "文件已不在预览时的位置、目录没了或目标位置被占：重新预览会按现在的网盘重新规划，重试只会再失败" },
  rejected: { label: "名字不被接受", tone: "danger", hint: "网盘不接受这个名字或目标已存在：改模板 / 识别词后重新预览，或放弃这些项" },
  mirror: { label: "本地未同步", tone: "warning", hint: "网盘已经改好，本地 strm 没跟上：重试只补本地，不碰网盘" },
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
