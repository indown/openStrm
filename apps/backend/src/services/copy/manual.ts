/**
 * 手动发起「复制到 OpenList」：把任务网盘目录里已经有的目录 / 文件交给复制队列。
 * 界面的「新建复制」（云下载页、strm 管理页）、智能体的 copy_add、REST 的 POST /api/copy 都走这里。
 *
 * 转存 / 追更 / 云下载 / 监控是在文件落进来那一刻登记的；这里是事后补：转存时没勾复制、后来才开了复制、看片卡顿想把某部片放到本地磁盘。
 *
 * 和自动登记的几处不同：
 *   - 先到网盘核对每条路径在不在（顺手拿节点 id，复制完删源 / 归档要按它核对）；
 *   - **补齐**：源是目录、OpenList 目标里已经有同名目录时，整目录登记会被「目标里已有」跳过、什么都不复制，
 *     所以改成和目标逐层比对，只把缺的文件 / 子目录登记进去（只比名字，和队列一致）；
 *   - 任务正在整理时拒：整理会改名挪目录，这时登记的复制不是复制成整理前的样子，就是复制到一半源被挪走。
 * 复制成功后源文件的去向默认跟任务设置，调用方可以按次指定（删除要更高的权限，由调用方把关）。
 */
import type { CopyAfterCopy, TaskDefinition } from "@openstrm/shared";
import { listRunsByStatus } from "../../db/repositories/organize.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";
import { moduleLogger } from "../../lib/logger.js";
import { providerForTask } from "../drive/registry.js";
import type { DriveProvider, SubtreeEntry } from "../drive/types.js";
import { autoOrganizeBusy } from "../organize/auto.js";
import { normalizeSubPath } from "../strm/naming.js";
import { baseName, copyBlockerFor, copyDstProblem, copyOptionsFor, dstDirFor, joinPath, normConfigDir, normDir, resolveCopyConfig, type CopyConfig } from "./paths.js";
import { enqueueCopy, listOpenlistNames, withAfterCopy, type CopyOutcome, type CopySource } from "./service.js";

const log = moduleLogger("copy-manual");

/** 一次最多交多少条路径 */
export const MANUAL_PATHS_MAX = 50;
/** 补齐时源子树最多这么多文件、最多列这么多个目标目录，超了让人缩小范围 */
export const FILL_FILES_MAX = 5000;
export const FILL_DIRS_MAX = 200;

/**
 * 一条路径的结果：
 *   queued    整条登记了
 *   filled    目标里已经有同名目录，只补了缺的（queued 是补了几条）
 *   complete  目标里已经有同名目录，里面一样都不缺，没登记
 *   exists    目标里已经有同名文件，没登记
 *   duplicate 已经在队列里，或刚复制过
 *   missing   网盘上没有这条路径
 */
export type ManualItemOutcome = "queued" | "filled" | "complete" | "exists" | "duplicate" | "missing";

export interface ManualCopyItem {
  /** 相对任务网盘目录 */
  path: string;
  outcome: ManualItemOutcome;
  /** 这条路径登记了几条记录 */
  queued: number;
  isDir?: boolean;
}

export interface ManualCopyResult extends CopyOutcome {
  items: ManualCopyItem[];
}

export interface ManualCopyInput {
  task: TaskDefinition;
  /** 相对任务网盘目录的路径，至少一段 */
  paths: string[];
  /** 这次复制到哪（OpenList 完整路径）；不给用任务上 / 设置页的目标目录 */
  dstDir?: string;
  /** 复制成功后源文件的去向；不给按任务设置（任务没开复制的按「不动」） */
  afterCopy?: CopyAfterCopy;
  signal?: AbortSignal;
}

const http = (status: number, message: string, code: string, extra: Record<string, unknown> = {}) => new HttpError(status, message, { code, ...extra });

