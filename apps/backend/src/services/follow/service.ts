/**
 * 分享追更的编排层，路由只调这里。
 *
 *   - 建订阅：解析任务和账号，把范围内现有的条目列一遍当快照——当时没勾的东西以后也不会补转存。
 *   - 检查：重新列 → diff（diff.ts）→ 按落点分组转存并生成 strm（复用 share/receive.ts）
 *     → 更新快照、记动态、通知。
 *   - 一条循环每分钟挑到期的订阅顺序跑，条与条之间隔两秒（分享接口打得太密会被封 IP）；
 *     没有开着的订阅时循环自己停，建订阅 / 恢复时再起。
 *   - 状态全在 share_follows 表里，重启接着跑。
 *
 * 网盘的差异全在 DriveProvider 里：订阅不存网盘类型，任务的账号是哪家就按哪家列分享和转存（建订阅时校验同类）。
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { AppSettings, ShareFollow, ShareFollowRun, ShareFollowSummary, TaskDefinition } from "@openstrm/shared";
import { getTask } from "../../db/repositories/tasks.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import {
  countEnabledShareFollows,
  deleteShareFollow,
  findShareFollow,
  getShareFollow,
  insertShareFollow,
  listDueShareFollows,
  listShareFollowSummaries,
  replaceShareFollows,
  toSummary,
  updateShareFollow,
} from "../../db/repositories/share-follows.js";
import { HttpError } from "../../lib/http-error.js";
import { moduleLogger } from "../../lib/logger.js";
import { driveErrorToHttp } from "../drive/errors.js";
import { assertSameKind, parseShareRef, providerForTask } from "../drive/registry.js";
import type { DriveProvider, ShareEntry, ShareProvider, ShareRef, ShareSession, ShareUpdateSignal } from "../drive/types.js";
import { saveSelectionToTask } from "../share/receive.js";
import { scheduleEmbyRefresh } from "../media-server.js";
import { normalizeSubPath } from "../strm/naming.js";
import { notify, type NotifyEvent } from "../telegram/notify.js";
import { baseName, diffShareListing, groupByParent, mergeKnown, scopeIsWhole, type ListedEntry } from "./diff.js";
import { issueFromDrive } from "../telegram/notify.js";

const log = moduleLogger("follow");

export const FOLLOW = {
  MIN_INTERVAL_MIN: 30,
  DEFAULT_INTERVAL_MIN: 360,
  MAX_INTERVAL_MIN: 7 * 24 * 60,
  /** 递归列目录的上限：整站合集级的分享不该拿追更来盯 */
  MAX_DEPTH: 4,
  MAX_ENTRIES: 3000,
  MAX_REQUESTS: 30,
  /** 分享接口连续这么多次说"不行"，就当分享没了 */
  EXPIRE_STREAK: 3,
  STALE_DAYS: 60,
  MAX_BACKOFF_MS: 24 * 3600_000,
  TICK_MS: 60_000,
  RECENT_KEEP: 20,
} as const;

const STALE_MS = FOLLOW.STALE_DAYS * 24 * 3600_000;

/* ------------------------------- 依赖注入 ------------------------------- */

/** 网盘那几步走 DriveProvider（测试用 setDriveProviderFactory 换假网盘）；这里只剩通知和时间 */
interface Deps {
  notify: (event: NotifyEvent) => Promise<unknown>;
  now: () => number;
  /** 下次检查时间的抖动，[0,1)；测试钉成 0.5 就没有抖动 */
  random: () => number;
  /** 一轮里两条订阅之间的间隔 */
  gapMs: number;
}

const realDeps: Deps = { notify, now: () => Date.now(), random: Math.random, gapMs: 2_000 };

let deps: Deps = { ...realDeps };

/** 仅供测试：换掉通知和时间；传 null 恢复 */
export function setFollowServiceDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/* ------------------------------- 小工具 ------------------------------- */

const errMsg = (err: unknown): string => (err instanceof Error && err.message ? err.message : String(err));

export function clampInterval(minutes: number | undefined): number {
  const n = Number.isFinite(minutes) ? Math.round(minutes as number) : FOLLOW.DEFAULT_INTERVAL_MIN;
  return Math.min(FOLLOW.MAX_INTERVAL_MIN, Math.max(FOLLOW.MIN_INTERVAL_MIN, n));
}

function normalizeCid(cid: string | number | undefined): string {
  const s = cid == null ? "" : String(cid).trim();
  return s === "" ? "0" : s;
}

