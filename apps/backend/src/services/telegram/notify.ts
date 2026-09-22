/**
 * 主动推送的唯一入口。业务代码只描述"发生了什么"（事件），这里负责：
 *   - 按设置里的开关过滤（任务开始默认关，其它默认开）
 *   - 同一件事短时间内只说一次（cookie 失效时监控每 30 秒撞一次，不能每次都响）
 *   - 套中文模板、HTML 转义、发到配置的 chatId
 * 发送失败只记日志，绝不抛到调用方。
 */
import { classifyAccountIssue } from "../drive/errors.js";
import type { AccountIssue as DriveAccountIssue } from "../drive/types.js";
import type { AppSettings, OAuthPendingRequest, TelegramNotifySettings, OrganizeErrorKind } from "@openstrm/shared";
import { readAppSettings } from "../../db/repositories/settings.js";
import { moduleLogger } from "../../lib/logger.js";
import { createTelegramBot, type InlineKeyboard } from "./bot.js";
import { oauthNotifyBucket } from "../agent/rate-limit.js";
import { esc, fmtDuration, taskLabel, type TaskRef } from "./format.js";
import { FAILURE_LABEL } from "../organize/failure-kinds.js";

const log = moduleLogger("telegram");

export type TaskTrigger = "manual" | "cron" | "telegram" | "share" | "agent";

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
      /** 数量最多那一类失败的处理建议（整轮停时已经在 message 里） */
      advice?: string;
    }
  /** issue：网盘自己认出的账号问题（见 issueFromDrive）；没给就从 reason 文案里猜 */
  | { type: "task-start-failed"; task: TaskRef; reason: string; trigger?: TaskTrigger; issue?: AccountIssue | null }
  | { type: "offline-done"; name: string; detail: string; target: string }
  | { type: "offline-failed"; name: string; detail: string }
  /** 云下载完成后由 OpenList 复制到了目标目录。旧名字，留一轮给存量的调用方 */
  | { type: "offline-copied"; name: string; target: string }
  /** 云下载的「复制到 OpenList」没走完；旧名字，留一轮 */
  | { type: "offline-copy-failed"; name: string; detail: string }
  /** OpenList 复制完了。source 是谁触发的（转存 / 追更 / 监控 / 云下载） */
  | { type: "copy-done"; name: string; target: string; source: string }
  /** OpenList 复制失败，detail 里说清楚在哪一步 */
  | { type: "copy-failed"; name: string; detail: string; source: string }
  /** 追更转存了新文件 */
  | { type: "follow-added"; name: string; added: string[]; generated: number; target: string }
  /** 追更连续几次检查失败；按订阅 id 一小时只说一次 */
  | { type: "follow-failed"; id: string; name: string; detail: string }
  /** 分享已经打不开了，订阅已停 */
  | { type: "follow-expired"; name: string; reason: string }
  /** 太久没更新，订阅已自动暂停 */
  | { type: "follow-stale"; name: string; days: number }
  /** OpenStrm 有新版本（默认关，同一个版本只推一次） */
  | { type: "update-available"; version: string; current: string; url: string }
  /** Emby 把新条目收进媒体库了；groups 为空表示这批太多、只报总数 */
  | { type: "emby-new"; groups: EmbyNewGroup[]; total: number }
  /** 整理执行完了 */
  | {
      type: "organize-done";
      task: TaskRef;
      runId: string;
      units: number;
      done: number;
      failed: number;
      reverted?: boolean;
      /** 还等着处理的失败按类别（transient / blocked / stale / rejected / mirror） */
      failedByKind?: Partial<Record<Exclude<OrganizeErrorKind, "">, number>>;
      /** 撤销：没退回的项数 */
      notReverted?: number;
    }
  /** 自动整理生成了待确认的清单（review 模式，或 auto 模式下有拿不准的） */
  | { type: "organize-review"; task: TaskRef; runId: string; units: number; planned: number; unsure: number; conflicts: number }
  /**
   * 账号层面的问题（cookie 失效、被封控）。issue 是调用方用网盘自己的规则认出来的（见 issueFromDrive）；
   * 没给就从 reason 文案里猜（115 的中文），两样都认不出就不发
   */
  | { type: "account-alert"; account: string; reason: string; source: string; issue?: AccountIssue | null };

