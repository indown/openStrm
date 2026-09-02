/**
 * 115 生活事件轮询监控。
 *
 * 每个被监控的 115 账号各跑一条循环（AccountMonitor）：
 *   开启生活事件开关 → 循环 { 拉一批 → 落库 → 逐条处理 → 存游标 → 等一轮 }
 *
 * 启停是整体的：startLifeMonitor 把配置里的账号一起拉起来，stopLifeMonitor 全部停掉。
 * 一次启动共用一个 AbortController（generation）：stop 一掐，正在过门禁的请求被中止、睡着的醒来、
 * 处理中的事件做完这条就退；下一次 start 换一个新的。
 * 某个账号起不来（cookie 失效）不影响其它账号，它会以 running=false + lastError 出现在状态里。
 * 游标和 proapi/webapi 降级状态按账号各存一份（KEY.lifeCursor(name) / KEY.lifeAppFallback(name)）；
 * 事件表、路径缓存、Emby 刷新防抖全局共用——115 的事件 id 和 file_id 全站唯一，账号之间不会串。
 *
 * 游标语义和 115 接口一致：事件列表是倒序的，所以每轮都从最新一条往回翻，
 * 翻到 (fromTime, fromId) 就停；处理完再把这一轮最新的一条存回去。
 */
import type { AccountInfo, LifeEventMode, LifeMonitorSettings, LifePullMode } from "@openstrm/shared";
import type { AccountInfo as Cloud115Account } from "../cloud-115/client.js";
import { KEY } from "../../db/keys.js";
import { isAbortError } from "../../lib/errors.js";
import { moduleLogger } from "../../lib/logger.js";
import { notify } from "../telegram/notify.js";
import { readAppSettings, updateAppSetting } from "../../db/repositories/settings.js";
import { getAccount, listAccounts } from "../../db/repositories/accounts.js";
import { listTasks } from "../../db/repositories/tasks.js";
import {
  countLifeEvents,
  countPathCache,
  deleteKv,
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
  type PullOptions,
} from "../cloud-115/life.js";
import { flushEmbyRefresh, getEmbyRefreshState, scheduleEmbyRefresh } from "../media-server.js";
import {
  handleCreate,
  handleMove,
  handleNewFolder,
  handleRemove,
  handleRename,
  type HandleResult,
  type LifeContext,
} from "./handlers.js";

const WEB_FALLBACK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_SEC = 15;
const ERROR_BACKOFF_MS = 30_000;
const ALL_EVENT_MODES: LifeEventMode[] = ["create", "move", "rename", "remove"];
const LOG_LIMIT = 500;
const ZERO_CURSOR: LifeCursor = { fromTime: 0, fromId: "0" };
const CANCELLED = "启动已取消";

type LogLevel = "info" | "warn" | "error" | "debug";
type LogFn = (level: LogLevel, msg: string) => void;

export interface MonitorStats {
  rounds: number;
  events: number;
  handled: number;
  skipped: number;
  failed: number;
}
const zeroStats = (): MonitorStats => ({ rounds: 0, events: 0, handled: 0, skipped: 0, failed: 0 });

export interface AccountMonitorStatus {
  name: string;
  running: boolean;
  cursor: LifeCursor;
  api: LifeApp;
  startedAt: number | null;
  lastPollAt: number | null;
  lastError: string | null;
  stats: MonitorStats;
}

export interface MonitorStatus {
  /** 至少有一个账号在跑 */
  running: boolean;
  /**
   * 配置里要监控的每个账号的运行态。起不来的也在里面，running=false 且 lastError 说明原因；
   * 监控运行期间才加进配置的账号也是 running=false，但没有 lastError——要重启监控才会带上它。
   */
  accounts: AccountMonitorStatus[];
  interval: number;
  eventModes: LifeEventMode[];
  startedAt: number | null;
  lastPollAt: number | null;
  /** 各账号合计 */
  stats: MonitorStats;
  db: { lifeEvents: number; pathCache: number };
  embyRefresh: { configured: boolean; pendingCount: number; pendingSince: number | null };
  logs: string[];
}

