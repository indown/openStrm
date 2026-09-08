/**
 * 网盘变更监控：每个被监控的账号各跑一条循环（AccountMonitor）。
 *
 *   门禁（source.prepare）→ 循环 { source.pull 一批 → 落库 → 逐条交给 handlers → 存游标 → 等一轮 }
 *
 * 变更来源按网盘类型来（DriveProvider.changes）：115 是生活事件流（sources/cloud115.ts），
 * 夸克是定时快照对比（sources/quark.ts）。这里不认任何一家的接口，只认 ChangeSource 和 ChangeEvent。
 *
 * 启停是整体的：startLifeMonitor 把配置里的账号一起拉起来，stopLifeMonitor 全部停掉。
 * 一次启动共用一个 AbortController（generation）：stop 一掐，正在过门禁的请求被中止、睡着的醒来、
 * 处理中的事件做完这条就退；下一次 start 换一个新的。
 * 某个账号起不来（cookie 失效）不影响其它账号，它会以 running=false + lastError 出现在状态里。
 * 游标按账号各存一份（KEY.lifeCursor(name)）；事件表和 Emby 刷新防抖全局共用。
 */
import type { AccountInfo, LifeEventMode, LifeMonitorSettings, LifePullMode } from "@openstrm/shared";
import { KEY } from "../../db/keys.js";
import { isAbortError } from "../../lib/errors.js";
import { moduleLogger } from "../../lib/logger.js";
import { issueFromDrive, notify } from "../telegram/notify.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { getAccount, listAccounts } from "../../db/repositories/accounts.js";
import { listTasks } from "../../db/repositories/tasks.js";
import {
  countDriveSnapshots,
  countLifeEvents,
  countPathCache,
  isLifeEventHandled,
  markLifeEvent,
  readKv,
  upsertLifeEvents,
  writeKv,
} from "../../db/repositories/life.js";
import { providerFor } from "../drive/registry.js";
import type { AccountIssue, ChangeCursor, ChangeEvent, ChangeKind, ChangeLog, ChangeSource, DriveProvider, ProbeResult } from "../drive/types.js";
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

const DEFAULT_INTERVAL_SEC = 15;
const ERROR_BACKOFF_MS = 30_000;
const ALL_EVENT_MODES: LifeEventMode[] = ["create", "move", "rename", "remove"];
const LOG_LIMIT = 500;
const ZERO_CURSOR: ChangeCursor = { time: 0, id: "0" };
const CANCELLED = "启动已取消";

/** 事件表里 type 列的通用编码：故意用负数，避开 115 的 behavior type（115 的事件保留它自己的） */
export const KIND_CODE: Record<ChangeKind, number> = { create: -1, move: -2, rename: -3, remove: -4, folder: -5 };
export const KIND_NAME: Record<ChangeKind, string> = { create: "新增", move: "移动", rename: "改名", remove: "删除", folder: "新建目录" };

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
  cursor: ChangeCursor;
  /** 变更来源：proapi / webapi / snapshot */
  source: string;
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
  db: { lifeEvents: number; pathCache: number; snapshots: number };
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

/* ---------------------------------- 日志 ---------------------------------- */

const lifeLog = moduleLogger("life");
const logs: string[] = [];

/** 既写进程日志，也留一份在内存里给状态页展示。各账号共用一条时间线，行首带账号名 */
function log(level: "info" | "warn" | "error" | "debug", msg: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  logs.push(line);
  if (logs.length > LOG_LIMIT) logs.shift();
  lifeLog[level](msg);
}

const accountLogger = (name: string): ChangeLog => (level, msg) => log(level, `[${name}] ${msg}`);

/* -------------------------------- 账号解析 -------------------------------- */

/** 能做变更监控的账号（115 / 夸克），按账户表顺序 */
function monitorablePool(): Array<{ account: AccountInfo; provider: DriveProvider }> {
  return listAccounts()
    .map((account) => ({ account, provider: providerFor(account) }))
    .filter((x) => x.provider.capabilities.changes && x.provider.changes);
}

function pickProvider(name: string): DriveProvider | null {
  const account = getAccount(name);
  if (!account) return null;
  const provider = providerFor(account);
  return provider.capabilities.changes && provider.changes ? provider : null;
}

