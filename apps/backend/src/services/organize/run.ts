/**
 * 整理的编排层，路由只调这里。
 *
 *   createRun   建 run → 后台：列范围 → 分单元 → 识别（TMDB）→ 规划 → 落库，状态 ready
 *   patchUnit   预览里换匹配 / 改季 / 集偏移 / 勾选：重新规划这个单元，冲突检测整体重算
 *   applyRun    后台按顺序执行：补本地镜像 → mkdir → 改名 → 移动 → 本地镜像 → 逐条记账 → 删空目录 → 收尾；
 *               再执行只重试失败 / 没做的（临时失败默认重试，stale / rejected 要点名 ids）
 *   skipItems   把失败项标成「已放弃」让 run 收口（原地改了名的先改回原名）
 *   revertRun   按流水账逆序退回；开始撤销之后 run.stage = revert，只能继续撤销
 *
 * 失败分类见 failures.ts。项的状态只描述文件在哪（pending / failed 在原处或 curPath，done 在整理后的位置或 curPath，
 * reverted 在原处，failed + stale 是找不到了），失败原因和类别在 error / errorKind 里。
 * 进行中的 run 在内存里有一个 job（中止信号 + 进度 + 日志），进程重启后 applying / planning / reverting 的 run 标成 failed，
 * 可以再 apply / revert（做完的项跳过，剩下的接着来）。
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  AppSettings,
  OrganizeAttention,
  OrganizeAttentionReason,
  OrganizeCandidate,
  OrganizeConfidence,
  OrganizeConflictResolution,
  OrganizeItem,
  OrganizeMatch,
  OrganizeMediaType,
  OrganizeProgress,
  OrganizeRun,
  OrganizeFailureGroup,
  OrganizeFailureGroupKey,
  OrganizeRunDetail,
  OrganizeRunSummary,
  OrganizeUnitCounts,
  OrganizeRunMode,
  OrganizeRunStage,
  OrganizeRunStats,
  OrganizeSkipResult,
  OrganizeTrigger,
  OrganizeUnit,
  OrganizeUnitPatch,
  TaskDefinition,
} from "@openstrm/shared";
import { getAll as listLibraryEntries } from "../../db/repositories/media-library.js";
import {
  bumpAttempts,
  changedSince,
  deleteRun as deleteRunRow,
  emptyStats,
  getRun,
  getUnit,
  insertRun,
  laterRunTouching,
  listItems,
  listLeftoverDirs,
  listRuns as listRunRows,
  listRunsByStatus,
  listUnits,
  recallMatch,
  rememberMatch,
  repathMatches,
  replaceItems,
  replaceUnits,
  updateItem,
  updateItems,
  updateRun,
  updateUnit,
  type NewItem,
} from "../../db/repositories/organize.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { getTask, listTasks } from "../../db/repositories/tasks.js";
import { isAbortError } from "../../lib/errors.js";
import { HttpError, upstreamError } from "../../lib/http-error.js";
import { moduleLogger } from "../../lib/logger.js";
import { resolveInDataDir } from "../../paths.js";
import { driveErrorToHttp } from "../drive/errors.js";
import { providerForTask } from "../drive/registry.js";
import { normalizePath, splitPath, type DriveNode, type DriveProvider, type WriteNode } from "../drive/types.js";
import { rewriteFollowSubPaths } from "../follow/service.js";
import { scheduleEmbyRefresh } from "../media-server.js";
import { rewriteOfflineSubPaths } from "../offline/service.js";
import { releaseCopyHolds, rewriteCopyPaths, type CopyMove } from "../copy/queue.js";
import { dstDirFor } from "../copy/paths.js";

/** 整理挪完之后，复制待办的目标目录按新路径重算（层级跟着源走） */
const copyLayout = (base: string, rootPath: string | undefined, srcPath: string): string => dstDirFor(base, rootPath, srcPath).dstDir;
import type { TmdbDetails, TmdbSearchResult } from "../tmdb.js";
import { extSet } from "../strm/naming.js";
import { notify } from "../telegram/notify.js";
import { describeFileFailure } from "../download/failure.js";
import { classifyFailure, FAILURE_LABEL, messageOf, OrganizeFailure, retryableItem, revertPendingItem, revertWorkItem, StaleError } from "./failures.js";
import { idTagFromName, identifyUnit, TmdbClient, type IdEvidence, type KnownId, type TmdbApi } from "./identify.js";
import { mirrorDelete, mirrorRelocate, mirrorRmdir } from "./mirror.js";
import { nfoEvidence } from "./nfo.js";
import { duplicatePathFor, underDuplicates } from "./duplicates.js";
import { finalizeItems, planUnit, type PlannedItem, type ScopeRoot, type UnitPlan } from "./plan.js";
import { parseRules } from "./rules.js";
import { resolveOrganizeSettings, type ResolvedOrganizeSettings } from "./settings.js";
import { looksLikeReleaseDir } from "./parse-name.js";
import { AUDIO_EXTS, buildUnits, type ScopeEntry, type Unit } from "./units.js";

const log = moduleLogger("organize");

export const ORGANIZE_LIMITS = {
  /** 一次 run 最多看这么多文件 */
  MAX_FILES: 20_000,
  /** 内存里留的日志行数 */
  LOG_LINES: 300,
} as const;

/* ------------------------------- 依赖注入 ------------------------------- */

interface Deps {
  tmdb: (settings: AppSettings) => TmdbApi | null;
  notify: typeof notify;
  /** 临时失败（网络 / 超时）自动重试前等多久；测试里调短 */
  retryDelayMs: number;
}

const realDeps: Deps = {
  tmdb: (settings) => {
    const key = settings.tmdb?.apiKey?.trim();
    return key ? new TmdbClient(key, settings.tmdb?.language || "zh-CN") : null;
  },
  notify,
  retryDelayMs: 3000,
};
let deps: Deps = { ...realDeps };

/** 仅供测试：换掉 TMDB / 通知 / 重试间隔；传 null 恢复 */
export function setOrganizeDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/* ------------------------------- 内存里的 job ------------------------------- */

interface Job {
  runId: string;
  abort: AbortController;
  progress: OrganizeProgress;
  logs: string[];
  done: Promise<void>;
}

const jobs = new Map<string, Job>();

/**
 * 不是后台 job 的写操作（预览里改单元、放弃失败项）进行中的个数。它们中间要等 TMDB / 列目录 / 改回原名，
 * 这段时间里执行 / 撤销 / 删除要等它们落完库：不然执行拿着旧清单跑，改单元回来把清单整个换掉，执行的记账全落空
 */
const runOps = new Map<string, number>();