function normalizeScope(scope: string[] | undefined): string[] {
  if (!scope || scope.length === 0) return [""];
  const names = [...new Set(scope.map((s) => s.trim()))];
  return names.includes("") ? [""] : names.filter(Boolean);
}

/** 下次检查：间隔按连续失败次数翻倍（封顶一天），再加 ±10% 抖动，几条订阅不会总在同一秒挤到网盘 */
function nextCheckAt(f: Pick<ShareFollow, "intervalMinutes">, streak: number, now: number): number {
  const base = f.intervalMinutes * 60_000;
  const delay = streak > 0 ? Math.min(base * 2 ** Math.min(streak, 5), FOLLOW.MAX_BACKOFF_MS) : base;
  const jitter = 1 + (deps.random() - 0.5) * 0.2;
  return now + Math.round(delay * jitter);
}

/** 记一条动态；同一个错误连着来只更新时间，别把 20 条位置全占了 */
function pushRecent(recent: ShareFollowRun[], run: ShareFollowRun): ShareFollowRun[] {
  const head = recent[0];
  const quietError = run.added.length === 0 && run.skipped.length === 0 && Boolean(run.error);
  if (quietError && head && head.added.length === 0 && head.skipped.length === 0 && head.error === run.error) {
    return [run, ...recent.slice(1)];
  }
  return [run, ...recent].slice(0, FOLLOW.RECENT_KEEP);
}

interface Target {
  task: TaskDefinition;
  provider: DriveProvider;
  share: ShareProvider;
}

function resolveTask(taskId: string): Target {
  const task = getTask(taskId);
  if (!task) throw new HttpError(404, `Task not found: ${taskId}`);
  if (!task.targetPath || !task.strmPrefix) throw new HttpError(400, "所选任务缺少 targetPath 或 strmPrefix 配置");
  const provider = providerForTask(task, "share");
  return { task, provider, share: provider.share! };
}

/** 订阅只存分享码和提取码；网盘类型就是任务账号的类型（建订阅时校验过同类） */
function refOf(f: Pick<ShareFollow, "shareUrl" | "shareCode" | "receiveCode">, provider: DriveProvider): ShareRef {
  return { kind: provider.kind, code: f.shareCode, password: f.receiveCode, url: f.shareUrl };
}

/* ------------------------------- 列分享目录 ------------------------------- */

class FollowTooLargeError extends Error {}

interface Budget {
  requests: number;
}

function toEntry(item: ShareEntry, prefix: string): ListedEntry {
  const entry: ListedEntry = {
    path: prefix ? `${prefix}/${item.name}` : item.name,
    isDir: item.isDir,
    id: String(item.id),
  };
  if (item.hash) entry.sha1 = item.hash;
  if (item.size != null) entry.size = item.size;
  if (item.token) entry.token = item.token;
  return entry;
}

async function listAll(share: ShareProvider, session: ShareSession, dirId: string, budget: Budget): Promise<ShareEntry[]> {
  const out: ShareEntry[] = [];
  let cursor: string | undefined;
  for (;;) {
    if (++budget.requests > FOLLOW.MAX_REQUESTS) {
      throw new FollowTooLargeError(`分享目录太大（列了 ${FOLLOW.MAX_REQUESTS} 次还没列完），追更只适合剧集级的目录`);
    }
    const page = await share.list(session, dirId, cursor);
    out.push(...page.entries);
    if (!page.next || page.entries.length === 0) return out;
    cursor = page.next;
  }
}

async function walk(
  share: ShareProvider,
  session: ShareSession,
  dirId: string,
  prefix: string,
  depth: number,
  budget: Budget,
  out: ListedEntry[],
): Promise<void> {
  for (const item of await listAll(share, session, dirId, budget)) {
    const entry = toEntry(item, prefix);
    out.push(entry);
    if (out.length > FOLLOW.MAX_ENTRIES) {
      throw new FollowTooLargeError(`分享目录太大（超过 ${FOLLOW.MAX_ENTRIES} 项），追更只适合剧集级的目录`);
    }
    if (item.isDir && depth < FOLLOW.MAX_DEPTH) await walk(share, session, item.id, entry.path, depth + 1, budget, out);
  }
}

export interface ScopeListing {
  entries: ListedEntry[];
  /** 范围里已经不在分享里的目录名 */
  missingScopes: string[];
}

