/**
 * 「复制到 OpenList」：新落到网盘上的文件，让 OpenList 复制到另一个存储（如挂载的本地磁盘）。
 *
 *   - 谁都能往这里丢活儿：云下载、转存、追更、网盘监控，调 enqueueCopy 就行。
 *     它同步返回、不碰网络、绝不往调用方抛——复制是锦上添花，不能把转存本身搞失败。
 *   - 队列落在 settings 表的 `copy.queue` 键里（见 ./queue.ts），进程重启不丢。
 *   - 一个后台循环推进两个阶段：
 *       waiting  产物在 OpenList 里可见了没有（列目录必须带 refresh，不然看的是缓存）→ 提交 /fs/copy；
 *       copying  盯着复制任务，全部结束后对成败。
 *     两个阶段各有各的计数器：waits（产物还没出现，等 10 轮）和 misses（任务列表里找不到，3 轮），
 *     换阶段时把对方清零，免得一个计数器两个含义。
 *   - 源目录在 OpenList 里压根不存在（挂载根填错了）第一轮就失败，不白等 10 轮。
 *   - 没待办时循环自己停掉，不白打接口。
 *
 * 路径换算在 ./paths.ts：网盘绝对路径 + 这个账号的挂载根 = OpenList 里的路径。
 */
import { randomUUID } from "node:crypto";
import type { AppSettings } from "@openstrm/shared";
import { KEY } from "../../db/keys.js";
import { readKv, writeKv } from "../../db/repositories/life.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { messageOf } from "../../lib/errors.js";
import { HttpError } from "../../lib/http-error.js";
import { moduleLogger } from "../../lib/logger.js";
import { createPollingLoop } from "../../lib/polling.js";
import {
  copyStateSucceeded,
  openlistCopy,
  openlistCopyTasks,
  openlistListDir,
  openlistMkdir,
  OpenlistError,
  type OpenlistTaskInfo,
} from "../openlist/client.js";
import { notify, type NotifyEvent } from "../telegram/notify.js";
import {
  baseName,
  dstDirFor,
  joinPath,
  normDir,
  parentDir,
  resolveCopyConfig,
  toOpenlistPath,
  type CopyConfig,
} from "./paths.js";
import {
  hasPendingCopies,
  isDuplicate,
  listCopies,
  saveCopies,
  type CopyRecord,
  type CopyStatus,
  type CopyTrigger,
} from "./queue.js";

const log = moduleLogger("copy");

export type { CopyRecord, CopyStatus, CopyTrigger } from "./queue.js";
export { listCopies } from "./queue.js";

const POLL_MS = 30_000;
const MAX_ATTEMPTS = 3;
/** 网盘报完成到产物在 OpenList 里可见有延迟，多等几轮（约 5 分钟）再放弃 */
const MAX_WAITS = 10;
const MAX_MISSES = 3;
/** 刚登记的先晾一会儿：监控是一个文件一条事件，晾这一下同目录的兄弟文件就能并进同一批 */
const SETTLE_MS = 10_000;
/** 排了这么久还没复制完就不再跟踪 */
const PENDING_MAX_AGE_MS = 7 * 24 * 3600_000;

const TRIGGER_LABEL: Record<CopyTrigger, string> = {
  offline: "云下载",
  share: "转存",
  follow: "追更",
  monitor: "网盘监控",
  manual: "手动",
};

/* ------------------------------- 依赖注入 ------------------------------- */

interface Deps {
  openlist: {
    /** 刷新目录缓存并返回其中的条目名 */
    listNames: (cfg: CopyConfig, dir: string) => Promise<string[]>;
    /** 建目标目录（OpenList 的 /fs/copy 不会自己建） */
    mkdir: (cfg: CopyConfig, dir: string) => Promise<void>;
    /** 提交复制；返回的任务和 names 一一对应 */
    copy: (cfg: CopyConfig, srcDir: string, dstDir: string, names: string[]) => Promise<OpenlistTaskInfo[]>;
    /** 复制任务的进行中 + 已结束列表 */
    copyTasks: (cfg: CopyConfig) => Promise<{ undone: OpenlistTaskInfo[]; done: OpenlistTaskInfo[] }>;
  };
  notify: (event: NotifyEvent) => Promise<unknown>;
  settings: () => AppSettings;
  now: () => number;
}

const realDeps: Deps = {
  openlist: {
    listNames: async (cfg, dir) => (await openlistListDir(cfg.account, dir, { refresh: true })).map((e) => e.name),
    mkdir: (cfg, dir) => openlistMkdir(cfg.account, dir),
    copy: (cfg, srcDir, dstDir, names) => openlistCopy(cfg.account, srcDir, dstDir, names),
    copyTasks: (cfg) => openlistCopyTasks(cfg.account),
  },
  notify,
  settings: readAppSettings,
  now: () => Date.now(),
};

