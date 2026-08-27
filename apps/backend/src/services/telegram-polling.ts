/**
 * Telegram 轮询管理器。
 *
 * 一个顺序的长轮询循环：一次 getUpdates 最多挂 30 秒，回来把这批处理完再发下一次。
 * 以前是 setInterval 每 5 秒发一次 30 秒的长轮询，同一时刻最多 6 个请求叠着，
 * Telegram 对并发的 getUpdates 回 409 把前一个掐掉——自己跟自己打架；
 * 再加上 limit=1，消息一多就一条条漏。
 */
import axios from "axios";
import { createTelegramBot, type TelegramUpdate } from "./telegram.js";
import { readAppSettings } from "../db/repositories/settings.js";
import { listTasks } from "../db/repositories/tasks.js";
import { startTask } from "./task/runner.js";
import type { TaskDefinition } from "@openstrm/shared";
import { moduleLogger } from "../lib/logger.js";

const log = moduleLogger("telegram-polling");

type Bot = ReturnType<typeof createTelegramBot>;

function readTasks(): TaskDefinition[] {
  return listTasks();
}

function isTelegramUserAllowed(userId: number): boolean {
  const settings = readAppSettings();
  return settings.telegram?.allowedUsers?.includes(userId) || false;
}

/** 启动任务的执行器。默认直接调 runner；测试可以换成桩，传 null 恢复默认 */
export type TaskStarter = (taskId: string) => Promise<{ ok: boolean; body: string }>;

const defaultTaskStarter: TaskStarter = async (taskId) => {
  const result = await startTask(taskId);
  return { ok: result.status === 200, body: JSON.stringify(result.body) };
};

let taskStarter: TaskStarter = defaultTaskStarter;

export function setTaskStarter(fn: TaskStarter | null): void {
  taskStarter = fn ?? defaultTaskStarter;
}

/* ------------------------------- 轮询循环 ------------------------------- */

/** 出错后的等待。409 是"另有人在拉同一个 bot"，等久一点；其余按次数指数退避 */
const backoff = { conflictMs: 10_000, errorBaseMs: 1_000, errorMaxMs: 30_000 };

let active = false;
let abort: AbortController | null = null;
let loopDone: Promise<void> = Promise.resolve();
let startPromise: Promise<boolean> | null = null;
/**
 * 只存在内存里：进程重启后从 0 开始，Telegram 会把上次没确认的更新再发一遍。
 * 确认发生在下一次 getUpdates 带上 offset 的时候，所以只有"停在一批处理到一半"这种
 * 窗口会重复收到已处理的那几条。
 */
let lastUpdateId = 0;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

async function pollLoop(bot: Bot, signal: AbortSignal): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    let updates: TelegramUpdate[];
    try {
      // 还没处理过任何 update 时不带 offset：Telegram 会从最早没确认的那条给起
      const offset = lastUpdateId > 0 ? lastUpdateId + 1 : 0;
      updates = await bot.getUpdates(offset, 100, 30, signal);
      failures = 0;
    } catch (err) {
      if (signal.aborted) return;
      failures++;
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status === 409) {
        // 另一个进程在用同一个 token 轮询，或者 webhook 还没摘掉——不是"没有新消息"
        log.warn(`getUpdates 409：另有轮询者或 webhook 仍在，${backoff.conflictMs / 1000}s 后重试`);
        await sleep(backoff.conflictMs, signal);
      } else {
        const wait = Math.min(backoff.errorMaxMs, backoff.errorBaseMs * 2 ** (failures - 1));
        log.warn({ err }, `getUpdates 失败（连续 ${failures} 次），${wait / 1000}s 后重试`);
        await sleep(wait, signal);
      }
      continue;
    }

    for (const update of updates) {
      // 停了就不再处理：没处理的那些下次从 lastUpdateId + 1 再拉，不会丢
      if (signal.aborted) return;
      lastUpdateId = update.update_id;
      try {
        if (update.message) await handleMessage(bot, update.message);
        if (update.callback_query) await handleCallbackQuery(bot, update.callback_query);
      } catch (err) {
        // 单条消息处理失败不能把整个循环带死
        log.error({ err, updateId: update.update_id }, "处理 Telegram update 失败");
      }
    }
  }
}

