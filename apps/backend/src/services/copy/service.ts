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
 *   - 源目录在 OpenList 里找不到时先从挂载根往下逐级刷新再看（OpenList 靠父目录的缓存找子目录，
 *     网盘上刚建 / 刚改名的目录直接刷新会报找不到）；挂载根本身都没有才第一轮就失败，不白等 10 轮。
 *   - 任务开着「把握大的直接执行」的自动整理时，登记的先压着等整理在网盘上改完名再复制（holdUntil），
 *     整理办完提前放行；整理挪走的文件由整理那边改写队列里的路径（rewriteCopyPaths）。
 *   - 没待办时循环自己停掉，不白打接口。
 *
 * 路径换算在 ./paths.ts：网盘绝对路径 + 这个账号的挂载根 = OpenList 里的路径。
 */
import { randomUUID } from "node:crypto";
import type { AppSettings, TaskDefinition } from "@openstrm/shared";
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
import { scheduleEmbyRefresh } from "../media-server.js";
import { maybeAutoOrganize, type AutoOrganizeInput } from "../organize/auto.js";
import fsp from "node:fs/promises";
import path from "node:path";
import { removeEmptyParents } from "../../lib/fs.js";
import { matchTask } from "../life/handlers.js";
import { mirrorDelete } from "../organize/mirror.js";
import { providerForAccount } from "../drive/registry.js";
import type { DriveNode } from "../drive/types.js";
import { listTasks } from "../../db/repositories/tasks.js";
import {
  baseName,
  dstDirFor,
  normConfigDir,
  joinPath,
  normDir,
  parentDir,
  relativeTo,
  resolveCopyConfig,
  toOpenlistPath,
  type CopyConfig,
} from "./paths.js";
import {
  commitCopies,
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
/**
 * 任务开着「把握大的直接执行」时最多等自动整理多久。整理办完会提前放行，这只是兜底：
 * 监控的整理要攒 30 秒，一季几十集识别 + 在网盘上挪也要一两分钟
 */
const ORGANIZE_HOLD_MS = 10 * 60_000;
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
  listTasks: () => TaskDefinition[];
  now: () => number;
  /** 复制完的后续动作，抽出来是为了测试能断言它们被调过 */
  embyRefresh: () => void;
  organize: (input: AutoOrganizeInput) => void;
  /** 删源：按网盘路径找到节点再删，找不到 / id 对不上就不删 */
  removeSource: (account: string, path: string, nodeId?: string) => Promise<"removed" | "missing" | "changed" | "unsupported">;
  /** 网盘上这个目录里有哪些条目名：删源前核对目录复制全了没有 */
  listDriveChildren: (account: string, path: string) => Promise<string[]>;
  /** 网盘上这个路径现在是哪个节点：要删源又没带节点 id 的（追更、115 转存），提交时钉住 */
  resolveNodeId: (account: string, path: string) => Promise<string | null>;
  /** 删源之后把本地对应的 strm / 下载文件（目录就整个目录）也删掉；本地没有返回 false */
  removeLocalMirror: (account: string, path: string, isDir: boolean | undefined) => Promise<boolean>;
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
  listTasks,
  now: () => Date.now(),
  embyRefresh: scheduleEmbyRefresh,
  organize: maybeAutoOrganize,
  removeSource: removeSourceReal,
  listDriveChildren: listDriveChildrenReal,
  resolveNodeId: async (account, path) => (await lookupFresh(account, path))?.id ?? null,
  removeLocalMirror: removeLocalMirrorReal,
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
  /** 复制成功后删掉网盘上那份（任务级开关，登记时冻结） */
  deleteSource?: boolean;
  /**
   * 调用方刚为这些路径排了一次会直接执行的自动整理：先压着，等整理在网盘上改完名、挪完目录再复制，
   * 不然要么复制成整理前的样子，要么复制到一半源文件被挪走。整理办完会放行（releaseCopyHolds）
   */
  holdForOrganize?: boolean;
}