export async function enqueueManualCopy(input: ManualCopyInput): Promise<ManualCopyResult> {
  const { task, signal } = input;
  const settings = readAppSettings();
  const blocked = copyBlockerFor(settings)(task);
  if (blocked) throw http(400, `没法复制到 OpenList：${blocked}`, "COPY_NOT_READY");
  const dst = normConfigDir(input.dstDir);
  if (input.dstDir !== undefined && input.dstDir.trim() !== "" && !dst) throw http(400, "dstDir 不是一个有效的路径", "VALIDATION");
  if (dst) {
    const why = copyDstProblem(dst, task, settings);
    if (why) throw http(400, why, "COPY_DST_INVALID");
  }
  const rels = uniquePaths(input.paths);
  // 整理正在动这个任务的目录：登记的复制要么复制成整理前的样子，要么复制到一半源被挪走。压着等整理的那套只放整理开始之前登记的，这里直说更清楚
  const organizing = listRunsByStatus(["planning", "applying", "reverting"]).find((r) => r.taskId === task.id);
  if (organizing || autoOrganizeBusy(task.id)) {
    throw http(409, "这个任务正在整理，整理完再复制", "TASK_ORGANIZING", organizing ? { runId: organizing.id } : {});
  }
  const opts = copyOptionsFor(task, true, settings, dst);
  if (opts.blocked) throw http(400, `没法复制到 OpenList：${opts.blocked}`, "COPY_NOT_READY");
  const afterCopy = input.afterCopy ?? opts.afterCopy;
  const cfg = resolveCopyConfig(settings);
  const base = normConfigDir(opts.dstDir) || cfg.dstDir;
  if (!base) throw http(400, "没有可用的目标目录：设置页的默认目标目录和任务上的都是空的", "COPY_NOT_READY");

  const provider = providerForTask(task);
  const origin = normDir(task.originPath);
  const targets = new TargetListing(cfg);
  const items: ManualCopyItem[] = [];
  let queued = 0;
  let reason: string | undefined;
  for (const rel of rels) {
    signal?.throwIfAborted();
    const abs = joinPath(origin, rel);
    const node = await provider.resolvePath(abs, signal);
    if (!node) {
      items.push({ path: rel, outcome: "missing", queued: 0 });
      continue;
    }
    const { dstDir } = dstDirFor(base, origin, abs);
    const names = await targets.names(dstDir);
    let sources: CopySource[];
    let outcome: ManualItemOutcome;
    if (!names?.includes(baseName(abs))) {
      // 目标里还没有（或列不出来：交给队列按它的规矩办）：整条登记
      sources = [{ path: abs, isDir: node.isDir, nodeId: node.id }];
      outcome = "queued";
    } else if (!node.isDir) {
      items.push({ path: rel, outcome: "exists", queued: 0, isDir: false });
      continue;
    } else {
      sources = await planFill(provider, abs, node.id, joinPath(dstDir, baseName(abs)), targets, signal);
      outcome = sources.length > 0 ? "filled" : "complete";
    }
    let got = 0;
    if (sources.length > 0) {
      const r = enqueueCopy({ account: task.account, sources, rootPath: origin, taskId: task.id, dstDir: opts.dstDir, afterCopy, trigger: "manual" });
      got = r.queued;
      if (r.queued === 0) {
        // 设置在这一步被改坏了（挂载根被删之类）和「都排着了」要分开说：前者整个请求都成不了
        if (!r.duplicates && !r.covered) throw http(400, r.skipped ?? "没排上", "COPY_NOT_READY");
        outcome = "duplicate";
        reason ??= r.skipped ?? undefined;
      }
    }
    queued += got;
    items.push({ path: rel, outcome, queued: got, isDir: node.isDir });
  }
  const summary = items.map((i) => `${i.path}=${i.outcome}${i.queued ? `(${i.queued})` : ""}`).join("，");
  log.info(`手动复制（${task.account}，任务 ${task.originPath}）：${summary}`);
  const stuck = queued === 0 ? (reason ?? explainNothing(items)) : undefined;
  return { queued, dstDir: base, ...withAfterCopy(afterCopy), items, ...(stuck ? { reason: stuck } : {}) };
}

/** 一条都没排上时的原因：按最常见的那种说 */
function explainNothing(items: ManualCopyItem[]): string {
  if (items.every((i) => i.outcome === "missing")) return "网盘上没有这些路径";
  if (items.every((i) => i.outcome === "exists" || i.outcome === "complete")) return "目标里已经都有了";
  if (items.some((i) => i.outcome === "duplicate")) return "这些条目已经在队列里或刚复制过";
  return "没有要复制的条目";
}