/** 把范围内的东西全列出来。范围是整个目录就从 watchCid 递归；否则先列一层找到范围目录再各自递归 */
async function listScope(
  share: ShareProvider,
  session: ShareSession,
  f: Pick<ShareFollow, "watchCid" | "scope">,
): Promise<ScopeListing> {
  const budget: Budget = { requests: 0 };
  const entries: ListedEntry[] = [];
  if (scopeIsWhole(f.scope)) {
    await walk(share, session, f.watchCid, "", 0, budget, entries);
    return { entries, missingScopes: [] };
  }
  const top = await listAll(share, session, f.watchCid, budget);
  const missingScopes: string[] = [];
  for (const name of f.scope) {
    const hit = top.find((it) => it.isDir && it.name === name);
    if (!hit) {
      missingScopes.push(name);
      continue;
    }
    entries.push(toEntry(hit, ""));
    await walk(share, session, hit.id, name, 1, budget, entries);
  }
  return { entries, missingScopes };
}

/* ------------------------------- 增删改查 ------------------------------- */

export interface CreateFollowInput {
  shareUrl?: string;
  shareCode?: string;
  receiveCode?: string;
  watchCid?: string | number;
  watchPath?: string;
  scope?: string[];
  taskId: string;
  subPath?: string;
  intervalMinutes?: number;
  name?: string;
  libraryId?: string | null;
}

export async function createFollow(input: CreateFollowInput): Promise<ShareFollowSummary> {
  let shareCode = (input.shareCode ?? "").trim();
  let receiveCode = (input.receiveCode ?? "").trim();
  const parsed = input.shareUrl?.trim() ? parseShareRef(input.shareUrl) : null;
  if (!shareCode && input.shareUrl?.trim()) {
    if (!parsed) throw new HttpError(400, "Invalid share url");
    shareCode = parsed.code;
    if (!receiveCode) receiveCode = parsed.password;
  }
  if (!shareCode) throw new HttpError(400, "shareCode is required");

  const { task, provider, share } = resolveTask(input.taskId);
  // 链接认得出是哪家的就必须和任务账号同类：115 的分享追不进夸克
  if (parsed) assertSameKind(parsed, provider);
  const watchCid = normalizeCid(input.watchCid);
  const existing = findShareFollow(shareCode, watchCid);
  if (existing) throw new HttpError(409, "这个分享目录已经在追更", { data: toSummary(existing) });

  const now = deps.now();
  const sec = Math.floor(now / 1000);
  const scope = normalizeScope(input.scope);
  const watchPath = (input.watchPath ?? "").trim();
  const draft: ShareFollow = {
    id: randomUUID(),
    name: (input.name ?? "").trim() || watchPath || shareCode,
    libraryId: input.libraryId ?? null,
    shareUrl: (input.shareUrl ?? "").trim() || parsed?.url || "",
    shareCode,
    receiveCode,
    watchCid,
    watchPath,
    scope,
    taskId: task.id,
    subPath: normalizeSubPath(input.subPath),
    enabled: true,
    intervalMinutes: clampInterval(input.intervalMinutes),
    status: "idle",
    lastError: "",
    errorStreak: 0,
    lastCheckedAt: now,
    lastChangeAt: null,
    nextCheckAt: 0,
    known: [],
    recent: [],
    createdAt: sec,
    updatedAt: sec,
  };

  let listing: ScopeListing;
  try {
    const session = await share.open(refOf(draft, provider));
    listing = await listScope(share, session, draft);
  } catch (err) {
    throw driveErrorToHttp(err, "列分享目录失败");
  }
  if (!scopeIsWhole(scope) && listing.missingScopes.length === scope.length) {
    throw new HttpError(400, `在分享里没找到目录：${listing.missingScopes.join("、")}`);
  }
  draft.known = mergeKnown([], listing.entries);
  draft.nextCheckAt = nextCheckAt(draft, 0, now);
  insertShareFollow(draft);
  log.info(`新建追更「${draft.name}」：${draft.known.length} 项已记为现有，→ ${task.originPath}${draft.subPath ? `/${draft.subPath}` : ""}`);
  startFollowWatcher();
  return toSummary(draft);
}

/** 两个转存接口用：转存成功后顺手建订阅，建不成只把原因带回去，不影响这次转存 */
export async function createFollowAfterSave(input: CreateFollowInput): Promise<{ follow?: ShareFollowSummary; followError?: string }> {
  try {
    return { follow: await createFollow(input) };
  } catch (err) {
    log.warn({ err }, "转存后建追更订阅失败");
    return { followError: errMsg(err) };
  }
}