export interface CopyEnqueueResult {
  /** 真排上队的条数 */
  queued: number;
  /** 一条都没排上的原因（配置没配好 / 没填挂载根 / 都重复了）；排上了就是 null */
  skipped: string | null;
}

/**
 * 登记待复制。同步返回、不碰网络、绝不抛：配置没配好、这个账号没配挂载根，都只记一条日志——
 * 调用方是转存 / 追更 / 监控，它们本身已经成功了，不能因为复制没配好就失败。
 * **返回值别忽略**：云下载那边要据此决定回执算不算兑现，不然会把「其实没排上」记成办完了。
 */
export function enqueueCopy(req: CopyRequest): CopyEnqueueResult {
  try {
    const sources = req.sources
      .map((s) => (typeof s === "string" ? { path: s } : s))
      .filter((s) => s.path && s.path.trim());
    if (sources.length === 0) return { queued: 0, skipped: null };

    let cfg: CopyConfig;
    try {
      cfg = resolveCopyConfig(deps.settings());
    } catch (err) {
      const why = `「复制到 OpenList」没配置好：${messageOf(err)}`;
      log.debug(`${req.account} 有 ${sources.length} 个新文件要复制，但${why}`);
      return { queued: 0, skipped: why };
    }
    if (!cfg.mounts[req.account]) {
      const why = `账号 ${req.account} 没填「在 OpenList 里的挂载根」`;
      log.debug(`${why}，这次的 ${sources.length} 个新文件不复制`);
      return { queued: 0, skipped: why };
    }

    const base = normConfigDir(req.dstDir) || cfg.dstDir;
    if (!base) {
      const why = "没有可用的目标目录：设置页的默认目标目录和任务上的都是空的";
      log.debug(`${req.account}：${why}`);
      return { queued: 0, skipped: why };
    }
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
        dstBase: base,
        rootPath: req.rootPath,
        taskId: req.taskId ?? "",
        trigger: req.trigger,
        deleteSource: req.deleteSource,
        addedAt: now,
        status: "pending",
        stage: "waiting",
        detail: flattened
          ? "等着复制到 OpenList（路径不在任务目录下，平铺复制）"
          : req.holdForOrganize
            ? "等自动整理先在网盘上改完名再复制"
            : "等着复制到 OpenList",
        attempts: 0,
        waits: 0,
        misses: 0,
        ...(req.holdForOrganize ? { holdUntil: now + ORGANIZE_HOLD_MS } : {}),
      };
      if (!rec.name) continue;
      if (isDuplicate([...rows, ...fresh], rec, now)) continue;
      fresh.push(rec);
    }
    if (fresh.length === 0) return { queued: 0, skipped: "这些条目已经在队列里或刚复制过" };
    saveCopies([...fresh, ...rows]);
    log.info(`登记 ${fresh.length} 个待复制（${req.account} → ${base}，来自${TRIGGER_LABEL[req.trigger]}）`);
    startCopyWatcher();
    return { queued: fresh.length, skipped: null };
  } catch (err) {
    // 登记失败不能影响调用方：转存 / 追更本身已经成功了
    log.warn({ err }, `登记复制待办失败（${req.account}，来自${TRIGGER_LABEL[req.trigger]}），这次不复制`);
    return { queued: 0, skipped: messageOf(err) };
  }
}

/* ------------------------------- 推进 ------------------------------- */

/**
 * 落定一条记录。成败都攒进 settledThisTick，一轮结束合成一条通知——
 * 队列是一个文件一条记录，一季四十集逐条发的话 Telegram 那边限流会把后面的直接丢掉。
 * 失败**一定要有通知**：四个触发点都是无人看着的后台活儿，只写进队列的话，
 * 除非用户恰好打开云下载页，否则永远不知道复制没成。
 */
function finish(c: CopyRecord, status: Exclude<CopyStatus, "pending">, detail: string, opts: { notify?: boolean } = {}): void {
  c.status = status;
  c.detail = detail;
  c.doneAt = deps.now();
  if (opts.notify !== false && (status === "failed" || status === "done")) settledThisTick.push(c);
}