/** 起轮询。已在跑返回 false；没配 bot token 也返回 false（并记一条 error） */
export function startPolling(): Promise<boolean> {
  if (active) return Promise.resolve(false);
  // 并发的两次 start 共用同一个启动过程，不会起出两个循环
  startPromise ??= doStart().finally(() => {
    startPromise = null;
  });
  return startPromise;
}

async function doStart(): Promise<boolean> {
  const telegram = readAppSettings().telegram;
  if (!telegram?.botToken) {
    log.error("Telegram not configured for polling");
    return false;
  }
  // 上一轮循环可能还在收尾（stop 之后 handler 还没跑完）：等它退出再起新的
  await loopDone;

  const bot = createTelegramBot(telegram.botToken);
  // getUpdates 和 webhook 互斥，先把 webhook 摘掉。摘不掉也照常起：真冲突会以 409 的形式在循环里暴露出来
  await bot.deleteWebhook();

  active = true;
  const controller = new AbortController();
  abort = controller;
  loopDone = pollLoop(bot, controller.signal)
    .catch((err) => log.error({ err }, "Telegram 轮询循环异常退出"))
    .finally(() => {
      // 循环自己退出（而不是被 stop 掉）时也要把状态收回来，界面上才能再点启动
      if (abort === controller) {
        active = false;
        abort = null;
      }
    });
  log.info("Telegram polling started");
  return true;
}

/** 停轮询：中止挂着的长连接，循环随即退出。本来就没在跑返回 false */
export function stopPolling(): boolean {
  if (!active) return false;
  active = false;
  abort?.abort();
  abort = null;
  log.info("Telegram polling stopped");
  return true;
}

/** 停掉再起：界面上的"强制清理"用；bot token 改了之后也走这个 */
export async function restartPolling(): Promise<boolean> {
  stopPolling();
  return startPolling();
}

export function getPollingStatus(): { active: boolean; message: string } {
  return {
    active,
    message: active ? "Polling is active" : "Polling is not active",
  };
}

/** 仅供测试：把退避调短、等循环真正退出 */
export function __test_setBackoff(next: Partial<typeof backoff>): void {
  Object.assign(backoff, next);
}
export const __test_pollingDone = (): Promise<void> => loopDone;

/* ------------------------------- 消息处理 ------------------------------- */

// 处理消息
async function handleMessage(bot: ReturnType<typeof createTelegramBot>, message: unknown) {
  const msg = message as { chat: { id: number }; text?: string; from: { username?: string; first_name: string; id: number } };
  const chatId = msg.chat.id.toString();
  const text = msg.text;
  const username = msg.from.username || msg.from.first_name;
  const userId = msg.from.id;

  log.info(`[Telegram Polling] Message from ${username} (${userId}): ${text}`);
  log.info(`[Telegram Polling] Chat ID: ${chatId}, User ID: ${userId}`);

  // 处理命令
  if (text?.startsWith('/')) {
    await handleCommand(bot, chatId, text, username, userId);
  } else {
    // 处理普通消息
    await bot.sendMessage({
      chat_id: chatId,
      text: `Hello ${username}! 👋\n\nUse /help to see available commands.`,
      parse_mode: 'HTML'
    });
  }
}