let deps: Deps = { ...realDeps };

/** 仅供测试：换掉会碰网络的几步；传 null 恢复 */
export function setCopyServiceDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/* ------------------------------- 登记 ------------------------------- */

export interface CopySource {
  /** 网盘绝对路径 */
  path: string;
  isDir?: boolean;
  /** 网盘节点 id，删源时核对用 */
  nodeId?: string;
}

export interface CopyRequest {
  /** 网盘账号名（115 / 夸克 / 以后的都一样） */
  account: string;
  /** 网盘绝对路径；只有路径时直接给字符串 */
  sources: Array<string | CopySource>;
  /** 这些路径相对哪个根算目录结构（通常是 task.originPath）；不给就平铺到目标目录 */
  rootPath?: string;
  taskId?: string;
  /** 这一次复制到哪（OpenList 完整路径）；不给用设置里的 dstDir */
  dstDir?: string;
  trigger: CopyTrigger;
}

/**
 * 登记待复制。同步返回、不碰网络、绝不抛：配置没配好、这个账号没配挂载根，都只记一条日志——
 * 调用方是转存 / 追更 / 监控，它们本身已经成功了，不能因为复制没配好就失败。
 */
export function enqueueCopy(req: CopyRequest): void {
  try {
    const sources = req.sources
      .map((s) => (typeof s === "string" ? { path: s } : s))
      .filter((s) => s.path && s.path.trim());
    if (sources.length === 0) return;

    let cfg: CopyConfig;
    try {
      cfg = resolveCopyConfig(deps.settings());
    } catch (err) {
      log.debug(`${req.account} 有 ${sources.length} 个新文件要复制，但「复制到 OpenList」没配置好：${messageOf(err)}`);
      return;
    }
    if (!cfg.mounts[req.account]) {
      log.debug(`账号 ${req.account} 没填「在 OpenList 里的挂载根」，这次的 ${sources.length} 个新文件不复制`);
      return;
    }

    const base = normDir(req.dstDir) || cfg.dstDir;
    const now = deps.now();
    const rows = listCopies();
    const fresh: CopyRecord[] = [];
    for (const s of sources) {
      const srcPath = s.path.trim();
      const { dstDir, flattened } = dstDirFor(base, req.rootPath, srcPath);
      const rec: CopyRecord = {
        id: randomUUID(),
        account: req.account,
        srcDir: parentDir(srcPath),
        name: baseName(srcPath),
        isDir: s.isDir,
        nodeId: s.nodeId,
        dstDir,
        taskId: req.taskId ?? "",
        trigger: req.trigger,
        addedAt: now,
        status: "pending",
        stage: "waiting",
        detail: flattened ? "等着复制到 OpenList（路径不在任务目录下，平铺复制）" : "等着复制到 OpenList",
        attempts: 0,
        waits: 0,
        misses: 0,
      };
      if (!rec.name) continue;
      if (isDuplicate([...rows, ...fresh], rec, now)) continue;
      fresh.push(rec);
    }
    if (fresh.length === 0) return;
    saveCopies([...fresh, ...rows]);
    log.info(`登记 ${fresh.length} 个待复制（${req.account} → ${base}，来自${TRIGGER_LABEL[req.trigger]}）`);
    startCopyWatcher();
  } catch (err) {
    // 登记失败不能影响调用方：转存 / 追更本身已经成功了
    log.warn({ err }, `登记复制待办失败（${req.account}，来自${TRIGGER_LABEL[req.trigger]}），这次不复制`);
  }
}

/* ------------------------------- 推进 ------------------------------- */

function finish(c: CopyRecord, status: Exclude<CopyStatus, "pending">, detail: string): void {
  c.status = status;
  c.detail = detail;
  c.doneAt = deps.now();
}

/** OpenList 说「目录不存在」：挂载根填错了，再等下去也不会变出来 */
function isMissingDir(err: unknown): boolean {
  return err instanceof OpenlistError && !err.transport && /not found|不存在|no such|object not found/i.test(err.message);
}

/**
 * 跑一轮。导出为函数是为了测试能直接触发，不用等 30 秒。
 *
 * 还没提交的按「OpenList 源目录 + 目标目录」分组，一组只列一次目录、只提交一次复制；
 * 已经提交的共用一次任务列表。
 */