/** 这一轮落定的记录，收尾时合成通知 */
let settledThisTick: CopyRecord[] = [];

/** 一轮结束：成的一条、败的一条，各自带上条目名（多了就说「等 N 个」） */
function flushNotifications(): void {
  const settled = settledThisTick;
  settledThisTick = [];
  if (settled.length === 0) return;
  for (const status of ["done", "failed"] as const) {
    const rows = settled.filter((c) => c.status === status);
    if (rows.length === 0) continue;
    const names = rows.map((c) => c.name);
    const source = [...new Set(rows.map((c) => TRIGGER_LABEL[c.trigger]))].join(" / ");
    if (status === "done") {
      // 一季的文件多半在同一个目录；落在好几个目录时只写第一个再说一共几个，别让人以为全在第一个里
      const dirs = [...new Set(rows.map((c) => c.dstDir))];
      const target = dirs.length > 1 ? `${dirs[0]} 等 ${dirs.length} 个目录` : dirs[0];
      void deps.notify({ type: "copy-done", names, target, source }).catch(() => {});
    } else {
      void deps.notify({ type: "copy-failed", names, detail: rows[0].detail, source }).catch(() => {});
    }
  }
}

/** OpenList 明确说「找不到」（不是连不上）：是挂载根填错了还是缓存没跟上，由 listSource 往上追着分 */
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
  const pending = listCopies().filter((c) => c.status === "pending");
  if (pending.length === 0) return;
  /**
   * 这一轮碰过的记录。循环里夹着网络等待，期间别人也在写这个键，所以只把碰过的按 id 合并回去。
   * 集合只增不清：中途 persist 过的记录后面还可能再改（分组是一组一组办的），清掉就会丢掉后面那次改动。
   */
  const touched = new Set<CopyRecord>();
  const persist = () => commitCopies([...touched], deps.now());

  let cfg: CopyConfig;
  try {
    cfg = resolveCopyConfig(deps.settings());
  } catch (err) {
    // 配置被删了：正在跑的这些没法再推进，说清楚原因。一条条发通知会刷屏，合成一条
    for (const c of pending) {
      finish(c, "failed", messageOf(err));
      touched.add(c);
    }
    persist();
    flushNotifications();
    return;
  }

  const now = deps.now();
  for (const c of pending) {
    if (now - c.addedAt > PENDING_MAX_AGE_MS) {
      finish(c, "failed", "等了 7 天还没复制完，不再跟踪");
      touched.add(c);
    }
  }

  const waiting = pending.filter(
    (c) => c.status === "pending" && c.stage === "waiting" && now - c.addedAt >= SETTLE_MS && (c.holdUntil ?? 0) <= now,
  );
  const copying = pending.filter((c) => c.status === "pending" && c.stage === "copying");
  await submitReady(cfg, waiting, pending, touched, persist);
  await pollSubmitted(cfg, copying, touched, persist);
  persist();
  flushNotifications();
}

/** 网盘绝对路径（所在目录 + 名字）：比较两条记录谁套着谁 */
const fullPathOf = (c: CopyRecord): string => joinPath(c.srcDir, c.name);
const isInside = (path: string, dir: string): boolean => path.startsWith(`${dir === "/" ? "" : dir}/`);

/**
 * 两条记录套在一起（一条是目录，另一条在它里面）时谁先谁后，免得两个 OpenList 任务同时写同一个文件：
 * 夸克监控只报最上层的新目录，转存 / 追更却是按文件登记的，第一次存进一个新建的子目录时两边就会套上。
 *   - 目录等它里面的先复制完：那些是按文件登记的（可能要删源），办完之后目标里已经有这个目录，目录本身就按「已存在」跳过；
 *   - 里面的等外面已经提交的目录复制完：OpenList 已经在复制整个目录了，办完再看目标里有没有。
 * 返回压着的原因；没套上返回 null
 */