export interface UpdateFollowInput {
  name?: string;
  enabled?: boolean;
  intervalMinutes?: number;
  taskId?: string;
  subPath?: string;
  receiveCode?: string;
}

export function updateFollow(id: string, input: UpdateFollowInput): ShareFollowSummary {
  const f = getShareFollow(id);
  if (!f) throw new HttpError(404, "追更订阅不存在");
  const now = deps.now();
  const patch: Partial<ShareFollow> = {};
  if (input.name !== undefined) patch.name = input.name.trim() || f.name;
  if (input.taskId !== undefined && input.taskId !== f.taskId) patch.taskId = resolveTask(input.taskId).task.id;
  if (input.subPath !== undefined) patch.subPath = normalizeSubPath(input.subPath);
  if (input.receiveCode !== undefined) patch.receiveCode = input.receiveCode.trim();
  if (input.intervalMinutes !== undefined) {
    patch.intervalMinutes = clampInterval(input.intervalMinutes);
    // 从上次检查算起：把 6 小时改成 1 小时，不该还要等满原来的 6 小时
    patch.nextCheckAt = Math.max(now, (f.lastCheckedAt ?? now) + patch.intervalMinutes * 60_000);
  }
  if (input.enabled !== undefined) {
    patch.enabled = input.enabled;
    // 重新打开：失效 / 停更 / 出错的状态都清掉，尽快检查一次
    if (input.enabled && (!f.enabled || f.status !== "idle")) {
      patch.status = "idle";
      patch.errorStreak = 0;
      patch.lastError = "";
      patch.nextCheckAt = now;
    }
  }
  const updated = updateShareFollow(id, patch);
  if (!updated) throw new HttpError(404, "追更订阅不存在");
  if (updated.enabled) startFollowWatcher();
  return toSummary(updated);
}

export function deleteFollow(id: string): void {
  if (checking.has(id)) throw new HttpError(409, "正在检查中，稍后再删");
  if (!deleteShareFollow(id)) throw new HttpError(404, "追更订阅不存在");
}

export interface FollowWatcherStatus {
  running: boolean;
  lastTickAt: number | null;
  lastError: string | null;
  /** 正在检查的订阅 id */
  checking: string[];
}

export function listFollows(): { follows: ShareFollowSummary[]; watcher: FollowWatcherStatus } {
  return { follows: listShareFollowSummaries(), watcher: getFollowWatcherStatus() };
}

/* ------------------------------- 检查 ------------------------------- */

const checking = new Set<string>();

export interface CheckResult {
  follow: ShareFollowSummary;
  /** 这次有动静才有；什么都没发生是 null */
  run: ShareFollowRun | null;
}

/** 检查一条。界面的「立即检查」和循环都走这里；同一条不会并发 */
export async function checkFollow(id: string): Promise<CheckResult> {
  const f = getShareFollow(id);
  if (!f) throw new HttpError(404, "追更订阅不存在");
  if (checking.has(id)) throw new HttpError(409, "正在检查中");
  checking.add(id);
  updateShareFollow(id, { status: "checking" });
  try {
    const run = await runCheck(f);
    const latest = getShareFollow(id) ?? f;
    return { follow: toSummary(latest), run };
  } finally {
    checking.delete(id);
  }
}

type FailKind = "error" | "share";

/** 这轮没能走到对照：记错误、退避；分享接口连续说不行就判失效停掉 */
function settleFailure(f: ShareFollow, error: string, kind: FailKind): ShareFollowRun {
  const now = deps.now();
  const streak = f.errorStreak + 1;
  const run: ShareFollowRun = { at: now, added: [], skipped: [], generated: 0, error };
  const recent = pushRecent(f.recent, run);
  if (kind === "share" && streak >= FOLLOW.EXPIRE_STREAK) {
    updateShareFollow(f.id, { status: "expired", enabled: false, lastError: error, errorStreak: streak, lastCheckedAt: now, recent });
    log.warn(`追更「${f.name}」的分享已失效，停止：${error}`);
    void deps.notify({ type: "follow-expired", name: f.name, reason: error }).catch(() => {});
    return run;
  }
  updateShareFollow(f.id, {
    status: "error",
    lastError: error,
    errorStreak: streak,
    lastCheckedAt: now,
    nextCheckAt: nextCheckAt(f, streak, now),
    recent,
  });
  log.warn(`追更「${f.name}」检查失败（第 ${streak} 次）：${error}`);
  if (streak >= FOLLOW.EXPIRE_STREAK) void deps.notify({ type: "follow-failed", id: f.id, name: f.name, detail: error }).catch(() => {});
  return run;
}