export async function tickCopies(): Promise<void> {
  const all = listCopies();
  const pending = all.filter((c) => c.status === "pending");
  if (pending.length === 0) return;
  const persist = () => saveCopies(all);

  let cfg: CopyConfig;
  try {
    cfg = resolveCopyConfig(deps.settings());
  } catch (err) {
    // 配置被删了：正在跑的这些没法再推进，说清楚原因
    for (const c of pending) finish(c, "failed", messageOf(err));
    persist();
    return;
  }

  const now = deps.now();
  for (const c of pending) {
    if (now - c.addedAt > PENDING_MAX_AGE_MS) finish(c, "failed", "等了 7 天还没复制完，不再跟踪");
  }

  const waiting = pending.filter((c) => c.status === "pending" && c.stage === "waiting" && now - c.addedAt >= SETTLE_MS);
  const copying = pending.filter((c) => c.status === "pending" && c.stage === "copying");
  await submitReady(cfg, waiting, persist);
  await pollSubmitted(cfg, copying, persist);
  persist();
}

/** 阶段一：确认产物在 OpenList 里可见，然后成批提交复制 */
async function submitReady(cfg: CopyConfig, items: CopyRecord[], persist: () => void): Promise<void> {
  if (items.length === 0) return;
  const groups = new Map<string, { srcDir: string; dstDir: string; items: CopyRecord[] }>();
  for (const c of items) {
    const srcDir = toOpenlistPath(cfg.mounts, c.account, c.srcDir);
    if (!srcDir) {
      finish(c, "failed", `账号 ${c.account} 没填「在 OpenList 里的挂载根」，不知道 ${c.srcDir} 在 OpenList 的哪里`);
      continue;
    }
    const key = JSON.stringify([srcDir, c.dstDir]);
    const g = groups.get(key) ?? { srcDir, dstDir: c.dstDir, items: [] };
    g.items.push(c);
    groups.set(key, g);
  }

  for (const g of groups.values()) {
    let names: string[];
    try {
      names = await deps.openlist.listNames(cfg, g.srcDir);
    } catch (err) {
      const msg = messageOf(err);
      if (isMissingDir(err)) {
        // 挂载根填错了：源目录在 OpenList 里根本不存在，等多少轮也不会出现
        for (const c of g.items) finish(c, "failed", `OpenList 里没有 ${g.srcDir}，检查一下账号 ${c.account} 的挂载根填对没有`);
      } else {
        for (const c of g.items) {
          c.attempts += 1;
          if (c.attempts >= MAX_ATTEMPTS) finish(c, "failed", `读 OpenList 的 ${g.srcDir} 失败：${msg}`);
          else c.detail = `读 OpenList 的 ${g.srcDir} 失败，稍后重试（${c.attempts}/${MAX_ATTEMPTS}）：${msg}`;
        }
        log.warn({ err }, `列 OpenList 目录失败：${g.srcDir}`);
      }
      persist();
      continue;
    }

    const ready: CopyRecord[] = [];
    for (const c of g.items) {
      if (names.includes(c.name)) {
        ready.push(c);
        continue;
      }
      c.waits += 1;
      if (c.waits >= MAX_WAITS) finish(c, "failed", `刷新后 OpenList 的 ${g.srcDir} 里始终没有出现「${c.name}」`);
      else c.detail = `等「${c.name}」出现在 OpenList（${c.waits}/${MAX_WAITS}）`;
    }
    if (ready.length === 0) {
      persist();
      continue;
    }

    // 目标目录里已经有同名的就不再复制一遍：overwrite 一直是 false，重复提交只会堆任务
    let existing: string[] = [];
    try {
      existing = await deps.openlist.listNames(cfg, g.dstDir);
    } catch {
      // 目标目录还不存在（下面会建）或一时读不到，都照常往下走
    }
    const todo = ready.filter((c) => {
      if (!existing.includes(c.name)) return true;
      finish(c, "skipped", `${g.dstDir} 里已经有「${c.name}」了，跳过`);
      return false;
    });
    if (todo.length === 0) {
      persist();
      continue;
    }

    try {
      // /fs/copy 不会自己建目标目录，先建一次（已存在时 OpenList 自己会说，吞掉）
      await deps.openlist.mkdir(cfg, g.dstDir).catch(() => {});
      const tasks = await deps.openlist.copy(cfg, g.srcDir, g.dstDir, todo.map((c) => c.name));
      const submittedAt = deps.now();
      todo.forEach((c, i) => {
        // 返回的任务和 names 一一对应；对不上就按名字认，再认不上就只靠名字启发式
        const task = tasks[i] ?? tasks.find((t) => t.name.includes(c.name)) ?? null;
        c.submittedAt = submittedAt;
        c.waits = 0;
        c.misses = 0;
        if (!task?.id) {
          // 同存储或极小文件会立即完成、没有任务可盯；OpenList 既然收下了就当办成了
          finish(c, "done", `OpenList 已复制到 ${g.dstDir}`);
          void deps.notify({ type: "offline-copied", name: c.name, target: g.dstDir }).catch(() => {});
          return;
        }
        c.stage = "copying";
        c.copyTaskId = task.id;
        c.detail = "已提交 OpenList 复制";
      });
      log.info(`已提交 OpenList 复制 ${todo.length} 项：${g.srcDir} → ${g.dstDir}`);
    } catch (err) {
      const msg = messageOf(err);
      for (const c of todo) {
        c.attempts += 1;
        if (c.attempts >= MAX_ATTEMPTS) finish(c, "failed", `提交 OpenList 复制失败：${msg}`);
        else c.detail = `提交 OpenList 复制失败，稍后重试（${c.attempts}/${MAX_ATTEMPTS}）：${msg}`;
      }
      log.warn({ err }, `提交 OpenList 复制失败：${g.srcDir} → ${g.dstDir}`);
    }
    persist();
  }
}