function overlapHold(c: CopyRecord, pending: CopyRecord[]): string | null {
  const me = fullPathOf(c);
  const others = pending.filter((o) => o.id !== c.id && o.status === "pending" && o.account === c.account && !o.adopted && o.srcDir !== "");
  const inner = others.filter((o) => isInside(fullPathOf(o), me));
  if (inner.length > 0) return `等目录里的 ${inner.length} 个条目先复制完`;
  const outer = others.find((o) => o.stage === "copying" && isInside(me, fullPathOf(o)));
  if (outer) return `等上层目录「${outer.name}」先复制完`;
  return null;
}

/**
 * 列 OpenList 里的源目录（带 refresh，不然看的是缓存）。
 *
 * OpenList 找子目录靠的是**父目录的缓存**：网盘上刚建 / 刚改名的目录（转存或追更新建的子目录、
 * 整理建的作品目录、在网盘 App 里改的名）还不在父目录的缓存里，直接刷新它会报 object not found。
 * 所以找不到时从挂载根往下逐级刷新一遍再试一次（真机撞到过：发布目录在 115 上改了名，
 * 下一集的复制第一轮就报「检查挂载根」）。挂载根本身都列不出来才是挂载根填错了；
 * 挂载根在、源目录刷新完还是没有，说明它在网盘上已经不在原处了（被挪走 / 改名），按「还没出现」等着。
 */
async function listSource(cfg: CopyConfig, account: string, srcDir: string): Promise<{ names: string[] } | { missing: "mount" | "dir" }> {
  try {
    return { names: await deps.openlist.listNames(cfg, srcDir) };
  } catch (err) {
    if (!isMissingDir(err)) throw err;
  }
  const mount = cfg.mounts[account] ?? "/";
  const chain = [mount];
  const rest = relativeTo(mount, srcDir);
  if (rest) {
    const segs = rest.split("/").filter(Boolean);
    for (let i = 1; i < segs.length; i++) chain.push(joinPath(mount, segs.slice(0, i).join("/")));
  }
  for (const dir of chain) {
    try {
      await deps.openlist.listNames(cfg, dir);
    } catch (err) {
      if (!isMissingDir(err)) throw err;
      return { missing: dir === mount ? "mount" : "dir" };
    }
  }
  try {
    return { names: await deps.openlist.listNames(cfg, srcDir) };
  } catch (err) {
    if (!isMissingDir(err)) throw err;
    return { missing: srcDir === mount ? "mount" : "dir" };
  }
}

