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
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  AppSettings,
  OrganizeConfidence,
  OrganizeItem,
  OrganizeMatch,
  OrganizeMediaType,
  OrganizeProgress,
  OrganizeRun,
  OrganizeFailureGroup,
  OrganizeRunDetail,
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
  deleteRun as deleteRunRow,
  emptyStats,
  getRun,
  getUnit,
  hasLaterAppliedRun,
  insertRun,
  listItems,
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
import { readTextCapped } from "../../lib/fs.js";
import { HttpError } from "../../lib/http-error.js";
import { moduleLogger } from "../../lib/logger.js";
import { resolveInDataDir } from "../../paths.js";
import { providerForTask } from "../drive/registry.js";
import { normalizePath, splitPath, type DriveProvider, type WriteNode } from "../drive/types.js";
import { rewriteFollowSubPaths } from "../follow/service.js";
import { scheduleEmbyRefresh } from "../media-server.js";
import { rewriteOfflineSubPaths } from "../offline/service.js";
import { extSet } from "../strm/naming.js";
import { notify } from "../telegram/notify.js";
import { describeFileFailure } from "../download/failure.js";
import { classifyFailure, FAILURE_LABEL, messageOf, OrganizeFailure, retryableItem, revertPendingItem, revertWorkItem, StaleError } from "./failures.js";
import { idTagFromName, identifyUnit, TmdbClient, type IdEvidence, type TmdbApi } from "./identify.js";
import { mirrorRelocate, mirrorRmdir } from "./mirror.js";
import { finalizeItems, planUnit, type PlannedItem, type UnitPlan } from "./plan.js";
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

/** 相对任务 originPath 的路径 → 网盘绝对路径 */
function absOf(task: TaskDefinition, rel: string): string {
  return normalizePath(rel ? `${task.originPath}/${rel}` : task.originPath);
}

/** 网盘绝对路径 → 相对任务 originPath */
function relOf(task: TaskDefinition, abs: string): string {
  const origin = normalizePath(task.originPath);
  const p = normalizePath(abs);
  if (p === origin) return "";
  return p.startsWith(`${origin}/`) ? p.slice(origin.length + 1) : p.replace(/^\//, "");
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
    else if (active) stats.planned++;
    if (it.status === "done") stats.done++;
    if (it.status === "failed") stats.failed++;
    if (it.givenUp) continue;
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
  const scopePaths = (input.paths ?? []).map((p) => splitPath(p).join("/")).filter(Boolean);
  // 范围只能是任务目录之内：`..` 会让本地镜像跑出数据目录
  for (const p of [scopePath, ...scopePaths]) {
    if (splitPath(p).some((seg) => seg === "." || seg === "..")) throw new HttpError(400, `范围路径不合法：${p}`);
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
    trigger: input.trigger ?? "manual",
  });
  startJob(run.id, (job) => preview(job, run.id));
  return getRun(run.id)!;
}

