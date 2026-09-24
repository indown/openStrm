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

/**
 * 截到最多 max 个 UTF-16 单元，但不把一个字符劈成两半：emoji 这类字符占两个单元，从中间切开会剩下半个
 * （孤立的代理项），Bot API 整条拒收（strings must be encoded in UTF-8），发的人还不会报错
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** 文本超过 Telegram 的 4096 上限时截断，宁可少显示几行也别整条发不出去。text 是已经转义、带着标签的 HTML */
export function clamp(text: string, max = 3800): string {
  return text.length <= max ? text : `${cutHtml(text, max)}\n…（已截断）`;
}

/**
 * 按 HTML 截：切口不落在标签、实体（&amp;）、代理对中间，截断时还开着的标签补上闭合——
 * 半个标签、没闭合的 <b>、半个实体，Telegram 都整条拒收（can't parse entities）。
 * 切下来的加上补的闭合不超过 max；刚开的标签跟着退掉，不留空的 <b></b>
 */
function cutHtml(html: string, max: number): string {
  const open: string[] = [];
  /** 此刻要补的闭合标签，里层的在前 */
  let closers = "";
  let cut = 0;
  let cutClosers = "";
  let afterOpen = false;
  let i = 0;
  while (i <= max) {
    if (!afterOpen && i + closers.length <= max) {
      cut = i;
      cutClosers = closers;
    }
    if (i >= html.length) break;
    afterOpen = false;
    const end = html[i] === "<" ? html.indexOf(">", i) : -1;
    const tag = end < 0 ? null : /^<(\/?)([a-z][\w-]*)/i.exec(html.slice(i, end + 1));
    if (tag) {
      const name = tag[2].toLowerCase();
      if (!tag[1]) {
        open.push(name);
        afterOpen = true;
      } else if (open.at(-1) === name) {
        open.pop();
      }
      closers = open.map((t) => `</${t}>`).reverse().join("");
      i = end + 1;
      continue;
    }
    const entity = html[i] === "&" ? /^&(?:#\d+|#x[\da-f]+|[a-z]+);/i.exec(html.slice(i, i + 12)) : null;
    const code = html.charCodeAt(i);
    i += entity ? entity[0].length : code >= 0xd800 && code <= 0xdbff ? 2 : 1;
  }
  return html.slice(0, cut) + cutClosers;
}

export function shortName(name: string, max = 48): string {
  return name.length <= max ? name : `${cutText(name, max - 1)}…`;
}