export interface StartResult {
  /** 至少起来一个账号 */
  ok: boolean;
  message: string;
  started: string[];
  /** 没起来的账号和原因；ok 为 true 时这里非空就是「部分启动」 */
  failed: Array<{ name: string; message: string }>;
}

/* -------------------------------- 依赖注入 -------------------------------- */

interface Deps {
  /** 拉一轮生活事件。真实现打 115 接口，测试换成本地桩 */
  pull: typeof pullLifeEvents;
  /** 开启 115 生活事件开关 */
  enable: typeof enableLifeCalendar;
}
const realDeps: Deps = { pull: pullLifeEvents, enable: enableLifeCalendar };
let deps: Deps = { ...realDeps };
/** 测试用：传 null 恢复真实现 */
export function setLifeMonitorDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/* ---------------------------------- 日志 ---------------------------------- */

const lifeLog = moduleLogger("life");
const logs: string[] = [];

/** 既写进程日志，也留一份在内存里给状态页展示。各账号共用一条时间线，行首带账号名 */
function log(level: LogLevel, msg: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  logs.push(line);
  if (logs.length > LOG_LIMIT) logs.shift();
  lifeLog[level](msg);
}

const accountLogger = (name: string): LogFn => (level, msg) => log(level, `[${name}] ${msg}`);

/* ------------------------------ 接口降级状态 ------------------------------ */

interface AppFallbackState {
  ios405Count?: number;
  webFallbackUntil?: number;
}

function readFallback(name: string): AppFallbackState {
  return readKv<AppFallbackState>(KEY.lifeAppFallback(name)) ?? {};
}

function currentApp(name: string): LifeApp {
  const st = readFallback(name);
  if (st.webFallbackUntil && Date.now() < st.webFallbackUntil) return "web";
  if (st.webFallbackUntil) writeKv(KEY.lifeAppFallback(name), { ...st, webFallbackUntil: undefined });
  return "ios";
}

function recordIos405(name: string, logTo: LogFn): void {
  const st = readFallback(name);
  const count = (st.ios405Count ?? 0) + 1;
  if (count >= 3) {
    writeKv(KEY.lifeAppFallback(name), { ios405Count: 0, webFallbackUntil: Date.now() + WEB_FALLBACK_MS });
    logTo("warn", "proapi 连续 3 次 405 而 webapi 正常，接下来 24h 固定走 webapi");
  } else {
    writeKv(KEY.lifeAppFallback(name), { ...st, ios405Count: count });
  }
}

function resetIos405(name: string): void {
  const st = readFallback(name);
  if (st.ios405Count) writeKv(KEY.lifeAppFallback(name), { ...st, ios405Count: 0 });
}

function clearWebFallback(name: string): void {
  const st = readFallback(name);
  if (st.webFallbackUntil) writeKv(KEY.lifeAppFallback(name), { ...st, webFallbackUntil: undefined });
}

/** proapi ↔ webapi 互为兜底，只有 405 才降级，其它错误照常抛 */
async function pullWithFallback(
  account: Cloud115Account,
  cursor: LifeCursor,
  signal: AbortSignal,
  logTo: LogFn,
  extra: Pick<PullOptions, "maxPages" | "firstBatchSize" | "cooldownMs"> = {},
): Promise<LifeEvent[]> {
  const name = account.name;
  const app = currentApp(name);
  const pull = (via: LifeApp) => deps.pull({ accountInfo: account, cursor, app: via, signal, ...extra });
  try {
    const events = await pull(app);
    if (app === "ios") resetIos405(name);
    return events;
  } catch (err) {
    if (!is405(err)) throw err;
    if (app === "web") {
      logTo("warn", "webapi 返回 405，改用 proapi 重试");
      clearWebFallback(name);
      return pull("ios");
    }
    logTo("warn", "proapi 返回 405，改用 webapi 重试");
    const events = await pull("web");
    recordIos405(name, logTo);
    return events;
  }
}

/* -------------------------------- 账号解析 -------------------------------- */