/**
 * 配置里要监控哪些账号：accounts 非空就是这些，否则全部能监控的账号。
 * 名字原样比对，不 trim：账号名以账户表里存的为准。保序去重；对不上账号表的照样返回，
 * 启动时会以「找不到账号」出现在状态里而不是被静默丢掉。
 */
export function resolveMonitoredAccountNames(
  cfg: LifeMonitorSettings,
  pool: ReadonlyArray<{ name: string }>,
): string[] {
  const names = [...new Set((cfg.accounts ?? []).filter((s) => s !== ""))];
  return names.length > 0 ? names : pool.map((a) => a.name);
}

function intervalSeconds(cfg: LifeMonitorSettings): number {
  return Math.max(5, Number(cfg.intervalSeconds) || DEFAULT_INTERVAL_SEC);
}

/** 老格式是 {fromTime, fromId}，读的时候一并认 */
function readSavedCursor(name: string): ChangeCursor | null {
  const saved = readKv<Partial<ChangeCursor> & { fromTime?: number; fromId?: string }>(KEY.lifeCursor(name));
  if (!saved) return null;
  const time = Number(saved.time ?? saved.fromTime) || 0;
  const id = String(saved.id ?? saved.fromId ?? "0");
  if (!time && (!id || id === "0")) return null;
  return { time, id };
}

/* -------------------------------- 单账号循环 -------------------------------- */

function dispatch(ctx: LifeContext, ev: ChangeEvent): Promise<HandleResult> {
  switch (ev.kind) {
    case "create":
      return handleCreate(ctx, ev);
    case "move":
      return handleMove(ctx, ev);
    case "rename":
      return handleRename(ctx, ev);
    case "remove":
      return handleRemove(ctx, ev);
    case "folder":
      return handleNewFolder(ctx, ev);
  }
}

function toRow(accountName: string, ev: ChangeEvent) {
  const name = ev.path.slice(ev.path.lastIndexOf("/") + 1);
  return {
    id: ev.id,
    accountName,
    type: ev.rawType ?? KIND_CODE[ev.kind],
    kind: ev.kind,
    path: ev.path,
    oldPath: ev.oldPath ?? "",
    fileId: ev.nodeId,
    parentId: "",
    fileName: name,
    fileCategory: ev.isDir ? 0 : 1,
    fileSize: ev.size ?? 0,
    sha1: ev.hash ?? "",
    pickCode: ev.token ?? "",
    updateTime: ev.at,
    createTime: ev.at,
  };
}

class AccountMonitor {
  running = false;
  cursor: ChangeCursor;
  startedAt: number | null = null;
  lastPollAt: number | null = null;
  lastError: string | null = null;
  readonly stats = zeroStats();
  /** 循环退出时落定；没起来过是 null */
  loopDone: Promise<void> | null = null;
  private readonly log: ChangeLog;
  private source: ChangeSource | null = null;

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
      source: this.source?.label ?? pickProvider(this.name)?.changes?.label ?? "-",
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
   * 启动前先过来源的门禁（能不能读到变更）。
   * 起不来不抛：原因留在 lastError 让状态页能看到，也不拖累别的账号。消息里不带账号名，
   * 状态页是按账号分行的，汇总消息由调用方加前缀。
   */
  async start(cfg: LifeMonitorSettings, intervalMs: number): Promise<{ ok: boolean; message: string }> {
    const fail = (message: string, reason?: string, issue?: AccountIssue | null) => {
      this.lastError = message;
      // cookie 失效 / 被封控才值得打扰人；认不出的不发，同一原因一小时只发一次
      if (reason) void notify({ type: "account-alert", account: this.name, reason, source: "网盘监控", issue: issueFromDrive(issue) });
      return { ok: false, message };
    };
    const provider = pickProvider(this.name);
    if (!provider) return fail("账户页里没有这个账号，或它不支持网盘监控（需要 115 / 夸克账号且带 cookie）");
    const source = provider.changes!;
    try {
      const gate = await source.prepare(this.signal, this.log);
      if (!gate.ok) return fail(gate.message, gate.reason, gate.issue);
    } catch (err) {
      if (this.signal.aborted || isAbortError(err)) return { ok: false, message: CANCELLED };
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`变更来源不可用：${msg}`, msg, provider.classifyError(err));
    }
    if (this.signal.aborted) return { ok: false, message: CANCELLED };