/** 阶段一：确认产物在 OpenList 里可见，然后成批提交复制 */
async function submitReady(cfg: CopyConfig, items: CopyRecord[], pending: CopyRecord[], touched: Set<CopyRecord>, persist: () => void): Promise<void> {
  if (items.length === 0) return;
  const groups = new Map<string, { account: string; srcDir: string; dstDir: string; items: CopyRecord[] }>();
  for (const c of items) {
    touched.add(c);
    const srcDir = toOpenlistPath(cfg.mounts, c.account, c.srcDir);
    if (!srcDir) {
      finish(c, "failed", `账号 ${c.account} 没填「在 OpenList 里的挂载根」，不知道 ${c.srcDir} 在 OpenList 的哪里`);
      continue;
    }
    const held = overlapHold(c, pending);
    if (held) {
      c.detail = held;
      continue;
    }
    const key = JSON.stringify([srcDir, c.dstDir]);
    const g = groups.get(key) ?? { account: c.account, srcDir, dstDir: c.dstDir, items: [] };
    g.items.push(c);
    groups.set(key, g);
  }

  for (const g of groups.values()) {
    let names: string[];
    try {
      const listed = await listSource(cfg, g.account, g.srcDir);
      if ("missing" in listed) {
        const mount = cfg.mounts[g.account];
        if (listed.missing === "mount") {
          // 挂载根填错了：等多少轮也不会出现
          for (const c of g.items) finish(c, "failed", `OpenList 里没有挂载根 ${mount}，检查一下账号 ${c.account} 的挂载根填对没有`);
        } else {
          for (const c of g.items) {
            c.waits += 1;
            if (c.waits >= MAX_WAITS) finish(c, "failed", `刷新后 OpenList 里始终找不到 ${g.srcDir}：网盘上这个目录可能被挪走或改名了`);
            else c.detail = `OpenList 里还看不到 ${g.srcDir}（${c.waits}/${MAX_WAITS}）`;
          }
        }
        persist();
        continue;
      }
      names = listed.names;
    } catch (err) {
      const msg = messageOf(err);
      for (const c of g.items) {
        c.attempts += 1;
        if (c.attempts >= MAX_ATTEMPTS) finish(c, "failed", `读 OpenList 的 ${g.srcDir} 失败：${msg}`);
        else c.detail = `读 OpenList 的 ${g.srcDir} 失败，稍后重试（${c.attempts}/${MAX_ATTEMPTS}）：${msg}`;
      }
      log.warn({ err }, `列 OpenList 目录失败：${g.srcDir}`);
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
      // 用户明确点了重试：多半是上次复制到一半留了个残缺的文件在那儿。
      // overwrite 一直是 false，覆盖不了，所以如实报失败让人去删，而不是悄悄「跳过」了事
      if (c.retried) {
        finish(c, "failed", `${g.dstDir} 里已经有「${c.name}」了，可能是上次没复制完的残留；先把它删掉再重试`);
      } else {
        finish(c, "skipped", `${g.dstDir} 里已经有「${c.name}」了，跳过`);
      }
      return false;
    });
    // 要删源却不知道网盘节点 id 的（追更、115 转存、整理拆出来的）：现在钉住，删之前按它核对。
    // 这一刻 OpenList 刚看见它，路径上就是要复制的这一份
    const pinned: CopyRecord[] = [];
    for (const c of todo) {
      if (!c.deleteSource || c.nodeId || c.adopted) {
        pinned.push(c);
        continue;
      }
      try {
        const id = await deps.resolveNodeId(c.account, joinPath(c.srcDir, c.name));
        if (id) c.nodeId = id;
        else {
          c.deleteSource = false;
          c.sourceKept = "提交时网盘上没找到这个路径的节点，核对不了";
        }
        pinned.push(c);
      } catch (err) {
        c.attempts += 1;
        const msg = messageOf(err);
        if (c.attempts >= MAX_ATTEMPTS) finish(c, "failed", `核对网盘上的源文件失败：${msg}`);
        else c.detail = `核对网盘上的源文件失败，稍后重试（${c.attempts}/${MAX_ATTEMPTS}）：${msg}`;
      }
    }
    if (pinned.length === 0) {
      persist();
      continue;
    }

    const settled: CopyRecord[] = [];
    try {
      // /fs/copy 不会自己建目标目录，先建一次（已存在时 OpenList 自己会说，吞掉）
      await deps.openlist.mkdir(cfg, g.dstDir).catch(() => {});
      const names = pinned.map((c) => c.name);
      const tasks = await deps.openlist.copy(cfg, g.srcDir, g.dstDir, names);
      const submittedAt = deps.now();
      /**
       * 只有「返回的任务数和提交的条目数一样」时才敢按下标认领——OpenList 只给需要排队的条目建任务，
       * 少回一个就会让后面每一条都认错别人的任务（成功的显示失败、还在跑的显示已复制，开了删源更危险）。
       * 对不上就按名字认；名字也认不出来的不当「立即完成」，留在盯任务阶段靠名字继续找。
       */
      const positional = tasks.length === names.length;
      pinned.forEach((c, i) => {
        const task = positional ? tasks[i] : (tasks.find((t) => t.name.includes(c.name)) ?? null);
        c.submittedAt = submittedAt;
        c.waits = 0;
        c.misses = 0;
        if (tasks.length === 0) {
          // 同存储或极小文件会立即完成、一个任务都没有；OpenList 既然收下了就当办成了
          finish(c, "done", "复制完成");
          settled.push(c);
          return;
        }
        c.stage = "copying";
        c.copyTaskId = task?.id;
        c.detail = task?.id ? "已提交 OpenList 复制" : "已提交 OpenList 复制（没认出任务号，按名字盯）";
      });
      log.info(`已提交 OpenList 复制 ${pinned.length} 项：${g.srcDir} → ${g.dstDir}`);
    } catch (err) {
      const msg = messageOf(err);
      for (const c of pinned) {
        c.attempts += 1;
        if (c.attempts >= MAX_ATTEMPTS) finish(c, "failed", `提交 OpenList 复制失败：${msg}`);
        else c.detail = `提交 OpenList 复制失败，稍后重试（${c.attempts}/${MAX_ATTEMPTS}）：${msg}`;
      }
      log.warn({ err }, `提交 OpenList 复制失败：${g.srcDir} → ${g.dstDir}`);
    }
    // 后续动作放在 try 外面：它报错只该写进 detail，不能被上面那个「提交失败」的 catch 接住
    for (const c of settled) await afterCopied(c, cfg);
    persist();
  }
}

