/**
 * 云下载的编排层，路由只调这里。
 *
 *   - 加任务：目标要么是任意 115 目录 id，要么是「同步任务的 originPath（+ 子目录）」——
 *     后者按路径解析成目录 id，并按需登记一条回执：115 下完之后为产物生成 strm。
 *   - 回执落在 settings 表的 `offline.followups` 键里，进程重启不丢。
 *   - 一个后台循环盯着有回执的账号：每 30 秒翻一遍 115 的任务列表，
 *     完成 → 生成 strm（目录用 115 给的产物 id 直接导出目录树，不按名字猜）；
 *     失败 → 记下 115 的说法；列表里连续几轮找不到 → 当作被人删了。
 *     没有待办时循环自己停掉，不白打接口。
 */
import type { Account115, AppSettings, TaskDefinition } from "@openstrm/shared";
import { getAccount, listAccounts } from "../../db/repositories/accounts.js";
import { getTask } from "../../db/repositories/tasks.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { readKv, writeKv } from "../../db/repositories/life.js";
import { KEY } from "../../db/keys.js";
import { HttpError } from "../../lib/http-error.js";
import { moduleLogger } from "../../lib/logger.js";
import { Cloud115Error, fsDirGetId, type AccountInfo } from "../cloud-115/client.js";
import {
  MAX_URLS_PER_ADD,
  normalizeOfflineUrls,
  offlineAddUrls,
  offlineClear,
  offlineDownPaths,
  offlineList,
  offlineRemove,
  offlineRestart,
  type OfflineAddResult,
  type OfflineClearFlag,
  type OfflineDownPath,
  type OfflineListPage,
  type OfflineTask,
} from "../cloud-115/offline.js";
import { resolveTaskAccount115 } from "../library/save-to-task.js";
import { scheduleEmbyRefresh } from "../media-server.js";
import { normalizeSubPath } from "../strm/naming.js";
import { generateStrmForSelected, type GenerateResult, type SelectedItem } from "../strm/share-strm.js";
import { sendTelegramNotification } from "../telegram.js";

const log = moduleLogger("offline");

/* ------------------------------- 回执 ------------------------------- */

export type OfflineFollowupStatus = "pending" | "done" | "failed";

export interface OfflineFollowup {
  infoHash: string;
  account: string;
  taskId: string;
  /** 相对 task.originPath 的子目录，已 normalize；空串表示就在 originPath 下 */
  subPath: string;
  /** 只用于展示：加任务时 115 回的名字，之后用列表里的名字刷新 */
  name: string;
  /** ms */
  addedAt: number;
  status: OfflineFollowupStatus;
  detail: string;
  doneAt?: number;
  /** 生成 strm 的尝试次数 */
  attempts: number;
  /** 115 列表里连续没找到的轮数 */
  misses: number;
}

const FOLLOWUP_KEY = KEY.offlineFollowups;
/** 已完成/失败的回执留 7 天给界面看，之后清掉 */
const KEEP_FINISHED_MS = 7 * 24 * 3600_000;
const MAX_RECORDS = 300;
/** 等了这么久还没下完就不再跟踪：115 自己也会把长期不动的任务判失败 */
const PENDING_MAX_AGE_MS = 7 * 24 * 3600_000;
const POLL_MS = 30_000;
/** 回执只会在最近加的任务里，翻到第 5 页还没有就下轮再说 */
const MAX_PAGES = 5;
const MAX_ATTEMPTS = 3;
const MAX_MISSES = 3;

export function listFollowups(): OfflineFollowup[] {
  const rows = readKv<OfflineFollowup[]>(FOLLOWUP_KEY);
  return Array.isArray(rows) ? rows : [];
}

function saveFollowups(rows: OfflineFollowup[]): void {
  const now = Date.now();
  const kept = rows
    .filter((f) => f.status === "pending" || now - (f.doneAt ?? f.addedAt) < KEEP_FINISHED_MS)
    .sort((a, b) => b.addedAt - a.addedAt)
    .slice(0, MAX_RECORDS);
  writeKv(FOLLOWUP_KEY, kept);
}