function as115(a: AccountInfo | null): Cloud115Account | null {
  if (!a || a.accountType !== "115" || !a.cookie) return null;
  return { name: a.name, cookie: a.cookie, accountType: "115" };
}

/** 全部带 cookie 的 115 账号，按账户表顺序 */
function list115Pool(): Cloud115Account[] {
  return listAccounts().map(as115).filter((a): a is Cloud115Account => a !== null);
}

function pick115Account(name: string): Cloud115Account | null {
  return as115(getAccount(name));
}

/**
 * 配置里要监控哪些账号：
 *   accounts 已设置（哪怕是空数组）→ 以它为准，空数组 = 全部；
 *   accounts 未设置但旧字段 account 有值 → 只这一个（2.1 之前的单账号配置）；
 *   都没有 → 全部带 cookie 的 115 账号。
 * 名字原样比对，不 trim：账号名以账户表里存的为准。保序去重；对不上账号表的照样返回，
 * 启动时会以「找不到账号」出现在状态里而不是被静默丢掉。
 */
export function resolveMonitoredAccountNames(
  cfg: LifeMonitorSettings,
  pool: ReadonlyArray<{ name: string }>,
): string[] {
  const chosen = cfg.accounts !== undefined ? cfg.accounts : cfg.account ? [cfg.account] : [];
  const names = [...new Set(chosen.filter((s) => s !== ""))];
  return names.length > 0 ? names : pool.map((a) => a.name);
}

function intervalSeconds(cfg: LifeMonitorSettings): number {
  return Math.max(5, Number(cfg.intervalSeconds) || DEFAULT_INTERVAL_SEC);
}

function readSavedCursor(name: string): LifeCursor | null {
  const saved = readKv<Partial<LifeCursor>>(KEY.lifeCursor(name));
  if (!saved || (!saved.fromId && !saved.fromTime)) return null;
  return { fromTime: Number(saved.fromTime) || 0, fromId: String(saved.fromId ?? "0") };
}

function initialCursor(name: string, mode: LifePullMode): LifeCursor {
  if (mode === "all") return { ...ZERO_CURSOR };
  if (mode === "last") {
    const saved = readSavedCursor(name);
    if (saved) return saved;
  }
  return { fromTime: Math.floor(Date.now() / 1000), fromId: "0" };
}

/**
 * 2.1 之前只监控一个账号：游标和降级状态存在不带账号名的键里，配置里也只有 `account`。
 * 服务启动时调用（界面还没机会改配置），把它们挪到当时监控的那个账号名下：
 *   - KV 旧键 → `life.cursor.<name>` / `life.appFallback.<name>`（已有新键就不覆盖），旧键删掉；
 *   - 配置没有 `accounts` 但以前用过监控（开过、填过 account、或留有旧游标）→ 写 `accounts: [<name>]`，
 *     升级后继续只盯原来那一个账号，不会悄悄把别的账号也拉进来。新装的没这些痕迹，保持「不选就全部」。
 * 之后每次启动都是空转。
 */
export function migrateLegacyLifeMonitorState(): void {
  const cfg = readAppSettings().lifeMonitor;
  const legacyCursor = readKv<unknown>(KEY.legacyLifeCursor);
  const legacyFallback = readKv<unknown>(KEY.legacyLifeAppFallback);
  // 旧版没填账号就是账户表里第一个 115 账号
  const name = cfg?.account || list115Pool()[0]?.name;
  if (!name) return;

  const pairs: Array<[string, unknown, string]> = [
    [KEY.legacyLifeCursor, legacyCursor, KEY.lifeCursor(name)],
    [KEY.legacyLifeAppFallback, legacyFallback, KEY.lifeAppFallback(name)],
  ];
  for (const [oldKey, value, newKey] of pairs) {
    if (value === null) continue;
    if (readKv<unknown>(newKey) === null) writeKv(newKey, value);
    deleteKv(oldKey);
  }

  const usedBefore = !!cfg && (cfg.enabled === true || !!cfg.account || legacyCursor !== null);
  if (usedBefore && cfg.accounts === undefined) {
    updateAppSetting("lifeMonitor", (current) => ({ ...(current ?? {}), accounts: [name] }));
    log("info", `升级：网盘监控沿用原来的单账号配置，只监控 ${name}；要监控更多账号到网盘监控页勾选`);
  }
}

