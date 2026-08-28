/**
 * 115 生活事件轮询监控。
 *
 * 单例，一个进程只跑一条循环：
 *   开启生活事件开关 → 循环 { 拉一批 → 落库 → 逐条处理 → 存游标 → 等一轮 }
 *
 * 游标语义和 115 接口一致：事件列表是倒序的，所以每轮都从最新一条往回翻，
 * 翻到 (fromTime, fromId) 就停；处理完再把这一轮最新的一条存回去。
 */
import type { AccountInfo, LifeEventMode, LifePullMode } from "@openstrm/shared";
import type { AccountInfo as Cloud115Account } from "../cloud-115/client.js";
import { KEY } from "../../db/keys.js";
import { moduleLogger } from "../../lib/logger.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { listAccounts } from "../../db/repositories/accounts.js";
import { listTasks } from "../../db/repositories/tasks.js";
import {
  countLifeEvents,
  countPathCache,
  isLifeEventHandled,
  markLifeEvent,
  readKv,
  upsertLifeEvents,
  writeKv,
} from "../../db/repositories/life.js";
import {
  CREATE_TYPES,
  MOVE_TYPES,
  NEW_FOLDER_TYPES,
  REMOVE_TYPES,
  RENAME_TYPES,
  BEHAVIOR_TYPE_TO_NAME,
  enableLifeCalendar,
  is405,
  pullLifeEvents,
  type LifeApp,
  type LifeCursor,
  type LifeEvent,
} from "../cloud-115/life.js";
import {
  cancelEmbyRefresh,
  flushEmbyRefresh,
  getEmbyRefreshState,
  scheduleEmbyRefresh,
} from "../media-server.js";
import {
  handleCreate,
  handleMove,
  handleNewFolder,
  handleRemove,
  handleRename,
  type HandleResult,
  type LifeContext,
} from "./handlers.js";

const CURSOR_KEY = KEY.lifeCursor;
const FALLBACK_KEY = KEY.lifeAppFallback;
const WEB_FALLBACK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_SEC = 15;
const ERROR_BACKOFF_MS = 30_000;
const ALL_EVENT_MODES: LifeEventMode[] = ["create", "move", "rename", "remove"];
const LOG_LIMIT = 500;


interface AppFallbackState {
  ios405Count?: number;
  webFallbackUntil?: number;
}

export interface MonitorStatus {
  running: boolean;
  account: string | null;
  cursor: LifeCursor;
  interval: number;
  eventModes: LifeEventMode[];
  api: LifeApp;
  startedAt: number | null;
  lastPollAt: number | null;
  lastError: string | null;
  stats: { rounds: number; events: number; handled: number; skipped: number; failed: number };
  db: { lifeEvents: number; pathCache: number };
  embyRefresh: { configured: boolean; pendingCount: number; pendingSince: number | null };
  logs: string[];
}

/* --------------------------------- 状态 --------------------------------- */

let running = false;
let abort: AbortController | null = null;
let wake: (() => void) | null = null;
let loopDone: Promise<void> | null = null;

let accountName: string | null = null;
let cursor: LifeCursor = { fromTime: 0, fromId: "0" };
let startedAt: number | null = null;
let lastPollAt: number | null = null;
let lastError: string | null = null;
const stats = { rounds: 0, events: 0, handled: 0, skipped: 0, failed: 0 };
const logs: string[] = [];

const lifeLog = moduleLogger("life");

/** 既写进程日志，也留一份在内存里给状态页展示 */
function log(level: "info" | "warn" | "error" | "debug", msg: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  logs.push(line);
  if (logs.length > LOG_LIMIT) logs.shift();
  lifeLog[level](msg);
}

/* ------------------------------ 可中断的等待 ------------------------------ */

function sleepInterruptible(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      wake = null;
      abort?.signal.removeEventListener("abort", finish);
      resolve();
    }
    wake = finish;
    abort?.signal.addEventListener("abort", finish, { once: true });
  });
}

/* ------------------------------ 接口降级状态 ------------------------------ */

