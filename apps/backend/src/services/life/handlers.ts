/**
 * 网盘变更事件 → 本地 strm 库的落地处理。
 *
 * 路径映射完全复用现有任务定义：
 *   事件的网盘绝对路径 P 命中某个 task.originPath 前缀
 *   → 本地位置 = DATA_DIR/<task.targetPath>/<P 相对 originPath 的部分>
 *   → strm 内容 = `${strmPrefix}/${P}`（与全量任务 services/task/runner.ts 完全一致）
 *
 * 事件已经带着绝对路径（旧路径不知道就是 null）：115 的 id → 路径还原在 sources/cloud115.ts 里做，这里不认任何一家的 id。
 */
import type { Dirent } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AppSettings, LifeEventMode, TaskDefinition } from "@openstrm/shared";
import { downloadFile, writeStrm } from "../download/rate-limited.js";
import { normalizePath, type ChangeEvent, type DriveEntry, type DriveProvider } from "../drive/types.js";
import { resolveInDataDir } from "../../paths.js";
import { decodeSegments, strmContent, toStrmPath } from "../strm/naming.js";
import { isDirectoryEntry, pathExists, removeEmptyParents } from "../../lib/fs.js";

export interface LifeContext {
  provider: DriveProvider;
  tasks: TaskDefinition[];
  settings: AppSettings;
  eventModes: Set<LifeEventMode>;
  log: (level: "info" | "warn" | "error" | "debug", msg: string) => void;
  signal?: AbortSignal;
}

export interface HandleResult {
  status: "done" | "skipped" | "failed";
  detail: string;
  /** 是否真的改动了本地文件——只有改动了才值得去打扰媒体服务器 */
  changed: boolean;
}

const skipped = (detail: string): HandleResult => ({ status: "skipped", detail, changed: false });
const done = (detail: string, changed = true): HandleResult => ({ status: "done", detail, changed });

/* ----------------------------- 路径与扩展名 ----------------------------- */

interface TaskMatch {
  task: TaskDefinition;
  /** 相对 originPath 的路径，可能为空串（事件对象就是 originPath 本身） */
  relPath: string;
  saveDir: string;
}

/** 和变更源算事件路径用同一套归一化（按段 trim、去重复斜杠），`tv//show ` 这种 originPath 才对得上 */
function normalizeOrigin(p: string): string {
  return normalizePath(p || "");
}

/** 命中最长（最具体）的 originPath */
export function matchTask(ctx: Pick<LifeContext, "tasks">, panPath: string): TaskMatch | null {
  let best: TaskMatch | null = null;
  for (const task of ctx.tasks) {
    const origin = normalizeOrigin(task.originPath);
    let rel: string | null = null;
    if (panPath === origin) rel = "";
    else if (panPath.startsWith(`${origin}/`)) rel = panPath.slice(origin.length + 1);
    if (rel === null) continue;
    if (best && normalizeOrigin(best.task.originPath).length >= origin.length) continue;
    const saveDir = resolveInDataDir(task.targetPath);
    if (!saveDir) continue; // targetPath 越出数据目录的任务不参与匹配
    best = { task, relPath: rel, saveDir };
  }
  return best;
}

function extOf(name: string): string {
  return path.extname(name).toLowerCase();
}

function strmExts(ctx: LifeContext): Set<string> {
  return new Set((ctx.settings.strmExtensions || []).map((e) => e.toLowerCase()));
}

function downloadExts(ctx: LifeContext): Set<string> {
  return new Set((ctx.settings.downloadExtensions || []).map((e) => e.toLowerCase()));
}

export { toStrmPath };

/** 本地对应文件的最终落盘路径（strm 类换扩展名，下载类保持原名） */
function localPathFor(match: TaskMatch, ctx: LifeContext, relFile: string): string | null {
  const ext = extOf(relFile);
  const full = path.join(match.saveDir, relFile);
  if (strmExts(ctx).has(ext)) return toStrmPath(full);
  if (downloadExts(ctx).has(ext)) return full;
  return null;
}