/* -------------------------------- 单账号循环 -------------------------------- */

function dispatch(ctx: LifeContext, ev: LifeEvent): Promise<HandleResult> {
  const type = Number(ev.type);
  if (CREATE_TYPES.has(type)) return handleCreate(ctx, ev);
  if (MOVE_TYPES.has(type)) return handleMove(ctx, ev);
  if (RENAME_TYPES.has(type)) return handleRename(ctx, ev);
  if (REMOVE_TYPES.has(type)) return handleRemove(ctx, ev);
  if (NEW_FOLDER_TYPES.has(type)) return handleNewFolder(ctx, ev);
  return Promise.resolve({ status: "skipped" as const, detail: `未处理的事件类型 ${type}`, changed: false });
}

class AccountMonitor {
  running = false;
  cursor: LifeCursor;
  startedAt: number | null = null;
  lastPollAt: number | null = null;
  lastError: string | null = null;
  readonly stats = zeroStats();
  /** 循环退出时落定；没起来过是 null */
  loopDone: Promise<void> | null = null;
  private readonly log: LogFn;

  constructor(
    readonly name: string,
    /** 整次启动共用的中止信号：门禁、睡眠、事件处理都听它 */
    private readonly signal: AbortSignal,
  ) {
    this.log = accountLogger(name);
    // 还没起来（或起不来）时显示上次停在哪
    this.cursor = readSavedCursor(name) ?? { ...ZERO_CURSOR };
  }

  status(): AccountMonitorStatus {
    return {
      name: this.name,
      running: this.running,
      cursor: { ...this.cursor },
      api: currentApp(this.name),
      startedAt: this.startedAt,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      stats: { ...this.stats },
    };
  }

  /** 这个账号本次不启动（比如 cookie 和别的账号重复），原因留在状态里 */
  skip(message: string): { ok: false; message: string } {
    this.lastError = message;
    this.log("warn", message);
    return { ok: false, message };
  }

  /**
   * 启动前先确认真的能读到事件。
   * 注意 calendar/setoption 对失效 cookie 也会返回成功，光看它会漏掉「请重新登录」，
   * 所以必须再真拉一条，否则只会在后台 30s 一轮地空转重试。
   * 起不来不抛：原因留在 lastError 让状态页能看到，也不拖累别的账号。消息里不带账号名，
   * 状态页是按账号分行的，汇总消息由调用方加前缀。
   */
  async start(cfg: LifeMonitorSettings, intervalMs: number): Promise<{ ok: boolean; message: string }> {
    const fail = (message: string, reason?: string) => {
      this.lastError = message;
      // cookie 失效 / 被封控才值得打扰人；notify 自己会认，认不出的不发，同一原因一小时只发一次
      if (reason) void notify({ type: "account-alert", account: this.name, reason, source: "网盘监控" });
      return { ok: false, message };
    };
    const account = pick115Account(this.name);
    if (!account) return fail("账户页里没有这个 115 账号，或它没有 cookie");
    try {
      const gate = await deps.enable(account, this.signal);
      if (!gate.ok) return fail(`115 生活事件开关未能开启（${gate.message}），请检查 cookie`, gate.message);
      await pullWithFallback(account, ZERO_CURSOR, this.signal, this.log, {
        maxPages: 1,
        firstBatchSize: 1,
        cooldownMs: 0,
      });
    } catch (err) {
      if (this.signal.aborted || isAbortError(err)) return { ok: false, message: CANCELLED };
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`115 生活事件不可用：${msg}，请检查 cookie`, msg);
    }
    if (this.signal.aborted) return { ok: false, message: CANCELLED };