/** 一条复制在 OpenList 任务名里的特征：源路径的最后两段，比只用条目名不容易串味 */
function taskKey(c: CopyRecord): string {
  const segs = joinPath(c.srcDir, c.name).split("/").filter(Boolean);
  return segs.slice(-2).join("/");
}

/**
 * 阶段二：盯复制进度。OpenList 复制目录是「父任务展开逐文件子任务」，父任务很快就结束，
 * 所以不能只看提交时拿到的那个任务 id：undone 里凡是任务名带着这条特征的都算这次复制的一部分，
 * 全部离开 undone 后再到 done 里对成败（按 endedAt 滤掉陈年同名任务）。
 */
async function pollSubmitted(cfg: CopyConfig, items: CopyRecord[], persist: () => void): Promise<void> {
  if (items.length === 0) return;
  let tasks: { undone: OpenlistTaskInfo[]; done: OpenlistTaskInfo[] };
  try {
    tasks = await deps.openlist.copyTasks(cfg);
  } catch (err) {
    // 这一轮任务列表拿不到（OpenList 重启中、断网）：什么都不改，下轮再来
    loop.noteError(messageOf(err));
    log.warn({ err }, "读取 OpenList 复制任务列表失败，下轮再对");
    return;
  }

  for (const c of items) {
    const key = taskKey(c);
    const mine = (rows: OpenlistTaskInfo[]) => rows.filter((r) => r.id === c.copyTaskId || (key !== "" && r.name.includes(key)));
    const active = mine(tasks.undone);
    if (active.length > 0) {
      c.misses = 0;
      const own = active.find((r) => r.id === c.copyTaskId) ?? active[0];
      c.detail = active.length > 1 ? `OpenList 复制中，还剩 ${active.length} 个任务` : `OpenList 复制中 ${Math.round(own.progress)}%`;
      continue;
    }
    // 提交之前就躺在 done 列表里的同名任务不算这次的；OpenList 和本机的钟可能有偏差，放宽 10 分钟
    const since = (c.submittedAt ?? c.addedAt) - 600_000;
    const settled = mine(tasks.done).filter((r) => r.id === c.copyTaskId || r.endedAt == null || r.endedAt >= since);
    if (settled.length === 0) {
      c.misses += 1;
      if (c.misses >= MAX_MISSES) finish(c, "failed", "OpenList 的任务列表里找不到这次复制（可能被手动清掉了）");
      else c.detail = `OpenList 任务列表里暂时没找到这次复制（${c.misses}/${MAX_MISSES}）`;
      continue;
    }
    const failed = settled.filter((r) => !copyStateSucceeded(r.state));
    if (failed.length > 0) {
      const suffix = failed.length > 1 ? `（共 ${failed.length} 个任务失败）` : "";
      finish(c, "failed", `OpenList 复制失败：${failed[0].error || "未知原因"}${suffix}`);
      void deps.notify({ type: "offline-copy-failed", name: c.name, detail: c.detail }).catch(() => {});
      continue;
    }
    finish(c, "done", `OpenList 已复制到 ${c.dstDir}`);
    log.info(`复制完成：${joinPath(c.srcDir, c.name)} → ${c.dstDir}`);
    void deps.notify({ type: "offline-copied", name: c.name, target: c.dstDir }).catch(() => {});
  }
  persist();
}

/* ------------------------------- 循环 ------------------------------- */

let lastTickAt: number | null = null;