function currentApp(): LifeApp {
  const st = readKv<AppFallbackState>(FALLBACK_KEY) ?? {};
  if (st.webFallbackUntil && Date.now() < st.webFallbackUntil) return "web";
  if (st.webFallbackUntil) writeKv(FALLBACK_KEY, { ...st, webFallbackUntil: undefined });
  return "ios";
}

function recordIos405(): void {
  const st = readKv<AppFallbackState>(FALLBACK_KEY) ?? {};
  const count = (st.ios405Count ?? 0) + 1;
  if (count >= 3) {
    writeKv(FALLBACK_KEY, { ios405Count: 0, webFallbackUntil: Date.now() + WEB_FALLBACK_MS });
    log("warn", "proapi 连续 3 次 405 而 webapi 正常，接下来 24h 固定走 webapi");
  } else {
    writeKv(FALLBACK_KEY, { ...st, ios405Count: count });
  }
}

function resetIos405(): void {
  const st = readKv<AppFallbackState>(FALLBACK_KEY) ?? {};
  if (st.ios405Count) writeKv(FALLBACK_KEY, { ...st, ios405Count: 0 });
}

function clearWebFallback(): void {
  const st = readKv<AppFallbackState>(FALLBACK_KEY) ?? {};
  if (st.webFallbackUntil) writeKv(FALLBACK_KEY, { ...st, webFallbackUntil: undefined });
}

/** proapi ↔ webapi 互为兜底，只有 405 才降级，其它错误照常抛 */
async function pullWithFallback(
  account: Cloud115Account,
  cur: LifeCursor,
  signal: AbortSignal,
): Promise<LifeEvent[]> {
  const app = currentApp();
  try {
    const events = await pullLifeEvents({ accountInfo: account, cursor: cur, app, signal });
    if (app === "ios") resetIos405();
    return events;
  } catch (err) {
    if (!is405(err)) throw err;
    if (app === "web") {
      log("warn", "webapi 返回 405，改用 proapi 重试");
      clearWebFallback();
      return pullLifeEvents({ accountInfo: account, cursor: cur, app: "ios", signal });
    }
    log("warn", "proapi 返回 405，改用 webapi 重试");
    const events = await pullLifeEvents({ accountInfo: account, cursor: cur, app: "web", signal });
    recordIos405();
    return events;
  }
}

/* -------------------------------- 账号解析 -------------------------------- */

function pick115Account(name?: string): Cloud115Account | null {
  const accounts = listAccounts() as Array<AccountInfo & { cookie?: string }>;
  const pool = accounts.filter((a) => a.accountType === "115" && a.cookie);
  const found = name ? pool.find((a) => a.name === name) : pool[0];
  if (!found?.cookie) return null;
  return { name: found.name, cookie: found.cookie, accountType: "115" };
}

/* -------------------------------- 单轮处理 -------------------------------- */

function dispatch(ctx: LifeContext, ev: LifeEvent): Promise<HandleResult> {
  const type = Number(ev.type);
  if (CREATE_TYPES.has(type)) return handleCreate(ctx, ev);
  if (MOVE_TYPES.has(type)) return handleMove(ctx, ev);
  if (RENAME_TYPES.has(type)) return handleRename(ctx, ev);
  if (REMOVE_TYPES.has(type)) return handleRemove(ctx, ev);
  if (NEW_FOLDER_TYPES.has(type)) return handleNewFolder(ctx, ev);
  return Promise.resolve({ status: "skipped" as const, detail: `未处理的事件类型 ${type}`, changed: false });
}