    const pullMode = cfg.pullMode ?? "latest";
    this.cursor = initialCursor(this.name, pullMode);
    writeKv(KEY.lifeCursor(this.name), this.cursor);
    this.running = true;
    this.startedAt = Date.now();
    this.lastPollAt = null;
    this.lastError = null;
    Object.assign(this.stats, zeroStats());
    this.log("info", `启动：模式 ${pullMode}，间隔 ${intervalMs / 1000}s`);
    this.loopDone = this.loop(intervalMs);
    return { ok: true, message: "已启动" };
  }

  private async loop(intervalMs: number): Promise<void> {
    const signal = this.signal;
    while (!signal.aborted) {
      try {
        // 每轮现取账号：cookie 在「账户」页改过就直接用新的；账号删了这条循环自己退出
        const account = pick115Account(this.name);
        if (!account) {
          this.lastError = "账号已删除或没有 cookie，监控已停止";
          this.log("warn", this.lastError);
          break;
        }
        await this.runOnce(account, signal);
        this.lastError = null;
        if (signal.aborted) break;
        await this.sleep(intervalMs);
      } catch (err) {
        if (signal.aborted) break;
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = msg;
        this.log("error", `轮询失败：${msg}`);
        void notify({ type: "account-alert", account: this.name, reason: msg, source: "网盘监控" });
        this.log("info", `${ERROR_BACKOFF_MS / 1000}s 后重试`);
        await this.sleep(ERROR_BACKOFF_MS);
      }
    }
    writeKv(KEY.lifeCursor(this.name), this.cursor);
    this.running = false;
    // 文件已经落盘了，攒着的 Emby 刷新不能丢；但别的账号还在跑就留给它们继续攒，最后一条退出时才发
    if (![...monitors.values()].some((m) => m.running)) flushEmbyRefresh();
    this.log("info", "已退出生活事件监控");
  }

  private async runOnce(account: Cloud115Account, signal: AbortSignal): Promise<void> {
    const events = await pullWithFallback(account, this.cursor, signal, this.log);
    this.lastPollAt = Date.now();
    this.stats.rounds++;
    if (events.length === 0) return;

    this.stats.events += events.length;
    this.log("info", `拉到 ${events.length} 条新事件`);

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
    const ctx: LifeContext = {
      accountInfo: account,
      tasks: listTasks().filter(
        (t) => t.account === account.name && (t.accountType ?? "115") === "115",
      ),
      settings,
      eventModes: new Set<LifeEventMode>(settings.lifeMonitor?.eventModes ?? ALL_EVENT_MODES),
      log: this.log,
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
          this.stats.handled++;
          // 防抖攒着：生活事件一条一条来，逐条触发全库扫描会把 Emby 打瘫
          if (res.changed) scheduleEmbyRefresh();
          this.log("info", `${name} ${res.detail}`);
        } else {
          this.stats.skipped++;
          this.log("debug", `${name} 跳过：${res.detail}`);
        }
      } catch (err) {
        this.stats.failed++;
        const msg = err instanceof Error ? err.message : String(err);
        markLifeEvent(id, "failed", msg);
        this.log("error", `${name} ${ev.file_name} 处理失败：${msg}`);
      }

      // 每条处理完都推进游标，中途崩了也不会重放已完成的事件
      this.cursor = { fromTime: Number(ev.update_time) || this.cursor.fromTime, fromId: id };
      writeKv(KEY.lifeCursor(this.name), this.cursor);
    }
  }

  /** 可中断的等待：stop 掐掉 signal 就立刻醒 */
  private sleep(ms: number): Promise<void> {
    const signal = this.signal;
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}

/* --------------------------------- 生命周期 --------------------------------- */

/** 最近一次启动涉及的账号，起来没起来都在；下次启动整体换掉 */
const monitors = new Map<string, AccountMonitor>();
/** 本次启动的中止信号；stop 掐它 */
let generation: AbortController | null = null;
let startPromise: Promise<StartResult> | null = null;

function runningMonitors(): AccountMonitor[] {
  return [...monitors.values()].filter((m) => m.running);
}