/** 服务端「没更新」信号连续信几次；有更新时的返回还没在真机验证过，信过头就照常列一遍兜底，最坏也就晚这几轮发现 */
const UPDATE_SIGNAL_TRUST = 3;
/** 每个订阅连续凭信号跳过了几轮 */
const signalSkips = new Map<string, number>();

/**
 * 有服务端信号的分享（夸克 inc_update_list）先问一句相对上次转存有没有新增：明确说没有就跳过整棵列目录。
 * 上一轮有转存失败的不问（失败的条目要靠列目录再试）；信号打不通就当不知道，让后面的列目录去报错。
 */
async function serverSaysUnchanged(f: ShareFollow, share: ShareProvider, session: ShareSession): Promise<boolean> {
  const updates = share.updates;
  if (!updates || f.errorStreak > 0) return false;
  const skips = signalSkips.get(f.id) ?? 0;
  if (skips >= UPDATE_SIGNAL_TRUST) return false;
  let signal: ShareUpdateSignal;
  try {
    signal = await updates.check(session);
  } catch {
    return false;
  }
  if (signal !== "none") return false;
  signalSkips.set(f.id, skips + 1);
  return true;
}

/** 这轮没列目录也没变化：只推进时间 */
function settleUnchanged(f: ShareFollow): null {
  const now = deps.now();
  updateShareFollow(f.id, { status: "idle", lastError: "", errorStreak: 0, lastCheckedAt: now, nextCheckAt: nextCheckAt(f, 0, now) });
  log.debug(`追更「${f.name}」服务端说分享没有更新，这轮不列目录`);
  return null;
}

async function runCheck(f: ShareFollow): Promise<ShareFollowRun | null> {
  let target: Target;
  try {
    target = resolveTask(f.taskId);
  } catch (err) {
    return settleFailure(f, err instanceof HttpError && err.status === 404 ? `同步任务 ${f.taskId} 已不存在` : errMsg(err), "error");
  }
  const { task, provider, share } = target;
  const ref = refOf(f, provider);

  let listing: ScopeListing;
  try {
    const session = await share.open(ref);
    if (await serverSaysUnchanged(f, share, session)) return settleUnchanged(f);
    listing = await listScope(share, session, f);
    signalSkips.delete(f.id);
  } catch (err) {
    const msg = errMsg(err);
    const issue = provider.classifyError(err);
    // cookie 失效 / 被风控是账号的问题，不该把订阅停掉：走账号告警，普通退避
    if (issue === "auth" || issue === "blocked") {
      void deps
        .notify({ type: "account-alert", account: provider.account.name, reason: msg, source: `追更 ${f.name}`, issue: issueFromDrive(issue) })
        .catch(() => {});
      return settleFailure(f, msg, "error");
    }
    if (issue === "gone") return settleFailure(f, `分享不可用：${msg}`, "share");
    return settleFailure(f, msg, "error");
  }

  const now = deps.now();
  const diff = diffShareListing(f.known, listing.entries);
  const settings: AppSettings = readAppSettings();
  const received: string[] = [];
  const failed: string[] = [];
  const errors: string[] = [];
  let generated = 0;
  for (const group of groupByParent(diff.added)) {
    const subPath = normalizeSubPath(group.parent ? `${f.subPath}/${group.parent}` : f.subPath);
    try {
      const r = await saveSelectionToTask({
        task,
        provider,
        ref,
        items: group.items.map((i) => ({ id: i.id, name: baseName(i.path), isDir: i.isDir, token: i.token })),
        subPath,
        mode: "sync",
        settings,
      });
      if ("generatedCount" in r) generated += r.generatedCount;
      received.push(...group.items.map((i) => i.path));
    } catch (err) {
      failed.push(...group.items.map((i) => i.path));
      errors.push(`${group.parent || "."}：${errMsg(err)}`);
    }
  }

  const skipped = [
    ...diff.replaced.map((e) => `${e.path}：分享里的文件被替换了，网盘里的那份没动`),
    ...diff.moved.map((e) => `${e.path}：改名或搬家，同样的文件已经有了，没有重复转存`),
    ...listing.missingScopes.map((n) => `${n}：范围目录已不在分享里`),
  ];
  const streak = errors.length ? f.errorStreak + 1 : 0;
  const patch: Partial<ShareFollow> = {
    known: mergeKnown(f.known, listing.entries, failed),
    status: errors.length ? "error" : "idle",
    lastError: errors.join("；"),
    errorStreak: streak,
    lastCheckedAt: now,
    nextCheckAt: nextCheckAt(f, streak, now),
  };
  const run: ShareFollowRun | null =
    received.length || skipped.length || errors.length
      ? { at: now, added: received, skipped, generated, ...(errors.length ? { error: errors.join("；") } : {}) }
      : null;
  if (run) patch.recent = pushRecent(f.recent, run);
  if (received.length) patch.lastChangeAt = now;

  // 很久没新东西：自动停下，省得一直打接口；通知一次，用户想继续再手动开
  const lastChange = received.length ? now : (f.lastChangeAt ?? f.createdAt * 1000);
  const stale = !received.length && !errors.length && now - lastChange > STALE_MS;
  if (stale) {
    patch.status = "stale";
    patch.enabled = false;
  }
  updateShareFollow(f.id, patch);

  const target2 = `${task.originPath}${f.subPath ? `/${f.subPath}` : ""}`;
  if (received.length) {
    log.info(`追更「${f.name}」新增 ${received.length} 项 → ${target2}，生成 ${generated} 个 strm`);
    if (generated > 0) scheduleEmbyRefresh();
    void deps.notify({ type: "follow-added", name: f.name, added: received.map(baseName), generated, target: target2 }).catch(() => {});
  }
  if (errors.length) {
    log.warn(`追更「${f.name}」有条目转存失败：${errors.join("；")}`);
    if (streak >= FOLLOW.EXPIRE_STREAK) void deps.notify({ type: "follow-failed", id: f.id, name: f.name, detail: errors.join("；") }).catch(() => {});
  }
  if (stale) {
    log.info(`追更「${f.name}」${FOLLOW.STALE_DAYS} 天没有更新，自动暂停`);
    void deps.notify({ type: "follow-stale", name: f.name, days: FOLLOW.STALE_DAYS }).catch(() => {});
  }
  return run;
}

