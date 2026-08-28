/**
 * 机器人的"大脑"：一条 update 进来，先查权限，再分发到命令 / 链接 / 按钮回调。
 *
 * 所有会碰数据库、115、任务引擎的动作都收在 CommandDeps 里，测试用桩整体换掉；
 * 处理器本身只依赖 BotLike（发消息、改消息、应答按钮）。
 *
 * 权限模型：
 *   - 只回应白名单里的用户；私聊里未授权的人会收到自己的 id（方便管理员加白名单），群里一律不理
 *   - 群聊只认设置里的 chatId 那一个群
 *   - 按钮回调同样过白名单（以前只查文字命令，群里谁都能点"启动"）
 *   - 会产生副作用的动作各有一个开关：allowTaskStart / allowOfflineAdd / allowShareReceive，默认全关
 */
import type { AppSettings, TaskDefinition, TaskExecutionSummary } from "@openstrm/shared";
import { readAppSettings } from "../../db/repositories/settings.js";
import { listTasks } from "../../db/repositories/tasks.js";
import { listAccounts } from "../../db/repositories/accounts.js";
import { getAllTaskHistory, getLatestExecutions, getTaskHistory } from "../task-history.js";
import { cancelRunningTask, getRunningTask, listRunningTaskIds } from "../task/registry.js";
import { startTask } from "../task/runner.js";
import { addOfflineTasks, getOfflineWatcherStatus, listOfflineTasks, resolveAccount115, type AddOfflineResponse } from "../offline/service.js";
import { getLifeMonitorStatus } from "../life/monitor.js";
import { normalizeOfflineUrls } from "../cloud-115/offline.js";
import { getShareData, getShareDirList, shareExtractPayload } from "../cloud-115/share.js";
import { resolveTaskAccount115, saveSelectionToTask } from "../library/save-to-task.js";
import { moduleLogger } from "../../lib/logger.js";
import { createPending, takePending, type PendingAction } from "./session.js";
import { clamp, describeRun, esc, fmtTime, shortName, taskLabel } from "./format.js";
import type { BotCommand, BotLike, InlineKeyboard, TelegramCallbackQuery, TelegramChat, TelegramMessage, TelegramUpdate, TelegramUser } from "./bot.js";

const log = moduleLogger("telegram");

/** 注册到 Telegram 菜单里的命令（/start /ping 不放菜单） */
export const BOT_COMMANDS: BotCommand[] = [
  { command: "tasks", description: "任务列表，可直接运行" },
  { command: "status", description: "正在运行的任务与监控状态" },
  { command: "history", description: "最近的执行记录" },
  { command: "offline", description: "最近的云下载" },
  { command: "cancel", description: "取消正在运行的任务" },
  { command: "id", description: "查看自己的用户 id" },
  { command: "help", description: "使用说明" },
];

/* ------------------------------- 依赖 ------------------------------- */

export interface OfflineRow {
  name: string;
  state: string;
  statusText: string;
  percent: number;
}

export interface ShareSummary {
  shareCode: string;
  receiveCode: string;
  name: string;
  count: number;
  items: Array<{ id: string; name: string; isDir: boolean }>;
}

export interface CommandDeps {
  settings(): AppSettings;
  listTasks(): TaskDefinition[];
  /** 115 账号名；只有这些账号的任务能作为云下载 / 转存的目的地 */
  accounts115(): string[];
  latestExecutions(): Map<string, TaskExecutionSummary>;
  recentExecutions(limit: number): TaskExecutionSummary[];
  taskExecutions(taskId: string, limit: number): TaskExecutionSummary[];
  runningTaskIds(): string[];
  /** 正在跑的任务的总进度（"42.10"），拿不到就 null */
  runningPercent(taskId: string): string | null;
  startTask(taskId: string): Promise<{ ok: boolean; message: string }>;
  cancelTask(taskId: string): boolean;
  addOffline(input: { urls: string; taskId?: string }): Promise<AddOfflineResponse>;
  listOffline(): Promise<{ tasks: OfflineRow[]; count: number; quota: number | null; total: number | null }>;
  offlinePending(): number;
  lifeStatus(): { running: boolean; account: string | null; lastError: string | null };
  shareInfo(link: string): Promise<ShareSummary>;
  receiveShare(input: {
    task: TaskDefinition;
    shareCode: string;
    receiveCode: string;
    fileIds: string[];
    items: Array<{ name: string; isDir: boolean }>;
  }): Promise<{ ok: boolean; message: string }>;
}