/**
 * strm 文件的内容。
 * 必须和全量任务逐字节一致：那边写的是 `${strmPrefix}/${originPath}/${rel}`，
 * 用的是任务里存的原始 originPath（现网数据里它不带前导 /），
 * 所以这里也得用原始值拼，不能拿归一化后的网盘绝对路径去拼。
 */
function strmUrlFor(task: TaskDefinition, relFile: string): string {
  return `${task.originPath}/${relFile}`;
}

const joinPan = (dir: string, name: string): string => (dir === "/" ? `/${name}` : `${dir}/${name}`);

/* ------------------------------- 生成 ------------------------------- */

/** 为单个网盘文件生成 strm 或下载媒体信息文件 */
async function materializeFile(
  ctx: LifeContext,
  match: TaskMatch,
  relFile: string,
  panPath: string,
  token: string | undefined,
): Promise<"strm" | "download" | "skip"> {
  const ext = extOf(relFile);
  const savePath = path.join(match.saveDir, relFile);

  if (strmExts(ctx).has(ext)) {
    await writeStrm(strmUrlFor(match.task, relFile), savePath, {
      displayPath: relFile,
      strmPrefix: match.task.strmPrefix,
      enablePathEncoding: match.task.enablePathEncoding,
    });
    return "strm";
  }

  if (downloadExts(ctx).has(ext)) {
    const link = await ctx.provider.downloadLink(panPath, { token, signal: ctx.signal });
    if (!link.url) return "skip";
    await downloadFile(link.url, savePath, { displayPath: relFile, headers: link.headers });
    return "download";
  }

  return "skip";
}

const MAX_WALK_ENTRIES = 20_000;

/**
 * 展开一个新增目录：递归列目录，为其中每个文件生成 strm / 下载媒体信息；
 * 列到的每一层都告诉网盘（115 借它维护路径缓存，后续该目录下的事件就不用打接口了）。
 */