async function runOnce(account: Cloud115Account, signal: AbortSignal): Promise<void> {
  const events = await pullWithFallback(account, cursor, signal);
  lastPollAt = Date.now();
  stats.rounds++;
  if (events.length === 0) return;

  stats.events += events.length;
  log("info", `拉到 ${events.length} 条新事件`);

  upsertLifeEvents(
    events.map((ev) => ({
      id: String(ev.id),
      accountName: account.name,
      type: Number(ev.type),
      fileId: String(ev.file_id),
      parentId: String(ev.parent_id),
      fileName: ev.file_name ?? "",
      fileCategory: Number(ev.file_category ?? 0),
      fileSize: Number(ev.file_size ?? 0),
      sha1: ev.sha1 ?? "",
      pickCode: ev.pick_code ?? "",
      updateTime: Number(ev.update_time ?? 0),
      createTime: Number(ev.create_time ?? 0),
    })),
  );

  const settings = readAppSettings();
  const modes = new Set<LifeEventMode>(
    (settings.lifeMonitor?.eventModes as LifeEventMode[] | undefined) ?? ALL_EVENT_MODES,
  );
  const ctx: LifeContext = {
    accountInfo: account,
    tasks: listTasks().filter(
      (t) => t.account === account.name && (t.accountType ?? "115") === "115",
    ),
    settings,
    eventModes: modes,
    log,
    signal,
  };

  // 事件是倒序拉回来的，按时间正序处理才能保证「先建后删」这类因果关系
  for (const ev of [...events].reverse()) {
    if (signal.aborted) return;
    const id = String(ev.id);
    if (isLifeEventHandled(id)) continue;

    const name = BEHAVIOR_TYPE_TO_NAME[Number(ev.type)] ?? `type_${ev.type}`;
    try {
      const res = await dispatch(ctx, ev);
      markLifeEvent(id, res.status, res.detail);
      if (res.status === "done") {
        stats.handled++;
        // 防抖攒着：生活事件一条一条来，逐条触发全库扫描会把 Emby 打瘫
        if (res.changed) scheduleEmbyRefresh();
        log("info", `${name} ${res.detail}`);
      } else {
        stats.skipped++;
        log("debug", `${name} 跳过：${res.detail}`);
      }
    } catch (err) {
      stats.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      markLifeEvent(id, "failed", msg);
      log("error", `${name} ${ev.file_name} 处理失败：${msg}`);
    }

    // 每条处理完都推进游标，中途崩了也不会重放已完成的事件
    cursor = { fromTime: Number(ev.update_time) || cursor.fromTime, fromId: id };
    writeKv(CURSOR_KEY, cursor);
  }
}

/* -------------------------------- 生命周期 -------------------------------- */

function initialCursor(mode: LifePullMode): LifeCursor {
  if (mode === "all") return { fromTime: 0, fromId: "0" };
  if (mode === "last") {
    const saved = readKv<LifeCursor>(CURSOR_KEY);
    if (saved && (saved.fromId || saved.fromTime)) {
      return { fromTime: Number(saved.fromTime) || 0, fromId: String(saved.fromId ?? "0") };
    }
  }
  return { fromTime: Math.floor(Date.now() / 1000), fromId: "0" };
}

let startPromise: Promise<{ ok: boolean; message: string }> | null = null;

/**
 * 启动监控。并发的两次调用（双击启动、启动时 index.ts 自动拉起撞上界面操作）共用同一次启动：
 * 以前 running 要到几次 await 之后才置位，两次都能过检查，起出两个循环，先起的那个再也停不掉。
 */
export function startLifeMonitor(): Promise<{ ok: boolean; message: string }> {
  if (running) return Promise.resolve({ ok: true, message: "生活事件监控已在运行" });
  startPromise ??= doStart().finally(() => {
    startPromise = null;
  });
  return startPromise;
}

