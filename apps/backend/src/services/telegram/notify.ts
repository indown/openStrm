/**
 * 主动推送的唯一入口。业务代码只描述"发生了什么"（事件），这里负责：
 *   - 按设置里的开关过滤（任务开始默认关，其它默认开）
 *   - 同一件事短时间内只说一次（cookie 失效时监控每 30 秒撞一次，不能每次都响）
 *   - 套中文模板、HTML 转义、发到配置的 chatId
 * 发送失败只记日志，绝不抛到调用方。
 */
import type { AppSettings, TelegramNotifySettings } from "@openstrm/shared";
import { readAppSettings } from "../../db/repositories/settings.js";
import { moduleLogger } from "../../lib/logger.js";
import { createTelegramBot } from "./bot.js";
import { esc, fmtDuration, taskLabel, type TaskRef } from "./format.js";

const log = moduleLogger("telegram");

export type TaskTrigger = "manual" | "cron" | "telegram" | "share";

export type NotifyEvent =
  | { type: "task-start"; task: TaskRef; total: number; trigger?: TaskTrigger }
  | {
      type: "task-done";
      task: TaskRef;
      status: "completed" | "failed" | "cancelled";
      total: number;
      finished: number;
      failed: number;
      durationMs: number;
      message?: string;
    }
  | { type: "task-start-failed"; task: TaskRef; reason: string; trigger?: TaskTrigger }
  | { type: "offline-done"; name: string; detail: string; target: string }
  | { type: "offline-failed"; name: string; detail: string }
  /** 追更转存了新文件 */
  | { type: "follow-added"; name: string; added: string[]; generated: number; target: string }
  /** 追更连续几次检查失败；按订阅 id 一小时只说一次 */
  | { type: "follow-failed"; id: string; name: string; detail: string }
  /** 分享已经打不开了，订阅已停 */
  | { type: "follow-expired"; name: string; reason: string }
  /** 太久没更新，订阅已自动暂停 */
  | { type: "follow-stale"; name: string; days: number }
  /** 115 账号层面的问题（cookie 失效、被封控）；reason 里认不出这两种就不发 */
  | { type: "account-alert"; account: string; reason: string; source: string };

export const DEFAULT_NOTIFY: Required<TelegramNotifySettings> = {
  taskStart: false,
  taskDone: true,
  taskFailed: true,
  offline: true,
  accountAlert: true,
  follow: true,
};

export function notifyPrefs(settings: AppSettings): Required<TelegramNotifySettings> {
  return { ...DEFAULT_NOTIFY, ...(settings.telegram?.notify ?? {}) };
}

export type AccountIssue = "cookie" | "blocked";

/** 从错误文案里认出"该换 cookie 了"和"被封控了"这两种需要人来处理的情况 */
export function classifyAccountIssue(message: string): AccountIssue | null {
  if (/登录超时|请重新登录|990001|cookie|not login|未登录/i.test(message)) return "cookie";
  if (/封控|阻断|405|Method Not Allowed|doctypehtml/i.test(message)) return "blocked";
  return null;
}

const TRIGGER_LABEL: Record<TaskTrigger, string> = {
  manual: "手动",
  cron: "定时",
  telegram: "Telegram",
  share: "转存",
};

/* ------------------------------- 去重 ------------------------------- */

const COOLDOWN_MS = 60 * 60 * 1000;
const recent = new Map<string, number>();

/** 同一个 key 一小时内只放行一次 */
function throttled(key: string, now = Date.now()): boolean {
  const last = recent.get(key);
  if (last !== undefined && now - last < COOLDOWN_MS) return true;
  recent.set(key, now);
  if (recent.size > 500) {
    for (const [k, t] of recent) if (now - t >= COOLDOWN_MS) recent.delete(k);
  }
  return false;
}

/* ------------------------------- 模板 ------------------------------- */

function accountAlertText(account: string, issue: AccountIssue, source: string, reason: string): string {
  const head =
    issue === "cookie"
      ? `⚠️ <b>115 账号需要处理</b>\n账号 <b>${esc(account)}</b> 的 cookie 已失效，同步和监控都会失败，请到「账户」页更新。`
      : `⚠️ <b>115 账号被封控</b>\n账号 <b>${esc(account)}</b> 的访问被阻断，请稍后再试或检查账号状态。`;
  return `${head}\n来源：${esc(source)}\n<code>${esc(reason.slice(0, 200))}</code>`;
}