/**
 * 一条复制在 OpenList 任务名里的特征：源路径的最后两段，比只用条目名不容易串味。
 * 升级接管过来的记录没有网盘路径，按名字认的风险更大，所以它们只认任务 id（返回空串）。
 */
function taskKey(c: CopyRecord): string {
  if (c.adopted || c.srcDir === "") return "";
  const segs = joinPath(c.srcDir, c.name).split("/").filter(Boolean);
  return segs.slice(-2).join("/");
}

/**
 * 阶段二：盯复制进度。OpenList 复制目录是「父任务展开逐文件子任务」，父任务很快就结束，
 * 所以不能只看提交时拿到的那个任务 id：undone 里凡是任务名带着这条特征的都算这次复制的一部分，
 * 全部离开 undone 后再到 done 里对成败（按 endedAt 滤掉陈年同名任务）。
 */
async function pollSubmitted(cfg: CopyConfig, items: CopyRecord[], touched: Set<CopyRecord>, persist: () => void): Promise<void> {
  if (items.length === 0) return;
  for (const c of items) touched.add(c);
  let tasks: { undone: OpenlistTaskInfo[]; done: OpenlistTaskInfo[] };
  try {
    tasks = await deps.openlist.copyTasks(cfg);
  } catch (err) {
    // 这一轮任务列表拿不到（OpenList 重启中、断网）：什么都不改，下轮再来
    loop.noteError(messageOf(err));
    log.warn({ err }, "读取 OpenList 复制任务列表失败，下轮再对");
    return;
  }

  // 别人明确认领的任务 id：按名字认的时候要避开，不然两条记录会互相抢结果
  const claimed = new Set(items.map((c) => c.copyTaskId).filter((id): id is string => Boolean(id)));
  for (const c of items) {
    const key = taskKey(c);
    const mine = (rows: OpenlistTaskInfo[]) =>
      rows.filter((r) => (c.copyTaskId && r.id === c.copyTaskId) || (key !== "" && r.name.includes(key) && !claimed.has(r.id)));
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
      continue;
    }
    finish(c, "done", "复制完成");
    log.info(`复制完成：${joinPath(c.srcDir, c.name)} → ${c.dstDir}`);
    await afterCopied(c, cfg);
  }
  persist();
}