function startJob(runId: string, work: (job: Job) => Promise<void>): Job {
  const job: Job = {
    runId,
    abort: new AbortController(),
    progress: { phase: "idle", done: 0, total: 0, message: "" },
    logs: [],
    done: Promise.resolve(),
  };
  jobs.set(runId, job);
  job.done = work(job)
    .catch((err) => {
      const msg = isAbortError(err) || job.abort.signal.aborted ? "已取消" : messageOf(err);
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

/** 本地 nfo 里的 tmdbid（随片下载的 nfo 才有；网盘上的不读） */
async function nfoEvidence(task: TaskDefinition, unit: Unit): Promise<IdEvidence["known"]> {
  const saveDir = resolveInDataDir(task.targetPath);
  if (!saveDir) return null;
  const candidates: Array<{ rel: string; kind: OrganizeMediaType }> = [];
  for (const f of unit.files) {
    if (f.kind !== "nfo") continue;
    const kind: OrganizeMediaType = /^tvshow\.nfo$/i.test(f.name) ? "tv" : /^movie\.nfo$/i.test(f.name) ? "movie" : unit.kindHint === "movie" ? "movie" : "tv";
    candidates.push({ rel: f.path, kind });
  }
  for (const c of candidates.slice(0, 3)) {
    const text = await readTextCapped(path.join(saveDir, ...c.rel.split("/")), 256 * 1024).catch(() => null);
    if (!text) continue;
    const m = /<tmdbid>\s*(\d+)\s*<\/tmdbid>/i.exec(text) ?? /<uniqueid[^>]*type="tmdb"[^>]*>\s*(\d+)\s*<\/uniqueid>/i.exec(text);
    if (m) return { tmdbId: Number(m[1]), mediaType: c.kind, source: `本地 ${baseOf(c.rel)} 里的 tmdbid` };
  }
  return null;
}

/** 影库条目：转存自影库的目录名和条目的 rawName 一致 */
function libraryEvidence(unit: Unit, entries: ReturnType<typeof listLibraryEntries>): IdEvidence["known"] {
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
): Promise<ScopeEntry[]> {
  const inScope = (rel: string) => roots.some((r) => r === "" || rel === r || rel.startsWith(`${r}/`));
  const dirs = new Set<string>();
  for (const p of plans) for (const it of p.items) if ((it.action === "rename" || it.action === "move") && !inScope(dirOf(it.dstPath))) dirs.add(dirOf(it.dstPath));
  // 只列最深的那些目录：它存在就顺便说明祖先都存在；不存在就往上找到第一个存在的祖先列出来
  const known = new Set(entries.map((e) => e.path));
  const out: ScopeEntry[] = [];
  const listed = new Set<string>();
  for (const dir of [...dirs].sort()) {
    let cur = dir;
    while (cur && !inScope(cur) && !listed.has(cur)) {
      signal.throwIfAborted();
      const node = await provider.resolvePath(absOf(task, cur), signal);
      if (node?.isDir) {
        listed.add(cur);
        if (!known.has(cur)) out.push({ path: cur, isDir: true, id: node.id });
        for (const e of await provider.listDir(node.id, signal)) {
          const p = joinRel(cur, e.name);
          if (!known.has(p)) {
            known.add(p);
            out.push({ path: p, isDir: e.isDir, id: e.id, size: e.size });
          }
        }
        break;
      }
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
    notes: plan?.notes ?? unit.notes,
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
  jobLog(job, `开始预览：${task.originPath}${run.scopePath ? `/${run.scopePath}` : ""}${run.scopePaths.length ? `（${run.scopePaths.length} 个新增路径）` : ""}`);
  const walked = await walkScope(provider, task, run, signal);
  jobLog(job, `列到 ${walked.files} 个文件`);
  signal.throwIfAborted();

  const rules = parseRules(org.rules).rules;
  const scopeName = run.scopePath ? baseOf(run.scopePath) : baseOf(normalizePath(task.originPath));
  const units = buildUnits(walked.entries, { scopePath: run.scopePath, scopeName, videoExts: videoExtsOf(settings), rules, libraryType: task.organize?.libraryType });
  jobLog(job, `分成 ${units.length} 个作品单元`);

  const state: PlanState = { task, settings, org, entries: walked.entries, roots: walked.roots, units: new Map(units.map((u) => [u.key, u])), episodeTitles: new Map() };
  const refPaths = [...rewriteFollowSubPaths(task.id, [], true), ...rewriteOfflineSubPaths(task.id, [], true)];
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
      known: (await nfoEvidence(task, unit)) ?? idTagFromName(unit.rawName, unit.kindHint) ?? libraryEvidence(unit, library),
    };
    let match: OrganizeMatch | null = null;
    let episodeTitles = new Map<string, string>();
    try {
      const r = await identifyUnit({ unit, evidence, libraryType: task.organize?.libraryType, episodeTitles: org.episodeTitle }, tmdb);
      match = r.match;
      episodeTitles = r.episodeTitles;
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      jobLog(job, `识别「${unit.rawName}」失败：${messageOf(err)}`);
    }
    state.episodeTitles.set(unit.key, episodeTitles);
    const memory = evidence.memory;
    const row = toUnitRow(runId, unit, match, null, referencesTo(refPaths, unit.rootPath));
    if (memory) {
      row.seasonOverride = memory.season;
      row.episodeOffset = memory.episodeOffset;
    }
    const plan = planUnit(
      { unit, match, seasonOverride: row.seasonOverride, episodeOffset: row.episodeOffset, episodeTitles, selected: row.selected },
      { settings: org, libraryType: task.organize?.libraryType },
    );
    row.dstRoot = plan.dstRoot;
    row.notes = plan.notes;
    rows.push(row);
    plans.push(plan);
    jobLog(job, match ? `「${unit.rawName}」→ ${match.title} (${match.year}) [${match.confidence}] ${match.reason}` : `「${unit.rawName}」没有识别出来`);
  }

  setProgress(job, "plan", 0, 0, "规划目标路径");
  // 目标目录在范围之外（整理到任务根下的作品目录）时，冲突检测得知道那边已经有什么：每个目标目录列一次
  const extra = await listOutsideDstDirs(provider, task, walked.roots, plans, walked.entries, signal);
  state.entries = [...walked.entries, ...extra];
  const items = finalizeItems(plans, { entries: state.entries, scopePath: run.scopePath, scopeRemovable: scopeRemovable(run), items: [], cleanupEmptyDirs: org.cleanupEmptyDirs });
  planStates.set(runId, state);
  replaceUnits(runId, rows);
  replaceItems(runId, toItemRows(task, items));
  const stats = computeStats(rows, listItems(runId), "apply");
  updateRun(runId, { status: "ready", stats, log: job.logs, error: "" });
  jobLog(job, `预览完成：${stats.units} 个单元，${stats.planned} 项要动，${stats.conflicts} 项冲突`);

  if (run.mode !== "manual") await afterAutoPreview(runId, task, run.mode, rows, stats);
}

/** 自动整理：run 是 auto 模式、全是 high 且没冲突就直接执行；否则留着等人确认并通知 */
async function afterAutoPreview(runId: string, task: TaskDefinition, mode: OrganizeRunMode, units: OrganizeUnit[], stats: OrganizeRunStats): Promise<void> {
  if (stats.planned === 0) {
    updateRun(runId, { status: "done", finishedAt: Math.floor(Date.now() / 1000) });
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
  const unsure = units.filter((u) => u.match && u.match.confidence !== "high").length + units.filter((u) => !u.match).length;
  void deps.notify({ type: "organize-review", task, runId, units: stats.units, planned: stats.planned, unsure, conflicts: stats.conflicts });
}

/* ------------------------------- 预览里改单元 ------------------------------- */

export async function patchUnit(runId: string, key: string, patch: OrganizeUnitPatch): Promise<OrganizeUnit> {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  if (run.status !== "ready") throw new HttpError(409, `只有待执行的整理能改（当前 ${run.status}）`);
  const state = planStates.get(runId);
  if (!state) throw new HttpError(409, "这次预览是上次进程里做的，改不了；重新预览一次");
  const unit = state.units.get(key);
  const row = getUnit(runId, key);
  if (!unit || !row) throw new HttpError(404, "单元不存在");
  const task = state.task;

  let match = row.match;
  let episodeTitles = state.episodeTitles.get(key) ?? new Map<string, string>();
  if (patch.match && (!match || match.tmdbId !== patch.match.tmdbId || match.mediaType !== patch.match.mediaType)) {
    const tmdb = deps.tmdb(state.settings);
    if (!tmdb) throw new HttpError(400, "TMDB 未配置 apiKey");
    const r = await identifyUnit(
      { unit, evidence: { known: { tmdbId: patch.match.tmdbId, mediaType: patch.match.mediaType, source: "手动指定" } }, episodeTitles: state.org.episodeTitle },
      tmdb,
    );
    if (!r.match) throw new HttpError(404, `TMDB 上没有 ${patch.match.mediaType} ${patch.match.tmdbId}`);
    match = { ...r.match, candidates: row.match?.candidates ?? [] };
    episodeTitles = r.episodeTitles;
    state.episodeTitles.set(key, episodeTitles);
  }
  const next: OrganizeUnit = {
    ...row,
    match,
    seasonOverride: patch.seasonOverride === undefined ? row.seasonOverride : patch.seasonOverride,
    episodeOffset: patch.episodeOffset ?? row.episodeOffset,
    selected: patch.selected ?? (patch.match ? true : row.selected),
    remember: patch.remember ?? row.remember,
  };
  const plan = planUnit(
    { unit, match, seasonOverride: next.seasonOverride, episodeOffset: next.episodeOffset, episodeTitles, selected: next.selected },
    { settings: state.org, libraryType: task.organize?.libraryType },
  );
  next.dstRoot = plan.dstRoot;
  next.notes = plan.notes;
  updateUnit(runId, key, next);

  // 换了匹配之后目标目录可能是没列过的：先列一遍，冲突检测和 mkdir 判断才准
  try {
    const provider = providerForTask(task, "write");
    const extra = await listOutsideDstDirs(provider, task, state.roots, [plan], state.entries, new AbortController().signal);
    if (extra.length > 0) state.entries = [...state.entries, ...extra];
  } catch (err) {
    log.warn({ err, runId, key }, "列目标目录失败，冲突检测按已知的条目算");
  }

  // 冲突检测要看全部单元：把其它单元现有的项（去掉目录项）和这个单元的新项一起重算
  const others = listItems(runId).filter((it) => it.unitKey !== key && it.kind !== "dir");
  const otherPlans: UnitPlan[] = [
    {
      unitKey: "",
      dstRoot: "",
      items: others.map((it) => ({
        unitKey: it.unitKey,
        kind: it.kind,
        action: it.action === "conflict" ? (dirOf(it.srcPath) === dirOf(it.dstPath) ? "rename" : "move") : it.action,
        srcPath: relOf(task, it.srcPath),
        dstPath: relOf(task, it.dstPath),
        nodeId: it.nodeId,
        reason: it.action === "conflict" ? "" : it.reason,
      })),
      notes: [],
    },
  ];
  const all = finalizeItems([...otherPlans, plan], { entries: state.entries, scopePath: run.scopePath, scopeRemovable: scopeRemovable(run), items: [], cleanupEmptyDirs: state.org.cleanupEmptyDirs });
  replaceItems(runId, toItemRows(task, all));
  const units = listUnits(runId);
  updateRun(runId, { stats: computeStats(units, listItems(runId), "apply") });
  return getUnit(runId, key)!;
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
const WORK_ACTIONS = new Set<OrganizeItem["action"]>(["mkdir", "rename", "move", "rmdir"]);

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
  const items = listItems(runId);
  const stats = computeStats(listUnits(runId), items, "apply");
  const finishedAt = now();
  if (fatal) {
    updateRun(runId, { status: "failed", error: fatal, stats, log: job.logs, finishedAt });
    jobLog(job, fatal);
  } else {
    updateRun(runId, { status: signal.aborted ? "cancelled" : "done", stats, log: job.logs, finishedAt });
    jobLog(job, `执行完成：${stats.done} 项完成，${stats.failed} 项失败${stats.failedByKind.mirror > 0 ? `，${stats.failedByKind.mirror} 项本地未同步` : ""}`);
  }
  const moved = items.filter((it) => it.status === "done" && (it.action === "rename" || it.action === "move")).length;
  if (moved > 0) {
    afterApply(task, provider, listUnits(runId), items);
    scheduleEmbyRefresh();
  }
  // 执行过就不能再改单元了，预览留在内存里的单元结构可以放掉
  if (moved > 0 || !fatal) planStates.delete(runId);
  if (!signal.aborted) {
    void deps.notify({ type: "organize-done", task, runId, units: stats.units, done: stats.done, failed: stats.failed, failedByKind: stats.failedByKind, notReverted: 0 });
  }
}

/** 收尾：追更 / 云下载回执的目录改写、识别记忆（先把旧记忆挪到新路径，再写这次确认的，新的才不会被旧的盖掉） */
function afterApply(task: TaskDefinition, provider: DriveProvider, units: OrganizeUnit[], items: OrganizeItem[]): void {
  const removedDirs = new Set(items.filter((it) => it.action === "rmdir" && it.status === "done").map((it) => relOf(task, it.srcPath)));
  const mappings: Array<{ from: string; to: string }> = [];
  for (const u of units) {
    if (!u.match || !u.dstRoot || !u.rootPath) continue;
    if (removedDirs.has(u.rootPath) && u.rootPath !== u.dstRoot) {
      mappings.push({ from: u.rootPath, to: u.dstRoot });
      repathMatches(provider.account.name, absOf(task, u.rootPath), absOf(task, u.dstRoot));
    }
  }
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
  if (mappings.length === 0) return;
  const rewritten = rewriteFollowSubPaths(task.id, mappings).length + rewriteOfflineSubPaths(task.id, mappings).length;
  if (rewritten > 0) log.info({ taskId: task.id, rewritten }, "整理后改写了追更 / 云下载回执的目录");
}

/**
 * 能不能（再）执行。ready 的执行全部；done / failed / cancelled 的重试失败和没做的项（默认只重试临时失败，
 * stale / rejected 要用户点名）；开始撤销的 run 不能再执行。count 是会做的项数
 */
export function applicability(run: OrganizeRun, ids?: string[], known?: { items: OrganizeItem[]; units: OrganizeUnit[] }): OrganizeRunDetail["applicable"] {
  if (run.stage === "revert") return { ok: false, reason: "这次整理已经开始撤销，只能继续撤销", count: 0 };
  if (run.status === "ready") return run.stats.planned > 0 ? { ok: true, count: run.stats.planned } : { ok: false, reason: "没有要动的项", count: 0 };
  if (!["done", "failed", "cancelled"].includes(run.status)) return { ok: false, reason: `当前状态（${run.status}）不能执行`, count: 0 };
  const active = activeItemFilter(run.id, known?.units);
  const items = (known?.items ?? listItems(run.id)).filter(active);
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
  const can = applicability(run, ids);
  if (!can.ok) throw new HttpError(409, can.reason ?? "不能执行");
  const busy = listRunsByStatus(["applying", "reverting", "planning"]).find((r) => r.taskId === run.taskId);
  if (busy) throw new HttpError(409, `任务已有一次整理在进行中（${busy.id}）`);
  updateRun(runId, { status: "applying", error: "", startedAt: run.startedAt ?? Math.floor(Date.now() / 1000), finishedAt: null });
  startJob(runId, (job) => execute(job, runId, ids ? new Set(ids) : null));
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

export function deleteRun(runId: string): void {
  if (jobs.has(runId)) throw new HttpError(409, "这次整理正在进行中，先取消");
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

export function revertability(run: OrganizeRun, items: OrganizeItem[] = listItems(run.id)): { ok: boolean; reason?: string } {
  if (!["done", "failed", "cancelled", "reverted"].includes(run.status)) return { ok: false, reason: "只有执行过的整理能撤销" };
  // 没执行过文件的不用撤；撤销中断过的连没删的自建目录也算还有事
  if (!items.some((it) => (run.stage === "revert" ? revertWorkItem(it) : revertPendingItem(it)))) return { ok: false, reason: run.stage === "revert" ? "已经全部退回" : "这次整理没有改动任何文件" };
  if (hasLaterAppliedRun(run)) return { ok: false, reason: "同一任务后面还有更晚的整理，只能撤销最近一次" };
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

  const units = listUnits(runId);
  const finalItems = listItems(runId);
  afterRevert(task, provider, units, finalItems);
  const stats = computeStats(units, finalItems, "revert");
  updateRun(runId, { status: fatal ? "failed" : signal.aborted ? "cancelled" : "reverted", error: fatal ?? "", stats, log: job.logs, finishedAt: now() });
  jobLog(job, fatal ?? `撤销完成：退回 ${n} 项${stats.notReverted > 0 ? `，${stats.notReverted} 项没退回` : ""}`);
  planStates.delete(runId);
  if (n > 0) scheduleEmbyRefresh();
  if (!signal.aborted) {
    void deps.notify({ type: "organize-done", task, runId, units: stats.units, done: n, failed: stats.failed, reverted: true, failedByKind: stats.failedByKind, notReverted: stats.notReverted });
  }
}

/** 撤销的收尾：腾空过的源目录退回来了，追更 / 云下载回执的目录和识别记忆也改回去 */
function afterRevert(task: TaskDefinition, provider: DriveProvider, units: OrganizeUnit[], items: OrganizeItem[]): void {
  const removedDirs = new Set(items.filter((it) => it.action === "rmdir").map((it) => relOf(task, it.srcPath)));
  const back = units.filter((u) => u.dstRoot && u.rootPath && removedDirs.has(u.rootPath) && u.rootPath !== u.dstRoot).map((u) => ({ from: u.dstRoot, to: u.rootPath }));
  if (back.length === 0) return;
  rewriteFollowSubPaths(task.id, back);
  rewriteOfflineSubPaths(task.id, back);
  for (const m of back) repathMatches(provider.account.name, absOf(task, m.from), absOf(task, m.to));
}

export async function revertRun(runId: string): Promise<OrganizeRun> {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  if (jobs.has(runId)) throw new HttpError(409, "这次整理正在进行中");
  const ok = revertability(run);
  if (!ok.ok) throw new HttpError(409, ok.reason ?? "不能撤销");
  const busy = listRunsByStatus(["applying", "reverting", "planning"]).find((r) => r.taskId === run.taskId);
  if (busy) throw new HttpError(409, `任务已有一次整理在进行中（${busy.id}）`);
  updateRun(runId, { status: "reverting", stage: "revert", error: "", finishedAt: null });
  startJob(runId, (job) => revert(job, runId));
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
    push("pending", live.filter((it) => it.status === "pending" && active(it) && WORK_ACTIONS.has(it.action)), { retry: true, skip: true });
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

export function getRunDetail(runId: string): OrganizeRunDetail {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  const units = listUnits(runId);
  const items = listItems(runId);
  return { run: withProgress(run), units, items, groups: failureGroups(run, items, units), revertable: revertability(run, items), applicable: applicability(run, undefined, { items, units }) };
}

/** 进程重启：上次没跑完的 run 标失败，用户可以再执行 / 继续撤销（做完的项不会重做）；清单上已经没事可做的直接收口 */
export function reconcileInterruptedRuns(): number {
  const rows = listRunsByStatus(["planning", "applying", "reverting"]);
  for (const r of rows) {
    if (finalizeIfNothingLeft(r)) continue;
    updateRun(r.id, {
      status: "failed",
      error: r.status === "reverting" ? "进程重启，撤销中断了；可以继续撤销（已退回的项不会重做）" : "进程重启，中断了；可以重新执行（已完成的项不会重做）",
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

export type { OrganizeConfidence };