export const DEFAULT_NOTIFY: Required<TelegramNotifySettings> = {
  taskStart: false,
  taskDone: true,
  taskFailed: true,
  offline: true,
  accountAlert: true,
  follow: true,
  embyNew: true,
  organize: true,
  update: false,
};

export function notifyPrefs(settings: AppSettings): Required<TelegramNotifySettings> {
  return { ...DEFAULT_NOTIFY, ...(settings.telegram?.notify ?? {}) };
}

/** Emby 入库通知里的一组：一部剧的一季，或一部电影 */
export interface EmbyNewGroup {
  kind: "tv" | "movie";
  name: string;
  year?: number;
  season?: number;
  /** 已排序去重的集号；specials 可能拿不到集号，count 才是准数 */
  episodes: number[];
  count: number;
}

export type AccountIssue = "cookie" | "blocked";

/** 网盘 Provider.classifyError 的结果换成通知这边的两档：分享失效（gone）不是账号问题 */
export function issueFromDrive(issue: DriveAccountIssue | null | undefined): AccountIssue | null {
  if (issue === "auth") return "cookie";
  if (issue === "blocked") return "blocked";
  return null;
}

/** 从错误文案里认出"该换 cookie 了"和"被封控了"：规则在 drive/errors.ts（分类器也用它），这里只是转一手 */
export { classifyAccountIssue };

const TRIGGER_LABEL: Record<TaskTrigger, string> = {
  manual: "手动",
  cron: "定时",
  telegram: "Telegram",
  share: "转存",
  agent: "智能体",
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
      ? `⚠️ <b>网盘账号需要处理</b>\n账号 <b>${esc(account)}</b> 的 cookie 已失效，同步和监控都会失败，请到「账户」页更新。`
      : `⚠️ <b>网盘账号被封控</b>\n账号 <b>${esc(account)}</b> 的访问被阻断，请稍后再试或检查账号状态。`;
  return `${head}\n来源：${esc(source)}\n<code>${esc(reason.slice(0, 200))}</code>`;
}

/** 连号折叠：5,6,7,9 → E05-E07、E09 */
function fmtEpisodes(eps: number[]): string {
  const one = (n: number) => `E${String(n).padStart(2, "0")}`;
  const parts: string[] = [];
  for (let i = 0; i < eps.length; ) {
    let j = i;
    while (j + 1 < eps.length && eps[j + 1] === eps[j] + 1) j++;
    parts.push(j > i ? `${one(eps[i])}-${one(eps[j])}` : one(eps[i]));
    i = j + 1;
  }
  return parts.join("、");
}