function beginOp(runId: string): () => void {
  runOps.set(runId, (runOps.get(runId) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (runOps.get(runId) ?? 1) - 1;
    if (left > 0) runOps.set(runId, left);
    else runOps.delete(runId);
  };
}

function assertNoOps(runId: string): void {
  if (runOps.has(runId)) throw new HttpError(409, "这次整理还有修改在保存，稍等再试");
}

function jobLog(job: Job, msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  job.logs.push(line);
  if (job.logs.length > ORGANIZE_LIMITS.LOG_LINES) job.logs.shift();
  log.info({ runId: job.runId }, msg);
}

function setProgress(job: Job, phase: OrganizeProgress["phase"], done: number, total: number, message: string): void {
  job.progress = { phase, done, total, message };
}

/** 仅供测试：等一个 run 的后台工作结束 */
export async function waitForRun(runId: string): Promise<void> {
  const job = jobs.get(runId);
  if (job) await job.done;
}

export function isRunBusy(runId: string): boolean {
  return jobs.has(runId);
}

/* ------------------------------- 小工具 ------------------------------- */

const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const joinRel = (a: string, b: string): string => (a && b ? `${a}/${b}` : a || b);

/**
 * 相对任务 originPath 的路径 → 网盘绝对路径。只拼、不动每一段的内容：
 * normalizePath 会把每段首尾的空格削掉（`凡人修仙传/Season 1 ` 这种网盘上真实存在的名字），
 * 那样 abs → rel 就回不到原来的路径，按文件勾选 / 冲突处理（都按绝对路径记）会对不上号
 */
function absOf(task: TaskDefinition, rel: string): string {
  const origin = normalizePath(task.originPath);
  return rel ? `${origin === "/" ? "" : origin}/${rel.replace(/^\/+/, "")}` : origin;
}

/** 网盘绝对路径 → 相对任务 originPath；和 absOf 严格互逆（段里的空格照原样留着） */
function relOf(task: TaskDefinition, abs: string): string {
  const origin = normalizePath(task.originPath);
  const p = abs.startsWith("/") ? abs : `/${abs}`;
  if (p === origin) return "";
  return p.startsWith(`${origin === "/" ? "" : origin}/`) ? p.slice(origin === "/" ? 1 : origin.length + 1) : p.replace(/^\//, "");
}

function videoExtsOf(settings: AppSettings): Set<string> {
  const all = extSet(settings.strmExtensions);
  for (const a of AUDIO_EXTS) all.delete(a);
  return all;
}

function computeStats(units: OrganizeUnit[], items: OrganizeItem[], stage: OrganizeRunStage): OrganizeRunStats {
  const stats = emptyStats();
  stats.units = units.length;
  for (const u of units) stats.confidence[u.match?.confidence ?? "none"]++;
  const selectedUnits = new Set(units.filter((u) => u.selected && u.match).map((u) => u.key));
  for (const it of items) {
    if (it.kind !== "dir") stats.items++;
    const active = it.unitKey === "" || selectedUnits.has(it.unitKey);
    if (it.action === "conflict") stats.conflicts++;
    else if (it.action === "skip") stats.skipped++;
    else if (it.action === "keep") stats.keep++;
    else if (active) {
      stats.planned++;
      if (it.action === "mkdir") stats.plannedMkdir++;
      else if (it.action === "rmdir") stats.plannedRmdir++;
      else if (it.action === "delete") stats.plannedDelete++;
    }
    if (it.status === "done") stats.done++;
    if (it.status === "failed") stats.failed++;
    if (it.status === "reverted") stats.reverted++;
    if (it.givenUp) continue;
    // 还没做的：勾选了、会动网盘的 pending 项（中途停下的 run 里就是「没做完」的）
    if (it.status === "pending" && active && WORK_ACTIONS.has(it.action)) stats.pending++;
    // 还等着处理的失败：failed 按各自类别（旧数据没分类的算临时）；done / reverted 带类别的是镜像没跟上或撤销在网盘那步失败
    if (it.status === "failed") stats.failedByKind[it.errorKind || "transient"]++;
    else if ((it.status === "done" || it.status === "reverted") && it.errorKind) stats.failedByKind[it.errorKind]++;
    // 撤销阶段：仍在整理后位置的 done、撤销时发现找不到的 failed（stale，撤销给它记了 finishedAt）都是没退回；
    // 执行时就没成的 failed（没 finishedAt）文件还在原处，不算
    if (stage === "revert" && (it.action === "rename" || it.action === "move") && (it.status === "done" || (it.status === "failed" && it.errorKind === "stale" && it.finishedAt !== null))) stats.notReverted++;
  }
  return stats;
}

/* ------------------------------- 建 run ------------------------------- */

export interface CreateRunInput {
  taskId: string;
  /** 相对任务 originPath 的范围目录 */
  subPath?: string;
  /** 只整理这些路径（相对任务 originPath）；自动触发时用 */
  paths?: string[];
  mode?: OrganizeRunMode;
  trigger?: OrganizeTrigger;
}

export async function createRun(input: CreateRunInput): Promise<OrganizeRun> {
  const task = getTask(input.taskId);
  if (!task) throw new HttpError(404, `Task not found: ${input.taskId}`);
  const provider = providerForTask(task, "write");
  const settings = readAppSettings();
  if (!deps.tmdb(settings)) throw new HttpError(400, "TMDB 未配置 apiKey，请先在设置中填入");
  const rules = parseRules(resolveOrganizeSettings(settings).rules);
  if (rules.errors.length > 0) throw new HttpError(400, `识别词有语法错误：${rules.errors.join("；")}`);
  const scopePath = splitPath(input.subPath ?? "").join("/");
  let scopePaths = [...new Set((input.paths ?? []).map((p) => splitPath(p).join("/")).filter(Boolean))];
  // 范围只能是任务目录之内：`..` 会让本地镜像跑出数据目录
  for (const p of [scopePath, ...scopePaths]) {
    if (splitPath(p).some((seg) => seg === "." || seg === "..")) throw new HttpError(400, `范围路径不合法：${p}`);
  }
  const trigger = input.trigger ?? "manual";
  if (trigger === "manual") {
    // 手动选的多个范围：套在别的范围里面的去掉（已经整个包含了）
    scopePaths = scopePaths.filter((p) => !scopePaths.some((o) => o !== p && p.startsWith(`${o}/`)));
    // 手动的范围要是网盘上真有的目录，不然要等预览失败才知道（自动整理的新增路径不在就跳过，照旧）。
    // 在查重和建 run 之前做：那两步之间不能有 await
    for (const p of scopePaths.length > 0 ? scopePaths : scopePath ? [scopePath] : []) {
      const abs = absOf(task, p);
      let node: DriveNode | null;
      try {
        node = await provider.resolvePath(abs);
      } catch (err) {
        throw driveErrorToHttp(err, "检查范围目录失败");
      }
      if (!node) throw new HttpError(400, `网盘上找不到 ${abs}`);
      if (!node.isDir) throw new HttpError(400, `${abs} 不是目录，范围要选目录`);
    }
  }
  // 同一任务同时只跑一个进行中的 run：两个 run 同时改同一批文件会互相踩
  const busy = listRunsByStatus(["planning", "applying", "reverting"]).find((r) => r.taskId === task.id);
  if (busy) throw new HttpError(409, `任务已有一次整理在进行中（${busy.id}）`, { runId: busy.id });

  const run = insertRun({
    id: randomUUID(),
    taskId: task.id,
    accountName: provider.account.name,
    scopePath,
    scopePaths,
    mode: input.mode ?? "manual",
    trigger,
  });
  startJob(run.id, (job) => preview(job, run.id));
  return getRun(run.id)!;
}

/**
 * onAbort：执行 / 撤销被取消时的收尾。取消多半发生在网盘请求中途、异常从 work 里抛出来，
 * 做完的项照样要进统计、收尾照常；预览没有收尾，取消了直接标 cancelled
 */
function startJob(runId: string, work: (job: Job) => Promise<void>, onAbort?: (job: Job) => void): Job {
  const job: Job = {
    runId,
    abort: new AbortController(),
    progress: { phase: "idle", done: 0, total: 0, message: "" },
    // 接着这次 run 已有的日志往下写：预览 → 执行 → 重试 → 撤销是一本账，后一次别把前一次的冲掉（落库时只留最近 300 行）
    logs: [...(getRun(runId)?.log ?? [])].slice(-ORGANIZE_LIMITS.LOG_LINES),
    done: Promise.resolve(),
  };
  jobs.set(runId, job);
  job.done = work(job)
    .catch((err) => {
      const aborted = isAbortError(err) || job.abort.signal.aborted;
      if (aborted && onAbort) {
        try {
          onAbort(job);
          return;
        } catch (e) {
          log.warn({ err: e, runId }, "取消后的收尾失败，按取消记");
        }
      }
      const msg = aborted ? "已取消" : messageOf(err);
      jobLog(job, `失败：${msg}`);
      const run = getRun(runId);
      if (run && (run.status === "planning" || run.status === "applying" || run.status === "reverting")) {
        updateRun(runId, {
          status: job.abort.signal.aborted ? "cancelled" : "failed",
          error: msg,
          log: job.logs,
          finishedAt: Math.floor(Date.now() / 1000),
        });
      }
      // 整理没办成：等它的复制别再干等兜底时间
      if (run) releaseHeldCopies(run);
    })
    .finally(() => {
      jobs.delete(runId);
    });
  return job;
}

/* ------------------------------- 预览：列 → 分单元 → 识别 → 规划 ------------------------------- */

interface Walked {
  entries: ScopeEntry[];
  files: number;
  /** 整棵列过的目录（相对任务 originPath）：这些目录里的东西全知道，其余目录要用时再列 */
  roots: string[];
}

/**
 * 范围目录本身腾空后删不删：手动把范围指到某个发布目录（`Show.S01.1080p-GROUP`、`片名 (2025)`）时，
 * 里面的东西全挪走后这个空壳没用了，一起删；`inbox`、`电影` 这种收件箱式的范围留着。任务根目录（范围为空）永远不删
 */
const scopeRemovable = (run: OrganizeRun): boolean => run.scopePaths.length === 0 && run.scopePath !== "" && looksLikeReleaseDir(baseOf(run.scopePath));

/** run 的范围写成一组路径（相对任务 originPath）；"" 是整个任务 */
const scopeListOf = (run: OrganizeRun): string[] => (run.scopePaths.length > 0 ? run.scopePaths : [run.scopePath]);

/** inner 的每一条路径都在 outer 的某一条路径之下（整个任务覆盖一切） */
const covers = (outer: string[], inner: string[]): boolean => inner.every((p) => outer.some((o) => o === "" || p === o || p.startsWith(`${o}/`)));

/** 一次预览作废另一次：标已取消、写明原因，内存里的单元结构也丢掉 */
function supersede(old: OrganizeRun, reason: string): void {
  updateRun(old.id, { status: "cancelled", error: reason, finishedAt: Math.floor(Date.now() / 1000) });
  planStates.delete(old.id);
}

/**
 * 预览完成时，把同任务里范围被它覆盖的旧「待执行」预览作废：网盘已经按这次预览的样子来了，
 * 旧的留着只会被误执行；范围不被覆盖的（别的目录）照旧留着
 */
function supersedeCovered(run: OrganizeRun): number {
  const scope = scopeListOf(run);
  let n = 0;
  for (const old of listRunsByStatus(["ready"])) {
    if (old.id === run.id || old.taskId !== run.taskId || !covers(scope, scopeListOf(old))) continue;
    supersede(old, "已被新的预览取代");
    n++;
  }
  return n;
}

/**
 * 启动时收拢堆在一起的「待执行」预览：同一个任务里范围被更新的那次覆盖的，留最新的一条，其余作废。
 * 每次预览完成本来就会这么收（`supersedeCovered`），这里管的是那之前留下的、和进程重启后没法再改的旧预览——
 * 待处理列表里一串「tv · 整个任务」谁也分不清，还都是按旧网盘状态算的
 */
export function collapseStaleReadyRuns(): number {
  // createdAt 只到秒，同一秒建的按落库顺序算新旧（后进的更新）
  const ready = listRunsByStatus(["ready"])
    .map((run, i) => ({ run, i }))
    .sort((a, b) => b.run.createdAt - a.run.createdAt || b.i - a.i)
    .map((x) => x.run);
  const kept: OrganizeRun[] = [];
  let n = 0;
  for (const run of ready) {
    const newer = kept.find((k) => k.taskId === run.taskId && covers(scopeListOf(k), scopeListOf(run)));
    if (!newer) {
      kept.push(run);
      continue;
    }
    supersede(run, "已被同范围更新的预览取代");
    n++;
  }
  return n;
}

/**
 * 分单元时的范围：单一范围照旧；手动选的多个范围各按单一范围的规则来（见 buildUnits 的 scopes）；
 * 自动触发的新增路径按任务根分单元（新落进来的发布目录名字可靠，按目录名认）
 */
const unitScopesOf = (run: OrganizeRun): string[] => (run.scopePaths.length === 0 ? [run.scopePath] : run.trigger === "manual" ? run.scopePaths : [""]);

/**
 * 删空目录的边界：只删范围里面腾空的目录。范围本身：单一范围 / 手动选的多个范围按「像发布目录 / 季目录」判断；
 * 自动触发的新增路径是目录的，它本来就是新落进来的，腾空了可删，但它的上级（转存落点 inbox 这种）不碰；是文件的不删任何目录
 */
function scopeRootsOf(run: OrganizeRun, walkedDirs: string[]): ScopeRoot[] {
  if (run.scopePaths.length === 0) return [{ path: run.scopePath, removable: scopeRemovable(run) }];
  if (run.trigger === "manual") return walkedDirs.map((p) => ({ path: p, removable: p !== "" && looksLikeReleaseDir(baseOf(p)) }));
  return walkedDirs.map((p) => ({ path: p, removable: p !== "" }));
}

/** 单元里单独取消勾选的文件（网盘绝对路径）换成规划用的相对路径 */
const excludedRel = (task: TaskDefinition, unit: OrganizeUnit): Set<string> => new Set(unit.excluded.map((p) => relOf(task, p)));
/** 单元上按网盘绝对路径记的冲突处理 → 相对任务 originPath（规划用的路径） */
const resolutionsRel = (task: TaskDefinition, unit: OrganizeUnit): Map<string, OrganizeConflictResolution> =>
  new Map(Object.entries(unit.resolutions ?? {}).map(([p, r]) => [relOf(task, p), r]));

/** 本地镜像只看同一账号的任务：不同网盘上同名的目录（都叫 tv）各有各的本地目录，按路径匹配会串到别的账号的任务上 */
const accountTasks = (accountName: string): TaskDefinition[] => listTasks().filter((t) => t.account === accountName);

/** 列范围：有 walkSubtree 的（夸克 / OpenList）带 id，115 只有路径，id 到执行时再解析 */
async function walkScope(provider: DriveProvider, task: TaskDefinition, run: OrganizeRun, signal: AbortSignal): Promise<Walked> {
  const entries: ScopeEntry[] = [];
  const seen = new Set<string>();
  const roots: string[] = [];
  const push = (e: ScopeEntry) => {
    if (seen.has(e.path)) return;
    seen.add(e.path);
    entries.push(e);
  };
  const walkDir = async (rel: string, id?: string) => {
    const abs = absOf(task, rel);
    roots.push(rel);
    if (provider.walkSubtree) {
      for (const e of await provider.walkSubtree(abs, { id, signal })) push({ path: joinRel(rel, e.path), isDir: e.isDir, id: e.id, size: e.size });
    } else {
      for (const p of await provider.listSubtree(abs, { id, signal })) {
        // listSubtree 给的是文件 + 顶层空目录；没有扩展名且不含点的当目录（115 导出树里空目录就是这样）
        const isDir = !/\.[A-Za-z0-9]{1,10}$/.test(baseOf(p));
        push({ path: joinRel(rel, p), isDir });
      }
    }
  };
  if (run.scopePaths.length === 0) {
    await walkDir(run.scopePath);
  } else {
    for (const rel of run.scopePaths) {
      const node = await provider.resolvePath(absOf(task, rel), signal);
      if (!node) continue;
      if (node.isDir) await walkDir(rel, node.id);
      else push({ path: rel, isDir: false, id: node.id });
    }
  }
  const files = entries.filter((e) => !e.isDir).length;
  if (files > ORGANIZE_LIMITS.MAX_FILES) throw new Error(`范围里有 ${files} 个文件，超过一次整理的上限 ${ORGANIZE_LIMITS.MAX_FILES}，请缩小范围`);
  return { entries, files, roots };
}

/** 影库条目：转存自影库的目录名和条目的 rawName 一致 */
function libraryEvidence(unit: Unit, entries: ReturnType<typeof listLibraryEntries>): KnownId | null {
  if (!unit.rootPath) return null;
  const name = baseOf(unit.rootPath);
  const hit = entries.find((e) => e.tmdbId && (e.mediaType === "movie" || e.mediaType === "tv") && (e.rawName === name || e.title === name));
  return hit ? { tmdbId: hit.tmdbId!, mediaType: hit.mediaType as OrganizeMediaType, source: "影库条目" } : null;
}

/** 范围之外的目标目录里现有的条目（连目录本身一起），给冲突检测和 mkdir 判断用 */
async function listOutsideDstDirs(
  provider: DriveProvider,
  task: TaskDefinition,
  roots: string[],
  plans: UnitPlan[],
  entries: ScopeEntry[],
  signal: AbortSignal,
  /** 已经去网盘看过的目录（在的列过了、不在的也记着）：同一次预览里重规划时不再重复列；会被这次调用补上 */
  listed: Set<string> = new Set(),
): Promise<ScopeEntry[]> {
  const inScope = (rel: string) => roots.some((r) => r === "" || rel === r || rel.startsWith(`${r}/`));
  const dirs = new Set<string>();
  for (const p of plans) {
    for (const it of p.items) {
      if ((it.action === "rename" || it.action === "move") && !inScope(dirOf(it.dstPath))) dirs.add(dirOf(it.dstPath));
      // 用户选了挪进重复文件目录：那边现在有什么也得知道（撞名了往后排 (2)）
      if (it.resolve === "duplicate" && !inScope(dirOf(duplicatePathFor(it.srcPath)))) dirs.add(dirOf(duplicatePathFor(it.srcPath)));
    }
  }
  // 只列最深的那些目录：它存在就顺便说明祖先都存在；不存在就往上找到第一个存在的祖先列出来
  const known = new Set(entries.map((e) => e.path));
  const out: ScopeEntry[] = [];
  for (const dir of [...dirs].sort()) {
    let cur = dir;
    while (cur && !inScope(cur) && !listed.has(cur)) {
      signal.throwIfAborted();
      const node = await provider.resolvePath(absOf(task, cur), signal);
      if (node?.isDir) {
        if (!known.has(cur)) out.push({ path: cur, isDir: true, id: node.id });
        for (const e of await provider.listDir(node.id, signal)) {
          const p = joinRel(cur, e.name);
          if (!known.has(p)) {
            known.add(p);
            out.push({ path: p, isDir: e.isDir, id: e.id, size: e.size });
          }
        }
        listed.add(cur);
        break;
      }
      // 不在的也记着：它下面的目录更不会在，下次到这里就停
      listed.add(cur);
      cur = dirOf(cur);
    }
  }
  return out;
}

interface PlanState {
  task: TaskDefinition;
  settings: AppSettings;
  org: ResolvedOrganizeSettings;
  entries: ScopeEntry[];
  roots: string[];
  units: Map<string, Unit>;
  episodeTitles: Map<string, Map<string, string>>;
  /** 识别阶段留给单元的提示（nfo 证据没采用之类）：重新规划时和规划的提示拼在一起；手动换了匹配就清掉 */
  identifyNotes: Map<string, string[]>;
  /** 删空目录的边界（见 finalizeItems 的 scopeRoots） */
  scopeRoots: ScopeRoot[];
  /** 这次预览已经去网盘看过的范围外目录（在的列过了、不在的也记着）：重规划时不再重复列 */
  listed: Set<string>;
}

const planContext = (state: PlanState) => ({ settings: state.org, libraryType: state.task.organize?.libraryType });

/** 把新列到的条目并进本轮已知的条目（按路径去重） */
function mergeEntries(state: PlanState, extra: ScopeEntry[]): void {
  if (extra.length === 0) return;
  const known = new Set(state.entries.map((e) => e.path));
  const fresh = extra.filter((e) => !known.has(e.path));
  if (fresh.length > 0) state.entries = [...state.entries, ...fresh];
}

/** 内存里的 run 状态：单元结构（Unit）不落库，改匹配重新规划时要用；进程重启后 run 只能看和执行，不能再改 */
const planStates = new Map<string, PlanState>();

function toUnitRow(runId: string, unit: Unit, match: OrganizeMatch | null, plan: UnitPlan | null, referencedBy: number): OrganizeUnit {
  return {
    runId,
    key: unit.key,
    rootPath: unit.rootPath,
    rawName: unit.rawName,
    parsedTitle: unit.parsed.title,
    parsedYear: unit.parsed.year ?? "",
    match,
    seasonOverride: null,
    episodeOffset: 0,
    dstRoot: plan?.dstRoot ?? "",
    selected: !!match,
    remember: false,
    fileCount: unit.files.length,
    videoCount: unit.files.filter((f) => f.kind === "video").length,
    referencedBy,
    notes: plan?.notes ?? [],
    excluded: [],
    resolutions: {},
  };
}

function toItemRows(task: TaskDefinition, items: PlannedItem[]): NewItem[] {
  return items.map((it, seq) => ({
    id: randomUUID(),
    unitKey: it.unitKey,
    seq,
    kind: it.kind,
    action: it.action,
    srcPath: absOf(task, it.srcPath),
    dstPath: absOf(task, it.dstPath),
    nodeId: it.nodeId,
    reason: it.reason,
  }));
}

/** 追更 / 云下载回执里有多少条落在这个目录下 */
function referencesTo(refPaths: string[], rootRel: string): number {
  if (!rootRel) return 0;
  return refPaths.filter((p) => p === rootRel || p.startsWith(`${rootRel}/`)).length;
}

async function preview(job: Job, runId: string): Promise<void> {
  const run = getRun(runId)!;
  const task = getTask(run.taskId);
  if (!task) throw new Error("任务已不存在");
  const provider = providerForTask(task, "write");
  const settings = readAppSettings();
  const org = resolveOrganizeSettings(settings);
  const tmdb = deps.tmdb(settings);
  if (!tmdb) throw new Error("TMDB 未配置 apiKey");
  const signal = job.abort.signal;
  updateRun(runId, { startedAt: Math.floor(Date.now() / 1000) });

  setProgress(job, "walk", 0, 0, "正在列网盘目录");
  // 手动选的多个目录列出来（和页面「N 个目录」一个说法）；自动触发的新增路径可能几十条，只报个数
  const scopeNote = run.scopePaths.length === 0 ? "" : run.trigger === "manual" ? `（${run.scopePaths.length} 个目录：${run.scopePaths.slice(0, 5).join("、")}${run.scopePaths.length > 5 ? " 等" : ""}）` : `（${run.scopePaths.length} 个新增路径）`;
  jobLog(job, `开始预览：${task.originPath}${run.scopePath ? `/${run.scopePath}` : ""}${scopeNote}`);
  const walked = await walkScope(provider, task, run, signal);
  jobLog(job, `列到 ${walked.files} 个文件`);
  signal.throwIfAborted();

  const rules = parseRules(org.rules).rules;
  const scopes = unitScopesOf(run);
  // 重复文件目录是用户自己处理的暂存区（冲突项挪进去的），不再当作品扫；冲突检测还是要知道里面有什么，所以只挡 buildUnits
  const units = buildUnits(walked.entries.filter((e) => !underDuplicates(e.path)), {
    scopePath: run.scopePath,
    scopes,
    taskRootName: baseOf(normalizePath(task.originPath)),
    videoExts: videoExtsOf(settings),
    rules,
    libraryType: task.organize?.libraryType,
  });
  jobLog(job, `分成 ${units.length} 个作品单元`);

  const state: PlanState = {
    task,
    settings,
    org,
    entries: walked.entries,
    roots: walked.roots,
    units: new Map(units.map((u) => [u.key, u])),
    episodeTitles: new Map(),
    identifyNotes: new Map(),
    scopeRoots: scopeRootsOf(run, walked.roots),
    listed: new Set(),
  };
  const under = (p: string, s: string) => s === "" || p === s || p.startsWith(`${s}/`);
  const refPaths = [
    ...rewriteFollowSubPaths(task.id, [], true),
    ...rewriteOfflineSubPaths(task.id, [], true),
    ...rewriteCopyPaths(task.id, task.originPath, [], true),
  ];
  const library = listLibraryEntries();
  const rows: OrganizeUnit[] = [];
  const plans: UnitPlan[] = [];
  let i = 0;
  for (const unit of units) {
    signal.throwIfAborted();
    setProgress(job, "identify", i++, units.length, `识别 ${unit.rawName}`);
    const absRoot = absOf(task, unit.rootPath);
    const evidence: IdEvidence = {
      memory: recallMatch(provider.account.name, absRoot),
      // 目录名里的 [tmdbid=…] 多半是整理自己写的，排最前；本地 nfo 可能是上传者的刮削器写的，识别时要核对标题；影库条目最后
      known: [idTagFromName(unit.rawName, unit.kindHint), await nfoEvidence(resolveInDataDir(task.targetPath), unit), libraryEvidence(unit, library)],
    };
    let match: OrganizeMatch | null = null;
    let episodeTitles = new Map<string, string>();
    let identifyNotes: string[] = [];
    try {
      const r = await identifyUnit({ unit, evidence, libraryType: task.organize?.libraryType, episodeTitles: org.episodeTitle }, tmdb);
      match = r.match;
      episodeTitles = r.episodeTitles;
      identifyNotes = r.notes;
      for (const n of r.notes) jobLog(job, `「${unit.rawName}」${n}`);
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      jobLog(job, `识别「${unit.rawName}」失败：${messageOf(err)}`);
    }
    state.episodeTitles.set(unit.key, episodeTitles);
    state.identifyNotes.set(unit.key, identifyNotes);
    const memory = evidence.memory;
    // 单元根越到了范围外（范围直接选在季目录上，单元根是上一级的剧目录）：只有范围里的会挪走，只数范围里的引用
    const rootInScope = scopes.some((s) => under(unit.rootPath, s));
    const refs = rootInScope
      ? referencesTo(refPaths, unit.rootPath)
      : scopes.filter((s) => unit.files.some((f) => under(f.path, s))).reduce((n, s) => n + referencesTo(refPaths, s), 0);
    const row = toUnitRow(runId, unit, match, null, refs);
    if (memory) {
      row.seasonOverride = memory.season;
      row.episodeOffset = memory.episodeOffset;
    }
    const plan = planUnit(
      { unit, match, seasonOverride: row.seasonOverride, episodeOffset: row.episodeOffset, episodeTitles, selected: row.selected },
      { settings: org, libraryType: task.organize?.libraryType },
    );
    row.dstRoot = plan.dstRoot;
    row.notes = [...identifyNotes, ...plan.notes];
    rows.push(row);
    plans.push(plan);
    jobLog(job, match ? `「${unit.rawName}」→ ${match.title} (${match.year}) [${match.confidence}] ${match.reason}` : `「${unit.rawName}」没有识别出来`);
  }

  setProgress(job, "plan", 0, 0, "规划目标路径");
  // 目标目录在范围之外（整理到任务根下的作品目录）时，冲突检测得知道那边已经有什么：每个目标目录列一次
  const extra = await listOutsideDstDirs(provider, task, walked.roots, plans, walked.entries, signal, state.listed);
  state.entries = [...walked.entries, ...extra];
  const items = finalizeItems(plans, { entries: state.entries, scopeRoots: state.scopeRoots, items: [], cleanupEmptyDirs: org.cleanupEmptyDirs });
  planStates.set(runId, state);
  replaceUnits(runId, rows);
  replaceItems(runId, toItemRows(task, items));
  const stats = computeStats(rows, listItems(runId), "apply");
  const superseded = supersedeCovered(run);
  if (superseded > 0) jobLog(job, `作废了 ${superseded} 个范围被这次覆盖的旧预览`);
  // 收尾这句先进日志再落库，不然页面上的日志里没有它
  jobLog(job, `预览完成：${stats.units} 个单元，${stats.planned} 项要动，${stats.conflicts} 项冲突`);
  updateRun(runId, { status: "ready", stats, log: job.logs, error: "" });

  if (run.mode !== "manual") await afterAutoPreview(runId, task, run.mode, rows, stats);
}

/** 自动整理：run 是 auto 模式、全是 high 且没冲突就直接执行；否则留着等人确认并通知 */
async function afterAutoPreview(runId: string, task: TaskDefinition, mode: OrganizeRunMode, units: OrganizeUnit[], stats: OrganizeRunStats): Promise<void> {
  const run = getRun(runId);
  if (stats.planned === 0) {
    updateRun(runId, { status: "done", finishedAt: Math.floor(Date.now() / 1000) });
    if (run) releaseHeldCopies(run);
    return;
  }
  const sure = units.filter((u) => u.selected).every((u) => u.match?.confidence === "high");
  if (mode === "auto" && sure && stats.conflicts === 0) {
    // 让 preview 的 job 先收尾，再起执行的 job
    setTimeout(() => {
      applyRun(runId).catch((err) => log.warn({ err, runId }, "自动执行失败"));
    }, 0);
    return;
  }
  // 要等人确认：不知道要等多久，复制先按现在的样子走
  if (run) releaseHeldCopies(run);
  const unsure = units.filter((u) => u.match && u.match.confidence !== "high").length + units.filter((u) => !u.match).length;
  void deps.notify({ type: "organize-review", task, runId, units: stats.units, planned: stats.planned, unsure, conflicts: stats.conflicts });
}

/* ------------------------------- 预览里改单元 ------------------------------- */

const NOT_EDITABLE = "这次预览是上次启动时做的，单元结构没保存下来，改不了；可以直接执行，或者重新预览";

/** 把 patch 套在一个单元行上（换匹配时带上新的识别结果）；dstRoot / notes 由重新规划填 */
function applyUnitPatch(row: OrganizeUnit, patch: OrganizeUnitPatch, picked?: OrganizeMatch): OrganizeUnit {
  return {
    ...row,
    match: picked ?? row.match,
    seasonOverride: patch.seasonOverride === undefined ? row.seasonOverride : patch.seasonOverride,
    episodeOffset: patch.episodeOffset ?? row.episodeOffset,
    selected: patch.selected ?? (patch.match ? true : row.selected),
    remember: patch.remember ?? row.remember,
  };
}

/**
 * 预览里改了单元之后整体重新规划：别的单元按内存里的单元结构和库里的匹配 / 季 / 偏移 / 勾选重新规划一遍（顺序和预览一样），
 * 冲突检测、建目录 / 删空目录整体重算。附属文件跟着哪个视频、撞名算不算冲突这些规划期标记不落库，从库里的项反推会丢，
 * 谁先占到目标也会跟着变，所以不能只重做改了的单元。全是同步的：调用方在它之前做完检查，中间不能有 await
 */
function replanRun(run: OrganizeRun, state: PlanState, changed: Map<string, OrganizeUnit>): void {
  const rows = new Map(listUnits(run.id).map((r) => [r.key, r]));
  const plans: UnitPlan[] = [];
  for (const u of state.units.values()) {
    const r = changed.get(u.key) ?? rows.get(u.key);
    if (!r) continue;
    const plan = planUnit(
      {
        unit: u,
        match: r.match,
        seasonOverride: r.seasonOverride,
        episodeOffset: r.episodeOffset,
        episodeTitles: state.episodeTitles.get(u.key),
        selected: r.selected,
        excluded: excludedRel(state.task, r),
        resolutions: resolutionsRel(state.task, r),
      },
      planContext(state),
    );
    if (changed.has(u.key)) updateUnit(run.id, u.key, { ...r, dstRoot: plan.dstRoot, notes: [...(state.identifyNotes.get(u.key) ?? []), ...plan.notes] });
    plans.push(plan);
  }
  const all = finalizeItems(plans, { entries: state.entries, scopeRoots: state.scopeRoots, items: [], cleanupEmptyDirs: state.org.cleanupEmptyDirs });
  replaceItems(run.id, toItemRows(state.task, all));
  updateRun(run.id, { stats: computeStats(listUnits(run.id), listItems(run.id), "apply") });
}

/** 能改的待执行预览：run 在、是 ready、单元结构还在内存里 */
function editableRun(runId: string): { run: OrganizeRun; state: PlanState } {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  if (run.status !== "ready") throw new HttpError(409, `只有待执行的整理能改（当前 ${run.status}）`);
  const state = planStates.get(runId);
  if (!state) throw new HttpError(409, NOT_EDITABLE);
  return { run, state };
}

/**
 * 落库前再确认一次：等 TMDB / 列目录的时候可能已经开始执行、被取消、被取代或删掉了——那就什么都不写。
 * 从这里到落库不能有 await
 */
function assertStillEditable(runId: string, state: PlanState): OrganizeRun {
  const current = getRun(runId);
  if (!current || current.status !== "ready" || planStates.get(runId) !== state) throw new HttpError(409, "这次预览已经不能改了：已经开始执行、被取消或删掉了");
  return current;
}

/** 改了单元之后目标目录可能是没列过的：把这些单元按改完的样子规划一遍，列一遍目标目录（列不到就按已知的条目算） */
async function listDraftTargets(runId: string, state: PlanState, drafts: UnitPlan[]): Promise<ScopeEntry[]> {
  if (drafts.length === 0) return [];
  try {
    return await listOutsideDstDirs(providerForTask(state.task, "write"), state.task, state.roots, drafts, state.entries, new AbortController().signal, state.listed);
  } catch (err) {
    log.warn({ err, runId }, "列目标目录失败，冲突检测按已知的条目算");
    return [];
  }
}

export async function patchUnit(runId: string, key: string, patch: OrganizeUnitPatch): Promise<OrganizeUnit> {
  const { state } = editableRun(runId);
  const unit = state.units.get(key);
  const row = getUnit(runId, key);
  if (!unit || !row) throw new HttpError(404, "单元不存在");
  const end = beginOp(runId);
  try {
    let picked: { match: OrganizeMatch; episodeTitles: Map<string, string> } | undefined;
    if (patch.match && (!row.match || row.match.tmdbId !== patch.match.tmdbId || row.match.mediaType !== patch.match.mediaType)) {
      const tmdb = deps.tmdb(state.settings);
      if (!tmdb) throw new HttpError(400, "TMDB 未配置 apiKey");
      const r = await identifyUnit(
        { unit, evidence: { known: { tmdbId: patch.match.tmdbId, mediaType: patch.match.mediaType, source: "手动指定" } }, episodeTitles: state.org.episodeTitle },
        tmdb,
      );
      if (!r.match) throw new HttpError(404, `TMDB 上没有 ${patch.match.mediaType} ${patch.match.tmdbId}`);
      picked = { match: { ...r.match, candidates: row.match?.candidates ?? [] }, episodeTitles: r.episodeTitles };
    }
    // 换了匹配 / 季之后目标目录可能是没列过的：按改完的样子规划这个单元，先把目标目录列一遍，冲突检测和 mkdir 判断才准
    const draft = applyUnitPatch(row, patch, picked?.match);
    const draftPlan = planUnit(
      {
        unit,
        match: draft.match,
        seasonOverride: draft.seasonOverride,
        episodeOffset: draft.episodeOffset,
        episodeTitles: picked?.episodeTitles ?? state.episodeTitles.get(key),
        selected: draft.selected,
        excluded: excludedRel(state.task, draft),
        resolutions: resolutionsRel(state.task, draft),
      },
      planContext(state),
    );
    const extra = await listDraftTargets(runId, state, [draftPlan]);
    // 从这里到落库没有 await：先确认这次预览还能改，再从库里重读这个单元套 patch——两个 patch 交错时，后一个不能把前一个的改动盖回去
    const current = assertStillEditable(runId, state);
    const fresh = getUnit(runId, key);
    if (!fresh) throw new HttpError(404, "单元不存在");
    mergeEntries(state, extra);
    if (picked) {
      state.episodeTitles.set(key, picked.episodeTitles);
      state.identifyNotes.set(key, []);
    }
    replanRun(current, state, new Map([[key, applyUnitPatch(fresh, patch, picked?.match)]]));
    return getUnit(runId, key)!;
  } finally {
    end();
  }
}

/** 批量勾选 / 取消勾选单元（全选、全不选、只选把握大的）：一次重规划，不是一个单元一次。没识别出来的单元不能勾 */
export async function patchUnits(runId: string, keys: string[], patch: { selected?: boolean; remember?: boolean }): Promise<{ changed: number }> {
  const { state } = editableRun(runId);
  const wanted = new Set(keys);
  const end = beginOp(runId);
  try {
    // 新勾上的单元：预览时没勾的不列目标目录，先列
    const drafts: UnitPlan[] = [];
    for (const row of listUnits(runId)) {
      const unit = state.units.get(row.key);
      if (!wanted.has(row.key) || !unit || !row.match || !patch.selected || row.selected) continue;
      drafts.push(
        planUnit(
          { unit, match: row.match, seasonOverride: row.seasonOverride, episodeOffset: row.episodeOffset, episodeTitles: state.episodeTitles.get(row.key), selected: true, excluded: excludedRel(state.task, row), resolutions: resolutionsRel(state.task, row) },
          planContext(state),
        ),
      );
    }
    const extra = await listDraftTargets(runId, state, drafts);
    const current = assertStillEditable(runId, state);
    mergeEntries(state, extra);
    const changed = new Map<string, OrganizeUnit>();
    for (const fresh of listUnits(runId)) {
      if (!wanted.has(fresh.key) || !fresh.match || !state.units.has(fresh.key)) continue;
      const next = { ...fresh, selected: patch.selected ?? fresh.selected, remember: patch.remember ?? fresh.remember };
      if (next.selected !== fresh.selected || next.remember !== fresh.remember) changed.set(fresh.key, next);
    }
    if (changed.size > 0) replanRun(current, state, changed);
    return { changed: changed.size };
  } finally {
    end();
  }
}

/**
 * 按文件改：勾选 / 取消勾选（记在单元的 excluded 里，网盘绝对路径，重规划不丢），或者给冲突项选个办法（记在 resolutions 里）。
 * 取消勾选的文件规划时跳过、跟着它的字幕 / nfo 一起留下——冲突的两份勾掉一份，另一份就能走；
 * 选了办法的（改名保留 / 自己改名 / 挪进重复文件 / 删掉 / 覆盖）按办法规划，顺带勾回来。
 * ids 是当前清单里的项（重规划之后 id 会换，页面拿最新的清单）
 */
export interface ItemsPatch {
  selected?: boolean;
  /** 给冲突项选的办法；null 是撤回选择，回到「留在原处」 */
  resolve?: OrganizeConflictResolution | null;
}

export async function patchItems(runId: string, ids: string[], patch: ItemsPatch): Promise<{ changed: number }> {
  const { state } = editableRun(runId);
  const wanted = new Set(ids);
  const end = beginOp(runId);
  try {
    const byUnit = new Map<string, string[]>();
    for (const it of listItems(runId)) {
      if (!wanted.has(it.id) || it.unitKey === "" || it.kind === "dir") continue;
      byUnit.set(it.unitKey, [...(byUnit.get(it.unitKey) ?? []), it.srcPath]);
    }
    // 选了办法就算勾上（不然规划阶段先跳过了，轮不到冲突）；取消勾选就撤掉之前选的办法
    const selected = patch.resolve !== undefined ? patch.resolve !== null : patch.selected;
    const next = (row: OrganizeUnit): Pick<OrganizeUnit, "excluded" | "resolutions"> => {
      const excluded = new Set(row.excluded);
      const resolutions = { ...row.resolutions };
      for (const p of byUnit.get(row.key) ?? []) {
        if (selected !== false) excluded.delete(p);
        else excluded.add(p);
        if (patch.resolve !== undefined || selected === false) {
          if (patch.resolve) resolutions[p] = patch.resolve;
          else delete resolutions[p];
        }
      }
      return { excluded: [...excluded].sort(), resolutions };
    };
    const same = (a: OrganizeUnit, b: Pick<OrganizeUnit, "excluded" | "resolutions">) =>
      [...a.excluded].sort().join("\n") === b.excluded.join("\n") && JSON.stringify(a.resolutions ?? {}) === JSON.stringify(b.resolutions);
    // 重新勾上 / 换了办法的文件：目标目录（含重复文件目录）可能没列过
    const drafts: UnitPlan[] = [];
    for (const row of listUnits(runId)) {
      const unit = state.units.get(row.key);
      if (!byUnit.has(row.key) || !unit || !row.match || !row.selected || selected === false) continue;
      const draft = { ...row, ...next(row) };
      drafts.push(
        planUnit(
          { unit, match: row.match, seasonOverride: row.seasonOverride, episodeOffset: row.episodeOffset, episodeTitles: state.episodeTitles.get(row.key), selected: true, excluded: excludedRel(state.task, draft), resolutions: resolutionsRel(state.task, draft) },
          planContext(state),
        ),
      );
    }
    const extra = await listDraftTargets(runId, state, drafts);
    const current = assertStillEditable(runId, state);
    mergeEntries(state, extra);
    const changed = new Map<string, OrganizeUnit>();
    for (const fresh of listUnits(runId)) {
      if (!byUnit.has(fresh.key) || !state.units.has(fresh.key)) continue;
      const patched = next(fresh);
      if (!same(fresh, patched)) changed.set(fresh.key, { ...fresh, ...patched });
    }
    if (changed.size > 0) replanRun(current, state, changed);
    return { changed: changed.size };
  } finally {
    end();
  }
}

/* ------------------------------- 换匹配弹框的 TMDB 搜索 ------------------------------- */

function tmdbOrThrow(): TmdbApi {
  const tmdb = deps.tmdb(readAppSettings());
  if (!tmdb) throw new HttpError(400, "TMDB 未配置 apiKey，请先在设置中填入");
  return tmdb;
}

const toPick = (r: Pick<TmdbSearchResult, "id" | "title" | "year" | "posterUrl">, mediaType: OrganizeCandidate["mediaType"]): OrganizeCandidate => ({
  tmdbId: r.id,
  mediaType,
  title: r.title,
  year: r.year,
  posterUrl: r.posterUrl,
  score: 0,
});

/** 换匹配弹框的搜索：可以限定类型和年份；不限类型但给了年份时电影、剧集各搜一次（TMDB 的 multi 搜索不认年份） */
export async function searchCandidates(q: { query: string; type?: OrganizeCandidate["mediaType"]; year?: string }): Promise<OrganizeCandidate[]> {
  const tmdb = tmdbOrThrow();
  const year = q.year && /^(19|20)\d{2}$/.test(q.year) ? q.year : undefined;
  let results: TmdbSearchResult[];
  try {
    if (q.type) results = await tmdb.search(q.query, q.type, year);
    else if (year) results = [...(await tmdb.search(q.query, "movie", year)), ...(await tmdb.search(q.query, "tv", year))];
    else results = await tmdb.search(q.query, "multi");
  } catch (err) {
    throw upstreamError(`TMDB 搜索失败：${messageOf(err)}`);
  }
  const seen = new Set<string>();
  const out: OrganizeCandidate[] = [];
  for (const r of results) {
    if (r.mediaType !== "movie" && r.mediaType !== "tv") continue;
    const key = `${r.mediaType}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toPick(r, r.mediaType));
  }
  return out;
}

/** 按 TMDB 编号查一部：换匹配弹框里直接填编号 / 贴链接 */
export async function lookupCandidate(mediaType: OrganizeCandidate["mediaType"], tmdbId: number): Promise<OrganizeCandidate> {
  const tmdb = tmdbOrThrow();
  let d: TmdbDetails | null;
  try {
    d = await tmdb.details(mediaType, tmdbId);
  } catch (err) {
    throw upstreamError(`TMDB 查询失败：${messageOf(err)}`);
  }
  if (!d) throw new HttpError(404, `TMDB 上没有${mediaType === "movie" ? "电影" : "剧集"} ${tmdbId}`);
  return toPick({ id: d.id, title: d.title || d.originalTitle, year: d.year, posterUrl: d.posterUrl }, mediaType);
}

/* ------------------------------- 执行 ------------------------------- */

type DirEntryRef = { id: string; isDir: boolean };

/** 列目录 / 撞名检查要的最小上下文：执行、撤销、放弃共用 */
interface ListCtx {
  provider: DriveProvider;
  signal: AbortSignal;
  /** 网盘绝对路径 → 目录 id */
  dirIds: Map<string, string>;
  /** 本轮列过的目录：绝对路径 → 名字 → { id, isDir }；我们自己改名 / 挪动之后原地更新，别整个丢掉再列 */
  listings: Map<string, Map<string, DirEntryRef>>;
}

interface ExecCtx extends ListCtx {
  job: Job;
  task: TaskDefinition;
  settings: AppSettings;
  tasks: TaskDefinition[];
}

const listCtx = (provider: DriveProvider, signal: AbortSignal): ListCtx => ({ provider, signal, dirIds: new Map(), listings: new Map() });

/** 我们自己在目录里改了名：更新本轮的目录缓存 */
function noteRenamed(ctx: ListCtx, dir: string, oldName: string, newName: string, node: DirEntryRef): void {
  const listing = ctx.listings.get(normalizePath(dir));
  if (!listing) return;
  listing.delete(oldName);
  listing.set(newName, node);
}

/** 我们自己把目录里的一项删掉了：更新本轮的目录缓存 */
function noteRemoved(ctx: ListCtx, dir: string, name: string): void {
  ctx.listings.get(normalizePath(dir))?.delete(name);
}

/** 我们自己把文件从 from 挪到了 to：两边的目录缓存都更新 */
function noteMoved(ctx: ListCtx, from: string, to: string, name: string, node: DirEntryRef): void {
  ctx.listings.get(normalizePath(from))?.delete(name);
  ctx.listings.get(normalizePath(to))?.set(name, node);
}

async function dirIdOf(ctx: ListCtx, abs: string): Promise<string> {
  const hit = ctx.dirIds.get(abs);
  if (hit) return hit;
  const node = await ctx.provider.resolvePath(abs, ctx.signal);
  if (!node || !node.isDir) throw new StaleError(`网盘上没有目录 ${abs}`);
  ctx.dirIds.set(abs, node.id);
  return node.id;
}

/**
 * 目录里现在有哪些名字。本轮列过的用 ctx 里的缓存（我们自己在里面改过名 / 挪过之后调用方会把它清掉）；
 * 真去列时绕过网盘客户端自己的缓存（115 的进程内缓存 5 分钟），不然预览之后别人放进来的同名文件看不见
 */
async function namesIn(ctx: ListCtx, dirAbs: string): Promise<Map<string, DirEntryRef>> {
  const dir = normalizePath(dirAbs);
  let listing = ctx.listings.get(dir);
  if (!listing) {
    const pid = await dirIdOf(ctx, dir);
    listing = new Map((await ctx.provider.listDir(pid, ctx.signal, { fresh: true })).map((e) => [e.name, { id: e.id, isDir: e.isDir }]));
    ctx.listings.set(dir, listing);
  }
  return listing;
}

async function nodeOf(ctx: ListCtx, abs: string, knownId: string): Promise<DirEntryRef> {
  if (knownId) return { id: knownId, isDir: false };
  const hit = (await namesIn(ctx, normalizePath(splitPath(abs).slice(0, -1).join("/")))).get(baseOf(abs));
  if (!hit) throw new StaleError(`网盘上找不到 ${abs}`);
  return hit;
}

/**
 * 预览之后目标位置可能被别人占了：网盘对同名要么拒绝（夸克 23008 / OpenList 403），要么自己加个 (1)（115 的 move）——
 * 后者会让记账和真实名字对不上、本地 strm 指向别人的文件。所以动手前先看一眼，撞名的记 rejected、不碰网盘。
 * ours：本轮自己的项的节点 id（或单个 id），占着名字的是它们就不算别人（连环改名、上次挪过去没记账）
 */
const occupied = (names: Map<string, DirEntryRef>, name: string, ours?: ReadonlySet<string> | string): boolean => {
  const hit = names.get(name);
  if (!hit) return false;
  if (typeof ours === "string") return hit.id !== ours;
  return !ours?.has(hit.id);
};
const clashError = (where: string, name: string): OrganizeFailure => new OrganizeFailure("rejected", new Error(`${where}已经有同名文件 ${name}，网盘不会覆盖`));

/**
 * 网盘调用统一从这里走：失败先分类，临时失败（网络 / 超时 / 5xx）等 retryDelayMs 再来一次，仍失败按类别抛 OrganizeFailure；
 * 风控 / 登录失效 / 预览后变了 / 名字不被接受 不重试
 */
async function withRetry<T>(ctx: ExecCtx, fn: () => Promise<T>): Promise<T> {
  const signal = ctx.job.abort.signal;
  for (let n = 0; ; n++) {
    try {
      return await fn();
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      const kind = classifyFailure(ctx.provider, err);
      if (kind === "transient" && n === 0) {
        jobLog(ctx.job, `临时失败（${messageOf(err)}），${deps.retryDelayMs / 1000} 秒后重试`);
        await sleep(deps.retryDelayMs, undefined, { signal });
        continue;
      }
      throw new OrganizeFailure(kind, err);
    }
  }
}


/** 会在网盘上动手的动作 */
const WORK_ACTIONS = new Set<OrganizeItem["action"]>(["mkdir", "rename", "move", "rmdir", "delete"]);

/** 只有勾选且识别出来的单元的项才动；目录项（unitKey 为空）随时动 */
function activeItemFilter(runId: string, known: OrganizeUnit[] = listUnits(runId)): (it: OrganizeItem) => boolean {
  const units = new Map(known.map((u) => [u.key, u]));
  return (it) => it.unitKey === "" || !!(units.get(it.unitKey)?.selected && units.get(it.unitKey)?.match);
}

/** 移动项在源目录里的中间名字（先原地改名再挪）；同名的没有 */
const intermediateOf = (it: OrganizeItem): string | undefined => (it.action === "move" && baseOf(it.srcPath) !== baseOf(it.dstPath) ? `${dirOf(it.srcPath)}/${baseOf(it.dstPath)}` : undefined);

async function execute(job: Job, runId: string, only: Set<string> | null): Promise<void> {
  const run = getRun(runId)!;
  const task = getTask(run.taskId);
  if (!task) throw new Error("任务已不存在");
  const provider = providerForTask(task, "write");
  const write = provider.write!;
  const settings = readAppSettings();
  const signal = job.abort.signal;
  const ctx: ExecCtx = { ...listCtx(provider, signal), job, task, settings, tasks: accountTasks(provider.account.name) };
  const active = activeItemFilter(runId);
  // 不给 ids：没做的 + 上次临时失败的（风控 / 网络抖动）再来，stale / rejected 的不碰；给了 ids：只做点名的这些
  const wanted = (it: OrganizeItem) => active(it) && (only ? only.has(it.id) && retryableItem(it, true) : retryableItem(it));
  const all = listItems(runId).filter(wanted);
  const redoMirror = all.filter((it) => it.status === "done");
  const pending = all.filter((it) => it.status !== "done");
  // 上次失败 / 跳过的先归零；attempts 记「这一项被执行了几轮」（界面「已试 N 轮」），执行中的自动重试不算一轮
  updateItems(pending.filter((it) => it.status !== "pending").map((it) => it.id), { status: "pending", error: "", errorKind: "" });
  bumpAttempts(all.map((it) => it.id));
  jobLog(job, `开始执行：${pending.length} 项${redoMirror.length > 0 ? `，补做本地镜像 ${redoMirror.length} 项` : ""}`);
  const now = () => Math.floor(Date.now() / 1000);
  const total = pending.length + redoMirror.length;
  let done = 0;
  let fatal: string | null = null;
  const fail = (it: OrganizeItem, err: unknown) => {
    const kind = classifyFailure(provider, err);
    const msg = messageOf(err);
    updateItem(it.id, { status: "failed", error: msg, errorKind: kind });
    jobLog(job, `失败 ${it.action} ${it.srcPath}：${msg}（${FAILURE_LABEL[kind]}）`);
    if (kind === "blocked") fatal = `网盘拒绝了请求（${msg}），整理已停下，稍后再继续`;
  };
  /** 网盘上动完之后同步本地；失败不影响网盘那边已经完成的事实，记成 mirror 类失败（监控见到就不跳过这条事件，让它把本地补回来；「重试」只补本地） */
  const mirror = async (oldPath: string, newPath: string, isDir: boolean, oldPathAlt?: string): Promise<string> => {
    try {
      await mirrorRelocate({ oldPath, newPath, isDir, oldPathAlt }, { tasks: ctx.tasks, settings });
      return "";
    } catch (err) {
      const msg = `本地镜像失败：${describeFileFailure(err, { relPath: relOf(task, newPath), kind: "strm", context: "mirror" })}`;
      jobLog(job, `${msg}（${newPath}）`);
      return msg;
    }
  };
  const finishItem = async (it: OrganizeItem, nodeId: string, isDir: boolean) => {
    // 跨目录且改了名的项在源目录里有过一个中间名字：本地文件可能已经被监控按它改过名
    const error = await mirror(it.srcPath, it.dstPath, isDir, intermediateOf(it));
    updateItem(it.id, { status: "done", nodeId, finishedAt: now(), curPath: "", error, errorKind: error ? "mirror" : "" });
    done++;
  };

  // 0. 上次网盘成功、本地没跟上的：只补本地，不碰网盘（网盘被风控时也能先把本地补上）
  for (const it of redoMirror) {
    if (signal.aborted) break;
    setProgress(job, "apply", done, total, `补本地镜像 ${it.dstPath}`);
    const error = await mirror(it.srcPath, it.dstPath, it.kind === "dir", intermediateOf(it));
    updateItem(it.id, { error, errorKind: error ? "mirror" : "" });
    if (!error) done++;
  }

  // 1. mkdir（按深度）。目录已经在（上次执行建过、别人建的）就直接复用
  for (const it of pending.filter((i) => i.action === "mkdir")) {
    if (fatal || signal.aborted) break;
    setProgress(job, "apply", done, total, `建目录 ${it.dstPath}`);
    try {
      await withRetry(ctx, async () => {
        const existing = await ctx.provider.resolvePath(it.dstPath, signal);
        if (existing?.isDir) {
          ctx.dirIds.set(it.dstPath, existing.id);
          updateItem(it.id, { status: "done", nodeId: existing.id, finishedAt: now(), error: "", errorKind: "" });
          done++;
          return;
        }
        const parent = normalizePath(splitPath(it.dstPath).slice(0, -1).join("/"));
        const pid = await dirIdOf(ctx, parent);
        const node = await write.mkdir({ id: pid, path: parent }, baseOf(it.dstPath), signal);
        ctx.dirIds.set(it.dstPath, node.id);
        ctx.listings.delete(parent);
        // 刚建的目录肯定是空的：撞名检查不用再列一遍（115 刚建的目录列出来也可能滞后）
        ctx.listings.set(it.dstPath, new Map());
        updateItem(it.id, { status: "done", nodeId: node.id, finishedAt: now(), error: "", errorKind: "" });
        done++;
      });
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      fail(it, err);
    }
  }

  // 1b. 删除：只有用户在冲突上明确选了「删掉这一份」/「覆盖」的项。放在改名 / 移动之前，覆盖才腾得出位置。
  //     动手前按目录清单核对名字和 id：预览之后位置上换了别的文件就不删（stale）。删掉的撤销退不回来
  const deletes = pending.filter((i) => i.action === "delete");
  for (const it of deletes) {
    if (fatal || signal.aborted) break;
    setProgress(job, "apply", done, total, `删除 ${it.srcPath}`);
    try {
      await withRetry(ctx, async () => {
        const dir = dirOf(it.srcPath);
        const name = baseOf(it.srcPath);
        const hit = (await namesIn(ctx, dir)).get(name);
        if (!hit) {
          // 已经不在了（上次执行删过、或者别人删了）：当做完，别再报错
          updateItem(it.id, { status: "done", finishedAt: now(), error: "网盘上已经没有这个文件", errorKind: "" });
          done++;
          return;
        }
        if (it.nodeId && hit.id !== it.nodeId) throw new StaleError(`预览之后 ${it.srcPath} 换成了另一个文件，没有删`);
        await write.remove({ id: hit.id, path: it.srcPath, isDir: hit.isDir }, signal);
        noteRemoved(ctx, dir, name);
        jobLog(job, `删除 ${it.srcPath}`);
        let error = "";
        try {
          await mirrorDelete(it.srcPath, { tasks: ctx.tasks, settings });
        } catch (err) {
          error = `本地文件没删掉：${messageOf(err)}`;
          jobLog(job, `${error}（${it.srcPath}）`);
        }
        updateItem(it.id, { status: "done", nodeId: hit.id, finishedAt: now(), error, errorKind: error ? "mirror" : "" });
        done++;
      });
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      fail(it, err);
    }
  }

  // 2. 改名 / 移动：先原地改名（同目录内一批），再按目标目录分组移动。
  //    移动项改完名还没挪走时把当前路径记进 cur_path：中途断了续跑 / 撤销都靠它
  const files = pending.filter((i) => i.action === "rename" || i.action === "move");
  const current = new Map<string, string>(files.map((i) => [i.id, i.curPath || i.srcPath]));
  const nodeIds = new Map<string, string>();
  const isDirNode = new Map<string, boolean>();
  const failed = new Set<string>();

  // 2a. 解析 id
  for (const it of files) {
    if (fatal || signal.aborted) break;
    try {
      const n = await withRetry(ctx, () => nodeOf(ctx, current.get(it.id)!, it.nodeId));
      nodeIds.set(it.id, n.id);
      isDirNode.set(it.id, n.isDir);
      if (!it.nodeId) updateItem(it.id, { nodeId: n.id });
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      failed.add(it.id);
      fail(it, err);
    }
  }

  // 2b. 改名（已经改过名、只差挪走的跳过）
  const renames = files.filter((it) => !failed.has(it.id) && baseOf(current.get(it.id)!) !== baseOf(it.dstPath));
  const renameBatches = new Map<string, OrganizeItem[]>();
  for (const it of renames) {
    const list = renameBatches.get(it.unitKey) ?? [];
    list.push(it);
    renameBatches.set(it.unitKey, list);
  }
  /** 本轮自己的项现在的节点：占着名字的是它们就不算别人 */
  const ourNodes = () => new Set([...nodeIds.values()]);
  for (const wholeBatch of renameBatches.values()) {
    if (fatal || signal.aborted) break;
    setProgress(job, "apply", done, total, `改名 ${baseOf(wholeBatch[0].srcPath)} 等 ${wholeBatch.length} 项`);
    const settle = async (it: OrganizeItem, newId: string) => {
      const prev = current.get(it.id)!;
      const next = `${dirOf(prev)}/${baseOf(it.dstPath)}`;
      current.set(it.id, next);
      nodeIds.set(it.id, newId);
      noteRenamed(ctx, dirOf(next), baseOf(prev), baseOf(next), { id: newId, isDir: isDirNode.get(it.id) ?? false });
      if (it.action === "rename") await finishItem(it, newId, isDirNode.get(it.id) ?? false);
      else updateItem(it.id, { curPath: next, nodeId: newId });
    };
    // 源目录里现在有没有和新名字撞的（预览之后别人放进来的）。新名字已经在自己的节点上（上次改了没记账）就只记账；
    // 被本轮别的项占着（连环改名：E02→E01、E03→E02）就等那一项先改；别人的就是撞名
    const ready: OrganizeItem[] = [];
    const waitFor = new Map<string, string>();
    const ours = ourNodes();
    for (const it of wholeBatch) {
      try {
        const names = await withRetry(ctx, () => namesIn(ctx, dirOf(current.get(it.id)!)));
        const hit = names.get(baseOf(it.dstPath));
        if (hit && hit.id === nodeIds.get(it.id)) {
          await settle(it, hit.id);
          continue;
        }
        if (hit && ours.has(hit.id)) {
          const owner = wholeBatch.find((o) => nodeIds.get(o.id) === hit.id);
          if (!owner) throw clashError("源目录里", baseOf(it.dstPath));
          waitFor.set(it.id, owner.id);
        } else if (hit) throw clashError("源目录里", baseOf(it.dstPath));
        ready.push(it);
      } catch (err) {
        if (isAbortError(err) || signal.aborted) throw err;
        failed.add(it.id);
        fail(it, err);
      }
    }
    // 按依赖排序：占着我目标名的那一项先改；转圈互占的（A↔B 互换）改不了
    const batch: OrganizeItem[] = [];
    const left = new Set(ready.map((it) => it.id));
    while (left.size > 0) {
      const round = ready.filter((it) => left.has(it.id) && (!waitFor.has(it.id) || !left.has(waitFor.get(it.id)!)));
      if (round.length === 0) {
        for (const it of ready.filter((i) => left.has(i.id))) {
          failed.add(it.id);
          fail(it, new OrganizeFailure("rejected", new Error(`和本轮别的文件互相占着名字，改不动 ${baseOf(it.dstPath)}`)));
        }
        break;
      }
      for (const it of round) {
        left.delete(it.id);
        // 给我腾名字的那一项没改成（撞了别人的）：名字还被它占着，改过去要么被拒、要么 115 悄悄变成 xxx(1)，不能碰
        const owner = waitFor.get(it.id);
        if (owner && failed.has(owner)) {
          failed.add(it.id);
          fail(it, new OrganizeFailure("rejected", new Error(`占着 ${baseOf(it.dstPath)} 的那一项没改成，这一项改不了`)));
          continue;
        }
        batch.push(it);
      }
    }
    if (batch.length === 0) continue;
    const nodes = batch.map((it) => ({ node: { id: nodeIds.get(it.id)!, path: current.get(it.id)!, isDir: isDirNode.get(it.id) ?? false } satisfies WriteNode, newName: baseOf(it.dstPath) }));
    const oneByOne = async () => {
      for (const [i, it] of batch.entries()) {
        if (fatal || signal.aborted) break;
        try {
          // 前面的项改到一半失败了名字就还占着：动手前再看一眼本轮的目录缓存（改成的都记在里面），占着就是撞名
          const owner = waitFor.get(it.id);
          if (owner && failed.has(owner)) throw new OrganizeFailure("rejected", new Error(`占着 ${baseOf(it.dstPath)} 的那一项没改成，这一项改不了`));
          if (occupied(await namesIn(ctx, dirOf(current.get(it.id)!)), nodes[i].newName, nodes[i].node.id)) throw clashError("源目录里", nodes[i].newName);
          const r = await withRetry(ctx, () => write.rename(nodes[i].node, nodes[i].newName, signal));
          await settle(it, r.id);
        } catch (err) {
          if (isAbortError(err) || signal.aborted) throw err;
          failed.add(it.id);
          fail(it, err);
        }
      }
    };
    // 连环改名一定要按顺序一个个来（批量接口不保证顺序）
    if (!write.renameMany || nodes.length === 1 || waitFor.size > 0) {
      await oneByOne();
      continue;
    }
    try {
      const ids = await withRetry(ctx, () => write.renameMany!(nodes, signal));
      for (const [i, it] of batch.entries()) await settle(it, ids[i]?.id ?? nodeIds.get(it.id)!);
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      if (classifyFailure(provider, err) === "blocked") {
        for (const it of batch) {
          failed.add(it.id);
          fail(it, err);
        }
      } else {
        // 一批里有一个改不了会把整批拖失败：逐个再试一遍，把失败定位到那一项
        jobLog(job, `批量改名失败（${messageOf(err)}），改为逐个改名`);
        await oneByOne();
      }
    }
  }

  // 2c. 移动：按目标目录分组
  const moves = files.filter((it) => !failed.has(it.id) && it.action === "move");
  const moveBatches = new Map<string, OrganizeItem[]>();
  for (const it of moves) {
    const to = dirOf(it.dstPath);
    const list = moveBatches.get(to) ?? [];
    list.push(it);
    moveBatches.set(to, list);
  }
  // 目标目录里现在有没有同名的（预览之后别人放进来的）：有就不挪，115 会悄悄改成 xxx(1)。
  // 名字在自己的节点上（上次挪过去没记账）只记账；被本轮别的项占着（它要挪走）就等所有批次跑完再来一遍
  let deferred = new Map<string, OrganizeItem[]>();
  const runMoveBatches = async (batches: Map<string, OrganizeItem[]>, allowDefer: boolean) => {
    for (const [to, wholeBatch] of batches) {
      if (fatal || signal.aborted) break;
      setProgress(job, "apply", done, total, `移动 ${wholeBatch.length} 项到 ${to}`);
      const nodeOfItem = (it: OrganizeItem): WriteNode => ({ id: nodeIds.get(it.id)!, path: current.get(it.id)!, isDir: isDirNode.get(it.id) ?? false });
      const settleMoved = async (it: OrganizeItem, newId: string) => {
        const from = current.get(it.id)!;
        noteMoved(ctx, dirOf(from), to, baseOf(from), { id: newId, isDir: isDirNode.get(it.id) ?? false });
        await finishItem(it, newId, isDirNode.get(it.id) ?? false);
      };
      let toId: string;
      let names: Map<string, DirEntryRef>;
      try {
        toId = await withRetry(ctx, () => dirIdOf(ctx, to));
        names = await withRetry(ctx, () => namesIn(ctx, to));
      } catch (err) {
        if (isAbortError(err) || signal.aborted) throw err;
        for (const it of wholeBatch) fail(it, err);
        continue;
      }
      const ours = ourNodes();
      const batch: OrganizeItem[] = [];
      for (const it of wholeBatch) {
        const name = baseOf(it.dstPath);
        const hit = names.get(name);
        if (hit && hit.id === nodeIds.get(it.id)) {
          await settleMoved(it, hit.id);
          continue;
        }
        if (hit && ours.has(hit.id) && allowDefer) {
          const list = deferred.get(to) ?? [];
          list.push(it);
          deferred.set(to, list);
          continue;
        }
        if (hit) {
          fail(it, clashError("目标目录里", name));
          continue;
        }
        batch.push(it);
      }
      if (batch.length === 0) continue;
      try {
        const ids = await withRetry(ctx, () => write.move(batch.map(nodeOfItem), { id: toId, path: to }, signal));
        for (const [i, it] of batch.entries()) await settleMoved(it, ids[i]?.id ?? nodeIds.get(it.id)!);
      } catch (err) {
        if (isAbortError(err) || signal.aborted) throw err;
        if (batch.length === 1 || classifyFailure(provider, err) === "blocked") {
          for (const it of batch) fail(it, err);
          continue;
        }
        // 一批里有一个挪不动会把整批拖失败：逐个再试一遍，把失败定位到那一项
        jobLog(job, `批量移动到 ${to} 失败（${messageOf(err)}），改为逐个移动`);
        for (const it of batch) {
          if (fatal || signal.aborted) break;
          try {
            const [moved] = await withRetry(ctx, () => write.move([nodeOfItem(it)], { id: toId, path: to }, signal));
            await settleMoved(it, moved?.id ?? nodeIds.get(it.id)!);
          } catch (err2) {
            if (isAbortError(err2) || signal.aborted) throw err2;
            fail(it, err2);
          }
        }
      }
    }
  };
  // 三个以上串成链（X 要去的名字被 Y 占着，Y 要去的又被 Z 占着）按目标目录的批次顺序一遍未必解得开：有进展就再来一遍，
  // 一遍下来一个都没挪成就是转圈互占，最后一遍不再等、按撞名记
  let pendingMoves = moveBatches;
  const sizeOf = (m: Map<string, OrganizeItem[]>) => [...m.values()].reduce((n, l) => n + l.length, 0);
  while (pendingMoves.size > 0 && !fatal && !signal.aborted) {
    const before = sizeOf(pendingMoves);
    deferred = new Map();
    await runMoveBatches(pendingMoves, true);
    const left = sizeOf(deferred);
    if (left === 0) break;
    if (left === before) {
      const stuck = deferred;
      deferred = new Map();
      await runMoveBatches(stuck, false);
      break;
    }
    pendingMoves = deferred;
  }

  // 3. 删空目录（从深到浅）。目录已经不在了算 stale（不用再试）；不是空的记成临时（下次重试再看一眼）
  for (const it of pending.filter((i) => i.action === "rmdir")) {
    if (fatal || signal.aborted) break;
    setProgress(job, "apply", done, total, `清理空目录 ${it.srcPath}`);
    try {
      await withRetry(ctx, async () => {
        const node = it.nodeId ? { id: it.nodeId, isDir: true } : await ctx.provider.resolvePath(it.srcPath, signal);
        if (!node) {
          updateItem(it.id, { status: "skipped", error: "目录已不存在", errorKind: "stale" });
          return;
        }
        const removed = await write.rmdirIfEmpty({ id: node.id, path: it.srcPath, isDir: true }, signal);
        if (removed) {
          updateItem(it.id, { status: "done", nodeId: node.id, finishedAt: now(), error: "", errorKind: "" });
          done++;
          await mirrorRmdir(it.srcPath, { tasks: ctx.tasks, settings });
        } else updateItem(it.id, { status: "skipped", error: provider.kind === "115" ? "目录不是空的（115 的目录信息有几分钟缓存，刚挪走的可能还显示在里面）" : "目录不是空的", errorKind: "transient" });
      });
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      fail(it, err);
    }
  }

  // 4. 收尾
  finishApply(job, runId, { fatal, aborted: signal.aborted });
}

/**
 * 执行的收尾：统计、日志和状态、追更 / 云下载目录改写 + 识别记忆 + Emby 刷新、通知。
 * 取消也走这里（取消多半发生在网盘请求中途，异常从 execute 里抛出来，由 startJob 接住后调它）：
 * 做完的项照样记进统计、收尾照常，只是不发通知
 */
function finishApply(job: Job, runId: string, outcome: { fatal: string | null; aborted: boolean }): void {
  const run = getRun(runId);
  const task = run ? getTask(run.taskId) : null;
  if (!run || !task) return;
  const units = listUnits(runId);
  const items = listItems(runId);
  const stats = computeStats(units, items, "apply");
  const finishedAt = Math.floor(Date.now() / 1000);
  // 收尾这句先进日志再落库，不然页面上的日志里没有它
  if (outcome.fatal) {
    jobLog(job, outcome.fatal);
    updateRun(runId, { status: "failed", error: outcome.fatal, stats, log: job.logs, finishedAt });
  } else if (outcome.aborted) {
    jobLog(job, `已取消：${stats.done} 项完成${stats.pending > 0 ? `，${stats.pending} 项还没做` : ""}${stats.failed > 0 ? `，${stats.failed} 项失败` : ""}`);
    updateRun(runId, { status: "cancelled", error: "已取消", stats, log: job.logs, finishedAt });
  } else {
    jobLog(job, `执行完成：${stats.done} 项完成，${stats.failed} 项失败${stats.failedByKind.mirror > 0 ? `，${stats.failedByKind.mirror} 项本地未同步` : ""}`);
    updateRun(runId, { status: "done", stats, log: job.logs, finishedAt });
  }
  const moved = items.filter((it) => it.status === "done" && (it.action === "rename" || it.action === "move")).length;
  if (moved > 0) {
    afterApply(task, providerForTask(task, "write"), units, items);
    scheduleEmbyRefresh();
  }
  // 路径已经改写好了，等这次整理的复制可以走了（没挪成的照原路径复制）
  releaseHeldCopies(run);
  // 执行过就不能再改单元了，预览留在内存里的单元结构可以放掉
  if (moved > 0 || !outcome.fatal) planStates.delete(runId);
  if (!outcome.aborted) {
    void deps.notify({ type: "organize-done", task, runId, units: stats.units, done: stats.done, failed: stats.failed, failedByKind: stats.failedByKind, notReverted: 0 });
  }
}

interface DirMapping {
  from: string;
  to: string;
  /** 单元根 → 作品目录（识别记忆跟着挪的只有这种） */
  root: boolean;
  /** 这条映射下挪过的文件项：撤销时一个都没退回（源目录还不在）就不把落点改回去 */
  items: OrganizeItem[];
}

/**
 * 整理把目录腾空删掉后，追更 / 云下载回执的落点要跟过去的映射（撤销时反过来用）：
 *   - 腾空删掉的单元根（剧目录 / 发布目录）→ 作品目录；
 *   - 腾空删掉的其它目录，里面直接放着的项都挪进了同一个目录（`某剧/season2` → `作品目录/Season 02`）→ 那个目录。
 *     范围直接选在季目录上时单元根是上一级、不会被删，指着这个季目录的追更靠这一条跟过去。
 * 长的 from 排在前面：改写取第一个命中的，`某剧/season2` 要先于 `某剧`
 */
function dirMappings(task: TaskDefinition, units: OrganizeUnit[], items: OrganizeItem[], removed: Set<string>): DirMapping[] {
  const out: DirMapping[] = [];
  const isFile = (it: OrganizeItem) => it.action === "rename" || it.action === "move";
  for (const u of units) {
    if (u.match && u.dstRoot && u.rootPath && removed.has(u.rootPath) && u.rootPath !== u.dstRoot) {
      out.push({ from: u.rootPath, to: u.dstRoot, root: true, items: items.filter((it) => it.unitKey === u.key && isFile(it)) });
    }
  }
  const roots = new Set(out.map((m) => m.from));
  const targets = new Map<string, { to: Set<string>; items: OrganizeItem[] }>();
  for (const it of items) {
    if (it.action !== "move") continue;
    const from = dirOf(relOf(task, it.srcPath));
    if (!removed.has(from) || roots.has(from)) continue;
    const t = targets.get(from) ?? { to: new Set<string>(), items: [] };
    t.to.add(dirOf(relOf(task, it.dstPath)));
    t.items.push(it);
    targets.set(from, t);
  }
  for (const [from, t] of targets) if (t.to.size === 1) out.push({ from, to: [...t.to][0], root: false, items: t.items });
  return out.sort((a, b) => b.from.length - a.from.length);
}

/** 收尾：追更 / 云下载回执的目录改写、识别记忆（先把旧记忆挪到新路径，再写这次确认的，新的才不会被旧的盖掉） */
function afterApply(task: TaskDefinition, provider: DriveProvider, units: OrganizeUnit[], items: OrganizeItem[]): void {
  const removedDirs = new Set(items.filter((it) => it.action === "rmdir" && it.status === "done").map((it) => relOf(task, it.srcPath)));
  const mappings = dirMappings(task, units, items, removedDirs);
  for (const m of mappings) if (m.root) repathMatches(provider.account.name, absOf(task, m.from), absOf(task, m.to));
  for (const u of units) {
    if (!u.match || !u.dstRoot || !u.remember) continue;
    rememberMatch({
      accountName: provider.account.name,
      srcPath: absOf(task, u.dstRoot),
      mediaType: u.match.mediaType,
      tmdbId: u.match.tmdbId,
      title: u.match.title,
      year: u.match.year,
      season: u.seasonOverride,
      episodeOffset: u.episodeOffset,
    });
  }
  // 复制队列按文件跟：整理最常见的是「一集挪进作品目录、顺手改名」，所在目录没腾空，目录级映射里没有它
  const fileMoves = movedFiles(task, items, "done");
  if (mappings.length === 0 && fileMoves.length === 0) return;
  const rewritten =
    (mappings.length > 0 ? rewriteFollowSubPaths(task.id, mappings).length + rewriteOfflineSubPaths(task.id, mappings).length : 0) +
    rewriteCopyPaths(task.id, task.originPath, mappings, false, copyLayout, fileMoves, removedDirs).length;
  if (rewritten > 0) log.info({ taskId: task.id, rewritten }, "整理后改写了追更 / 云下载回执 / 复制队列里的路径");
}

/** 这次真正挪过 / 改过名的文件（任务相对路径）；撤销时反过来：已退回的项从目标回到原处 */
function movedFiles(task: TaskDefinition, items: OrganizeItem[], how: "done" | "reverted"): CopyMove[] {
  return items
    .filter((it) => (it.action === "rename" || it.action === "move") && it.status === how)
    .map((it) =>
      how === "done"
        ? { from: relOf(task, it.srcPath), to: relOf(task, it.dstPath) }
        : { from: relOf(task, it.dstPath), to: relOf(task, it.srcPath) },
    );
}

/**
 * 自动整理这次到头了（执行完、没有要动的、留着等人确认、失败或取消）：
 * 在它开始之前登记、为等它而压着的复制放行。createdAt 只到秒，同一秒登记的也算进来
 */
function releaseHeldCopies(run: Pick<OrganizeRun, "taskId" | "createdAt">): void {
  const n = releaseCopyHolds(run.taskId, (run.createdAt + 1) * 1000);
  if (n > 0) log.info({ taskId: run.taskId, released: n }, "自动整理办完，放行压着的复制");
}

/**
 * 能不能（再）执行。ready 的执行全部；done / failed / cancelled 的重试失败和没做的项（默认只重试临时失败，
 * stale / rejected 要用户点名）；开始撤销的 run 不能再执行。count 是会做的项数
 */
export function applicability(run: OrganizeRun, ids?: string[], known?: { items: OrganizeItem[]; units: OrganizeUnit[] }): OrganizeRunDetail["applicable"] {
  if (run.stage === "revert") return { ok: false, reason: "这次整理已经开始撤销，只能继续撤销", count: 0 };
  if (run.status === "ready") return run.stats.planned > 0 ? { ok: true, count: run.stats.planned } : { ok: false, reason: "没有要动的项", count: 0 };
  if (!["done", "failed", "cancelled"].includes(run.status)) return { ok: false, reason: `当前状态（${run.status}）不能执行`, count: 0 };
  const all = known?.items ?? listItems(run.id);
  // 从没执行过的（待执行的预览被取消 / 被新的预览取代）：所有项都是 pending，那不是「没做完」，要执行就重新预览
  if (!all.some((it) => it.attempts > 0)) return { ok: false, reason: "这次预览没有执行过；要执行请重新预览", count: 0 };
  const active = activeItemFilter(run.id, known?.units);
  const items = all.filter(active);
  if (ids) {
    const set = new Set(ids);
    const count = items.filter((it) => set.has(it.id) && retryableItem(it, true)).length;
    return count > 0 ? { ok: true, count } : { ok: false, reason: "这些项没有可以重试的", count: 0 };
  }
  // 「目录不是空的」这种顺带再看一眼的 rmdir 不算有事可做，也不进按钮上的数字
  const retry = items.filter((it) => retryableItem(it) && !(it.action === "rmdir" && it.status === "skipped"));
  if (retry.length === 0) return { ok: false, reason: "没有要重试的项", count: 0 };
  return { ok: true, count: retry.length };
}

export async function applyRun(runId: string, ids?: string[]): Promise<OrganizeRun> {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  if (jobs.has(runId)) throw new HttpError(409, "这次整理正在进行中");
  assertNoOps(runId);
  const can = applicability(run, ids);
  if (!can.ok) throw new HttpError(409, can.reason ?? "不能执行");
  const busy = listRunsByStatus(["applying", "reverting", "planning"]).find((r) => r.taskId === run.taskId);
  if (busy) throw new HttpError(409, `任务已有一次整理在进行中（${busy.id}）`, { runId: busy.id });
  updateRun(runId, { status: "applying", error: "", startedAt: run.startedAt ?? Math.floor(Date.now() / 1000), finishedAt: null });
  startJob(
    runId,
    (job) => execute(job, runId, ids ? new Set(ids) : null),
    (job) => finishApply(job, runId, { fatal: null, aborted: true }),
  );
  return getRun(runId)!;
}

export function cancelRun(runId: string): OrganizeRun {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  const job = jobs.get(runId);
  if (job) {
    job.abort.abort();
    return run;
  }
  if (run.status === "ready") {
    updateRun(runId, { status: "cancelled", finishedAt: Math.floor(Date.now() / 1000) });
    planStates.delete(runId);
  }
  return getRun(runId)!;
}

/**
 * 按原范围、原触发来源重新预览：建一个新的手动预览（不自动执行、不发待确认通知）。新增路径的 run 保留新增路径的语义，
 * 触发来源也照旧（界面上还是「转存 / 监控 …的 N 个新增路径」）
 */
export async function repreviewRun(runId: string): Promise<OrganizeRun> {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  return createRun({ taskId: run.taskId, subPath: run.scopePath, paths: run.scopePaths.length > 0 ? run.scopePaths : undefined, mode: "manual", trigger: run.trigger });
}

export function deleteRun(runId: string): void {
  if (jobs.has(runId)) throw new HttpError(409, "这次整理正在进行中，先取消");
  assertNoOps(runId);
  planStates.delete(runId);
  if (!deleteRunRow(runId)) throw new HttpError(404, "整理记录不存在");
}

/* ------------------------------- 放弃 ------------------------------- */

/**
 * 把失败项标成「已放弃」，让 run 收口。原则：放弃 = 用一步把文件放回干净位置，没有这一步的只能重试。
 *   - 执行失败、文件还在原处：直接放弃
 *   - 执行时原地改了名还没挪走：先在网盘上改回原名，成功才放弃
 *   - 网盘成功、本地没跟上：放弃就是不再补本地（状态照旧），可用全量同步 / 体检补齐
 *   - 撤销失败、文件还在整理后的位置：放弃撤销，文件留在那里
 *   - 撤销时挪回来了还没改回原名：不给放弃（改回原名就是失败的那一步），只能继续撤销
 *   - 放弃建目录项时，连带放弃要进这个目录的项（不然它们下次重试全变 stale）
 */
export async function skipItems(runId: string, ids: string[]): Promise<OrganizeSkipResult> {
  // 放弃要在网盘上改回原名（有 await）：这期间不许执行 / 撤销 / 删除，也不许再来一次放弃
  assertNoOps(runId);
  const end = beginOp(runId);
  try {
    return await giveUpItems(runId, ids);
  } finally {
    end();
  }
}

async function giveUpItems(runId: string, ids: string[]): Promise<OrganizeSkipResult> {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  if (jobs.has(runId)) throw new HttpError(409, "这次整理正在进行中");
  if (!["done", "failed", "cancelled", "reverted"].includes(run.status)) throw new HttpError(409, `当前状态（${run.status}）没有可以放弃的项；待执行的整理用勾选来排除`);
  const task = getTask(run.taskId);
  if (!task) throw new HttpError(404, "任务已不存在");
  const all = listItems(runId);
  const wanted = new Set(ids);
  // 放弃建目录项时连带要进这个目录的项：按祖先目录查，不用 n × m 比前缀
  const givenDirs = new Set(all.filter((it) => wanted.has(it.id) && it.action === "mkdir" && it.status === "failed").map((it) => it.dstPath));
  if (givenDirs.size > 0) {
    for (const child of all) {
      if (!(child.action === "rename" || child.action === "move") || !(child.status === "pending" || child.status === "failed")) continue;
      for (let dir = dirOf(child.dstPath); dir; dir = dirOf(dir)) {
        if (givenDirs.has(dir)) {
          wanted.add(child.id);
          break;
        }
      }
    }
  }
  const result: OrganizeSkipResult = { skipped: 0, renamedBack: 0, refused: [] };
  const now = () => Math.floor(Date.now() / 1000);
  let ctx: ListCtx | null = null;
  const give = (it: OrganizeItem, error: string, extra: Partial<Pick<OrganizeItem, "errorKind">> = {}) => {
    updateItem(it.id, { status: "skipped", error, curPath: "", finishedAt: now(), givenUp: true, ...extra });
    result.skipped++;
  };
  const refuse = (it: OrganizeItem, reason: string) => result.refused.push({ id: it.id, reason });
  for (const it of all) {
    if (!wanted.has(it.id) || it.givenUp) {
      if (wanted.has(it.id)) refuse(it, "已经放弃过了");
      continue;
    }
    const isFile = it.action === "rename" || it.action === "move";
    if (it.curPath && it.status !== "done") {
      // 执行时原地改了名还没挪走的（不管现在是哪个阶段）：先在网盘上改回原名，网盘上才是干净的
      ctx ??= listCtx(providerForTask(task, "write"), new AbortController().signal);
      try {
        const names = await namesIn(ctx, dirOf(it.curPath));
        const node = names.get(baseOf(it.curPath));
        if (!node) {
          give(it, `已放弃：文件已不在改名后的位置（${it.error}）`, { errorKind: "stale" });
          continue;
        }
        // 原名已经被别的文件占了就改不回去（网盘要么拒绝要么加 (1)），留给用户处理
        if (occupied(names, baseOf(it.srcPath), node.id)) throw clashError("原位置", baseOf(it.srcPath));
        await ctx.provider.write!.rename({ id: node.id, path: it.curPath, isDir: node.isDir }, baseOf(it.srcPath), ctx.signal);
        noteRenamed(ctx, dirOf(it.curPath), baseOf(it.curPath), baseOf(it.srcPath), node);
        result.renamedBack++;
        give(it, `已放弃：${it.error || "改回了原名"}`);
      } catch (err) {
        if (isAbortError(err)) throw err;
        const kind = classifyFailure(ctx.provider, err);
        updateItem(it.id, { error: `改回原名失败：${messageOf(err)}`, errorKind: kind });
        refuse(it, `改回原名失败：${messageOf(err)}`);
      }
      continue;
    }
    if (run.stage === "apply" && (it.status === "failed" || (it.status === "pending" && WORK_ACTIONS.has(it.action)))) {
      give(it, it.status === "failed" ? `已放弃：${it.error}` : "已放弃：没有执行");
      continue;
    }
    if (it.errorKind === "mirror" && (it.status === "done" || it.status === "reverted")) {
      // 网盘那步是对的，状态和类别都不变（监控见到自有事件仍会把本地补回来）；只是不再当失败项提醒
      updateItem(it.id, { error: `已放弃：本地未同步，可用全量同步或体检补齐（${it.error}）`, givenUp: true });
      result.skipped++;
      continue;
    }
    if (run.stage === "revert" && isFile) {
      if (it.status === "done" && it.errorKind) {
        if (it.curPath) {
          refuse(it, "已挪回但还没改回原名，只能继续撤销");
          continue;
        }
        // 文件留在整理后的位置：done 就是在那里，状态不变，只标放弃
        updateItem(it.id, { error: `已放弃撤销，文件留在整理后的位置（${it.error}）`, givenUp: true });
        result.skipped++;
        continue;
      }
      if (it.status === "failed") {
        give(it, `已放弃：${it.error}`);
        continue;
      }
    }
    refuse(it, "这一项没有需要放弃的失败");
  }
  // 放弃之后没剩下要人处理的（本地没跟上的除外，执行本来就不因它算失败）：中断的 run 收口成 done / reverted。
  // 不能只看默认重试集是不是空的：stale / rejected 的失败项不在默认重试集里，它们还在就不算收口
  const items = listItems(runId);
  const units = listUnits(runId);
  const stats = computeStats(units, items, run.stage);
  let status = run.status;
  if (run.stage === "apply" && (run.status === "failed" || run.status === "cancelled") && failureGroups(run, items, units).every((g) => g.key === "mirror")) status = "done";
  if (run.stage === "revert" && (run.status === "failed" || run.status === "cancelled") && !items.some((it) => revertWorkItem(it))) status = "reverted";
  updateRun(runId, { stats, status, ...(status !== run.status ? { error: "" } : {}) });
  return result;
}

/* ------------------------------- 撤销 ------------------------------- */

export function revertability(run: OrganizeRun, items: OrganizeItem[] = listItems(run.id)): OrganizeRunDetail["revertable"] {
  if (!["done", "failed", "cancelled", "reverted"].includes(run.status)) return { ok: false, reason: "只有执行过的整理能撤销" };
  // 没执行过文件的不用撤；撤销中断过的连没删的自建目录也算还有事
  if (!items.some((it) => (run.stage === "revert" ? revertWorkItem(it) : revertPendingItem(it)))) {
    if (run.stage !== "revert" && items.some((it) => it.action === "delete" && it.status === "done")) return { ok: false, reason: "这次整理只删了文件，删掉的退不回来（在网盘回收站里找）" };
    return { ok: false, reason: run.stage === "revert" ? "已经全部退回" : "这次整理没有改动任何文件" };
  }
  // 后面的整理动过这次挪好的文件：文件已经被它挪走了，得先撤它。不相干的后续整理（别的目录、自动整理的新一集）不挡
  const blocker = laterRunTouching(run);
  if (blocker) return { ok: false, reason: "后面的一次整理又动过这次整理挪好的文件，先撤销那一次", blockedBy: blocker };
  return { ok: true };
}

/**
 * 撤销时文件项的先后：A 的原名现在被本轮还没退回的 B 占着（同一个原目录里，B 现在的名字就是 A 的原名）就等 B 先退。
 * 连环改名（集偏移）正着做是 E03→E04 先改，倒回来得 E01←E02 先退，不然 E02←E03 退回时会撞上自己人；
 * 跨目录挪回时 B 是先顶着现在的名字挪回来（中间名）再改回原名，规则一样。A 挪回来的中间名撞上还在原目录里的 B 也等 B。
 * 转圈互占的（A↔B 互换）退不了，单列出来记 rejected。目录项位置不动（删空目录要在文件退回之后）
 */
function orderRevert(items: OrganizeItem[]): { ordered: OrganizeItem[]; stuck: OrganizeItem[] } {
  const isFile = (it: OrganizeItem) => (it.action === "rename" || it.action === "move") && it.status !== "reverted";
  const files = items.filter(isFile);
  if (files.length < 2) return { ordered: items, stuck: [] };
  const home = (it: OrganizeItem) => dirOf(it.srcPath);
  const nowName = (it: OrganizeItem) => baseOf(it.curPath || it.dstPath);
  const inHome = (it: OrganizeItem) => it.curPath !== "" || dirOf(it.dstPath) === home(it);
  // 原目录 + 现在的名字 → 项：查「谁占着我的原名」不用每项扫一遍全表（一次整理可以有几千项）
  const holders = new Map<string, OrganizeItem[]>();
  for (const it of files) {
    const key = `${home(it)}/${nowName(it)}`;
    holders.set(key, [...(holders.get(key) ?? []), it]);
  }
  const left = new Set(files.map((it) => it.id));
  const heldBy = (dir: string, name: string, a: OrganizeItem, extra?: (b: OrganizeItem) => boolean) => (holders.get(`${dir}/${name}`) ?? []).some((b) => b.id !== a.id && left.has(b.id) && (!extra || extra(b)));
  const waits = (a: OrganizeItem) => heldBy(home(a), baseOf(a.srcPath), a) || (!inHome(a) && heldBy(home(a), nowName(a), a, inHome));
  const ordered: OrganizeItem[] = [];
  while (left.size > 0) {
    const round = files.filter((a) => left.has(a.id) && !waits(a));
    if (round.length === 0) break;
    for (const it of round) {
      ordered.push(it);
      left.delete(it.id);
    }
  }
  let i = 0;
  return { ordered: items.filter((it) => !isFile(it) || !left.has(it.id)).map((it) => (isFile(it) ? ordered[i++] : it)), stuck: files.filter((it) => left.has(it.id)) };
}

/**
 * 按流水账逆序退回（文件项之间再按 orderRevert 排先后）。状态只描述文件在哪：网盘那步失败的项保持 done（文件还在整理后的位置 / 中间位置），
 * 只记原因，下次撤销自然包含；文件已经不在整理后的位置 / 被别的文件占了的记成 failed + stale（不再归整理管，可以放弃）。
 * move 项先挪回再改名，挪回之后把中间位置记进 cur_path，改名失败下次只改名
 */
async function revert(job: Job, runId: string): Promise<void> {
  const run = getRun(runId)!;
  const task = getTask(run.taskId);
  if (!task) throw new Error("任务已不存在");
  const provider = providerForTask(task, "write");
  const write = provider.write!;
  const settings = readAppSettings();
  const signal = job.abort.signal;
  const ctx: ExecCtx = { ...listCtx(provider, signal), job, task, settings, tasks: accountTasks(provider.account.name) };
  const { ordered: items, stuck } = orderRevert(listItems(runId).filter((it) => revertWorkItem(it, true)).reverse());
  const now = () => Math.floor(Date.now() / 1000);
  let n = 0;
  let fatal: string | null = null;
  bumpAttempts([...items, ...stuck].map((it) => it.id));
  jobLog(job, `开始撤销：${items.length + stuck.length} 项`);
  // 用户选了删除 / 覆盖的项已经进了网盘回收站，这里退不回来，只说一声
  const deleted = listItems(runId).filter((it) => it.action === "delete" && it.status === "done").length;
  if (deleted > 0) jobLog(job, `其中 ${deleted} 项是删掉的文件，退不回来（在网盘回收站里找）`);

  const failRevert = (it: OrganizeItem, err: unknown) => {
    const kind = classifyFailure(provider, err);
    const msg = messageOf(err);
    // 撤销侧的结果都是新账：放弃过本地镜像的项这次在网盘上没退回，要重新当失败项提醒
    updateItem(it.id, { error: msg, errorKind: kind, givenUp: false });
    jobLog(job, `撤销失败 ${it.dstPath}：${msg}（${FAILURE_LABEL[kind]}）`);
    if (kind === "blocked") fatal = `网盘拒绝了请求（${msg}），撤销已停下`;
  };
  for (const it of stuck) failRevert(it, new OrganizeFailure("rejected", new Error(`和本轮别的文件互相占着名字，退不回 ${baseOf(it.srcPath)}`)));
  const lost = (it: OrganizeItem, msg: string) => {
    updateItem(it.id, { status: "failed", error: msg, errorKind: "stale", curPath: "", finishedAt: now(), givenUp: false });
    jobLog(job, `${msg}：${it.dstPath}`);
  };
  /** 撤销侧的本地镜像：文件可能还在 `源目录/新名字`（先挪回再改名的窗口里监控动了本地） */
  const mirrorBack = async (it: OrganizeItem, alt?: string): Promise<string> => {
    try {
      await mirrorRelocate({ oldPath: it.dstPath, newPath: it.srcPath, isDir: false, oldPathAlt: alt ?? intermediateOf(it) }, { tasks: ctx.tasks, settings });
      return "";
    } catch (err) {
      const msg = `本地镜像失败：${describeFileFailure(err, { relPath: relOf(task, it.srcPath), kind: "strm", context: "mirror" })}`;
      jobLog(job, `${msg}（${it.srcPath}）`);
      return msg;
    }
  };
  const ensureDir = async (abs: string): Promise<string> => {
    const hit = ctx.dirIds.get(abs);
    if (hit) return hit;
    const node = await ctx.provider.resolvePath(abs, signal);
    if (node?.isDir) {
      ctx.dirIds.set(abs, node.id);
      return node.id;
    }
    const parent = normalizePath(splitPath(abs).slice(0, -1).join("/"));
    const pid = await ensureDir(parent);
    const made = await write.mkdir({ id: pid, path: parent }, baseOf(abs), signal);
    ctx.dirIds.set(abs, made.id);
    return made.id;
  };
  const renameBack = async (it: OrganizeItem, at: string): Promise<boolean> => {
    if (!at) return false;
    const node = await withRetry(ctx, () => ctx.provider.resolvePath(at, signal));
    if (!node) return false;
    // 原名已经被别的文件占了：网盘要么拒绝要么自己加 (1)，都不是退回
    const names = await withRetry(ctx, () => namesIn(ctx, dirOf(at)));
    if (occupied(names, baseOf(it.srcPath), node.id)) throw clashError("原位置", baseOf(it.srcPath));
    await withRetry(ctx, () => write.rename({ id: node.id, path: at, isDir: node.isDir }, baseOf(it.srcPath), signal));
    noteRenamed(ctx, dirOf(at), baseOf(at), baseOf(it.srcPath), node);
    return true;
  };

  for (const it of items) {
    if (fatal || signal.aborted) break;
    setProgress(job, "revert", n, items.length, `退回 ${it.dstPath}`);
    try {
      if (it.status === "reverted") {
        // 已经退回了、只是本地没跟上：补本地
        const error = await mirrorBack(it);
        updateItem(it.id, { error, errorKind: error ? "mirror" : "" });
        if (!error) n++;
        continue;
      }
      if (it.curPath && it.status !== "done") {
        // 执行时只改了名还没挪走的（pending / failed 带 curPath）：改回去就行，本地没动过
        if (!(await renameBack(it, it.curPath))) {
          lost(it, "文件已不在改名后的位置");
          continue;
        }
        updateItem(it.id, { status: "reverted", finishedAt: now(), curPath: "", error: "", errorKind: "" });
        n++;
        continue;
      }
      if (it.action === "rename" || it.action === "move") {
        if (it.curPath) {
          // 上次撤销挪回来了、还没改回原名
          if (!(await renameBack(it, it.curPath))) {
            lost(it, "文件已不在挪回的位置");
            continue;
          }
          const error = await mirrorBack(it, it.curPath);
          updateItem(it.id, { status: "reverted", finishedAt: now(), curPath: "", error, errorKind: error ? "mirror" : "", givenUp: false });
          n++;
          continue;
        }
        // 整理后的目录列一次（本轮缓存、绕过网盘客户端的缓存），比每个文件 resolvePath 一次省；目录本身没了文件当然也没了
        let node: DirEntryRef | undefined;
        try {
          node = (await withRetry(ctx, () => namesIn(ctx, dirOf(it.dstPath)))).get(baseOf(it.dstPath));
        } catch (err) {
          if (!(err instanceof OrganizeFailure && err.kind === "stale")) throw err;
        }
        if (!node) {
          lost(it, "文件已不在整理后的位置");
          continue;
        }
        if (it.nodeId && node.id !== it.nodeId && provider.kind !== "openlist") {
          lost(it, "整理后的位置上已经是另一个文件");
          continue;
        }
        let cur: WriteNode = { id: node.id, path: it.dstPath, isDir: node.isDir };
        const needRename = baseOf(it.dstPath) !== baseOf(it.srcPath);
        const crossDir = dirOf(it.dstPath) !== dirOf(it.srcPath);
        const home = dirOf(it.srcPath);
        const toId = crossDir ? await withRetry(ctx, () => ensureDir(home)) : "";
        // 原位置又有了同名文件（现在的名字或原名）：网盘要么拒绝要么自己加 (1)，都不是退回，先看一眼
        const names = await withRetry(ctx, () => namesIn(ctx, home));
        const clash = (crossDir ? [baseOf(it.dstPath), baseOf(it.srcPath)] : [baseOf(it.srcPath)]).find((n) => occupied(names, n, node.id));
        if (clash) throw clashError("原位置", clash);
        if (crossDir) {
          const [moved] = await withRetry(ctx, () => write.move([cur], { id: toId, path: home }, signal));
          cur = { id: moved.id, path: `${home}/${baseOf(it.dstPath)}`, isDir: cur.isDir };
          noteMoved(ctx, dirOf(it.dstPath), home, baseOf(it.dstPath), { id: moved.id, isDir: cur.isDir });
          // 挪回来了、还没改回原名：记住中间位置，改名失败下次只改名
          if (needRename) updateItem(it.id, { curPath: cur.path, nodeId: moved.id });
        }
        if (needRename) {
          await withRetry(ctx, () => write.rename(cur, baseOf(it.srcPath), signal));
          noteRenamed(ctx, home, baseOf(it.dstPath), baseOf(it.srcPath), { id: cur.id, isDir: cur.isDir });
        }
        const error = await mirrorBack(it);
        updateItem(it.id, { status: "reverted", finishedAt: now(), curPath: "", error, errorKind: error ? "mirror" : "", givenUp: false });
        n++;
      } else if (it.action === "mkdir") {
        // 建过的目录（done，或上一轮因为不空留下的 skipped）：空了就删
        const node = await withRetry(ctx, () => ctx.provider.resolvePath(it.dstPath, signal));
        if (node?.isDir && (await withRetry(ctx, () => write.rmdirIfEmpty({ id: node.id, path: it.dstPath, isDir: true }, signal)))) {
          await mirrorRmdir(it.dstPath, { tasks: ctx.tasks, settings });
          updateItem(it.id, { status: "reverted", finishedAt: now(), error: "", errorKind: "" });
          n++;
        } else updateItem(it.id, { status: "skipped", error: node ? "目录不是空的，留着" : "目录已不存在", errorKind: "" });
      } else if (it.action === "rmdir") {
        // 目录会在挪回文件时按需重建，这里不用做什么
        updateItem(it.id, { status: "reverted", finishedAt: now(), error: "", errorKind: "" });
      }
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      failRevert(it, err);
    }
  }

  if (!fatal && !signal.aborted) await sweepLeftoverDirs(job, ctx, run, runId);

  // n 是这一轮做成的，只用来决定刷不刷 Emby
  finishRevert(job, runId, { fatal, aborted: signal.aborted, refresh: n > 0 });
}

/**
 * 撤销放宽之后可以先撤前面的整理：它建的目录当时装着后面这次放进去的文件，只能留着（skipped「目录不是空的，留着」），
 * 前面那次也就撤完了、没有再撤的机会。后面这次撤销把文件挪走以后，这些目录空了就顺手删掉，前面那次的记账跟着改成已退回；
 * 还有别的东西（用户自己放的）就接着留着
 */
async function sweepLeftoverDirs(job: Job, ctx: ExecCtx, run: OrganizeRun, runId: string): Promise<void> {
  const dirs = new Set<string>();
  for (const it of listItems(runId)) {
    if (it.status !== "reverted" || (it.action !== "rename" && it.action !== "move")) continue;
    for (let d = dirOf(it.dstPath); splitPath(d).length > 0; d = dirOf(d)) dirs.add(d);
  }
  const left = listLeftoverDirs(run.taskId, runId, [...dirs]).sort((a, b) => b.dstPath.length - a.dstPath.length);
  if (left.length === 0) return;
  const write = ctx.provider.write!;
  const signal = job.abort.signal;
  const touched = new Set<string>();
  for (const it of left) {
    try {
      const node = await withRetry(ctx, () => ctx.provider.resolvePath(it.dstPath, signal));
      if (!node?.isDir || !(await withRetry(ctx, () => write.rmdirIfEmpty({ id: node.id, path: it.dstPath, isDir: true }, signal)))) continue;
      await mirrorRmdir(it.dstPath, { tasks: ctx.tasks, settings: ctx.settings });
      updateItem(it.id, { status: "reverted", finishedAt: Math.floor(Date.now() / 1000), error: "", errorKind: "" });
      touched.add(it.runId);
      jobLog(job, `前面整理留下的空目录一起删了：${it.dstPath}`);
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      jobLog(job, `前面整理留下的目录没删掉 ${it.dstPath}：${messageOf(err)}`);
    }
  }
  for (const id of touched) updateRun(id, { stats: computeStats(listUnits(id), listItems(id), "revert") });
}

/**
 * 撤销的收尾：追更 / 云下载目录和识别记忆改回去、统计、日志和状态、Emby 刷新、通知。取消也走这里（见 finishApply）。
 * 「退回了几项」和执行时的「项完成」同一个口径：累计、建目录 / 删目录也算
 */
function finishRevert(job: Job, runId: string, outcome: { fatal: string | null; aborted: boolean; refresh: boolean }): void {
  const run = getRun(runId);
  const task = run ? getTask(run.taskId) : null;
  if (!run || !task) return;
  const units = listUnits(runId);
  const items = listItems(runId);
  afterRevert(task, providerForTask(task, "write"), units, items);
  const stats = computeStats(units, items, "revert");
  const left = stats.notReverted > 0 ? `，${stats.notReverted} 项没退回` : "";
  const status = outcome.fatal ? "failed" : outcome.aborted ? "cancelled" : "reverted";
  jobLog(job, outcome.fatal ?? (outcome.aborted ? `已取消：退回 ${stats.reverted} 项${left}` : `撤销完成：退回 ${stats.reverted} 项${left}`));
  updateRun(runId, { status, error: outcome.fatal ?? (outcome.aborted ? "已取消" : ""), stats, log: job.logs, finishedAt: Math.floor(Date.now() / 1000) });
  planStates.delete(runId);
  if (outcome.refresh) scheduleEmbyRefresh();
  if (!outcome.aborted) {
    void deps.notify({ type: "organize-done", task, runId, units: stats.units, done: stats.reverted, failed: stats.failed, reverted: true, failedByKind: stats.failedByKind, notReverted: stats.notReverted });
  }
}

/** 撤销的收尾：腾空过的源目录退回来了，追更 / 云下载回执的目录和识别记忆也改回去 */
function afterRevert(task: TaskDefinition, provider: DriveProvider, units: OrganizeUnit[], items: OrganizeItem[]): void {
  const removedDirs = new Set(items.filter((it) => it.action === "rmdir").map((it) => relOf(task, it.srcPath)));
  // 非单元根的只认这次新建出来的目标目录：原来就有的目录，别的追更本来就可能指着它，不能拽回来
  const created = new Set(items.filter((it) => it.action === "mkdir").map((it) => relOf(task, it.dstPath)));
  const back = dirMappings(task, units, items, removedDirs)
    .filter((m) => m.root || created.has(m.to))
    // 这条映射下一个文件都没退回（撤销被取消、在网盘上失败、已经找不到）：源目录还不在，追更 / 云下载继续指着作品目录
    .filter((m) => m.items.some((it) => it.status === "reverted"))
    .map((m) => ({ from: m.to, to: m.from, root: m.root }))
    .sort((a, b) => b.from.length - a.from.length);
  const fileMoves = movedFiles(task, items, "reverted");
  if (back.length === 0 && fileMoves.length === 0) return;
  if (back.length > 0) {
    rewriteFollowSubPaths(task.id, back);
    rewriteOfflineSubPaths(task.id, back);
  }
  rewriteCopyPaths(task.id, task.originPath, back, false, copyLayout, fileMoves);
  for (const m of back) if (m.root) repathMatches(provider.account.name, absOf(task, m.from), absOf(task, m.to));
}

export async function revertRun(runId: string): Promise<OrganizeRun> {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  if (jobs.has(runId)) throw new HttpError(409, "这次整理正在进行中");
  assertNoOps(runId);
  const ok = revertability(run);
  if (!ok.ok) throw new HttpError(409, ok.reason ?? "不能撤销");
  const busy = listRunsByStatus(["applying", "reverting", "planning"]).find((r) => r.taskId === run.taskId);
  if (busy) throw new HttpError(409, `任务已有一次整理在进行中（${busy.id}）`, { runId: busy.id });
  updateRun(runId, { status: "reverting", stage: "revert", error: "", finishedAt: null });
  startJob(
    runId,
    (job) => revert(job, runId),
    (job) => finishRevert(job, runId, { fatal: null, aborted: true, refresh: true }),
  );
  return getRun(runId)!;
}

/* ------------------------------- 查询 ------------------------------- */

function withProgress(run: OrganizeRun): OrganizeRun {
  const job = jobs.get(run.id);
  return job ? { ...run, progress: job.progress, log: job.logs.slice(-ORGANIZE_LIMITS.LOG_LINES) } : run;
}

export function listRuns(opts: { taskId?: string; limit?: number; offset?: number } = {}): OrganizeRun[] {
  return listRunRows(opts).map(withProgress);
}

/**
 * 失败面板的分组，按「下一步该做什么」分；和 retryableItem / skipItems 的规则同源，前端只管文案和按钮。
 * 执行阶段：failed 按类别（stale 可以重新预览）、done 但本地没跟上（mirror）、没轮到的 pending；
 * 撤销阶段：网盘那步失败的 done 按类别（挪回了没改名的不能放弃，记在 held）、撤销时找不到的（lost）、已退回但本地没跟上（mirror）
 */
export function failureGroups(run: OrganizeRun, items: OrganizeItem[], units: OrganizeUnit[]): OrganizeFailureGroup[] {
  if (!["done", "failed", "cancelled", "reverted"].includes(run.status)) return [];
  const selected = new Set(units.filter((u) => u.selected && u.match).map((u) => u.key));
  const active = (it: OrganizeItem) => it.unitKey === "" || selected.has(it.unitKey);
  const isFile = (it: OrganizeItem) => it.action === "rename" || it.action === "move";
  const live = items.filter((it) => !it.givenUp);
  const groups: OrganizeFailureGroup[] = [];
  const push = (key: OrganizeFailureGroup["key"], list: OrganizeItem[], actions: Partial<Pick<OrganizeFailureGroup, "retry" | "skip" | "repreview">>, held = 0) => {
    if (list.length > 0) groups.push({ key, itemIds: list.map((it) => it.id), retry: false, skip: false, repreview: false, held, ...actions });
  };
  if (run.stage === "apply") {
    const failed = live.filter((it) => it.status === "failed" && active(it));
    for (const k of ["blocked", "transient", "stale", "rejected"] as const) push(k, failed.filter((it) => (it.errorKind || "transient") === k), { retry: true, skip: true, repreview: k === "stale" });
    push("mirror", live.filter((it) => it.status === "done" && it.errorKind === "mirror"), { retry: true, skip: true });
    // 没做完的只对执行过的 run 说：待执行的预览被取消 / 取代时所有项都是 pending，那不是「没做完」
    if (items.some((it) => it.attempts > 0)) push("pending", live.filter((it) => it.status === "pending" && active(it) && WORK_ACTIONS.has(it.action)), { retry: true, skip: true });
  } else {
    const stuck = live.filter((it) => it.status === "done" && isFile(it) && it.errorKind !== "" && it.errorKind !== "mirror");
    for (const k of ["blocked", "transient", "stale", "rejected"] as const) {
      const list = stuck.filter((it) => it.errorKind === k);
      push(k, list, { retry: true, skip: true }, list.filter((it) => it.curPath !== "").length);
    }
    push("lost", live.filter((it) => it.status === "failed" && it.errorKind === "stale" && isFile(it) && it.finishedAt !== null), { skip: true });
    push("mirror", live.filter((it) => it.status === "reverted" && it.errorKind === "mirror"), { retry: true, skip: true });
  }
  return groups;
}

function summaryOf(run: OrganizeRun, units: OrganizeUnit[], items: OrganizeItem[]): OrganizeRunSummary {
  return {
    run: withProgress(run),
    groups: failureGroups(run, items, units),
    revertable: revertability(run, items),
    applicable: applicability(run, undefined, { items, units }),
    editable: run.status === "ready" && planStates.has(run.id),
    executed: items.some((it) => it.attempts > 0),
    outdated: outdatedOf(run),
  };
}

/** 执行 / 撤销进行中页面轮询它：run（含进度 / 日志）+ 分组 + 按钮开关，不带单元和项 */
export function getRunSummary(runId: string): OrganizeRunSummary {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  return summaryOf(run, listUnits(runId), listItems(runId));
}

/**
 * 单元卡上的数字：详情不带全部项（一次整理最多两万个文件），按单元数好。和单元卡、失败面板同一个口径：
 * 要处理 = 没放弃的 failed，或者 done / reverted 但带着类别（本地没跟上 / 撤销在网盘那步失败）；跳过里用户自己的选择（单元没勾选）不算
 */
function unitCounts(units: OrganizeUnit[], items: OrganizeItem[]): Record<string, OrganizeUnitCounts> {
  const selected = new Map(units.map((u) => [u.key, u.selected && !!u.match]));
  const excluded = new Map(units.map((u) => [u.key, new Set(u.excluded)]));
  const out: Record<string, OrganizeUnitCounts> = {};
  for (const u of units) out[u.key] = { total: 0, changing: 0, conflicts: 0, skipped: 0, keep: 0, failed: 0, done: 0, reverted: 0, excluded: 0 };
  for (const it of items) {
    const c = out[it.unitKey];
    if (!c) continue; // 建目录 / 删空目录另算
    c.total++;
    if (excluded.get(it.unitKey)?.has(it.srcPath)) c.excluded++;
    else if (it.action === "rename" || it.action === "move") c.changing++;
    else if (it.action === "conflict") c.conflicts++;
    else if (it.action === "keep") c.keep++;
    else if (it.action === "skip" && selected.get(it.unitKey)) c.skipped++;
    if (it.status === "done") c.done++;
    if (it.status === "reverted") c.reverted++;
    if (!it.givenUp && (it.status === "failed" || ((it.status === "done" || it.status === "reverted") && it.errorKind !== ""))) c.failed++;
  }
  return out;
}

/** 详情里的单元不带候选的简介：页面用不上，几十部作品 × 八个候选的简介能占满一半的体积 */
const lightUnit = (u: OrganizeUnit): OrganizeUnit =>
  u.match?.candidates?.length ? { ...u, match: { ...u.match, candidates: u.match.candidates.map(({ overview: _overview, ...c }) => c) } } : u;

export function getRunDetail(runId: string): OrganizeRunDetail {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  const units = listUnits(runId);
  const items = listItems(runId);
  return { ...summaryOf(run, units, items), units: units.map(lightUnit), counts: unitCounts(units, items), dirCount: items.filter((it) => it.unitKey === "").length };
}

/** 按需拉项：一个单元的（unitKey 为空是建目录 / 删空目录），或者失败面板的一组 */
export function listRunItems(runId: string, q: { unit?: string; group?: OrganizeFailureGroupKey }): OrganizeItem[] {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  if (q.group === undefined) return listItems(runId, q.unit ?? "");
  const items = listItems(runId);
  const group = failureGroups(run, items, listUnits(runId)).find((g) => g.key === q.group);
  if (!group) return [];
  const ids = new Set(group.itemIds);
  return items.filter((it) => ids.has(it.id));
}

const OLD_PREVIEW_S = 24 * 3600;

/** 待执行的预览是不是旧了：预览之后同任务又有整理 / 撤销落了盘，或者预览超过一天。执行不拦（执行前本来就逐项核对），页面提示重新预览 */
function outdatedOf(run: OrganizeRun): OrganizeRunDetail["outdated"] {
  if (run.status !== "ready") return undefined;
  const changed = changedSince(run.taskId, run.createdAt, run.id);
  if (changed) return { kind: "changed", at: changed.finishedAt, runId: changed.id };
  if (Math.floor(Date.now() / 1000) - run.createdAt > OLD_PREVIEW_S) return { kind: "old", at: run.createdAt };
  return undefined;
}

/** 待处理列表只看最近这么久建的 run（进行中 / 待执行的不限） */
const ATTENTION_WINDOW_S = 30 * 24 * 3600;

/** 一个 run 要不要人管、为什么 */
function attentionOf(run: OrganizeRun): OrganizeAttentionReason | null {
  if (run.status === "ready") return "ready";
  if (run.status === "planning" || run.status === "applying" || run.status === "reverting") return "busy";
  const k = run.stats.failedByKind;
  if (run.stage === "revert") return run.stats.notReverted > 0 || k.mirror > 0 ? "revert" : null;
  const failures = k.transient + k.blocked + k.stale + k.rejected + k.mirror;
  // 做了一半：做过一些（用户中途取消的另算，没做过就取消是他自己不要了）、或者中途停下的（风控 / 重启）
  if (failures > 0 || (run.stats.pending > 0 && (run.stats.done > 0 || run.status === "failed"))) return "failures";
  // 自动触发的预览失败了用户看不到；手动的当场就看到了
  if (run.status === "failed" && run.stats.items === 0 && run.trigger !== "manual") return "preview-failed";
  return null;
}

/** 跨任务列出要人管的 run（整理页的待处理列表、侧栏角标），新的在前；不带日志 */
export function listAttention(limit = 50): OrganizeAttention[] {
  const since = Math.floor(Date.now() / 1000) - ATTENTION_WINDOW_S;
  const seen = new Set<string>();
  const out: OrganizeAttention[] = [];
  const consider = (run: OrganizeRun) => {
    if (seen.has(run.id)) return;
    seen.add(run.id);
    const reason = attentionOf(run);
    if (reason) out.push({ run: { ...withProgress(run), log: [] }, reason });
  };
  for (const r of listRunsByStatus(["planning", "applying", "reverting", "ready"])) consider(r);
  for (const r of listRunRows({ limit: 200 })) if (r.createdAt >= since) consider(r);
  return out.sort((a, b) => b.run.createdAt - a.run.createdAt).slice(0, limit);
}

/** 进程重启：上次没跑完的 run 标失败，用户可以再执行 / 继续撤销（做完的项不会重做）；清单上已经没事可做的直接收口 */
export function reconcileInterruptedRuns(): number {
  const rows = listRunsByStatus(["planning", "applying", "reverting"]);
  for (const r of rows) {
    if (finalizeIfNothingLeft(r)) continue;
    updateRun(r.id, {
      status: "failed",
      error: r.status === "reverting" ? "进程重启，撤销中断了；可以继续撤销（已退回的项不会重做）" : "进程重启，中断了；可以重新执行（已完成的项不会重做）",
      // 统计按清单重算：中断前做完的项要算进去，不然页面和待处理列表还是上一次落库时的数
      stats: computeStats(listUnits(r.id), listItems(r.id), r.stage),
      finishedAt: Math.floor(Date.now() / 1000),
    });
  }
  return rows.length;
}

/**
 * 进程在最后一项做完、还没写 run 状态时重启：标成 failed 的话「没有要重试的项」，再也执行不了，收尾（追更目录改写、识别记忆）
 * 也永远不跑，还挡着前一次整理的撤销。所以清单上没事可做的按正常结束收口
 */
function finalizeIfNothingLeft(run: OrganizeRun): boolean {
  if (run.status !== "applying" && run.status !== "reverting") return false;
  const task = getTask(run.taskId);
  if (!task) return false;
  const items = listItems(run.id);
  const units = listUnits(run.id);
  let provider: DriveProvider;
  try {
    provider = providerForTask(task, "write");
  } catch {
    return false;
  }
  const finishedAt = Math.floor(Date.now() / 1000);
  if (run.status === "applying") {
    const active = activeItemFilter(run.id, units);
    if (items.some((it) => active(it) && retryableItem(it) && !(it.action === "rmdir" && it.status === "skipped"))) return false;
    if (!items.some((it) => it.status === "done" && WORK_ACTIONS.has(it.action))) return false;
    updateRun(run.id, { status: "done", error: "", stats: computeStats(units, items, "apply"), finishedAt });
    afterApply(task, provider, units, items);
    releaseHeldCopies(run);
  } else {
    if (items.some((it) => revertWorkItem(it))) return false;
    updateRun(run.id, { status: "reverted", error: "", stats: computeStats(units, items, "revert"), finishedAt });
    afterRevert(task, provider, units, items);
  }
  planStates.delete(run.id);
  return true;
}

/** 进程退出：把在跑的都掐掉 */
export function cancelAllRuns(): void {
  for (const job of jobs.values()) job.abort.abort();
}

/** 仅供测试：丢掉内存里的单元结构，模拟进程重启过 */
export function __test_dropPlanState(runId: string): void {
  planStates.delete(runId);
}

export type { OrganizeConfidence };