    this.source = source;
    const pullMode = cfg.pullMode ?? "latest";
    this.cursor = source.initialCursor(pullMode, readSavedCursor(this.name));
    writeKv(KEY.lifeCursor(this.name), this.cursor);
    this.running = true;
    this.startedAt = Date.now();
    this.lastPollAt = null;
    this.lastError = null;
    Object.assign(this.stats, zeroStats());
    const effective = Math.max(intervalMs, source.minIntervalSeconds * 1000);
    this.log("info", `启动：来源 ${source.label}，模式 ${pullMode}，间隔 ${effective / 1000}s`);
    this.loopDone = this.loop(effective);
    return { ok: true, message: "已启动" };
  }

  private async loop(intervalMs: number): Promise<void> {
    const signal = this.signal;
    while (!signal.aborted) {
      let provider: DriveProvider | null = null;
      try {
        // 每轮现取账号：cookie 在「账户」页改过就直接用新的；账号删了这条循环自己退出
        provider = pickProvider(this.name);
        if (!provider) {
          this.lastError = "账号已删除或不再支持监控，监控已停止";
          this.log("warn", this.lastError);
          break;
        }
        await this.runOnce(provider, signal);
        this.lastError = null;
        if (signal.aborted) break;
        await this.sleep(intervalMs);
      } catch (err) {
        if (signal.aborted) break;
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = msg;
        this.log("error", `轮询失败：${msg}`);
        void notify({ type: "account-alert", account: this.name, reason: msg, source: "网盘监控", issue: issueFromDrive(provider?.classifyError(err)) });
        this.log("info", `${ERROR_BACKOFF_MS / 1000}s 后重试`);
        await this.sleep(ERROR_BACKOFF_MS);
      }
    }
    writeKv(KEY.lifeCursor(this.name), this.cursor);
    this.running = false;
    // 文件已经落盘了，攒着的 Emby 刷新不能丢；但别的账号还在跑就留给它们继续攒，最后一条退出时才发
    if (![...monitors.values()].some((m) => m.running)) flushEmbyRefresh();
    this.log("info", "已退出网盘监控");
  }

  private async runOnce(provider: DriveProvider, signal: AbortSignal): Promise<void> {
    const source = provider.changes!;
    this.source = source;
    const tasks = listTasks().filter((t) => t.account === this.name);
    const pulled = await source.pull(this.cursor, { tasks, signal, log: this.log });
    this.lastPollAt = Date.now();
    this.stats.rounds++;
    const events = pulled.events;
    if (events.length === 0) {
      this.cursor = pulled.cursor;
      writeKv(KEY.lifeCursor(this.name), this.cursor);
      return;
    }

    this.stats.events += events.length;
    this.log("info", `拉到 ${events.length} 条新事件`);
    upsertLifeEvents(events.map((ev) => toRow(this.name, ev)));

    const settings = readAppSettings();
    const ctx: LifeContext = {
      provider,
      tasks,
      settings,
      eventModes: new Set<LifeEventMode>(settings.lifeMonitor?.eventModes ?? ALL_EVENT_MODES),
      log: this.log,
      signal,
    };

    for (const ev of events) {
      if (signal.aborted) return;
      const id = ev.id;
      if (isLifeEventHandled(id)) continue;

      const name = KIND_NAME[ev.kind];
      if (ev.problem) {
        markLifeEvent(id, "skipped", ev.problem);
        this.stats.skipped++;
        this.log("debug", `${name} 跳过：${ev.problem}`);
      } else {
        try {
          const res = await dispatch(ctx, ev);
          markLifeEvent(id, res.status, res.detail);
          if (res.status === "done") {
            this.stats.handled++;
            // 防抖攒着：事件一条一条来，逐条触发全库扫描会把 Emby 打瘫
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
          this.log("error", `${name} ${ev.path} 处理失败：${msg}`);
        }
      }

      // 每条处理完都推进游标，中途崩了也不会重放已完成的事件
      this.cursor = { time: ev.at || this.cursor.time, id };
      writeKv(KEY.lifeCursor(this.name), this.cursor);
    }
    this.cursor = pulled.cursor;
    writeKv(KEY.lifeCursor(this.name), this.cursor);
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
      message: "网盘监控已在运行",
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
  const pool = monitorablePool();
  if (pool.length === 0) return none("没有能监控的账号：需要带 cookie 的 115 或夸克账号");
  const names = resolveMonitoredAccountNames(cfg, pool.map((x) => x.account));

  // 同一个 cookie 挂在两个账号名下会把同一批事件拉两遍、互相抢去重位：只监控先出现的那个
  const firstByCookie = new Map<string, string>();
  const twinOf = new Map<string, string>();
  for (const name of names) {
    const account = pool.find((x) => x.account.name === name)?.account as { cookie?: string } | undefined;
    const cookie = account?.cookie;
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
  let message = `网盘监控已启动（账号 ${started.join("、")}）`;
  if (failed.length > 0) message += `；${failed.map((f) => `${f.name} 未启动：${f.message}`).join("；")}`;
  return { ok: true, message, started, failed };
}

export async function stopLifeMonitor(): Promise<{ ok: boolean; message: string }> {
  const ctl = generation;
  const active = ctl !== null && !ctl.signal.aborted && (startPromise !== null || runningMonitors().length > 0);
  if (!active) return { ok: true, message: "网盘监控未在运行" };
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
  return { ok: true, message: "网盘监控已停止" };
}

function idleStatus(name: string): AccountMonitorStatus {
  return {
    name,
    running: false,
    cursor: readSavedCursor(name) ?? { ...ZERO_CURSOR },
    source: pickProvider(name)?.changes?.label ?? "-",
    startedAt: null,
    lastPollAt: null,
    lastError: null,
    stats: zeroStats(),
  };
}

export function getLifeMonitorStatus(): MonitorStatus {
  const cfg = readAppSettings().lifeMonitor ?? {};
  const names = resolveMonitoredAccountNames(cfg, monitorablePool().map((x) => x.account));
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
    db: { lifeEvents: countLifeEvents(), pathCache: countPathCache(), snapshots: countDriveSnapshots() },
    embyRefresh: getEmbyRefreshState(),
    // 界面只显示最近 50 条，这个接口每 5 秒被轮询一次，别每次都搬 500 行
    logs: logs.slice(-100),
  };
}

/* ----------------------------------- 探测 ----------------------------------- */

export interface ProbeAccountResult extends ProbeResult {
  account: string;
}

export interface ProbeSummary {
  /** 每个账号都通了才算通 */
  ok: boolean;
  /** 单账号就是它自己的结果；多账号逐个列出 */
  message: string;
  accounts: ProbeAccountResult[];
}

async function probeAccount(name: string, limit: number): Promise<ProbeAccountResult> {
  const provider = pickProvider(name);
  if (!provider) return { account: name, ok: false, message: "账户页里没有这个账号，或它不支持网盘监控" };
  const source = provider.changes!;
  if (!source.probe) return { account: name, ok: true, message: "这个来源没有探测接口" };
  return { account: name, ...(await source.probe(limit)) };
}

/** 只看不处理，用于在页面上确认「能不能读到变更」；不指定账号就把配置里的都测一遍 */
export async function probeLifeEvents(limit = 20, only?: string): Promise<ProbeSummary> {
  const cfg = readAppSettings().lifeMonitor ?? {};
  const names = only ? [only] : resolveMonitoredAccountNames(cfg, monitorablePool().map((x) => x.account));
  if (names.length === 0) return { ok: false, message: "没有可监控的账号", accounts: [] };
  const accounts = await Promise.all(names.map((name) => probeAccount(name, limit)));
  const message =
    accounts.length === 1 ? accounts[0]!.message : accounts.map((a) => `${a.account}：${a.message}`).join("；");
  return { ok: accounts.every((a) => a.ok), message, accounts };
}

export type { LifePullMode };