export function isLifeMonitorRunning(): boolean {
  // 正在停的（signal 已掐）不算在跑：这时再来的 start 要等它退完重新起，不能被「已在运行」打发
  if (!generation || generation.signal.aborted) return false;
  return runningMonitors().length > 0;
}

/**
 * 启动监控。并发的两次调用（双击启动、启动时 index.ts 自动拉起撞上界面操作）共用同一次启动：
 * running 要到门禁的几次 await 之后才置位，不共用的话两次都能过检查，同一账号起出两条循环。
 */
export function startLifeMonitor(): Promise<StartResult> {
  if (isLifeMonitorRunning()) {
    return Promise.resolve({
      ok: true,
      message: "生活事件监控已在运行",
      started: runningMonitors().map((m) => m.name),
      failed: [],
    });
  }
  startPromise ??= doStart().finally(() => {
    startPromise = null;
  });
  return startPromise;
}

async function doStart(): Promise<StartResult> {
  const ctl = new AbortController();
  generation = ctl;
  const none = (message: string): StartResult => ({ ok: false, message, started: [], failed: [] });

  // 上一轮的循环可能还在收尾（stop 之后的最后一轮），等它们退出再起新的：
  // 同一账号两条循环并存会互相覆盖游标
  await Promise.allSettled([...monitors.values()].map((m) => m.loopDone));
  if (ctl.signal.aborted) return none(CANCELLED);

  const cfg = readAppSettings().lifeMonitor ?? {};
  const pool = list115Pool();
  if (pool.length === 0) return none("没有配置任何带 cookie 的 115 账号");
  const names = resolveMonitoredAccountNames(cfg, pool);

  // 同一个 cookie 挂在两个账号名下会把同一批事件拉两遍、互相抢去重位：只监控先出现的那个
  const firstByCookie = new Map<string, string>();
  const twinOf = new Map<string, string>();
  for (const name of names) {
    const cookie = pool.find((a) => a.name === name)?.cookie;
    if (!cookie) continue;
    const first = firstByCookie.get(cookie);
    if (first) twinOf.set(name, first);
    else firstByCookie.set(cookie, name);
  }

  monitors.clear();
  const intervalMs = intervalSeconds(cfg) * 1000;
  const results = await Promise.all(
    names.map(async (name) => {
      const m = new AccountMonitor(name, ctl.signal);
      monitors.set(name, m);
      const twin = twinOf.get(name);
      try {
        const r = twin ? m.skip(`cookie 和账号 ${twin} 相同，同一个网盘只监控一次`) : await m.start(cfg, intervalMs);
        return { name, ...r };
      } catch (err) {
        // 门禁之外的同步代码（读账号表、写游标）炸了——磁盘满之类：按该账号启动失败记，别把别的账号一起拖死
        const message = err instanceof Error ? err.message : String(err);
        m.lastError = message;
        return { name, ok: false, message };
      }
    }),
  );
  if (ctl.signal.aborted) return none(CANCELLED);

  const started = results.filter((r) => r.ok).map((r) => r.name);
  const failed = results.filter((r) => !r.ok).map((r) => ({ name: r.name, message: r.message }));
  if (started.length === 0) {
    return { ok: false, message: failed.map((f) => `${f.name}：${f.message}`).join("；"), started, failed };
  }
  let message = `生活事件监控已启动（账号 ${started.join("、")}）`;
  if (failed.length > 0) message += `；${failed.map((f) => `${f.name} 未启动：${f.message}`).join("；")}`;
  return { ok: true, message, started, failed };
}

export async function stopLifeMonitor(): Promise<{ ok: boolean; message: string }> {
  const ctl = generation;
  const active = ctl !== null && !ctl.signal.aborted && (startPromise !== null || runningMonitors().length > 0);
  if (!active) return { ok: true, message: "生活事件监控未在运行" };
  // 一掐全退：过门禁的请求被中止、睡着的醒来、处理中的事件做完这条就停
  ctl.abort();
  if (startPromise) {
    try {
      await startPromise;
    } catch {
      /* doStart 自己处理 */
    }
  }
  await Promise.allSettled([...monitors.values()].map((m) => m.loopDone));
  return { ok: true, message: "生活事件监控已停止" };
}