function addFollowups(items: OfflineFollowup[]): void {
  const rows = listFollowups().filter((f) => !items.some((i) => i.infoHash === f.infoHash && i.account === f.account));
  saveFollowups([...items, ...rows]);
}

function dropFollowups(account: string, infoHashes: string[]): void {
  const drop = new Set(infoHashes);
  const rows = listFollowups();
  const kept = rows.filter((f) => !(f.account === account && drop.has(f.infoHash)));
  if (kept.length !== rows.length) saveFollowups(kept);
}

const hasPending = (): boolean => listFollowups().some((f) => f.status === "pending");

/* ------------------------------- 依赖注入 ------------------------------- */

export interface GenerateParams {
  task: TaskDefinition;
  accountInfo: AccountInfo;
  settings: AppSettings;
  subPath: string;
  item: SelectedItem;
}

interface Deps {
  list: (accountInfo: AccountInfo, page: number) => Promise<OfflineListPage>;
  /** 把 115 路径解析成目录 id；找不到抛 HttpError */
  resolveDirId: (accountInfo: AccountInfo, path: string) => Promise<string>;
  generate: (p: GenerateParams) => Promise<GenerateResult>;
  notify: (message: string) => Promise<void>;
}

async function resolveDirIdReal(accountInfo: AccountInfo, dirPath: string): Promise<string> {
  let res: { id?: number | string } | undefined;
  try {
    res = await fsDirGetId(dirPath, { accountInfo });
  } catch (err) {
    throw upstream(err, `解析目录失败：${dirPath}`);
  }
  // getid 对不存在的路径回 id=0；0 是根目录，不能把东西下到那里去
  if (res?.id == null || String(res.id) === "" || String(res.id) === "0") {
    throw new HttpError(400, `无法在 115 上找到目录：${dirPath}`);
  }
  return String(res.id);
}

const realDeps: Deps = {
  list: (accountInfo, page) => offlineList(accountInfo, page),
  resolveDirId: resolveDirIdReal,
  generate: ({ task, accountInfo, settings, subPath, item }) =>
    generateStrmForSelected({ task, selectedItems: [item], accountInfo, settings, subPath }),
  notify: (message) => sendTelegramNotification(message, "complete"),
};

let deps: Deps = { ...realDeps };

/** 仅供测试：换掉会碰网络 / 磁盘的几步；传 null 恢复 */
export function setOfflineServiceDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/* ------------------------------- 账号与错误 ------------------------------- */

/** 指定了名字就要那一个；没指定取第一个 115 账号 */
export function resolveAccount115(name?: string): Account115 {
  const accounts = listAccounts();
  const acc = name ? accounts.find((a) => a.name === name) : accounts.find((a) => a.accountType === "115");
  if (!acc) throw new HttpError(name ? 404 : 400, name ? `115 account not found: ${name}` : "No 115 account configured");
  if (acc.accountType !== "115") throw new HttpError(400, `${acc.name} 不是 115 账号`);
  if (!acc.cookie) throw new HttpError(400, "115 account cookie is required");
  return acc;
}

/** 115 的失败要原样说出来：cookie 失效、风控 405 和"列表本来就是空的"在界面上不能长一样 */
function upstream(err: unknown, fallback: string): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof Cloud115Error) return new HttpError(502, err.message, { upstreamStatus: err.status });
  return new HttpError(502, err instanceof Error && err.message ? err.message : fallback);
}

/* ------------------------------- 路由用的动作 ------------------------------- */

export interface AddOfflineOptions {
  account?: string;
  urls: string | string[];
  /** 直接指定 115 目录；不传也不给 taskId 时用 115 自己的默认目录 */
  dirId?: string | number;
  /** 指定同步任务（+ 子目录），目录按 task.originPath 解析；账号跟任务走 */
  taskId?: string;
  subPath?: string;
  /** 任务目录模式下，下载完成后是否自动生成 strm，默认开 */
  generateStrm?: boolean;
}

