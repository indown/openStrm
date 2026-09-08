/**
 * strm 管理页的展示映射与小工具：条目类型 / 体检问题类型的文案与配色、路径拼拆、错误文案。
 * 路径一律是相对任务 targetPath 的 POSIX 路径，"" 表示根目录。
 */
import type { StrmDeleteResult, StrmEntryKind, StrmIssueType, StrmParseReason } from "@openstrm/shared";
import type { StatusTone } from "@/components/status-badge";
import { apiErrorMessage } from "@/lib/axios";

export const KIND_META: Record<StrmEntryKind, { label: string; tone: StatusTone }> = {
  dir: { label: "目录", tone: "neutral" },
  strm: { label: "strm", tone: "brand" },
  download: { label: "附件", tone: "info" },
  part: { label: "残留分段", tone: "warning" },
  other: { label: "其他", tone: "neutral" },
};

export const ISSUE_META: Record<
  StrmIssueType,
  { label: string; tone: StatusTone; hint: string; batch?: "delete" | "rewrite" }
> = {
  "nested-same-name": {
    label: "同名嵌套",
    tone: "warning",
    hint: "目录里套了一个同名子目录，多半是重复生成的一层，确认后把里层删掉",
  },
  "empty-dir": { label: "空目录", tone: "neutral", hint: "整棵目录里一个文件都没有", batch: "delete" },
  "stale-content": {
    label: "内容过期",
    tone: "warning",
    hint: "strm 内容和任务现在的前缀 / 网盘路径 / 编码设置对不上，可以直接重写",
    batch: "rewrite",
  },
  unparsable: {
    label: "无法解析",
    tone: "danger",
    hint: "看不出这个 strm 指向哪个文件（空文件、没有扩展名或文件名对不上），用「重新生成」按 115 目录重建",
  },
  "duplicate-episode": {
    label: "疑似重复剧集",
    tone: "info",
    hint: "同一集有多个 strm，播放器里会显示成多条；也可能只是不同画质的版本",
  },
  "leftover-part": { label: "残留分段", tone: "neutral", hint: "下载中断留下的 .part 文件", batch: "delete" },
};

export const PARSE_REASON_LABEL: Record<StrmParseReason, string> = {
  empty: "文件是空的",
  "no-ext": "内容最后一段没有扩展名",
  "name-mismatch": "内容里的文件名和本地文件名对不上",
  "prefix-mismatch": "前缀和任务现在的 strmPrefix 对不上",
};

export const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);
export const parentOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** 校验 / 重新生成这类要等很久的接口，超时要说清楚是等不到而不是失败 */
export function strmErrorMessage(err: unknown, fallback: string): string {
  const code = (err as { code?: string } | null)?.code;
  if (code === "ECONNABORTED") return `${fallback}：等待超时，目录可能太大，换个小一点的目录再试`;
  return apiErrorMessage(err, fallback);
}

/** 页面层统一的删除确认：resolve 成结果表示删了，null 表示用户取消 */
export type RequestDelete = (paths: string[], label: string) => Promise<StrmDeleteResult | null>;