async function doStart(): Promise<{ ok: boolean; message: string }> {
  // 上一轮循环可能还在收尾（stop 之后的最后一轮），等它退出再起新的
  if (loopDone) {
    try {
      await loopDone;
    } catch {
      /* 循环内部已经处理过异常 */
    }
  }
  if (running) return { ok: true, message: "生活事件监控已在运行" };

  const settings = readAppSettings();
  const cfg = settings.lifeMonitor ?? {};
  const account = pick115Account(cfg.account);
  if (!account) {
    return { ok: false, message: cfg.account ? `找不到可用的 115 账号：${cfg.account}` : "没有配置任何带 cookie 的 115 账号" };
  }

  // 启动前先确认真的能读到事件。
  // 注意 calendar/setoption 对失效 cookie 也会返回成功，光看它会漏掉「请重新登录」，
  // 所以必须再真拉一条，否则只会在后台 30s 一轮地空转重试。
  try {
    const gate = await enableLifeCalendar(account);
    if (!gate.ok) {
      return { ok: false, message: `115 生活事件开关未能开启（${gate.message}），请检查账号 ${account.name} 的 cookie` };
    }
    await pullLifeEvents({
      accountInfo: account,
      cursor: { fromTime: 0, fromId: "0" },
      app: currentApp(),
      maxPages: 1,
      firstBatchSize: 1,
      cooldownMs: 0,
      signal: new AbortController().signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `115 生活事件不可用：${msg}（请检查账号 ${account.name} 的 cookie）` };
  }

  accountName = account.name;
  cursor = initialCursor((cfg.pullMode as LifePullMode) ?? "latest");
  writeKv(CURSOR_KEY, cursor);
  cancelEmbyRefresh();
  abort = new AbortController();
  running = true;
  startedAt = Date.now();
  lastError = null;
  Object.assign(stats, { rounds: 0, events: 0, handled: 0, skipped: 0, failed: 0 });

  const intervalMs = Math.max(5, Number(cfg.intervalSeconds) || DEFAULT_INTERVAL_SEC) * 1000;
  log("info", `启动：账号 ${account.name}，模式 ${cfg.pullMode ?? "latest"}，间隔 ${intervalMs / 1000}s`);

  const signal = abort.signal;
  loopDone = (async () => {
    while (!signal.aborted) {
      try {
        await runOnce(account, signal);
        lastError = null;
        if (signal.aborted) break;
        await sleepInterruptible(intervalMs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = msg;
        log("error", `轮询失败：${msg}`);
        if (signal.aborted) break;
        log("info", `${ERROR_BACKOFF_MS / 1000}s 后重试`);
        await sleepInterruptible(ERROR_BACKOFF_MS);
      }
    }
    writeKv(CURSOR_KEY, cursor);
    // 文件已经落盘了，没理由把攒着的刷新丢掉
    flushEmbyRefresh();
    running = false;
    log("info", "已退出生活事件监控");
  })();

  return { ok: true, message: `生活事件监控已启动（账号 ${account.name}）` };
}

export async function stopLifeMonitor(): Promise<{ ok: boolean; message: string }> {
  if (!running) return { ok: true, message: "生活事件监控未在运行" };
  abort?.abort();
  wake?.();
  try {
    await loopDone;
  } catch {
    /* 循环内部已经处理过异常 */
  }
  abort = null;
  loopDone = null;
  return { ok: true, message: "生活事件监控已停止" };
}

export function getLifeMonitorStatus(): MonitorStatus {
  const settings = readAppSettings();
  const cfg = settings.lifeMonitor ?? {};
  return {
    running,
    account: accountName,
    cursor,
    interval: Math.max(5, Number(cfg.intervalSeconds) || DEFAULT_INTERVAL_SEC),
    eventModes: (cfg.eventModes as LifeEventMode[] | undefined) ?? ALL_EVENT_MODES,
    api: currentApp(),
    startedAt,
    lastPollAt,
    lastError,
    stats: { ...stats },
    db: { lifeEvents: countLifeEvents(), pathCache: countPathCache() },
    embyRefresh: getEmbyRefreshState(),
    logs: [...logs],
  };
}

/** 只拉不处理，用于在页面上确认「事件开关是否已开、能不能拉到数据」 */
export async function probeLifeEvents(
  limit = 20,
): Promise<{ ok: boolean; message: string; events?: Array<LifeEvent & { type_name: string }> }> {
  const cfg = readAppSettings().lifeMonitor ?? {};
  const account = pick115Account(cfg.account);
  if (!account) return { ok: false, message: "没有可用的 115 账号" };
  try {
    await enableLifeCalendar(account);
    const controller = new AbortController();
    const events = await pullLifeEvents({
      accountInfo: account,
      cursor: { fromTime: 0, fromId: "0" },
      app: currentApp(),
      maxPages: 1,
      firstBatchSize: Math.max(1, Math.min(limit, 100)),
      signal: controller.signal,
    });
    return {
      ok: true,
      message: `拉到 ${events.length} 条事件`,
      events: events.slice(0, limit).map((e) => ({
        ...e,
        type_name: BEHAVIOR_TYPE_TO_NAME[Number(e.type)] ?? `type_${e.type}`,
      })),
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export function isLifeMonitorRunning(): boolean {
  return running;
}