export interface AddOfflineResponse {
  account: string;
  dirId: string | null;
  /** 任务目录模式下解析用的路径，给界面回显 */
  dirPath: string | null;
  added: number;
  failed: number;
  /** 115 不认的链接（thunder:// 之类），没有提交 */
  invalid: string[];
  results: OfflineAddResult[];
  /** 是否登记了"完成后生成 strm"的回执 */
  followup: boolean;
}

export async function addOfflineTasks(opts: AddOfflineOptions): Promise<AddOfflineResponse> {
  const { urls, invalid } = normalizeOfflineUrls(opts.urls);
  if (urls.length === 0) {
    throw new HttpError(
      400,
      invalid.length ? `没有可提交的链接：115 只收磁力、ed2k、http(s)、ftp，「${invalid[0]}」不在其中` : "urls is required",
      { invalid },
    );
  }
  if (urls.length > MAX_URLS_PER_ADD) throw new HttpError(400, `一次最多提交 ${MAX_URLS_PER_ADD} 条链接`);

  let account: Account115;
  let task: TaskDefinition | null = null;
  let dirId: string | null = null;
  let dirPath: string | null = null;
  const subPath = normalizeSubPath(opts.subPath);

  if (opts.taskId) {
    task = getTask(opts.taskId);
    if (!task) throw new HttpError(404, `Task not found: ${opts.taskId}`);
    account = resolveTaskAccount115(listAccounts(), task);
    dirPath = subPath ? `${task.originPath}/${subPath}` : task.originPath;
    dirId = await deps.resolveDirId(account, dirPath);
  } else {
    account = resolveAccount115(opts.account);
    // "0" 是根目录，合法；空串才是"没选，用 115 的默认目录"
    if (opts.dirId != null && String(opts.dirId).trim() !== "") dirId = String(opts.dirId).trim();
  }

  let results: OfflineAddResult[];
  try {
    results = await offlineAddUrls(account, urls, { dirId: dirId ?? undefined });
  } catch (err) {
    throw upstream(err, "添加云下载任务失败");
  }

  const ok = results.filter((r) => r.ok && r.infoHash);
  const followup = Boolean(task) && opts.generateStrm !== false && ok.length > 0;
  if (followup && task) {
    const now = Date.now();
    addFollowups(
      ok.map((r) => ({
        infoHash: r.infoHash!,
        account: account.name,
        taskId: task.id,
        subPath,
        name: r.name || r.url,
        addedAt: now,
        status: "pending" as const,
        detail: "等待 115 下载完成",
        attempts: 0,
        misses: 0,
      })),
    );
    startOfflineWatcher();
  }
  log.info(`账号 ${account.name} 添加云下载 ${ok.length}/${urls.length} 条${dirPath ? `，目录 ${dirPath}` : ""}`);
  return {
    account: account.name,
    dirId,
    dirPath,
    added: ok.length,
    failed: results.length - ok.length,
    invalid,
    results,
    followup,
  };
}

export interface OfflineWatcherStatus {
  running: boolean;
  pending: number;
  lastTickAt: number | null;
  lastError: string | null;
}

export type ListOfflineResponse = OfflineListPage & {
  account: string;
  /** 这个账号的回执（含最近完成/失败的） */
  followups: OfflineFollowup[];
  watcher: OfflineWatcherStatus;
};

export async function listOfflineTasks(accountName: string | undefined, page = 1): Promise<ListOfflineResponse> {
  const account = resolveAccount115(accountName);
  let res: OfflineListPage;
  try {
    res = await deps.list(account, page);
  } catch (err) {
    throw upstream(err, "读取云下载列表失败");
  }
  return {
    account: account.name,
    ...res,
    followups: listFollowups().filter((f) => f.account === account.name),
    watcher: getOfflineWatcherStatus(),
  };
}