async function materializeFolder(
  ctx: LifeContext,
  match: TaskMatch,
  folderId: string,
  folderPanPath: string,
): Promise<{ strm: number; download: number }> {
  const counters = { strm: 0, download: 0 };
  const queue: Array<{ id: string; panPath: string }> = [{ id: folderId, panPath: folderPanPath }];
  let visited = 0;

  while (queue.length > 0) {
    // 被中止就抛出去：按「完成」返回会让这条事件带着只生成了一半的目录推进游标
    ctx.signal?.throwIfAborted();
    const cur = queue.shift()!;
    const entries: DriveEntry[] = await ctx.provider.listDir(cur.id, ctx.signal);
    ctx.provider.rememberListing?.(cur.panPath, entries);

    for (const e of entries) {
      visited++;
      if (visited > MAX_WALK_ENTRIES) {
        ctx.log("warn", `目录 ${folderPanPath} 条目超过 ${MAX_WALK_ENTRIES}，停止展开`);
        return counters;
      }
      const childPan = joinPan(cur.panPath, e.name);
      if (e.isDir) {
        queue.push({ id: e.id, panPath: childPan });
        continue;
      }
      const childMatch = matchTask(ctx, childPan);
      if (!childMatch) continue;
      try {
        const kind = await materializeFile(ctx, childMatch, childMatch.relPath, childPan, e.token);
        if (kind === "strm") counters.strm++;
        else if (kind === "download") counters.download++;
      } catch (err) {
        ctx.log("error", `生成失败 ${childPan}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  return counters;
}

/**
 * 目录被移动/改名后，其下所有 strm 里写的还是旧网盘路径，要把前缀换掉。
 *
 * 匹配先按原样比（没开编码的任务就是这种），比不上就把内容按段解码再比：
 * 旧版整体 encodeURI 写的文件（`&`、`:` 这些没转）和新版按段 encodeURIComponent 写的都能对上。
 * 命中后按新任务的开关整体重写，旧写法的文件顺手规范成新的。
 */
async function rewriteStrmPrefixUnder(
  dir: string,
  oldTask: TaskDefinition,
  oldRel: string,
  newTask: TaskDefinition,
  newRel: string,
): Promise<number> {
  const oldPlain = `${oldTask.strmPrefix ?? ""}/${strmUrlFor(oldTask, oldRel)}`;
  const newRemote = strmUrlFor(newTask, newRel);
  const encode = !!newTask.enablePathEncoding;
  if (oldPlain === `${newTask.strmPrefix ?? ""}/${newRemote}` && !!oldTask.enablePathEncoding === encode) return 0;

  const matches = (c: string) => c === oldPlain || c.startsWith(`${oldPlain}/`);
  const rewrite = (content: string): string | null => {
    // 没开编码：先按原样比，这就是以前的逻辑；只有原样比不上（文件是编码写法）才去解码。
    // 开着编码：只认解码后的内容——拿原样的尾巴再编一次会把 %20 变成 %2520
    if (!encode && matches(content)) {
      return strmContent(newTask.strmPrefix, `${newRemote}${content.slice(oldPlain.length)}`, false);
    }
    const decoded = decodeSegments(content);
    if (!matches(decoded)) return null;
    return strmContent(newTask.strmPrefix, `${newRemote}${decoded.slice(oldPlain.length)}`, encode);
  };

  let n = 0;
  // 挪的是整个剧集目录时这里可能是几千个 strm，同步读写会把监控循环所在的事件循环卡住
  const walk = async (cur: string): Promise<void> => {
    let items: Dirent[];
    try {
      items = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(cur, it.name);
      if (await isDirectoryEntry(cur, it)) {
        await walk(full);
        continue;
      }
      if (!it.name.endsWith(".strm")) continue;
      try {
        const content = await fsp.readFile(full, "utf8");
        const next = rewrite(content);
        if (next === null || next === content) continue;
        await fsp.writeFile(full, next, "utf8");
        n++;
      } catch {
        /* 单个文件失败不影响其余 */
      }
    }
  };
  await walk(dir);
  return n;
}

/* ------------------------------- 事件处理 ------------------------------- */

/** 新增（上传 / 接收 / 复制 / 快照里冒出来的） */
export async function handleCreate(ctx: LifeContext, ev: ChangeEvent): Promise<HandleResult> {
  if (!ctx.eventModes.has("create")) return skipped("create 模式未开启");

  const panPath = ev.path;
  const match = matchTask(ctx, panPath);
  if (!match) return skipped(`${panPath} 不在任何任务的 originPath 下`);

  if (ev.isDir) {
    const c = await materializeFolder(ctx, match, ev.nodeId, panPath);
    return done(`目录 ${panPath} → strm ${c.strm} / 下载 ${c.download}`, c.strm + c.download > 0);
  }

  const kind = await materializeFile(ctx, match, match.relPath, panPath, ev.token);
  if (kind === "skip") return skipped(`${panPath} 扩展名不在 strm/下载白名单`);
  return done(`${kind}: ${panPath}`);
}

/** 新建目录：不生成任何本地文件（路径缓存由变更源自己维护） */
export async function handleNewFolder(_ctx: LifeContext, ev: ChangeEvent): Promise<HandleResult> {
  return done(`记录目录 ${ev.path}`, false);
}

/** 删除 */
export async function handleRemove(ctx: LifeContext, ev: ChangeEvent): Promise<HandleResult> {
  if (!ctx.eventModes.has("remove")) return skipped("remove 模式未开启");

  const panPath = ev.path;
  const match = matchTask(ctx, panPath);
  if (!match) return skipped(`${panPath} 不在任何任务的 originPath 下`);
  if (match.relPath === "") {
    ctx.log("warn", `${panPath} 是任务 ${match.task.id} 的 originPath 本身，拒绝整目录删除`);
    return skipped("命中任务根目录，不做删除");
  }

  const target = ev.isDir ? path.join(match.saveDir, match.relPath) : localPathFor(match, ctx, match.relPath);

  if (!target) return skipped(`${panPath} 扩展名不在白名单，无需删除`);
  if (!(await pathExists(target))) return skipped(`本地不存在 ${target}`);

  await fsp.rm(target, { recursive: ev.isDir, force: true });
  await removeEmptyParents(path.dirname(target), match.saveDir);

  return done(`删除 ${target}`);
}

/**
 * 移动：新路径来自事件，旧路径只有变更源知道（115 靠 path_cache）。
 * 旧路径未知时退化成「按新增处理」，本地可能残留一份旧 strm，由全量任务的 removeExtraFiles 兜底清理。
 */
export async function handleMove(ctx: LifeContext, ev: ChangeEvent): Promise<HandleResult> {
  if (!ctx.eventModes.has("move")) return skipped("move 模式未开启");
  return relocate(ctx, ev, "移动");
}

/** 改名：与移动同构，区别只在父目录不变 */
export async function handleRename(ctx: LifeContext, ev: ChangeEvent): Promise<HandleResult> {
  if (!ctx.eventModes.has("rename")) return skipped("rename 模式未开启");
  return relocate(ctx, ev, "改名");
}

const asCreate = (ctx: LifeContext): LifeContext => ({ ...ctx, eventModes: new Set([...ctx.eventModes, "create"]) });

async function relocate(ctx: LifeContext, ev: ChangeEvent, label: string): Promise<HandleResult> {
  const isDir = ev.isDir;
  const oldPan = ev.oldPath;
  const newPan = ev.path;

  if (!oldPan || oldPan === newPan) {
    ctx.log("debug", `${label}事件旧路径未知（${newPan}），按新增处理；旧文件由全量任务兜底清理`);
    return handleCreate(asCreate(ctx), ev);
  }

  const oldMatch = matchTask(ctx, oldPan);
  const newMatch = matchTask(ctx, newPan);

  // 移出监控范围 → 删本地
  if (oldMatch && !newMatch) {
    const target = isDir ? path.join(oldMatch.saveDir, oldMatch.relPath) : localPathFor(oldMatch, ctx, oldMatch.relPath);
    if (target && (await pathExists(target))) {
      await fsp.rm(target, { recursive: isDir, force: true });
      await removeEmptyParents(path.dirname(target), oldMatch.saveDir);
      return done(`${label}出监控范围，已删除 ${target}`);
    }
    return skipped(`${label}出监控范围，本地无对应文件`);
  }

  // 移入监控范围 → 当作新增
  if (!oldMatch && newMatch) return handleCreate(asCreate(ctx), ev);

  if (!oldMatch || !newMatch) return skipped(`${oldPan} → ${newPan} 均不在监控范围`);

  // 范围内挪动 → 直接移动本地文件，省掉一次重新生成
  const from = isDir ? path.join(oldMatch.saveDir, oldMatch.relPath) : localPathFor(oldMatch, ctx, oldMatch.relPath);
  const to = isDir ? path.join(newMatch.saveDir, newMatch.relPath) : localPathFor(newMatch, ctx, newMatch.relPath);

  if (!from || !to) return skipped(`${newPan} 扩展名不在白名单`);

  // 本地本来就没有，退化成新增
  if (!(await pathExists(from))) return handleCreate(asCreate(ctx), ev);

  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
  await removeEmptyParents(path.dirname(from), oldMatch.saveDir);

  // strm 内容里写的是网盘绝对路径，挪了位置就要重写
  if (!isDir && to.endsWith(".strm")) {
    await writeStrm(strmUrlFor(newMatch.task, newMatch.relPath), path.join(newMatch.saveDir, newMatch.relPath), {
      displayPath: newMatch.relPath,
      strmPrefix: newMatch.task.strmPrefix,
      enablePathEncoding: newMatch.task.enablePathEncoding,
    });
  } else if (isDir) {
    const rewritten = await rewriteStrmPrefixUnder(to, oldMatch.task, oldMatch.relPath, newMatch.task, newMatch.relPath);
    ctx.log("info", `${label}目录后重写了 ${rewritten} 个 strm 的网盘路径`);
  }

  return done(`${label} ${from} → ${to}`);
}