// 处理命令
async function handleCommand(bot: ReturnType<typeof createTelegramBot>, chatId: string, command: string, username: string, userId: number) {
  const [cmd] = command.split(' ');

  // 检查用户权限
  if (!isTelegramUserAllowed(userId)) {
    await bot.sendMessage({
      chat_id: chatId,
      text: `❌ <b>Access Denied</b>\n\n` +
            `You are not authorized to use this bot.\n\n` +
            `Contact the administrator to get access.\n\n` +
            `Your User ID: <code>${userId}</code>`,
      parse_mode: 'HTML'
    });
    return;
  }

  switch (cmd) {
    case '/start':
      await handleStartCommand(bot, chatId, username);
      break;

    case '/help':
      await bot.sendMessage({
        chat_id: chatId,
        text: `<b>🤖 OpenStrm Bot Commands</b>\n\n` +
              `<b>Available Commands:</b>\n` +
              `<b>/start</b> - Start the bot\n` +
              `<b>/help</b> - Show this help message\n` +
              `<b>/ping</b> - Test bot connectivity\n` +
              `<b>/status</b> - Show system status\n` +
              `<b>/tasks</b> - List current tasks\n` +
              `<b>/settings</b> - Show current settings\n` +
              `<b>/users</b> - List authorized users\n` +
              `<b>/adduser &lt;user_id&gt;</b> - Add new user\n` +
              `<b>/removeuser &lt;user_id&gt;</b> - Remove user\n\n` +
              `✅ You are authorized to use all commands.`,
        parse_mode: 'HTML'
      });
      break;

    case '/ping':
      await bot.sendMessage({
        chat_id: chatId,
        text: `🏓 Pong! Bot is working fine. (Polling mode)`,
        parse_mode: 'HTML'
      });
      break;

    case '/status':
      await bot.sendMessage({
        chat_id: chatId,
        text: `<b>📊 System Status</b>\n\n` +
              `<b>Bot:</b> ✅ Online (Polling)\n` +
              `<b>Time:</b> ${new Date().toLocaleString()}\n` +
              `<b>Uptime:</b> ${process.uptime().toFixed(0)}s`,
        parse_mode: 'HTML'
      });
      break;

    case '/tasks':
      await bot.sendMessage({
        chat_id: chatId,
        text: `<b>📋 Current Tasks</b>\n\n` +
              `No tasks available at the moment.\n\n` +
              `<i>This feature will be implemented soon.</i>`,
        parse_mode: 'HTML'
      });
      break;

    case '/users': {
      const settings = readAppSettings();
      const users = settings.telegram?.allowedUsers || [];
      
      await bot.sendMessage({
        chat_id: chatId,
        text: `<b>👥 Authorized Users</b>\n\n` +
              `Total users: ${users.length}\n` +
              `Users: ${users.join(', ')}`,
        parse_mode: 'HTML'
      });
      break;
    }

    default:
      await bot.sendMessage({
        chat_id: chatId,
        text: `❓ Unknown command: ${cmd}\n\nUse /help to see available commands.`,
        parse_mode: 'HTML'
      });
  }
}

// 处理回调查询（简化版本）
async function handleCallbackQuery(bot: ReturnType<typeof createTelegramBot>, callbackQuery: unknown) {
  const query = callbackQuery as { message?: { chat: { id: number } }; data?: string; id: string };
  if (!query.message) {
    log.error("Callback query has no message");
    return;
  }

  const chatId = query.message.chat.id.toString();
  const data = query.data;
  const queryId = query.id;

  log.info(`[Telegram Polling] Callback query: ${data}`);

  // 回答回调查询
  await bot.answerCallbackQuery(queryId, "Processing...");

  // 处理任务开始回调
  if (data && data.startsWith('start_task_')) {
    const taskId = data.replace('start_task_', '');
    if (!readAppSettings().telegram?.allowTaskStart) {
      await bot.sendMessage({
        chat_id: chatId,
        text: `⚠️ <b>任务启动未开启</b>\n\n` +
              `从 Telegram 启动任务默认关闭。需要的话在设置里把 ` +
              `<code>telegram.allowTaskStart</code> 打开。\n` +
              `Task ID: <code>${taskId}</code>`,
        parse_mode: 'HTML'
      });
      return;
    }
    await handleTaskStartCallback(bot, chatId, taskId);
    return;
  }

  // 其他回调查询处理
  await bot.sendMessage({
    chat_id: chatId,
    text: `✅ Callback processed: ${data}`,
    parse_mode: 'HTML'
  });
}

