/**
 * 生活事件 → 本地 strm 库的落地处理。
 *
 * 路径映射完全复用现有任务定义：
 *   事件的网盘绝对路径 P 命中某个 task.originPath 前缀
 *   → 本地位置 = DATA_DIR/<task.targetPath>/<P 相对 originPath 的部分>
 *   → strm 内容 = `${strmPrefix}/${P}`（与全量任务 routes/task/start.ts 完全一致）
 */
import fs from "node:fs";
import path from "node:path";
import { firstValueFrom } from "rxjs";
import type { AppSettings, LifeEventMode, TaskDefinition } from "@openstrm/shared";
import type { AccountInfo } from "../cloud-115/client.js";
import { getDownloadUrlWeb } from "../cloud-115/client.js";
import { downloadOrCreateStrm } from "../download/rate-limited.js";
import { listDir, type LifeEvent } from "../cloud-115/life.js";
import {
  joinPanPath,
  lookupCachedPath,
  rememberPath,
  rememberPaths,
  resolveDirPath,
} from "../cloud-115/path-resolver.js";
import { dropSubtree, repathSubtree } from "../../db/repositories/life.js";
import { DATA_DIR } from "../../paths.js";

export interface LifeContext {
  accountInfo: AccountInfo;
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

function normalizeOrigin(p: string): string {
  const s = (p || "").trim().replace(/\/+$/, "");
  return s.startsWith("/") ? s : `/${s}`;
}

/** 命中最长（最具体）的 originPath */
export function matchTask(ctx: LifeContext, panPath: string): TaskMatch | null {
  let best: TaskMatch | null = null;
  for (const task of ctx.tasks) {
    const origin = normalizeOrigin(task.originPath);
    let rel: string | null = null;
    if (panPath === origin) rel = "";
    else if (panPath.startsWith(`${origin}/`)) rel = panPath.slice(origin.length + 1);
    if (rel === null) continue;
    if (best && normalizeOrigin(best.task.originPath).length >= origin.length) continue;
    best = { task, relPath: rel, saveDir: path.resolve(DATA_DIR, task.targetPath) };
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

/** .mkv → .strm，与 downloadOrCreateStrm 内部的替换等价 */
export function toStrmPath(p: string): string {
  const ext = path.extname(p);
  return ext ? `${p.slice(0, -ext.length)}.strm` : `${p}.strm`;
}

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
 * 必须和 routes/task/start.ts 逐字节一致：那边写的是 `${strmPrefix}/${originPath}/${rel}`，
 * 用的是任务里存的原始 originPath（现网数据里它不带前导 /），
 * 所以这里也得用原始值拼，不能拿归一化后的网盘绝对路径去拼。
 */
function strmUrlFor(task: TaskDefinition, relFile: string): string {
  return `${task.originPath}/${relFile}`;
}

function strmContentPrefix(task: TaskDefinition, rel: string): string {
  return `${task.strmPrefix ?? ""}/${strmUrlFor(task, rel)}`;
}

function removeEmptyParents(dir: string, stopAt: string): void {
  if (!dir.startsWith(stopAt) || dir === stopAt) return;
  try {
    if (fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      removeEmptyParents(path.dirname(dir), stopAt);
    }
  } catch {
    /* 目录非空或已不存在，停止 */
  }
}

/* ------------------------------- 生成 ------------------------------- */

/** 为单个网盘文件生成 strm 或下载媒体信息文件 */
async function materializeFile(
  ctx: LifeContext,
  match: TaskMatch,
  relFile: string,
  panPath: string,
  pickCode: string,
): Promise<"strm" | "download" | "skip"> {
  const ext = extOf(relFile);
  const savePath = path.join(match.saveDir, relFile);

  if (strmExts(ctx).has(ext)) {
    await firstValueFrom(
      downloadOrCreateStrm(strmUrlFor(match.task, relFile), savePath, {
        asStrm: true,
        displayPath: relFile,
        strmPrefix: match.task.strmPrefix,
        enablePathEncoding: match.task.enablePathEncoding,
      }),
    );
    return "strm";
  }

  if (downloadExts(ctx).has(ext)) {
    if (!pickCode) {
      ctx.log("warn", `缺少 pick_code，跳过下载: ${panPath}`);
      return "skip";
    }
    const url = await getDownloadUrlWeb(pickCode, {
      userAgent: ctx.settings["user-agent"],
      accountInfo: ctx.accountInfo,
    });
    if (!url) return "skip";
    await firstValueFrom(
      downloadOrCreateStrm(url, savePath, { asStrm: false, displayPath: relFile }),
    );
    return "download";
  }

  return "skip";
}

const MAX_WALK_ENTRIES = 20_000;

/**
 * 展开一个新增目录：递归列目录，为其中每个文件生成 strm / 下载媒体信息，
 * 同时把途中遇到的每个子目录写进 path_cache（后续该目录下的事件就不用打接口了）。
 */
async function materializeFolder(
  ctx: LifeContext,
  match: TaskMatch,
  folderCid: string,
  folderPanPath: string,
): Promise<{ strm: number; download: number }> {
  const counters = { strm: 0, download: 0 };
  const queue: Array<{ cid: string; panPath: string }> = [
    { cid: folderCid, panPath: folderPanPath },
  ];
  let visited = 0;

  while (queue.length > 0) {
    if (ctx.signal?.aborted) break;
    const cur = queue.shift()!;
    let offset = 0;
    for (;;) {
      if (ctx.signal?.aborted) break;
      const { entries, total } = await listDir(ctx.accountInfo, cur.cid, offset, 1000);
      if (entries.length === 0) break;

      const cacheRows = entries.map((e) => ({
        fileId: e.fileId,
        parentId: e.parentId,
        name: e.name,
        path: joinPanPath(cur.panPath, e.name),
        isDir: e.isDir,
        accountName: ctx.accountInfo.name,
      }));
      rememberPaths(cacheRows);

      for (const e of entries) {
        visited++;
        if (visited > MAX_WALK_ENTRIES) {
          ctx.log("warn", `目录 ${folderPanPath} 条目超过 ${MAX_WALK_ENTRIES}，停止展开`);
          return counters;
        }
        const childPan = joinPanPath(cur.panPath, e.name);
        if (e.isDir) {
          queue.push({ cid: e.fileId, panPath: childPan });
          continue;
        }
        const childMatch = matchTask(ctx, childPan);
        if (!childMatch) continue;
        try {
          const kind = await materializeFile(
            ctx,
            childMatch,
            childMatch.relPath,
            childPan,
            e.pickCode,
          );
          if (kind === "strm") counters.strm++;
          else if (kind === "download") counters.download++;
        } catch (err) {
          ctx.log("error", `生成失败 ${childPan}: ${err instanceof Error ? err.message : err}`);
        }
      }

      offset += entries.length;
      if (offset >= total) break;
    }
  }

  return counters;
}

/**
 * 目录被移动/改名后，其下所有 strm 里写的还是旧网盘路径。
 * strm 内容形如 `${strmPrefix}/${panPath}`（可能整体 encodeURI 过），
 * encodeURI 不转义 `/`，所以直接做前缀替换在两种情况下都成立。
 */
function rewriteStrmPrefixUnder(
  dir: string,
  oldPrefix: string,
  newPrefix: string,
  encoded: boolean,
): number {
  const from = encoded ? encodeURI(oldPrefix) : oldPrefix;
  const to = encoded ? encodeURI(newPrefix) : newPrefix;
  if (from === to) return 0;
  let n = 0;
  const walk = (cur: string) => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(cur, it.name);
      if (it.isDirectory()) {
        walk(full);
        continue;
      }
      if (!it.name.endsWith(".strm")) continue;
      try {
        const content = fs.readFileSync(full, "utf8");
        if (!content.startsWith(from)) continue;
        fs.writeFileSync(full, to + content.slice(from.length), "utf8");
        n++;
      } catch {
        /* 单个文件失败不影响其余 */
      }
    }
  };
  walk(dir);
  return n;
}

/* ------------------------------- 事件处理 ------------------------------- */

/** 新增（上传 / 接收 / 复制）：1,2,14,18,23 */
export async function handleCreate(ctx: LifeContext, ev: LifeEvent): Promise<HandleResult> {
  if (!ctx.eventModes.has("create")) return skipped("create 模式未开启");

  const dir = await resolveDirPath(ctx.accountInfo, String(ev.parent_id));
  if (!dir) return skipped(`父目录 ${ev.parent_id} 无法解析`);

  const panPath = joinPanPath(dir, ev.file_name);
  const isDir = Number(ev.file_category) === 0;

  rememberPath({
    fileId: String(ev.file_id),
    parentId: String(ev.parent_id),
    name: ev.file_name,
    path: panPath,
    isDir,
    accountName: ctx.accountInfo.name,
  });

  const match = matchTask(ctx, panPath);
  if (!match) return skipped(`${panPath} 不在任何任务的 originPath 下`);

  if (isDir) {
    const c = await materializeFolder(ctx, match, String(ev.file_id), panPath);
    return done(`目录 ${panPath} → strm ${c.strm} / 下载 ${c.download}`, c.strm + c.download > 0);
  }

  const kind = await materializeFile(ctx, match, match.relPath, panPath, ev.pick_code);
  if (kind === "skip") return skipped(`${panPath} 扩展名不在 strm/下载白名单`);
  return done(`${kind}: ${panPath}`);
}

/** 新建目录：17。只补缓存，不生成任何本地文件 */
export async function handleNewFolder(ctx: LifeContext, ev: LifeEvent): Promise<HandleResult> {
  const dir = await resolveDirPath(ctx.accountInfo, String(ev.parent_id));
  if (!dir) return skipped(`父目录 ${ev.parent_id} 无法解析`);
  const panPath = joinPanPath(dir, ev.file_name);
  rememberPath({
    fileId: String(ev.file_id),
    parentId: String(ev.parent_id),
    name: ev.file_name,
    path: panPath,
    isDir: true,
    accountName: ctx.accountInfo.name,
  });
  return done(`记录目录 ${panPath}`, false);
}

/** 删除：22 */
export async function handleRemove(ctx: LifeContext, ev: LifeEvent): Promise<HandleResult> {
  if (!ctx.eventModes.has("remove")) return skipped("remove 模式未开启");

  const isDir = Number(ev.file_category) === 0;
  let panPath = lookupCachedPath(ctx.accountInfo.name, String(ev.file_id));
  let via = "缓存";

  if (!panPath) {
    // 缓存里没有就用 parent_id 反推。为防误删，只有反推出的本地路径确实存在时才动手。
    const dir = await resolveDirPath(ctx.accountInfo, String(ev.parent_id));
    if (!dir) return skipped(`无法确定 ${ev.file_name} 的路径，跳过删除`);
    panPath = joinPanPath(dir, ev.file_name);
    via = "parent_id 反推";
  }

  const match = matchTask(ctx, panPath);
  if (!match) return skipped(`${panPath} 不在任何任务的 originPath 下`);
  if (match.relPath === "") {
    ctx.log("warn", `${panPath} 是任务 ${match.task.id} 的 originPath 本身，拒绝整目录删除`);
    return skipped("命中任务根目录，不做删除");
  }

  const target = isDir
    ? path.join(match.saveDir, match.relPath)
    : localPathFor(match, ctx, match.relPath);

  if (!target) return skipped(`${panPath} 扩展名不在白名单，无需删除`);
  if (!fs.existsSync(target)) {
    dropSubtree(panPath);
    return skipped(`本地不存在 ${target}（${via}）`);
  }

  if (isDir) fs.rmSync(target, { recursive: true, force: true });
  else fs.unlinkSync(target);
  removeEmptyParents(path.dirname(target), match.saveDir);
  dropSubtree(panPath);

  return done(`删除 ${target}（${via}）`);
}

/**
 * 移动：5,6。新路径来自 parent_id + file_name，旧路径只能来自 path_cache。
 * 旧路径未知时退化成「按新增处理」，本地可能残留一份旧 strm，
 * 由全量任务的 removeExtraFiles 兜底清理。
 */
export async function handleMove(ctx: LifeContext, ev: LifeEvent): Promise<HandleResult> {
  if (!ctx.eventModes.has("move")) return skipped("move 模式未开启");
  return relocate(ctx, ev, "移动");
}

/** 改名：20,24。与移动同构，区别只在父目录不变 */
export async function handleRename(ctx: LifeContext, ev: LifeEvent): Promise<HandleResult> {
  if (!ctx.eventModes.has("rename")) return skipped("rename 模式未开启");
  return relocate(ctx, ev, "改名");
}

async function relocate(ctx: LifeContext, ev: LifeEvent, label: string): Promise<HandleResult> {
  const isDir = Number(ev.file_category) === 0;
  const oldPan = lookupCachedPath(ctx.accountInfo.name, String(ev.file_id));

  const dir = await resolveDirPath(ctx.accountInfo, String(ev.parent_id));
  if (!dir) return skipped(`父目录 ${ev.parent_id} 无法解析`);
  const newPan = joinPanPath(dir, ev.file_name);

  const newEntry = {
    fileId: String(ev.file_id),
    parentId: String(ev.parent_id),
    name: ev.file_name,
    path: newPan,
    isDir,
    accountName: ctx.accountInfo.name,
  };

  if (!oldPan || oldPan === newPan) {
    rememberPath(newEntry);
    ctx.log(
      "debug",
      `${label}事件旧路径未知（${ev.file_name}），按新增处理；旧文件由全量任务兜底清理`,
    );
    return handleCreate({ ...ctx, eventModes: new Set([...ctx.eventModes, "create"]) }, ev);
  }

  const oldMatch = matchTask(ctx, oldPan);
  const newMatch = matchTask(ctx, newPan);

  // 缓存先更新：无论本地怎么处理，网盘侧的事实已经变了
  rememberPath(newEntry);
  if (isDir) repathSubtree(oldPan, newPan);

  // 移出监控范围 → 删本地
  if (oldMatch && !newMatch) {
    const target = isDir
      ? path.join(oldMatch.saveDir, oldMatch.relPath)
      : localPathFor(oldMatch, ctx, oldMatch.relPath);
    if (target && fs.existsSync(target)) {
      if (isDir) fs.rmSync(target, { recursive: true, force: true });
      else fs.unlinkSync(target);
      removeEmptyParents(path.dirname(target), oldMatch.saveDir);
      return done(`${label}出监控范围，已删除 ${target}`);
    }
    return skipped(`${label}出监控范围，本地无对应文件`);
  }

  // 移入监控范围 → 当作新增
  if (!oldMatch && newMatch) {
    return handleCreate({ ...ctx, eventModes: new Set([...ctx.eventModes, "create"]) }, ev);
  }

  if (!oldMatch || !newMatch) return skipped(`${oldPan} → ${newPan} 均不在监控范围`);

  // 范围内挪动 → 直接移动本地文件，省掉一次重新生成
  const from = isDir
    ? path.join(oldMatch.saveDir, oldMatch.relPath)
    : localPathFor(oldMatch, ctx, oldMatch.relPath);
  const to = isDir
    ? path.join(newMatch.saveDir, newMatch.relPath)
    : localPathFor(newMatch, ctx, newMatch.relPath);

  if (!from || !to) return skipped(`${newPan} 扩展名不在白名单`);

  if (!fs.existsSync(from)) {
    // 本地本来就没有，退化成新增
    return handleCreate({ ...ctx, eventModes: new Set([...ctx.eventModes, "create"]) }, ev);
  }

  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  removeEmptyParents(path.dirname(from), oldMatch.saveDir);

  // strm 内容里写的是网盘绝对路径，挪了位置就要重写
  if (!isDir && to.endsWith(".strm")) {
    await firstValueFrom(
      downloadOrCreateStrm(
        strmUrlFor(newMatch.task, newMatch.relPath),
        path.join(newMatch.saveDir, newMatch.relPath),
        {
          asStrm: true,
          displayPath: newMatch.relPath,
          strmPrefix: newMatch.task.strmPrefix,
          enablePathEncoding: newMatch.task.enablePathEncoding,
        },
      ),
    );
  } else if (isDir) {
    const rewritten = rewriteStrmPrefixUnder(
      to,
      strmContentPrefix(oldMatch.task, oldMatch.relPath),
      strmContentPrefix(newMatch.task, newMatch.relPath),
      !!newMatch.task.enablePathEncoding,
    );
    ctx.log("info", `${label}目录后重写了 ${rewritten} 个 strm 的网盘路径`);
  }

  return done(`${label} ${from} → ${to}`);
}