export async function removeOfflineTasks(
  accountName: string | undefined,
  infoHashes: string[],
  deleteFiles: boolean,
): Promise<{ removed: number }> {
  const account = resolveAccount115(accountName);
  try {
    await offlineRemove(account, infoHashes, deleteFiles);
  } catch (err) {
    throw upstream(err, "删除云下载任务失败");
  }
  dropFollowups(account.name, infoHashes);
  return { removed: infoHashes.length };
}

export async function clearOfflineTasks(accountName: string | undefined, flag: OfflineClearFlag): Promise<void> {
  const account = resolveAccount115(accountName);
  try {
    await offlineClear(account, flag);
  } catch (err) {
    throw upstream(err, "清空云下载列表失败");
  }
  // 清的是哪些任务 115 不会说；已经兑现的回执留着给界面看，没兑现的由循环按"列表里找不到"收掉
}

export async function restartOfflineTask(accountName: string | undefined, infoHash: string): Promise<void> {
  const account = resolveAccount115(accountName);
  try {
    await offlineRestart(account, infoHash);
  } catch (err) {
    throw upstream(err, "重试云下载任务失败");
  }
  // 之前因为 115 下载失败而作废的回执，重试后重新盯
  const rows = listFollowups();
  const hit = rows.find((f) => f.account === account.name && f.infoHash === infoHash && f.status === "failed");
  if (hit) {
    Object.assign(hit, { status: "pending", detail: "已重试，等待 115 下载完成", attempts: 0, misses: 0, doneAt: undefined });
    saveFollowups(rows);
    startOfflineWatcher();
  }
}

export async function getOfflineDownPaths(accountName: string | undefined): Promise<OfflineDownPath[]> {
  const account = resolveAccount115(accountName);
  try {
    return await offlineDownPaths(account);
  } catch (err) {
    throw upstream(err, "读取默认下载目录失败");
  }
}

/* ------------------------------- 回执循环 ------------------------------- */

let running = false;
let timer: NodeJS.Timeout | null = null;
let ticking: Promise<void> | null = null;
let lastTickAt: number | null = null;
let lastError: string | null = null;

export function getOfflineWatcherStatus(): OfflineWatcherStatus {
  return {
    running,
    pending: listFollowups().filter((f) => f.status === "pending").length,
    lastTickAt,
    lastError,
  };
}

/** 有待办就起循环；已在跑或没待办都不动 */
export function startOfflineWatcher(): void {
  if (running || !hasPending()) return;
  running = true;
  log.info("云下载回执循环启动");
  schedule(0);
}

export async function stopOfflineWatcher(): Promise<void> {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  await ticking;
}

function schedule(ms: number): void {
  timer = setTimeout(() => {
    timer = null;
    void runTick();
  }, ms);
  timer.unref?.();
}

async function runTick(): Promise<void> {
  if (!running) return;
  ticking = tickFollowups()
    .then(() => {
      lastError = null;
    })
    .catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn({ err }, "云下载回执循环这一轮失败");
    })
    .finally(() => {
      ticking = null;
    });
  await ticking;
  if (!running) return;
  if (!hasPending()) {
    running = false;
    log.info("云下载回执已全部兑现，循环停止");
    return;
  }
  schedule(POLL_MS);
}