function idleStatus(name: string): AccountMonitorStatus {
  return {
    name,
    running: false,
    cursor: readSavedCursor(name) ?? { ...ZERO_CURSOR },
    api: currentApp(name),
    startedAt: null,
    lastPollAt: null,
    lastError: null,
    stats: zeroStats(),
  };
}

export function getLifeMonitorStatus(): MonitorStatus {
  const cfg = readAppSettings().lifeMonitor ?? {};
  const names = resolveMonitoredAccountNames(cfg, list115Pool());
  // 已从配置里去掉但还在跑的账号照样显示，直到它停下
  for (const m of monitors.values()) if (m.running && !names.includes(m.name)) names.push(m.name);
  const accounts = names.map((name) => monitors.get(name)?.status() ?? idleStatus(name));

  const running = accounts.filter((a) => a.running);
  const startedAts = running.map((a) => a.startedAt).filter((t): t is number => t !== null);
  const pollAts = accounts.map((a) => a.lastPollAt).filter((t): t is number => t !== null);
  const stats = zeroStats();
  for (const a of accounts) {
    for (const k of Object.keys(stats) as Array<keyof MonitorStats>) stats[k] += a.stats[k];
  }
  return {
    running: running.length > 0,
    accounts,
    interval: intervalSeconds(cfg),
    eventModes: cfg.eventModes ?? ALL_EVENT_MODES,
    startedAt: startedAts.length > 0 ? Math.min(...startedAts) : null,
    lastPollAt: pollAts.length > 0 ? Math.max(...pollAts) : null,
    stats,
    db: { lifeEvents: countLifeEvents(), pathCache: countPathCache() },
    embyRefresh: getEmbyRefreshState(),
    // 界面只显示最近 50 条，这个接口每 5 秒被轮询一次，别每次都搬 500 行
    logs: logs.slice(-100),
  };
}

/* ----------------------------------- 探测 ----------------------------------- */

export interface ProbeAccountResult {
  account: string;
  ok: boolean;
  message: string;
  events?: Array<LifeEvent & { type_name: string }>;
}

export interface ProbeResult {
  /** 每个账号都通了才算通 */
  ok: boolean;
  /** 单账号就是它自己的结果；多账号逐个列出 */
  message: string;
  accounts: ProbeAccountResult[];
}

async function probeAccount(name: string, limit: number): Promise<ProbeAccountResult> {
  const account = pick115Account(name);
  if (!account) return { account: name, ok: false, message: "账户页里没有这个 115 账号，或它没有 cookie" };
  try {
    await deps.enable(account);
    // 只拉一页：cooldown 是翻页之间的，这里用不上
    const events = await pullWithFallback(account, ZERO_CURSOR, new AbortController().signal, accountLogger(name), {
      maxPages: 1,
      firstBatchSize: Math.max(1, Math.min(limit, 100)),
      cooldownMs: 0,
    });
    return {
      account: name,
      ok: true,
      message: `拉到 ${events.length} 条事件`,
      events: events.slice(0, limit).map((e) => ({
        ...e,
        type_name: BEHAVIOR_TYPE_TO_NAME[Number(e.type)] ?? `type_${e.type}`,
      })),
    };
  } catch (err) {
    return { account: name, ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** 只拉不处理，用于在页面上确认「事件开关是否已开、能不能拉到数据」；不指定账号就把配置里的都测一遍 */
export async function probeLifeEvents(limit = 20, only?: string): Promise<ProbeResult> {
  const cfg = readAppSettings().lifeMonitor ?? {};
  const names = only ? [only] : resolveMonitoredAccountNames(cfg, list115Pool());
  if (names.length === 0) return { ok: false, message: "没有可用的 115 账号", accounts: [] };
  const accounts = await Promise.all(names.map((name) => probeAccount(name, limit)));
  const message =
    accounts.length === 1 ? accounts[0]!.message : accounts.map((a) => `${a.account}：${a.message}`).join("；");
  return { ok: accounts.every((a) => a.ok), message, accounts };
}
