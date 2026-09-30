/**
 * Telegram 轮询循环。
 *
 * 一个顺序的长轮询：一次 getUpdates 最多挂 30 秒，回来把这批处理完再发下一次。
 * 并发的 getUpdates 会被 Telegram 用 409 互相掐掉，所以绝不能叠着发——循环本身跑在
 * lib/polling.ts 上，一轮没回来不会起下一轮；stop 掐断挂着的长连接，循环随即退出。
 * 起循环前先 deleteWebhook（老版本可能设过）、把命令注册进菜单。
 */
import axios from "axios";
import { readAppSettings } from "../../db/repositories/settings.js";
import { moduleLogger } from "../../lib/logger.js";
import { createPollingLoop, type PollingLoop } from "../../lib/polling.js";
import { createTelegramBot, type TelegramBot, type TelegramUpdate } from "./bot.js";
import { BOT_COMMANDS, handleUpdate } from "./commands.js";

const log = moduleLogger("telegram-polling");

/** 出错后的等待。409 是"另有人在拉同一个 bot"，等久一点；其余交给循环按次数指数退避 */
const backoff = { conflictMs: 10_000, errorBaseMs: 1_000, errorMaxMs: 30_000 };

let loop: PollingLoop | null = null;
let startPromise: Promise<boolean> | null = null;
/** 上一次 stop 的收尾（等在跑的那一轮退出）；起新循环前等它，不然两个循环会叠着发 getUpdates */
let stopping: Promise<void> = Promise.resolve();
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

/** 一轮：一次 getUpdates（最多挂 30 秒），回来把这批处理完。409 自己等一会儿；别的错抛出去由循环退避 */
async function pollOnce(bot: TelegramBot, signal: AbortSignal): Promise<void> {
  let updates: TelegramUpdate[];
  try {
    // 还没处理过任何 update 时不带 offset：Telegram 会从最早没确认的那条给起
    const offset = lastUpdateId > 0 ? lastUpdateId + 1 : 0;
    updates = await bot.getUpdates(offset, 100, 30, signal);
  } catch (err) {
    if (signal.aborted) return;
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    if (status === 409) {
      // 另一个进程在用同一个 token 轮询，或者 webhook 还没摘掉——不是"没有新消息"，也不按次数退避
      log.warn(`getUpdates 409：另有轮询者或 webhook 仍在，${backoff.conflictMs / 1000}s 后重试`);
      await sleep(backoff.conflictMs, signal);
      return;
    }
    throw err;
  }

  for (const update of updates) {
    // 停了就不再处理：没处理的那些下次从 lastUpdateId + 1 再拉，不会丢
    if (signal.aborted) return;
    lastUpdateId = update.update_id;
    try {
      await handleUpdate(bot, update);
    } catch (err) {
      // 单条消息处理失败不能把整个循环带死
      log.error({ err, updateId: update.update_id }, "处理 Telegram update 失败");
    }
  }
}

/** 起轮询。已在跑返回 false；没配 bot token 也返回 false（并记一条 error） */
export function startPolling(): Promise<boolean> {
  if (loop?.running) return Promise.resolve(false);
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
  await stopping;

  const bot = createTelegramBot(telegram.botToken);
  // getUpdates 和 webhook 互斥，先把 webhook 摘掉。摘不掉也照常起：真冲突会以 409 的形式在循环里暴露出来
  await bot.deleteWebhook();
  // 菜单注册失败不影响使用，命令照样能打
  await bot.setMyCommands(BOT_COMMANDS);

  // 长轮询没有轮与轮之间的间隔；失败的退避基数、封顶在这里定（测试会调短）
  loop = createPollingLoop({
    name: "Telegram 轮询",
    log,
    intervalMs: 0,
    backoffBaseMs: backoff.errorBaseMs,
    maxBackoffMs: backoff.errorMaxMs,
    tick: (signal) => pollOnce(bot, signal),
  });
  loop.start();
  log.info("Telegram polling started");
  return true;
}

/** 停轮询：中止挂着的长连接，循环随即退出。本来就没在跑返回 false */
export function stopPolling(): boolean {
  if (!loop?.running) return false;
  stopping = loop.stop();
  log.info("Telegram polling stopped");
  return true;
}

/** 停掉再起：界面上的"重启"用；bot token 改了之后也走这个 */
export async function restartPolling(): Promise<boolean> {
  stopPolling();
  return startPolling();
}

export function getPollingStatus(): { active: boolean; message: string } {
  const active = loop?.running ?? false;
  return { active, message: active ? "轮询运行中" : "轮询未运行" };
}

/** 仅供测试：把退避调短（下次 start 生效）、等循环真正退出 */
export function __test_setBackoff(next: Partial<typeof backoff>): void {
  Object.assign(backoff, next);
}
export const __test_pollingDone = (): Promise<void> => stopping;