/** 后端 startTask 的 message 是固定的英文句式，这里说成人话（和任务页保持一致） */
function describeStart(body: Record<string, unknown>): string {
  const message = typeof body.message === "string" ? body.message : "";
  const m = /^(\d+) files to download$/.exec(message);
  if (m) return `开始处理 ${m[1]} 个文件`;
  if (message === "no files to download") return "本地已是最新，没有需要处理的文件";
  const details = typeof body.details === "string" && body.details ? `：${body.details}` : "";
  return `${message || "启动失败"}${details}`;
}

const realDeps: CommandDeps = {
  settings: readAppSettings,
  listTasks,
  accounts115: () => listAccounts().filter((a) => a.accountType === "115").map((a) => a.name),
  latestExecutions: getLatestExecutions,
  recentExecutions: (limit) => getAllTaskHistory().slice(0, limit),
  taskExecutions: (taskId, limit) => getTaskHistory(taskId).slice(0, limit),
  runningTaskIds: listRunningTaskIds,
  runningPercent: (taskId) => {
    const logs = getRunningTask(taskId)?.logs;
    if (!logs?.length) return null;
    for (let i = logs.length - 1; i >= Math.max(0, logs.length - 50); i--) {
      try {
        const line = JSON.parse(logs[i]) as { overallPercent?: string };
        if (line.overallPercent) return line.overallPercent;
      } catch {
        /* 跳过 */
      }
    }
    return null;
  },
  startTask: async (taskId) => {
    const r = await startTask(taskId, { trigger: "telegram" });
    return { ok: r.status === 200, message: describeStart(r.body) };
  },
  cancelTask: (taskId) => cancelRunningTask(taskId, "Telegram 取消"),
  addOffline: (input) => addOfflineTasks(input),
  listOffline: async () => {
    const page = await listOfflineTasks(undefined, 1);
    return {
      tasks: page.tasks.map((t) => ({ name: t.name, state: t.state, statusText: t.statusText, percent: t.percent })),
      count: page.count,
      quota: page.quota,
      total: page.total,
    };
  },
  offlinePending: () => getOfflineWatcherStatus().pending,
  lifeStatus: () => {
    const s = getLifeMonitorStatus();
    return { running: s.running, account: s.account, lastError: s.lastError };
  },
  shareInfo: async (link) => {
    const account = resolveAccount115();
    const { share_code: shareCode, receive_code: receiveCode } = shareExtractPayload(link);
    const data = await getShareData(account, shareCode, receiveCode);
    const info = (data.shareinfo ?? data) as Record<string, unknown>;
    const name = String(info.share_title ?? info.share_name ?? info.title ?? "分享");
    const { list, count } = await getShareDirList(account, shareCode, receiveCode, 0, { limit: 20 });
    return {
      shareCode,
      receiveCode,
      name,
      count,
      items: list.map((it) => ({ id: String(it.id), name: it.name, isDir: it.is_dir })),
    };
  },
  receiveShare: async ({ task, shareCode, receiveCode, fileIds, items }) => {
    try {
      const accountInfo = resolveTaskAccount115(listAccounts(), task);
      const r = await saveSelectionToTask({
        task,
        accountInfo,
        shareCode,
        receiveCode,
        fileIds,
        selectedItems: items,
        subPath: "",
        mode: "async",
        settings: readAppSettings(),
      });
      if ("error" in r) {
        const body = r.error as Record<string, unknown>;
        return { ok: true, message: `已转存，但后台同步没能启动：${describeStart(body)}` };
      }
      const started = "message" in r && r.message ? describeStart({ message: r.message }) : "";
      return { ok: true, message: `已转存，后台同步已启动${started ? `：${started}` : ""}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },
};

let deps: CommandDeps = { ...realDeps };

/** 仅供测试：换掉会碰库、115、任务引擎的部分；传 null 恢复 */
export function setCommandDeps(partial: Partial<CommandDeps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/* ------------------------------- 权限 ------------------------------- */

type Access = "ok" | "deny-private" | "deny-silent";

function checkAccess(settings: AppSettings, from: TelegramUser | undefined, chat: TelegramChat): Access {
  if (!from || from.is_bot) return "deny-silent";
  const allowed = settings.telegram?.allowedUsers ?? [];
  const isPrivate = chat.type === "private";
  if (!allowed.includes(from.id)) return isPrivate ? "deny-private" : "deny-silent";
  const home = settings.telegram?.chatId;
  if (!isPrivate && (!home || String(chat.id) !== String(home))) return "deny-silent";
  return "ok";
}

function perms(settings: AppSettings) {
  return {
    taskStart: settings.telegram?.allowTaskStart === true,
    offlineAdd: settings.telegram?.allowOfflineAdd === true,
    shareReceive: settings.telegram?.allowShareReceive === true,
  };
}

/* ------------------------------- 入口 ------------------------------- */

export async function handleUpdate(bot: BotLike, update: TelegramUpdate): Promise<void> {
  if (update.message) return handleMessage(bot, update.message);
  if (update.callback_query) return handleCallback(bot, update.callback_query);
}

const SHARE_LINK = /https?:\/\/(?:[\w-]+\.)*(?:115\.com|115cdn\.com|anxia\.com)\/s\/[a-z0-9]+(?:\?[^\s]*)?/i;

async function handleMessage(bot: BotLike, msg: TelegramMessage): Promise<void> {
  const settings = deps.settings();
  const chatId = String(msg.chat.id);
  const access = checkAccess(settings, msg.from, msg.chat);
  if (access === "deny-silent") return;
  if (access === "deny-private") {
    await bot.sendMessage(
      chatId,
      `你还没有使用权限。\n你的用户 id 是 <code>${msg.from?.id}</code>，请管理员到 OpenStrm 的 Telegram 页把它加进白名单。`,
    );
    return;
  }
  const text = (msg.text ?? "").trim();
  if (!text) return;

  if (text.startsWith("/")) {
    // 群里的命令带 @botname
    const cmd = text.split(/\s+/)[0].replace(/@\S+$/, "").toLowerCase();
    await handleCommand(bot, chatId, cmd);
    return;
  }

  const share = SHARE_LINK.exec(text);
  if (share) {
    await beginShare(bot, chatId, msg.from!.id, share[0], settings);
    return;
  }
  const { urls } = normalizeOfflineUrls(text);
  if (urls.length > 0) {
    await beginOffline(bot, chatId, msg.from!.id, urls, settings);
    return;
  }
  // 长得像链接（thunder:// 之类）但一条都不认：说清楚收什么；纯聊天就给个提示
  if (/(?:^|\s)(?:[a-z][\w+.-]*:\/\/|magnet:\?|[0-9a-f]{40}\b)/i.test(text)) {
    await bot.sendMessage(chatId, "不认识这种链接。能收的有：115 分享链接、磁力、ed2k、http(s)、ftp。");
    return;
  }
  await bot.sendMessage(chatId, "直接把 115 分享链接或磁力/ed2k 链接发给我，或者用 /help 看看能做什么。");
}

/* ------------------------------- 命令 ------------------------------- */

async function handleCommand(bot: BotLike, chatId: string, cmd: string): Promise<void> {
  switch (cmd) {
    case "/start":
    case "/help":
      return void (await bot.sendMessage(chatId, helpText(deps.settings())));
    case "/ping":
      return void (await bot.sendMessage(chatId, "🏓 Pong，机器人在线。"));
    case "/id":
      return void (await bot.sendMessage(chatId, `这个会话的 chat id 是 <code>${esc(chatId)}</code>`));
    case "/tasks":
      return sendTaskList(bot, chatId);
    case "/status":
      return sendStatus(bot, chatId);
    case "/history":
      return sendHistory(bot, chatId);
    case "/offline":
      return sendOffline(bot, chatId);
    case "/cancel":
      return sendCancelMenu(bot, chatId);
    default:
      await bot.sendMessage(chatId, `不认识的命令 ${esc(cmd)}，用 /help 看看有哪些。`);
  }
}

function helpText(settings: AppSettings): string {
  const p = perms(settings);
  const onOff = (v: boolean) => (v ? "已开启" : "未开启，到 Telegram 页打开");
  return [
    "<b>OpenStrm 机器人</b>",
    "",
    "<b>直接发链接：</b>",
    `• 磁力 / ed2k / http 链接 → 交给 115 云下载，可选下到某个任务的目录，下完自动生成 strm（${onOff(p.offlineAdd)}）`,
    `• 115 分享链接 → 转存到某个任务的目录并同步（${onOff(p.shareReceive)}）`,
    "",
    "<b>命令：</b>",
    `/tasks 任务列表，带「运行」按钮（${onOff(p.taskStart)}）`,
    "/status 正在跑的任务、云下载回执、网盘监控",
    "/history 最近的执行记录",
    "/offline 最近的云下载",
    "/cancel 取消正在运行的任务",
    "/id 查看 chat id",
  ].join("\n");
}

function taskButtons(task: TaskDefinition, running: boolean, canStart: boolean): InlineKeyboard[number] {
  const row: InlineKeyboard[number] = [];
  if (running) row.push({ text: "⏹ 取消", callback_data: `cancel:${task.id}` });
  else if (canStart) row.push({ text: "▶ 运行", callback_data: `run:${task.id}` });
  row.push({ text: "📜 记录", callback_data: `hist:${task.id}` });
  return row;
}

async function sendTaskList(bot: BotLike, chatId: string): Promise<void> {
  const settings = deps.settings();
  const tasks = deps.listTasks();
  if (tasks.length === 0) {
    await bot.sendMessage(chatId, "还没有任务，先到 OpenStrm 首页建一个。");
    return;
  }
  const latest = deps.latestExecutions();
  const running = new Set(deps.runningTaskIds());
  const canStart = perms(settings).taskStart;
  const lines: string[] = [`<b>任务（${tasks.length}）</b>`];
  const buttons: InlineKeyboard = [];
  tasks.slice(0, 20).forEach((t, i) => {
    const last = latest.get(t.id);
    const state = running.has(t.id) ? `🔄 运行中 ${deps.runningPercent(t.id) ?? ""}%`.replace(" %", "") : last ? describeRun(last) : "还没跑过";
    const cron = t.cronExpression ? ` · ⏰ <code>${esc(t.cronExpression)}</code>` : "";
    lines.push(`\n<b>${i + 1}. ${esc(taskLabel(t))}</b>\n账户 ${esc(t.account)}${cron}\n${state}`);
    buttons.push([{ text: `${i + 1}`, callback_data: "noop" }, ...taskButtons(t, running.has(t.id), canStart)]);
  });
  if (tasks.length > 20) lines.push(`\n…还有 ${tasks.length - 20} 个任务，请到网页查看`);
  if (!canStart) lines.push("\n「运行」按钮未开启：到 Telegram 页打开「允许从 Telegram 启动任务」");
  await bot.sendMessage(chatId, clamp(lines.join("\n")), { buttons });
}

async function sendStatus(bot: BotLike, chatId: string): Promise<void> {
  const tasks = new Map(deps.listTasks().map((t) => [t.id, t]));
  const running = deps.runningTaskIds();
  const lines: string[] = ["<b>运行状态</b>", ""];
  if (running.length === 0) lines.push("没有正在运行的任务");
  else {
    lines.push(`<b>正在运行（${running.length}）</b>`);
    for (const id of running) {
      const t = tasks.get(id);
      const pct = deps.runningPercent(id);
      lines.push(`🔄 ${esc(t ? taskLabel(t) : id)}${pct ? ` · ${pct}%` : ""}`);
    }
  }
  const pending = deps.offlinePending();
  lines.push("", `云下载：${pending > 0 ? `${pending} 个下载完成后待生成 strm` : "没有待处理的回执"}`);
  const life = deps.lifeStatus();
  lines.push(
    `网盘监控：${life.running ? `运行中（账号 ${esc(life.account ?? "")}）` : "未运行"}${life.lastError ? `\n⚠️ 最近错误：${esc(life.lastError)}` : ""}`,
  );
  await bot.sendMessage(chatId, clamp(lines.join("\n")));
}

function historyLines(runs: TaskExecutionSummary[], tasks: Map<string, TaskDefinition>): string[] {
  return runs.map((r) => {
    const t = tasks.get(r.taskId);
    const label = t ? taskLabel(t) : r.taskInfo.originPath || r.taskId;
    return `<b>${esc(label)}</b>\n${describeRun(r)} · ${fmtTime(r.startTime)}`;
  });
}

async function sendHistory(bot: BotLike, chatId: string): Promise<void> {
  const runs = deps.recentExecutions(8);
  if (runs.length === 0) {
    await bot.sendMessage(chatId, "还没有执行记录。");
    return;
  }
  const tasks = new Map(deps.listTasks().map((t) => [t.id, t]));
  await bot.sendMessage(chatId, clamp(["<b>最近的执行</b>", "", ...historyLines(runs, tasks).join("\n\n").split("\n")].join("\n")));
}

async function sendOffline(bot: BotLike, chatId: string): Promise<void> {
  let page: Awaited<ReturnType<CommandDeps["listOffline"]>>;
  try {
    page = await deps.listOffline();
  } catch (err) {
    await bot.sendMessage(chatId, `读取云下载列表失败：${esc(err instanceof Error ? err.message : String(err))}`);
    return;
  }
  const icon: Record<string, string> = { done: "✅", failed: "❌", downloading: "⬇️", pending: "⏳" };
  const lines = [`<b>云下载</b>（共 ${page.count}${page.quota != null ? `，配额剩余 ${page.quota}${page.total != null ? `/${page.total}` : ""}` : ""}）`, ""];
  if (page.tasks.length === 0) lines.push("列表是空的");
  for (const t of page.tasks.slice(0, 10)) {
    const pct = t.state === "downloading" ? ` ${Math.floor(t.percent)}%` : "";
    lines.push(`${icon[t.state] ?? "•"} ${esc(shortName(t.name))} · ${esc(t.statusText)}${pct}`);
  }
  await bot.sendMessage(chatId, clamp(lines.join("\n")));
}

async function sendCancelMenu(bot: BotLike, chatId: string): Promise<void> {
  const running = deps.runningTaskIds();
  if (running.length === 0) {
    await bot.sendMessage(chatId, "没有正在运行的任务。");
    return;
  }
  const tasks = new Map(deps.listTasks().map((t) => [t.id, t]));
  const buttons: InlineKeyboard = running.map((id) => [
    { text: `⏹ ${shortName(tasks.get(id)?.originPath ?? id, 30)}`, callback_data: `cancel:${id}` },
  ]);
  await bot.sendMessage(chatId, "要取消哪个任务？", { buttons });
}

/* ------------------------------- 链接：云下载 ------------------------------- */

function destinationTasks(): TaskDefinition[] {
  const names = new Set(deps.accounts115());
  return deps.listTasks().filter((t) => names.has(t.account));
}

async function beginOffline(bot: BotLike, chatId: string, userId: number, urls: string[], settings: AppSettings): Promise<void> {
  if (!perms(settings).offlineAdd) {
    await bot.sendMessage(chatId, "云下载功能未开启：到 OpenStrm 的 Telegram 页打开「允许添加云下载」。");
    return;
  }
  if (deps.accounts115().length === 0) {
    await bot.sendMessage(chatId, "还没有配置 115 账号，无法云下载。");
    return;
  }
  const token = createPending(chatId, userId, { kind: "offline", urls });
  const buttons: InlineKeyboard = destinationTasks()
    .slice(0, 15)
    .map((t) => [{ text: `📁 ${shortName(t.originPath, 40)}`, callback_data: `ofl:${token}:${t.id}` }]);
  buttons.push([{ text: "☁️ 115 默认目录（不生成 strm）", callback_data: `ofl:${token}:default` }]);
  buttons.push([{ text: "取消", callback_data: `drop:${token}` }]);
  const preview = urls.slice(0, 5).map((u) => `• ${esc(shortName(u, 60))}`);
  if (urls.length > 5) preview.push(`…共 ${urls.length} 条`);
  await bot.sendMessage(chatId, clamp([`收到 ${urls.length} 条链接，下载到哪里？`, ...preview, "", "选任务目录的话，下完会自动生成 strm。"].join("\n")), { buttons });
}

async function finishOffline(bot: BotLike, chatId: string, messageId: number | undefined, urls: string[], dest: string): Promise<void> {
  const task = dest === "default" ? undefined : deps.listTasks().find((t) => t.id === dest);
  if (dest !== "default" && !task) {
    await edit(bot, chatId, messageId, "这个任务已经不存在了，请重新发一次链接。");
    return;
  }
  let text: string;
  try {
    const r = await deps.addOffline({ urls: urls.join("\n"), taskId: task?.id });
    const lines = [`☁️ 已添加 ${r.added} 个云下载${task ? `\n目录：${esc(task.originPath)}${r.followup ? "，下完自动生成 strm" : ""}` : "\n目录：115 默认目录"}`];
    const failed = r.results.filter((x) => !x.ok);
    if (failed.length) lines.push("", `未接受 ${failed.length} 条：`, ...failed.slice(0, 5).map((x) => `• ${esc(shortName(x.url, 40))} — ${esc(x.message ?? "115 未接受")}`));
    if (r.invalid.length) lines.push(`不支持的链接 ${r.invalid.length} 条`);
    text = lines.join("\n");
  } catch (err) {
    text = `❌ 添加云下载失败：${esc(err instanceof Error ? err.message : String(err))}`;
  }
  await edit(bot, chatId, messageId, clamp(text));
}

/* ------------------------------- 链接：分享转存 ------------------------------- */

async function beginShare(bot: BotLike, chatId: string, userId: number, link: string, settings: AppSettings): Promise<void> {
  if (!perms(settings).shareReceive) {
    await bot.sendMessage(chatId, "分享转存功能未开启：到 OpenStrm 的 Telegram 页打开「允许转存分享」。");
    return;
  }
  let info: ShareSummary;
  try {
    info = await deps.shareInfo(link);
  } catch (err) {
    await bot.sendMessage(chatId, `读取分享失败：${esc(err instanceof Error ? err.message : String(err))}`);
    return;
  }
  if (info.items.length === 0) {
    await bot.sendMessage(chatId, "这个分享是空的，或者提取码不对。");
    return;
  }
  const targets = destinationTasks();
  if (targets.length === 0) {
    await bot.sendMessage(chatId, "没有 115 账号的同步任务，先到首页建一个再来转存。");
    return;
  }
  const token = createPending(chatId, userId, {
    kind: "share",
    link,
    shareCode: info.shareCode,
    receiveCode: info.receiveCode,
    name: info.name,
    fileIds: info.items.map((i) => i.id),
    items: info.items.map((i) => ({ name: i.name, isDir: i.isDir })),
  });
  const listing = info.items.slice(0, 10).map((i) => `${i.isDir ? "📁" : "📄"} ${esc(shortName(i.name))}`);
  if (info.count > 10) listing.push(`…共 ${info.count} 项`);
  const buttons: InlineKeyboard = targets.slice(0, 15).map((t) => [{ text: `📁 转存到 ${shortName(t.originPath, 36)}`, callback_data: `shr:${token}:${t.id}` }]);
  buttons.push([{ text: "取消", callback_data: `drop:${token}` }]);
  await bot.sendMessage(
    chatId,
    clamp([`📦 <b>${esc(info.name)}</b>`, ...listing, "", "整个分享转存到哪个任务的目录？转存后会触发该任务的后台同步。"].join("\n")),
    { buttons },
  );
}

async function finishShare(
  bot: BotLike,
  chatId: string,
  messageId: number | undefined,
  pending: Extract<PendingAction, { kind: "share" }>,
  taskId: string,
): Promise<void> {
  const task = deps.listTasks().find((t) => t.id === taskId);
  if (!task) {
    await edit(bot, chatId, messageId, "这个任务已经不存在了，请重新发一次链接。");
    return;
  }
  const r = await deps.receiveShare({ task, shareCode: pending.shareCode, receiveCode: pending.receiveCode, fileIds: pending.fileIds, items: pending.items });
  const head = r.ok ? `✅ <b>${esc(pending.name)}</b>` : `❌ <b>${esc(pending.name)}</b> 转存失败`;
  await edit(bot, chatId, messageId, clamp(`${head}\n目录：${esc(task.originPath)}\n${esc(r.message)}`));
}

/* ------------------------------- 按钮回调 ------------------------------- */

async function edit(bot: BotLike, chatId: string, messageId: number | undefined, text: string): Promise<void> {
  if (messageId != null) {
    const r = await bot.editMessage(chatId, messageId, text);
    if (r.ok) return;
  }
  await bot.sendMessage(chatId, text);
}

async function handleCallback(bot: BotLike, q: TelegramCallbackQuery): Promise<void> {
  const settings = deps.settings();
  const chat = q.message?.chat;
  if (!chat) {
    await bot.answerCallback(q.id);
    return;
  }
  if (checkAccess(settings, q.from, chat) !== "ok") {
    await bot.answerCallback(q.id, "没有权限");
    return;
  }
  const chatId = String(chat.id);
  const messageId = q.message?.message_id;
  const data = q.data ?? "";
  const [action, ...rest] = data.split(":");
  const arg = rest.join(":");

  try {
    switch (action) {
      case "noop":
        await bot.answerCallback(q.id);
        return;
      case "run": {
        if (!perms(settings).taskStart) {
          await bot.answerCallback(q.id, "未开启从 Telegram 启动任务");
          await bot.sendMessage(chatId, "「运行」未开启：到 OpenStrm 的 Telegram 页打开「允许从 Telegram 启动任务」。");
          return;
        }
        const task = deps.listTasks().find((t) => t.id === arg);
        if (!task) {
          await bot.answerCallback(q.id, "任务不存在");
          return;
        }
        await bot.answerCallback(q.id, "启动中…");
        const r = await deps.startTask(task.id);
        await bot.sendMessage(chatId, `${r.ok ? "🚀" : "❌"} <b>${esc(taskLabel(task))}</b>\n${esc(r.message)}`);
        return;
      }
      case "cancel": {
        const task = deps.listTasks().find((t) => t.id === arg);
        const ok = deps.cancelTask(arg);
        await bot.answerCallback(q.id, ok ? "已取消" : "任务没在运行");
        await bot.sendMessage(chatId, ok ? `⏹ 已取消 ${esc(task ? taskLabel(task) : arg)}` : "这个任务没在运行。");
        return;
      }
      case "hist": {
        const task = deps.listTasks().find((t) => t.id === arg);
        const runs = deps.taskExecutions(arg, 3);
        await bot.answerCallback(q.id);
        if (runs.length === 0) {
          await bot.sendMessage(chatId, `${esc(task ? taskLabel(task) : arg)} 还没有执行记录。`);
          return;
        }
        const label = task ? taskLabel(task) : runs[0].taskInfo.originPath || arg;
        await bot.sendMessage(chatId, clamp([`<b>${esc(label)}</b>`, "", ...runs.map((r) => `${describeRun(r)} · ${fmtTime(r.startTime)}`)].join("\n")));
        return;
      }
      case "drop": {
        takePending(arg);
        await bot.answerCallback(q.id);
        await edit(bot, chatId, messageId, "已取消。");
        return;
      }
      case "ofl":
      case "shr": {
        const [token, dest] = arg.split(":");
        const pending = takePending(token);
        if (!pending || pending.action.kind !== (action === "ofl" ? "offline" : "share")) {
          await bot.answerCallback(q.id, "已过期，请重新发一次链接");
          return;
        }
        if (pending.userId !== q.from.id) {
          await bot.answerCallback(q.id, "这不是你发起的操作");
          return;
        }
        // 权限可能在贴链接和点按钮之间被关掉了，点的时候再查一次
        if (action === "ofl") {
          if (!perms(settings).offlineAdd) {
            await bot.answerCallback(q.id, "云下载功能已关闭");
            return;
          }
          await bot.answerCallback(q.id, "提交中…");
          await finishOffline(bot, chatId, messageId, (pending.action as { urls: string[] }).urls, dest);
        } else {
          if (!perms(settings).shareReceive) {
            await bot.answerCallback(q.id, "分享转存功能已关闭");
            return;
          }
          await bot.answerCallback(q.id, "转存中…");
          await finishShare(bot, chatId, messageId, pending.action as Extract<typeof pending.action, { kind: "share" }>, dest);
        }
        return;
      }
      default:
        await bot.answerCallback(q.id, "不认识的操作");
    }
  } catch (err) {
    log.error({ err, data }, "处理 Telegram 按钮失败");
    await bot.answerCallback(q.id, "出错了");
    await bot.sendMessage(chatId, `❌ 操作失败：${esc(err instanceof Error ? err.message : String(err))}`);
  }
}