const loop = createPollingLoop({
  name: "复制到 OpenList 的队列",
  log,
  intervalMs: POLL_MS,
  tick: async () => {
    lastTickAt = Date.now();
    await tickCopies();
  },
  shouldContinue: hasPendingCopies,
  doneMessage: "复制队列已清空，循环停止",
});

export interface CopyWatcherStatus {
  running: boolean;
  pending: number;
  lastTickAt: number | null;
  lastError: string | null;
}

export function getCopyWatcherStatus(): CopyWatcherStatus {
  return {
    running: loop.running,
    pending: listCopies().filter((c) => c.status === "pending").length,
    lastTickAt,
    lastError: loop.lastError,
  };
}

export function startCopyWatcher(): void {
  if (loop.running || !hasPendingCopies()) return;
  log.info("复制队列循环启动");
  loop.start();
}

export async function stopCopyWatcher(): Promise<void> {
  await loop.stop();
}

/* ------------------------------- 路由用的动作 ------------------------------- */

/** 失败的重新排队：计数清零，回到「等产物可见」那一步 */
export function retryCopy(id: string): CopyRecord {
  const rows = listCopies();
  const c = rows.find((x) => x.id === id);
  if (!c) throw new HttpError(404, `复制记录不存在：${id}`);
  if (c.status === "pending") throw new HttpError(409, "这条还在队列里跑着，不用重试");
  c.status = "pending";
  c.stage = "waiting";
  c.detail = "重新排队，等着复制到 OpenList";
  c.attempts = 0;
  c.waits = 0;
  c.misses = 0;
  c.copyTaskId = undefined;
  c.submittedAt = undefined;
  c.doneAt = undefined;
  c.addedAt = deps.now();
  saveCopies(rows);
  startCopyWatcher();
  return c;
}

/** 不跟了：从队列里去掉（已经提交给 OpenList 的复制不会被取消，只是这边不再盯） */
export function dropCopy(id: string): void {
  const rows = listCopies();
  const kept = rows.filter((c) => c.id !== id);
  if (kept.length === rows.length) throw new HttpError(404, `复制记录不存在：${id}`);
  saveCopies(kept);
}

/**
 * 升级：接管云下载里已经提交给 OpenList 的复制。
 *
 * 老版本把「下载完成后复制走」整条都记在云下载回执里（`offline.followups` 的 kind = "openlist-copy"）。
 * 现在复制归这个队列管，已经提交出去的那些得搬过来接着盯，不然它们会烂在回执里没人问。
 * 还在等 115 下载的不用搬：115 一报完成，云下载那边就会调 enqueueCopy 走新路。
 */
export function adoptLegacyCopyFollowups(): number {
  type Legacy = {
    kind?: string;
    status?: string;
    account?: string;
    name?: string;
    addedAt?: number;
    copyDstDir?: string;
    copyTaskId?: string;
    copySubmittedAt?: number;
    misses?: number;
  };
  const rows = readKv<Legacy[]>(KEY.offlineFollowups);
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const inFlight = rows.filter((f) => f.kind === "openlist-copy" && f.status === "pending" && f.copyTaskId != null);
  if (inFlight.length === 0) return 0;

  let cfg: CopyConfig;
  try {
    cfg = resolveCopyConfig(deps.settings());
  } catch {
    return 0; // 配置都没了，搬过来也跑不动
  }
  const now = deps.now();
  const adopted: CopyRecord[] = [];
  for (const f of inFlight) {
    if (!f.name || !f.account) continue;
    adopted.push({
      id: randomUUID(),
      account: f.account,
      // 老回执只知道 OpenList 里的源目录，网盘路径无从得知；copying 阶段用不到它
      srcDir: "",
      name: f.name,
      dstDir: normDir(f.copyDstDir) || cfg.dstDir,
      taskId: "",
      trigger: "offline",
      addedAt: f.addedAt ?? now,
      status: "pending",
      stage: "copying",
      detail: "升级后接着盯这次复制",
      attempts: 0,
      waits: 0,
      misses: f.misses ?? 0,
      copyTaskId: f.copyTaskId,
      submittedAt: f.copySubmittedAt,
    });
  }
  if (adopted.length === 0) return 0;
  saveCopies([...adopted, ...listCopies()]);
  const kept = rows.filter((f) => !inFlight.includes(f));
  writeKv(KEY.offlineFollowups, kept);
  log.info(`接管了 ${adopted.length} 条云下载在途的复制`);
  startCopyWatcher();
  return adopted.length;
}

/** 仅供测试：清空队列并停循环 */
export async function __test_resetCopy(): Promise<void> {
  await stopCopyWatcher();
  saveCopies([]);
  lastTickAt = null;
  loop.noteError(null);
}