/** 复制完了，但这一份在目标里到底全不全？删源之前必须先答上来 */
async function verifyCopied(c: CopyRecord, cfg: CopyConfig): Promise<{ ok: true } | { ok: false; why: string }> {
  const names = await deps.openlist.listNames(cfg, c.dstDir);
  if (!names.includes(c.name)) return { ok: false, why: "目标里没看到这一份" };
  if (!c.isDir) return { ok: true };
  /**
   * 目录只看「目标里有这个名字」是不够的：OpenList 一开始就把目录建出来了，
   * 里面可能一个文件都还没搬完。逐个对一层子项的名字，缺一个就不删。
   */
  const [src, dst] = await Promise.all([
    deps.listDriveChildren(c.account, joinPath(c.srcDir, c.name)),
    deps.openlist.listNames(cfg, joinPath(c.dstDir, c.name)),
  ]);
  const missing = src.filter((n) => !dst.includes(n));
  if (missing.length > 0) return { ok: false, why: `目标里少了 ${missing.length} 项（${missing.slice(0, 3).join("、")}…）` };
  return { ok: true };
}


/**
 * 网盘上这个路径现在是哪个节点。按父目录**绕开缓存**列一遍再按名字找：
 * 115 按路径找文件时用的是进程内缓存 5 分钟的目录清单，刚转存进来的文件在缓存里还没有
 * （真机撞到：转存弹框刚列过任务目录，提交复制时就钉不住节点，删源被关掉；删的时候也会说「源已不在原处」）。
 * 目录本身按路径解析（115 的 getid 不走那份缓存），整理那边挑同名也是这么绕的
 */
async function lookupFresh(account: string, path: string): Promise<DriveNode | null> {
  const provider = providerForAccount(account);
  const name = baseName(path);
  const dir = await provider.resolvePath(parentDir(path));
  if (!dir || !dir.isDir || !name) return null;
  const hit = (await provider.listDir(dir.id, undefined, { fresh: true })).find((e) => e.name === name);
  return hit ? { id: hit.id, isDir: hit.isDir } : null;
}

/**
 * 删源之后同步本地：只认这个网盘账号的任务（别的账号同名 originPath 的任务不能被串到）。
 * 目录就把本地同名目录整个删掉，文件交给整理那边同一个 mirrorDelete（strm 按扩展名换算、下载的字幕等直接删）
 */
async function removeLocalMirrorReal(account: string, panPath: string, isDir: boolean | undefined): Promise<boolean> {
  const tasks = listTasks().filter((t) => t.account === account);
  const match = matchTask({ tasks }, panPath);
  if (!match || !match.relPath) return false;
  if (isDir !== false) {
    const local = path.join(match.saveDir, match.relPath);
    const stat = await fsp.stat(local).catch(() => null);
    if (stat?.isDirectory()) {
      await fsp.rm(local, { recursive: true, force: true });
      await removeEmptyParents(path.dirname(local), match.saveDir);
      return true;
    }
  }
  return mirrorDelete(panPath, { tasks, settings: readAppSettings() });
}

/** 网盘上这个目录的一层子项名（同样绕开缓存：刚复制完的目录要对的是现在的样子） */
async function listDriveChildrenReal(account: string, path: string): Promise<string[]> {
  const provider = providerForAccount(account);
  const node = await lookupFresh(account, path);
  if (!node || !node.isDir) return [];
  return (await provider.listDir(node.id, undefined, { fresh: true })).map((e) => e.name);
}

/**
 * 删源：整理可能已经把文件挪走了，路径还在但换了一个同名的，所以有 nodeId 就必须对得上才删。
 * 115 / 夸克删进回收站，OpenList 看存储后端。
 */
async function removeSourceReal(account: string, path: string, nodeId?: string): Promise<"removed" | "missing" | "changed" | "unsupported"> {
  const provider = providerForAccount(account);
  if (!provider.write) return "unsupported";
  const node = await lookupFresh(account, path);
  if (!node) return "missing";
  if (nodeId && String(node.id) !== String(nodeId)) return "changed";
  await provider.write.remove({ id: node.id, path, isDir: node.isDir });
  return "removed";
}

/**
 * 复制成功之后：通知 Emby 扫一遍、目标落在某个 OpenList 任务里就按它的策略自动整理、
 * 按需删源。每一步失败都只写进 detail，不把已经成功的复制翻成失败。
 */