function finish(f: OfflineFollowup, status: "done" | "failed", detail: string): void {
  f.status = status;
  f.detail = detail;
  f.doneAt = Date.now();
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 跑一轮：翻每个有待办的账号的任务列表，把待办逐条对上号处理。
 * 导出为函数是为了测试能直接触发，不用等 30 秒。
 */
export async function tickFollowups(): Promise<void> {
  const all = listFollowups();
  const pending = all.filter((f) => f.status === "pending");
  if (pending.length === 0) return;
  const persist = () => saveFollowups(all);

  const byAccount = new Map<string, OfflineFollowup[]>();
  for (const f of pending) byAccount.set(f.account, [...(byAccount.get(f.account) ?? []), f]);

  for (const [accountName, items] of byAccount) {
    const accountInfo = getAccount(accountName);
    if (!accountInfo || accountInfo.accountType !== "115" || !accountInfo.cookie) {
      for (const f of items) finish(f, "failed", `账号 ${accountName} 不存在、不是 115 账号或没有 cookie`);
      persist();
      continue;
    }

    const want = new Set(items.map((i) => i.infoHash));
    const found = new Map<string, OfflineTask>();
    try {
      for (let page = 1; page <= MAX_PAGES && found.size < want.size; page++) {
        const res = await deps.list(accountInfo, page);
        for (const t of res.tasks) if (want.has(t.infoHash)) found.set(t.infoHash, t);
        if (res.tasks.length === 0 || page >= res.pageCount) break;
      }
    } catch (err) {
      // 这一轮列表拿不到（风控、断网）：什么都不改，下轮再来
      lastError = err instanceof Error ? err.message : String(err);
      log.warn({ err }, `读取账号 ${accountName} 的云下载列表失败，回执下轮再对`);
      continue;
    }

    for (const f of items) {
      const t = found.get(f.infoHash);
      if (!t) {
        f.misses += 1;
        if (f.misses >= MAX_MISSES) finish(f, "failed", "任务已不在 115 的云下载列表里");
        else f.detail = `列表里暂时没找到这条任务（${f.misses}/${MAX_MISSES}）`;
        continue;
      }
      f.misses = 0;
      if (t.name) f.name = t.name;
      if (t.state === "failed") {
        finish(f, "failed", `115 下载失败：${t.statusText}`);
        continue;
      }
      if (t.state !== "done") {
        f.detail = t.state === "downloading" ? `115 下载中 ${t.percent}%` : t.statusText;
        if (Date.now() - f.addedAt > PENDING_MAX_AGE_MS) finish(f, "failed", "等了 7 天还没下完，不再跟踪");
        continue;
      }
      await completeFollowup(f, t, accountInfo);
      persist();
    }
    persist();
  }
  lastTickAt = Date.now();
}

async function completeFollowup(f: OfflineFollowup, t: OfflineTask, accountInfo: AccountInfo): Promise<void> {
  const task = getTask(f.taskId);
  if (!task) {
    finish(f, "failed", `同步任务 ${f.taskId} 已不存在，无法生成 strm`);
    return;
  }
  f.attempts += 1;
  const item: SelectedItem = { name: t.resultName || t.name, isDir: t.isDir, cid: t.isDir ? t.resultId : undefined };
  try {
    const r = await deps.generate({ task, accountInfo, settings: readAppSettings(), subPath: f.subPath, item });
    finish(f, "done", `已生成 ${r.generatedCount} 个 strm（跳过 ${r.skippedCount} 个）`);
    log.info(`云下载完成：${t.name} → ${f.detail}`);
    if (r.generatedCount > 0) scheduleEmbyRefresh();
    void deps
      .notify(`云下载完成：<b>${esc(t.name)}</b>\n${esc(f.detail)}\n目录：${esc(task.originPath)}${f.subPath ? `/${esc(f.subPath)}` : ""}`)
      .catch(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (f.attempts >= MAX_ATTEMPTS) finish(f, "failed", `生成 strm 失败：${msg}`);
    else f.detail = `生成 strm 失败，稍后重试（${f.attempts}/${MAX_ATTEMPTS}）：${msg}`;
    log.warn({ err }, `云下载 ${t.name} 生成 strm 失败（第 ${f.attempts} 次）`);
  }
}

/** 仅供测试：清掉所有回执并停循环 */
export async function __test_resetOffline(): Promise<void> {
  await stopOfflineWatcher();
  writeKv(FOLLOWUP_KEY, []);
  lastTickAt = null;
  lastError = null;
}