function embyNewLine(g: EmbyNewGroup): string {
  if (g.kind === "tv") {
    const season = g.season != null ? ` S${String(g.season).padStart(2, "0")}` : "";
    const eps = g.episodes.length > 0 ? `：${fmtEpisodes(g.episodes)}` : "";
    return `《${esc(g.name)}》${season} 新增 ${g.count} 集${eps}`;
  }
  return `《${esc(g.name)}》${g.year != null ? `(${g.year})` : ""}`;
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
      return `❌ <b>同步失败</b>\n${label}\n完成 ${counts}，失败 ${event.failed}，用时 ${fmtDuration(event.durationMs)}${event.message ? `\n${esc(event.message)}` : ""}${event.advice ? `\n👉 ${esc(event.advice)}` : ""}`;
    }
    case "task-start-failed":
      return `❌ <b>任务启动失败</b>${event.trigger ? `（${TRIGGER_LABEL[event.trigger]}触发）` : ""}\n${esc(taskLabel(event.task))}\n${esc(event.reason)}`;
    case "offline-done":
      return `☁️ <b>云下载完成</b>\n${esc(event.name)}\n${esc(event.detail)}\n→ ${esc(event.target)}`;
    case "offline-failed":
      return `❌ <b>云下载未能生成 strm</b>\n${esc(event.name)}\n${esc(event.detail)}`;
    case "offline-copied":
      return `📦 <b>已复制到 OpenList</b>\n${esc(event.name)}\n→ ${esc(event.target)}`;
    case "offline-copy-failed":
      return `❌ <b>云下载未能复制到 OpenList</b>\n${esc(event.name)}\n${esc(event.detail)}`;
    case "copy-done":
      return `📦 <b>已复制到 OpenList</b>（${esc(event.source)}）\n${esc(event.name)}\n→ ${esc(event.target)}`;
    case "copy-failed":
      return `❌ <b>复制到 OpenList 失败</b>（${esc(event.source)}）\n${esc(event.name)}\n${esc(event.detail)}`;
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
    case "update-available":
      return `🆕 <b>OpenStrm 有新版本</b>\n${esc(event.current)} → <b>${esc(event.version)}</b>\n${esc(event.url)}\n升级前记得在「设置」里下载一次备份。`;
    case "emby-new": {
      if (event.groups.length === 0) return `📥 <b>Emby 入库</b>\n新增 ${event.total} 个条目（数量太多，不逐条列了）`;
      const lines = event.groups.slice(0, 12).map(embyNewLine);
      if (event.groups.length > 12) lines.push(`…还有 ${event.groups.length - 12} 部`);
      return `📥 <b>Emby 入库</b>\n${lines.join("\n")}`;
    }
    case "organize-done": {
      const kinds = event.failedByKind ?? {};
      const breakdown = (Object.keys(FAILURE_LABEL) as Array<keyof typeof FAILURE_LABEL>)
        .filter((k) => k !== "mirror" && (kinds[k] ?? 0) > 0)
        .map((k) => `${FAILURE_LABEL[k]} ${kinds[k]}`)
        .join("、");
      const mirror = kinds.mirror ?? 0;
      if (event.reverted) {
        const left = event.notReverted ?? 0;
        const head = left > 0 ? "⚠️ <b>整理已撤销（有没退回的）</b>" : "↩️ <b>整理已撤销</b>";
        const tail = left > 0 ? `，${left} 项没退回${breakdown ? `（${breakdown}）` : ""}` : "";
        const hint = left > 0 || mirror > 0 ? "\n到「整理」页继续撤销或放弃" : "";
        return `${head}\n${esc(taskLabel(event.task))}\n${event.units} 部作品，${event.done} 项已退回${tail}${mirror > 0 ? `，本地未同步 ${mirror}` : ""}${hint}`;
      }
      const head = event.failed > 0 ? "⚠️ <b>整理完成（有失败）</b>" : "🗂 <b>整理完成</b>";
      const parts = [`${event.units} 部作品，${event.done} 项已改名 / 移动`];
      if (event.failed > 0) parts.push(`失败 ${event.failed}${breakdown ? `（${breakdown}）` : ""}`);
      if (mirror > 0) parts.push(`本地未同步 ${mirror}`);
      const hint = event.failed > 0 || mirror > 0 ? "\n到「整理」页重试或放弃" : "";
      return `${head}\n${esc(taskLabel(event.task))}\n${parts.join("，")}${hint}`;
    }
    case "organize-review": {
      const extra = [event.unsure > 0 ? `${event.unsure} 部识别把握不大` : "", event.conflicts > 0 ? `${event.conflicts} 项冲突` : ""].filter(Boolean).join("，");
      return `🗂 <b>整理待确认</b>\n${esc(taskLabel(event.task))}\n${event.units} 部作品、${event.planned} 项待处理${extra ? `（${extra}）` : ""}\n到「整理」页确认后执行。`;
    }
    case "account-alert": {
      const issue = event.issue ?? classifyAccountIssue(event.reason);
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

/** 安全告警（比如管理员密码一小时里错了太多次）：不看通知开关，配了机器人就发 */
export async function notifySecurityAlert(text: string): Promise<boolean> {
  const telegram = readAppSettings().telegram;
  if (!telegram?.botToken || !telegram.chatId) return false;
  await sender(telegram.chatId, text);
  return true;
}

/* ------------------------------- OAuth 授权请求 ------------------------------- */

/** 按钮的回调数据前缀：`oaa:<请求 id>:<read|daily>` 批准、`oad:<请求 id>` 拒绝，commands.ts 认这两个 */
export const OAUTH_APPROVE_ACTION = "oaa";
export const OAUTH_DENY_ACTION = "oad";

const SCOPE_TEXT: Record<string, string> = { read: "查看", run: "运行", write: "改网盘", danger: "危险操作" };

type ButtonSender = (chatId: string, text: string, buttons: InlineKeyboard) => Promise<void>;

const realButtonSender: ButtonSender = async (chatId, text, buttons) => {
  const token = readAppSettings().telegram?.botToken;
  if (!token) return;
  const res = await createTelegramBot(token).sendMessage(chatId, text, { buttons });
  if (!res.ok) log.warn(`Telegram 批准通知发送失败：${res.error ?? res.description ?? "unknown"}`);
};

let buttonSender: ButtonSender = realButtonSender;

/** 仅供测试：换掉带按钮的发送；传 null 恢复 */
export function setButtonSender(fn: ButtonSender | null): void {
  buttonSender = fn ?? realButtonSender;
}

/** 一条授权请求的说明（通知、配对码对上后回的消息都用）：名字是客户端自己报的，CIMD 的另外给出它地址的域名 */
export function oauthRequestText(req: OAuthPendingRequest): string {
  const lines = [
    "🔐 <b>有客户端请求连接 OpenStrm</b>",
    req.clientHost ? `${esc(req.clientName)}（身份：${esc(req.clientHost)}）` : `${esc(req.clientName)}（名字是它自己报的）`,
    `授权后跳到：${esc(req.redirectHost)}${req.redirectInsecure ? "（公网上的 http，明文）" : req.redirectLoopback ? "（本机）" : ""}`,
  ];
  if (req.requestedScopes.length > 0) lines.push(`它要：${req.requestedScopes.map((s) => SCOPE_TEXT[s] ?? s).join("、")}`);
  if (req.ip) lines.push(`来自：${esc(req.ip)}`);
  return lines.join("\n");
}

/**
 * 有客户端在授权页上等批准：推到通知的那个聊天，只带「拒绝」按钮。批准要证明批的是自己眼前那一条：
 * 开了 Telegram 里批准的，把授权页上的配对码发给机器人才出批准按钮；没开的到设置页里批。
 * 不看通知开关（这是要人去处理的）；一小时最多 10 条，有人刷授权请求时不至于刷屏
 */
export async function notifyOAuthRequest(req: OAuthPendingRequest): Promise<boolean> {
  const telegram = readAppSettings().telegram;
  if (!telegram?.botToken || !telegram.chatId) return false;
  if (!oauthNotifyBucket.take("all").ok) {
    log.warn({ requestId: req.id }, "授权请求通知太多，这一条不发了（设置页里照样看得到）");
    return false;
  }
  const how = [
    req.passwordApproval ? "是你自己在连接的话，直接在授权页上输管理员密码批准就行。" : "",
    telegram.allowOAuthApproval
      ? "是你自己发起的：把授权页上显示的配对码发给我，我回你批准按钮。不是你发起的就点拒绝。"
      : "要批准：到 OpenStrm 的「设置 → 智能体接入 → 待批准」里点「批准」，输入授权页上的配对码。不是你发起的就点拒绝。",
  ].join("");
  await buttonSender(telegram.chatId, `${oauthRequestText(req)}\n\n${how}`, [[{ text: "❌ 拒绝", callback_data: `${OAUTH_DENY_ACTION}:${req.id}` }]]);
  return true;
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
        const issue = event.issue ?? classifyAccountIssue(event.reason);
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
      case "offline-copied":
      case "offline-copy-failed":
      // 复制的通知跟着云下载那个开关走：它本来就是从云下载长出来的，设置不用迁
      case "copy-done":
      case "copy-failed":
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
      case "emby-new":
        if (!prefs.embyNew) return false;
        text = render(event);
        break;
      case "update-available":
        if (!prefs.update) return false;
        text = render(event);
        break;
      case "organize-done":
      case "organize-review":
        if (!prefs.organize) return false;
        text = render(event);
        break;
      case "account-alert": {
        const issue = event.issue ?? classifyAccountIssue(event.reason);
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