/** 归一路径：去掉多余斜杠和空段，不许 `..`，不许任务目录本身（整目录复制会摆成 dst/tv，层级不对），去重 */
function uniquePaths(paths: string[]): string[] {
  if (paths.length === 0) throw http(400, "paths 不能为空", "VALIDATION");
  if (paths.length > MANUAL_PATHS_MAX) throw http(400, `一次最多 ${MANUAL_PATHS_MAX} 条路径`, "VALIDATION");
  const out: string[] = [];
  for (const raw of paths) {
    const rel = normalizeSubPath(raw);
    if (!rel) throw http(400, "路径不能是任务目录本身：要整个任务都复制，把它下面的条目选上", "VALIDATION");
    if (rel.split("/").some((s) => s === "..")) throw http(400, `路径里不能有「..」：${raw}`, "VALIDATION");
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

/** OpenList 目标目录的一层条目名，同一次请求里每个目录只列一次；列不出来（目录还没有、连不上）记成 null */
class TargetListing {
  private readonly cache = new Map<string, string[] | null>();
  private calls = 0;
  constructor(private readonly cfg: CopyConfig) {}
  async names(dir: string): Promise<string[] | null> {
    const key = normDir(dir);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    if (++this.calls > FILL_DIRS_MAX) throw http(400, `目标里要比对的目录超过 ${FILL_DIRS_MAX} 个，请缩小范围（少选几个目录）`, "TOO_LARGE");
    let names: string[] | null;
    try {
      names = await listOpenlistNames(this.cfg, key);
    } catch (err) {
      log.debug({ err, dir: key }, "列 OpenList 目标目录失败，当它还没有");
      names = null;
    }
    this.cache.set(key, names);
    return names;
  }
}

/**
 * 目标里已经有同名目录：和源子树逐层比对，目标里缺的文件按文件登记、缺的子目录整目录登记（只比名字）。
 * 有 walkSubtree 的网盘（夸克 / OpenList）一次拿到整棵带 id；115 只有文件路径，目录从路径里推，节点 id 到提交时再钉
 */
async function planFill(provider: DriveProvider, abs: string, id: string, olDir: string, targets: TargetListing, signal: AbortSignal | undefined): Promise<CopySource[]> {
  const entries = await sourceTree(provider, abs, id, signal);
  const files = entries.filter((e) => !e.isDir).length;
  if (files > FILL_FILES_MAX) throw http(400, `「${baseName(abs)}」里有 ${files} 个文件，超过一次补齐的上限 ${FILL_FILES_MAX}，请缩小范围`, "TOO_LARGE");
  /** 目录（相对 abs，"" 是根）→ 直接子项 */
  const children = new Map<string, SubtreeEntry[]>();
  for (const e of entries) {
    const dir = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "";
    const list = children.get(dir) ?? [];
    list.push(e);
    children.set(dir, list);
  }
  const out: CopySource[] = [];
  const walk = async (relDir: string, dir: string): Promise<void> => {
    signal?.throwIfAborted();
    const names = (await targets.names(dir)) ?? [];
    for (const e of children.get(relDir) ?? []) {
      const name = baseName(e.path);
      if (!names.includes(name)) {
        out.push({ path: joinPath(abs, e.path), isDir: e.isDir, ...(e.id ? { nodeId: e.id } : {}) });
      } else if (e.isDir) {
        await walk(e.path, joinPath(dir, name));
      }
    }
  };
  await walk("", olDir);
  return out;
}

/** 源目录整棵：每个节点相对 abs 的路径、是不是目录、节点 id（115 的目录树导出没有 id） */
async function sourceTree(provider: DriveProvider, abs: string, id: string, signal: AbortSignal | undefined): Promise<SubtreeEntry[]> {
  if (provider.walkSubtree) return provider.walkSubtree(abs, { id, signal });
  const paths = await provider.listSubtree(abs, { id, signal });
  const seen = new Map<string, SubtreeEntry>();
  for (const p of paths) {
    const segs = p.split("/").filter(Boolean);
    // 中间每一级都是目录；最后一段：没有扩展名且不含点的当目录（115 导出树里空目录就是这样）
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join("/");
      if (!seen.has(dir)) seen.set(dir, { path: dir, id: "", isDir: true });
    }
    const rel = segs.join("/");
    if (rel && !seen.has(rel)) seen.set(rel, { path: rel, id: "", isDir: !/\.[A-Za-z0-9]{1,10}$/.test(segs[segs.length - 1] ?? "") });
  }
  return [...seen.values()];
}