/* ------------------------------- 循环 ------------------------------- */

let running = false;
let timer: NodeJS.Timeout | null = null;
let ticking: Promise<void> | null = null;
let lastTickAt: number | null = null;
let lastError: string | null = null;

export function getFollowWatcherStatus(): FollowWatcherStatus {
  return { running, lastTickAt, lastError, checking: [...checking] };
}

/** 有开着的订阅就起循环；已在跑或一条都没开都不动 */
export function startFollowWatcher(): void {
  if (running || countEnabledShareFollows() === 0) return;
  running = true;
  log.info("追更循环启动");
  schedule(0);
}

export async function stopFollowWatcher(): Promise<void> {
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
  ticking = tickFollows()
    .then(() => {
      lastError = null;
    })
    .catch((err) => {
      lastError = errMsg(err);
      log.warn({ err }, "追更循环这一轮失败");
    })
    .finally(() => {
      ticking = null;
    });
  await ticking;
  if (!running) return;
  if (countEnabledShareFollows() === 0) {
    running = false;
    log.info("没有开着的追更订阅，循环停止");
    return;
  }
  schedule(FOLLOW.TICK_MS);
}

/**
 * 跑一轮：到期的订阅顺序检查。导出为函数是为了测试能直接触发，不用等一分钟。
 * 单条失败不影响其余；正在被手动检查的跳过。
 */
export async function tickFollows(): Promise<void> {
  const due = listDueShareFollows(deps.now());
  for (let i = 0; i < due.length; i++) {
    const f = due[i];
    if (checking.has(f.id)) continue;
    try {
      await checkFollow(f.id);
    } catch (err) {
      log.warn({ err, id: f.id }, "追更检查抛错");
    }
    if (i < due.length - 1 && deps.gapMs > 0) await sleep(deps.gapMs);
  }
  lastTickAt = deps.now();
}

/** 仅供测试：清掉所有订阅并停循环 */
export async function __test_resetFollows(): Promise<void> {
  await stopFollowWatcher();
  replaceShareFollows([]);
  checking.clear();
  signalSkips.clear();
  lastTickAt = null;
  lastError = null;
}