async function afterCopied(c: CopyRecord, cfg: CopyConfig): Promise<void> {
  try {
    await afterCopiedInner(c, cfg);
  } catch (err) {
    // 复制本身已经成了，后续动作出岔子只写进说明，不把记录翻成失败
    c.detail += `；复制完的后续动作出错：${messageOf(err)}`;
    log.warn({ err }, `复制完的后续动作失败：${joinPath(c.srcDir, c.name)}`);
  }
}

async function afterCopiedInner(c: CopyRecord, cfg: CopyConfig): Promise<void> {
  deps.embyRefresh();

  // 目标目录落在哪个「用这个 OpenList 账号」的任务下：最长 originPath 胜，同 life/handlers 的规则
  const full = joinPath(c.dstDir, c.name);
  const hit = deps.listTasks()
    .filter((t) => t.account === cfg.account.name)
    .map((t) => ({ task: t, rel: relativeTo(t.originPath, full) }))
    .filter((x): x is { task: TaskDefinition; rel: string } => x.rel !== null)
    .sort((a, b) => b.task.originPath.length - a.task.originPath.length)[0];
  if (hit && hit.rel) deps.organize({ task: hit.task, paths: [hit.rel], trigger: "copy", debounce: true });

  if (!c.deleteSource) {
    if (c.sourceKept) c.detail += `；${c.sourceKept}，源文件没删`;
    return;
  }
  if (c.adopted || c.srcDir === "") {
    c.detail += "；这条是升级前接管的，不知道源在哪，没删";
    return;
  }
  const src = joinPath(c.srcDir, c.name);
  try {
    const verdict = await verifyCopied(c, cfg);
    if (!verdict.ok) {
      c.detail += `；${verdict.why}，源文件没删`;
      return;
    }
    const r = await deps.removeSource(c.account, src, c.nodeId);
    if (r === "removed") {
      c.detail += "；网盘上那份已删";
      // 本地的 strm 指着的就是刚删掉的那一份，留着就是 Emby 里一个放不了的条目。
      // 不能指望网盘监控来收拾：115 删文件时 Provider 当场就把路径缓存清了，
      // 随后那条删除事件（不带父目录）就对不上任何任务，被当成根目录下的文件跳过（真机撞到）
      try {
        if (await deps.removeLocalMirror(c.account, src, c.isDir)) c.detail += "，本地 strm 也删了";
      } catch (err) {
        c.detail += `，本地 strm 没删掉：${messageOf(err)}`;
      }
    } else if (r === "missing") c.detail += "；源文件已不在原处，没删";
    else if (r === "changed") c.detail += "；源路径上换成了别的文件，没删";
    else c.detail += "；这个网盘不支持删除，源文件没删";
  } catch (err) {
    c.detail += `；删源失败：${messageOf(err)}`;
    log.warn({ err }, `复制后删源失败：${src}`);
  }
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

/** rows：调用方已经读出来的队列，给了就不再读一遍 */
export function getCopyWatcherStatus(rows: CopyRecord[] = listCopies()): CopyWatcherStatus {
  return {
    running: loop.running,
    pending: rows.filter((c) => c.status === "pending").length,
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
  if (c.adopted || c.srcDir === "") {
    throw new HttpError(409, "这条是升级前接管过来的，只有 OpenList 的任务号、没有网盘路径，重试无从下手；重新触发一次复制吧");
  }
  c.status = "pending";
  c.retried = true;
  c.stage = "waiting";
  c.detail = "重新排队，等着复制到 OpenList";
  c.attempts = 0;
  c.waits = 0;
  c.misses = 0;
  c.copyTaskId = undefined;
  c.submittedAt = undefined;
  c.doneAt = undefined;
  c.holdUntil = undefined;
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
      dstBase: normDir(f.copyDstDir) || cfg.dstDir,
      taskId: "",
      trigger: "offline",
      adopted: true,
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
  settledThisTick = [];
  saveCopies([]);
  lastTickAt = null;
  loop.noteError(null);
}