function render(event: NotifyEvent): string {
  switch (event.type) {
    case "task-start":
      return `🚀 <b>任务开始</b>${event.trigger ? `（${TRIGGER_LABEL[event.trigger]}）` : ""}\n${esc(taskLabel(event.task))}\n账户 ${esc(event.task.account)} · ${event.total} 个文件待处理`;
    case "task-done": {
      const label = esc(taskLabel(event.task));
      const counts = `${event.finished}/${event.total} 个文件`;
      if (event.status === "completed") return `✅ <b>同步完成</b>\n${label}\n${counts}，用时 ${fmtDuration(event.durationMs)}`;
      if (event.status === "cancelled") return `⏹ <b>任务已取消</b>\n${label}\n完成 ${counts}${event.message ? `\n${esc(event.message)}` : ""}`;
      return `❌ <b>同步失败</b>\n${label}\n完成 ${counts}，失败 ${event.failed}，用时 ${fmtDuration(event.durationMs)}${event.message ? `\n${esc(event.message)}` : ""}`;
    }
    case "task-start-failed":
      return `❌ <b>任务启动失败</b>${event.trigger ? `（${TRIGGER_LABEL[event.trigger]}触发）` : ""}\n${esc(taskLabel(event.task))}\n${esc(event.reason)}`;
    case "offline-done":
      return `☁️ <b>云下载完成</b>\n${esc(event.name)}\n${esc(event.detail)}\n→ ${esc(event.target)}`;
    case "offline-failed":
      return `❌ <b>云下载未能生成 strm</b>\n${esc(event.name)}\n${esc(event.detail)}`;
    case "follow-added": {
      const shown = event.added.slice(0, 8).map(esc).join("、");
      const more = event.added.length > 8 ? ` 等 ${event.added.length} 个` : "";
      return `📺 <b>追更：新增 ${event.added.length} 个</b>\n${esc(event.name)}\n${shown}${more}\n→ ${esc(event.target)}，已生成 ${event.generated} 个 strm`;
    }
    case "follow-failed":
      return `❌ <b>追更检查失败</b>\n${esc(event.name)}\n${esc(event.detail)}`;
    case "follow-expired":
      return `⚠️ <b>追更已停止</b>\n${esc(event.name)}\n分享已经打不开了：${esc(event.reason)}\n需要的话到「追更」页换个链接再继续。`;
    case "follow-stale":
      return `💤 <b>追更已暂停</b>\n${esc(event.name)}\n${event.days} 天没有更新，先停下不再检查；要继续到「追更」页点「继续」。`;
    case "account-alert": {
      const issue = classifyAccountIssue(event.reason);
      return issue ? accountAlertText(event.account, issue, event.source, event.reason) : "";
    }
  }
}

/* ------------------------------- 发送 ------------------------------- */

type Sender = (chatId: string, text: string) => Promise<void>;

const realSender: Sender = async (chatId, text) => {
  const token = readAppSettings().telegram?.botToken;
  if (!token) return;
  const res = await createTelegramBot(token).sendMessage(chatId, text);
  if (!res.ok) log.warn(`Telegram 通知发送失败：${res.error ?? res.description ?? "unknown"}`);
};

let sender: Sender = realSender;

/** 仅供测试：换掉真正的发送；传 null 恢复 */
export function setNotifySender(fn: Sender | null): void {
  sender = fn ?? realSender;
}

export function __test_resetNotify(): void {
  recent.clear();
}

/** 事件是否该发、发什么，都在这里决定。返回是否真的发出去了 */
export async function notify(event: NotifyEvent): Promise<boolean> {
  try {
    const settings = readAppSettings();
    const telegram = settings.telegram;
    if (!telegram?.botToken || !telegram.chatId) return false;
    const prefs = notifyPrefs(settings);

    let text: string;
    switch (event.type) {
      case "task-start":
        if (!prefs.taskStart) return false;
        text = render(event);
        break;
      case "task-done":
        if (event.status === "failed" ? !prefs.taskFailed : !prefs.taskDone) return false;
        text = render(event);
        break;
      case "task-start-failed": {
        // 起不来多半是账号的问题：按账号告警去重，别每次定时触发都来一条
        const issue = classifyAccountIssue(event.reason);
        if (issue) {
          if (!prefs.accountAlert) return false;
          if (throttled(`account:${event.task.account}:${issue}`)) return false;
          text = accountAlertText(event.task.account, issue, `任务 ${taskLabel(event.task)}`, event.reason);
          break;
        }
        if (!prefs.taskFailed) return false;
        if (throttled(`start-failed:${event.task.id}:${event.reason.slice(0, 80)}`)) return false;
        text = render(event);
        break;
      }
      case "offline-done":
      case "offline-failed":
        if (!prefs.offline) return false;
        text = render(event);
        break;
      case "follow-added":
      case "follow-expired":
      case "follow-stale":
        if (!prefs.follow) return false;
        text = render(event);
        break;
      case "follow-failed":
        if (!prefs.follow) return false;
        if (throttled(`follow-failed:${event.id}`)) return false;
        text = render(event);
        break;
      case "account-alert": {
        const issue = classifyAccountIssue(event.reason);
        if (!issue || !prefs.accountAlert) return false;
        if (throttled(`account:${event.account}:${issue}`)) return false;
        text = render(event);
        break;
      }
    }
    if (!text) return false;
    await sender(telegram.chatId, text);
    return true;
  } catch (err) {
    log.warn({ err }, "Telegram 通知失败");
    return false;
  }
}