// 处理 /start 命令 - 显示任务列表
async function handleStartCommand(bot: ReturnType<typeof createTelegramBot>, chatId: string, username: string) {
  try {
    const tasks = readTasks();
    
    if (tasks.length === 0) {
      await bot.sendMessage({
        chat_id: chatId,
        text: `Welcome to OpenStrm Bot! 🤖\n\n` +
              `Hello ${username}! You are authorized to use this bot.\n\n` +
              `📋 <b>Current Tasks:</b> No tasks available\n\n` +
              `Use /help to see all available commands.`,
        parse_mode: 'HTML'
      });
      return;
    }

    // 构建任务列表消息
    let message = `Welcome to OpenStrm Bot! 🤖\n\n` +
                  `Hello ${username}! You are authorized to use this bot.\n\n` +
                  `📋 <b>Current Tasks (${tasks.length}):</b>\n\n`;

    // 为每个任务创建按钮
    const buttons = [];
    
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const taskName = `${task.originPath} → ${task.targetPath}`;
      const taskInfo = `${i + 1}. <b>${taskName}</b>\n` +
                      `   Account: ${task.account}\n` +
                      `   Type: ${task.strmType}\n\n`;
      
      message += taskInfo;
      
      // 添加开始按钮
      buttons.push([{
        text: `▶️ Start Task ${i + 1}`,
        callback_data: `start_task_${task.id}`
      }]);
    }

    message += `Use the buttons below to start tasks, or /help for more commands.`;

    await bot.sendMessageWithButtons(chatId, message, buttons);
  } catch (error) {
    log.error({ err: error }, "Error handling start command");
    await bot.sendMessage({
      chat_id: chatId,
      text: `❌ Error loading tasks: ${error}`,
      parse_mode: 'HTML'
    });
  }
}

// 处理任务开始回调
async function handleTaskStartCallback(bot: ReturnType<typeof createTelegramBot>, chatId: string, taskId: string) {
  try {
    const tasks = readTasks();
    const task = tasks.find((t: { id: string }) => t.id === taskId);
    
    if (!task) {
      await bot.sendMessage({
        chat_id: chatId,
        text: `❌ Task not found`,
        parse_mode: 'HTML'
      });
      return;
    }

    // 发送任务开始消息
    await bot.sendMessage({
      chat_id: chatId,
      text: `🚀 <b>Starting Task</b>\n\n` +
            `📁 <b>From:</b> ${task.originPath}\n` +
            `📁 <b>To:</b> ${task.targetPath}\n` +
            `👤 <b>Account:</b> ${task.account}\n` +
            `⚙️ <b>Type:</b> ${task.strmType}\n\n` +
            `⏳ Task is starting...`,
      parse_mode: 'HTML'
    });

    try {
      const result = await taskStarter(taskId);

      if (result.ok) {
        await bot.sendMessage({
          chat_id: chatId,
          text: `✅ <b>Task started successfully!</b>\n\n` +
                `Task ID: <code>${taskId}</code>\n` +
                `📁 From: ${task.originPath}\n` +
                `📁 To: ${task.targetPath}\n\n` +
                `You can check the progress in the web interface.`,
          parse_mode: 'HTML'
        });
      } else {
        await bot.sendMessage({
          chat_id: chatId,
          text: `❌ <b>Failed to start task</b>\n\n` +
                `Error: ${result.body}\n` +
                `Task ID: <code>${taskId}</code>`,
          parse_mode: 'HTML'
        });
      }
    } catch (apiError) {
      log.error({ err: apiError }, "Error calling startTask API");
      await bot.sendMessage({
        chat_id: chatId,
        text: `❌ <b>API Error</b>\n\n` +
              `Failed to call startTask API: ${apiError}\n` +
              `Task ID: <code>${taskId}</code>`,
        parse_mode: 'HTML'
      });
    }

  } catch (error) {
    log.error({ err: error }, "Error starting task");
    await bot.sendMessage({
      chat_id: chatId,
      text: `❌ Error starting task: ${error}`,
      parse_mode: 'HTML'
    });
  }
}

/** 仅供测试：回调分发是纯内部函数，暴露出来才能验证开关行为 */
export const __test_handleCallbackQuery = handleCallbackQuery;
