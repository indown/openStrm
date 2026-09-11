/**
 * 整理的编排层，路由只调这里。
 *
 *   createRun   建 run → 后台：列范围 → 分单元 → 识别（TMDB）→ 规划 → 落库，状态 ready
 *   patchUnit   预览里换匹配 / 改季 / 集偏移 / 勾选：重新规划这个单元，冲突检测整体重算
 *   applyRun    后台按顺序执行：mkdir → 改名 → 移动 → 本地镜像 → 逐条记账 → 删空目录 → 收尾
 *   revertRun   最近一次 done 的 run 按流水账逆序退回
 *
 * 进行中的 run 在内存里有一个 job（中止信号 + 进度 + 日志），进程重启后 applying / planning 的 run 标成 failed，
 * 可以再 apply（done 的项跳过，pending 的接着来）。
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AppSettings,
  OrganizeConfidence,
  OrganizeItem,
  OrganizeMatch,
  OrganizeMediaType,
  OrganizeProgress,
  OrganizeRun,
  OrganizeRunDetail,
  OrganizeRunMode,
  OrganizeRunStats,
  OrganizeTrigger,
  OrganizeUnit,
  OrganizeUnitPatch,
  TaskDefinition,
} from "@openstrm/shared";
import { getAll as listLibraryEntries } from "../../db/repositories/media-library.js";
import {
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
}

const realDeps: Deps = {
  tmdb: (settings) => {
    const key = settings.tmdb?.apiKey?.trim();
    return key ? new TmdbClient(key, settings.tmdb?.language || "zh-CN") : null;
  },
  notify,
};
let deps: Deps = { ...realDeps };

/** 仅供测试：换掉 TMDB 和通知；传 null 恢复 */
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

const errMsg = (err: unknown): string => (err instanceof Error && err.message ? err.message : String(err));
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

function computeStats(units: OrganizeUnit[], items: OrganizeItem[]): OrganizeRunStats {
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
      const msg = isAbortError(err) || job.abort.signal.aborted ? "已取消" : errMsg(err);
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
      jobLog(job, `识别「${unit.rawName}」失败：${errMsg(err)}`);
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
  const stats = computeStats(rows, listItems(runId));
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
  updateRun(runId, { stats: computeStats(units, listItems(runId)) });
  return getUnit(runId, key)!;
}

/* ------------------------------- 执行 ------------------------------- */

interface ExecCtx {
  job: Job;
  task: TaskDefinition;
  provider: DriveProvider;
  settings: AppSettings;
  tasks: TaskDefinition[];
  /** 网盘绝对路径 → 目录 id */
  dirIds: Map<string, string>;
  /** 列过的目录：绝对路径 → 名字 → { id, isDir } */
  listings: Map<string, Map<string, { id: string; isDir: boolean }>>;
}

async function dirIdOf(ctx: ExecCtx, abs: string): Promise<string> {
  const hit = ctx.dirIds.get(abs);
  if (hit) return hit;
  const node = await ctx.provider.resolvePath(abs, ctx.job.abort.signal);
  if (!node || !node.isDir) throw new Error(`网盘上没有目录 ${abs}`);
  ctx.dirIds.set(abs, node.id);
  return node.id;
}

async function nodeOf(ctx: ExecCtx, abs: string, knownId: string): Promise<{ id: string; isDir: boolean }> {
  if (knownId) return { id: knownId, isDir: false };
  const parent = normalizePath(splitPath(abs).slice(0, -1).join("/"));
  let listing = ctx.listings.get(parent);
  if (!listing) {
    const pid = await dirIdOf(ctx, parent);
    listing = new Map((await ctx.provider.listDir(pid, ctx.job.abort.signal)).map((e) => [e.name, { id: e.id, isDir: e.isDir }]));
    ctx.listings.set(parent, listing);
  }
  const hit = listing.get(baseOf(abs));
  if (!hit) throw new Error(`网盘上找不到 ${abs}`);
  return hit;
}

/** 每一步网盘写操作都可能撞上风控：认出来就整轮停 */
function blockedError(ctx: ExecCtx, err: unknown): boolean {
  return ctx.provider.classifyError(err) === "blocked" || ctx.provider.classifyError(err) === "auth";
}

async function execute(job: Job, runId: string): Promise<void> {
  const run = getRun(runId)!;
  const task = getTask(run.taskId);
  if (!task) throw new Error("任务已不存在");
  const provider = providerForTask(task, "write");
  const write = provider.write!;
  const settings = readAppSettings();
  const ctx: ExecCtx = { job, task, provider, settings, tasks: accountTasks(provider.account.name), dirIds: new Map(), listings: new Map() };
  const signal = job.abort.signal;
  const units = new Map(listUnits(runId).map((u) => [u.key, u]));
  const active = (it: OrganizeItem) => it.unitKey === "" || (units.get(it.unitKey)?.selected && units.get(it.unitKey)?.match);
  // 上次失败的这次再试一遍（风控 / 网络抖动）；done 的不重做
  const pending = listItems(runId).filter((it) => (it.status === "pending" || it.status === "failed") && active(it) && ["mkdir", "rename", "move", "rmdir"].includes(it.action));
  for (const it of pending) {
    if (it.status === "failed") {
      updateItem(it.id, { status: "pending", error: "" });
      it.status = "pending";
      it.error = "";
    }
  }
  jobLog(job, `开始执行：${pending.length} 项`);
  const now = () => Math.floor(Date.now() / 1000);
  let done = 0;
  let fatal: string | null = null;
  const fail = (it: OrganizeItem, err: unknown) => {
    const msg = errMsg(err);
    updateItem(it.id, { status: "failed", error: msg });
    jobLog(job, `失败 ${it.action} ${it.srcPath}：${msg}`);
    if (blockedError(ctx, err)) fatal = `网盘拒绝了请求（${msg}），整理已停下，稍后再继续`;
  };
  /** 网盘上动完之后同步本地；失败不影响网盘那边已经完成的事实，但要记在项上（监控见到 error 非空就不跳过这条事件，让它把本地补回来） */
  const mirror = async (oldPath: string, newPath: string, isDir: boolean): Promise<string> => {
    try {
      await mirrorRelocate({ oldPath, newPath, isDir }, { tasks: ctx.tasks, settings });
      return "";
    } catch (err) {
      const msg = `本地镜像失败：${errMsg(err)}`;
      jobLog(job, `${msg}（${newPath}）`);
      return msg;
    }
  };
  const finishItem = async (it: OrganizeItem, nodeId: string, isDir: boolean) => {
    const error = await mirror(it.srcPath, it.dstPath, isDir);
    updateItem(it.id, { status: "done", nodeId, finishedAt: now(), curPath: "", error });
    done++;
  };

  // 1. mkdir（按深度）。目录已经在（上次执行建过、别人建的）就直接复用
  for (const it of pending.filter((i) => i.action === "mkdir")) {
    if (fatal || signal.aborted) break;
    setProgress(job, "apply", done, pending.length, `建目录 ${it.dstPath}`);
    try {
      const existing = await ctx.provider.resolvePath(it.dstPath, signal);
      if (existing?.isDir) {
        ctx.dirIds.set(it.dstPath, existing.id);
        updateItem(it.id, { status: "done", nodeId: existing.id, finishedAt: now(), error: "" });
        done++;
        continue;
      }
      const parent = normalizePath(splitPath(it.dstPath).slice(0, -1).join("/"));
      const pid = await dirIdOf(ctx, parent);
      const node = await write.mkdir({ id: pid, path: parent }, baseOf(it.dstPath), signal);
      ctx.dirIds.set(it.dstPath, node.id);
      ctx.listings.delete(parent);
      updateItem(it.id, { status: "done", nodeId: node.id, finishedAt: now(), error: "" });
      done++;
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
      const n = await nodeOf(ctx, current.get(it.id)!, it.nodeId);
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
  for (const batch of renameBatches.values()) {
    if (fatal || signal.aborted) break;
    setProgress(job, "apply", done, pending.length, `改名 ${baseOf(batch[0].srcPath)} 等 ${batch.length} 项`);
    const nodes = batch.map((it) => ({ node: { id: nodeIds.get(it.id)!, path: current.get(it.id)!, isDir: isDirNode.get(it.id) ?? false } satisfies WriteNode, newName: baseOf(it.dstPath) }));
    const settle = async (it: OrganizeItem, newId: string) => {
      const next = `${dirOf(current.get(it.id)!)}/${baseOf(it.dstPath)}`;
      current.set(it.id, next);
      nodeIds.set(it.id, newId);
      ctx.listings.delete(dirOf(next));
      if (it.action === "rename") await finishItem(it, newId, isDirNode.get(it.id) ?? false);
      else updateItem(it.id, { curPath: next, nodeId: newId });
    };
    const oneByOne = async () => {
      for (const [i, it] of batch.entries()) {
        if (fatal || signal.aborted) break;
        try {
          const r = await write.rename(nodes[i].node, nodes[i].newName, signal);
          await settle(it, r.id);
        } catch (err) {
          if (isAbortError(err) || signal.aborted) throw err;
          failed.add(it.id);
          fail(it, err);
        }
      }
    };
    try {
      if (write.renameMany && nodes.length > 1) {
        const ids = await write.renameMany(nodes, signal);
        for (const [i, it] of batch.entries()) await settle(it, ids[i]?.id ?? nodeIds.get(it.id)!);
      } else await oneByOne();
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      if (blockedError(ctx, err)) {
        for (const it of batch) {
          failed.add(it.id);
          fail(it, err);
        }
      } else {
        // 一批里有一个改不了会把整批拖失败：逐个再试一遍，把失败定位到那一项
        jobLog(job, `批量改名失败（${errMsg(err)}），改为逐个改名`);
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
  for (const [to, batch] of moveBatches) {
    if (fatal || signal.aborted) break;
    setProgress(job, "apply", done, pending.length, `移动 ${batch.length} 项到 ${to}`);
    const nodeOfItem = (it: OrganizeItem): WriteNode => ({ id: nodeIds.get(it.id)!, path: current.get(it.id)!, isDir: isDirNode.get(it.id) ?? false });
    const settleMoved = async (it: OrganizeItem, newId: string) => {
      ctx.listings.delete(dirOf(current.get(it.id)!));
      ctx.listings.delete(to);
      await finishItem(it, newId, isDirNode.get(it.id) ?? false);
    };
    let toId: string;
    try {
      toId = await dirIdOf(ctx, to);
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      for (const it of batch) fail(it, err);
      continue;
    }
    try {
      const ids = await write.move(batch.map(nodeOfItem), { id: toId, path: to }, signal);
      for (const [i, it] of batch.entries()) await settleMoved(it, ids[i]?.id ?? nodeIds.get(it.id)!);
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      if (batch.length === 1 || blockedError(ctx, err)) {
        for (const it of batch) fail(it, err);
        continue;
      }
      // 一批里有一个挪不动会把整批拖失败：逐个再试一遍，把失败定位到那一项
      jobLog(job, `批量移动到 ${to} 失败（${errMsg(err)}），改为逐个移动`);
      for (const it of batch) {
        if (fatal || signal.aborted) break;
        try {
          const [moved] = await write.move([nodeOfItem(it)], { id: toId, path: to }, signal);
          await settleMoved(it, moved?.id ?? nodeIds.get(it.id)!);
        } catch (err2) {
          if (isAbortError(err2) || signal.aborted) throw err2;
          fail(it, err2);
        }
      }
    }
  }

  // 3. 删空目录（从深到浅）
  for (const it of pending.filter((i) => i.action === "rmdir")) {
    if (fatal || signal.aborted) break;
    setProgress(job, "apply", done, pending.length, `清理空目录 ${it.srcPath}`);
    try {
      const node = it.nodeId ? { id: it.nodeId, isDir: true } : await ctx.provider.resolvePath(it.srcPath, signal);
      if (!node) {
        updateItem(it.id, { status: "skipped", error: "目录已不存在" });
        continue;
      }
      const removed = await write.rmdirIfEmpty({ id: node.id, path: it.srcPath, isDir: true }, signal);
      if (removed) {
        updateItem(it.id, { status: "done", nodeId: node.id, finishedAt: now(), error: "" });
        done++;
        await mirrorRmdir(it.srcPath, { tasks: ctx.tasks, settings });
      } else updateItem(it.id, { status: "skipped", error: "目录不是空的（115 的目录信息有几分钟缓存，刚挪走的可能还显示在里面）" });
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      fail(it, err);
    }
  }

  // 4. 收尾
  const items = listItems(runId);
  const stats = computeStats([...units.values()], items);
  const finishedAt = now();
  if (fatal) {
    updateRun(runId, { status: "failed", error: fatal, stats, log: job.logs, finishedAt });
    jobLog(job, fatal);
  } else {
    updateRun(runId, { status: signal.aborted ? "cancelled" : "done", stats, log: job.logs, finishedAt });
    jobLog(job, `执行完成：${stats.done} 项完成，${stats.failed} 项失败`);
  }
  const moved = items.filter((it) => it.status === "done" && (it.action === "rename" || it.action === "move")).length;
  if (moved > 0) {
    await afterApply(task, provider, [...units.values()], items);
    scheduleEmbyRefresh();
  }
  // 执行过就不能再改单元了，预览留在内存里的单元结构可以放掉
  if (moved > 0 || !fatal) planStates.delete(runId);
  if (!signal.aborted) void deps.notify({ type: "organize-done", task, runId, units: stats.units, done: stats.done, failed: stats.failed });
}

/** 收尾：追更 / 云下载回执的目录改写、识别记忆（先把旧记忆挪到新路径，再写这次确认的，新的才不会被旧的盖掉） */
async function afterApply(task: TaskDefinition, provider: DriveProvider, units: OrganizeUnit[], items: OrganizeItem[]): Promise<void> {
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

export async function applyRun(runId: string): Promise<OrganizeRun> {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  if (jobs.has(runId)) throw new HttpError(409, "这次整理正在进行中");
  // done 的 run 里还有失败的项也允许再执行（只重试失败 / 没做的，done 的项不重做）
  const retryable = run.status === "done" && listItems(runId).some((it) => it.status === "failed" || (it.status === "pending" && ["mkdir", "rename", "move", "rmdir"].includes(it.action)));
  if (!["ready", "cancelled", "failed"].includes(run.status) && !retryable) throw new HttpError(409, `当前状态（${run.status}）不能执行`);
  const busy = listRunsByStatus(["applying", "reverting", "planning"]).find((r) => r.taskId === run.taskId);
  if (busy) throw new HttpError(409, `任务已有一次整理在进行中（${busy.id}）`);
  updateRun(runId, { status: "applying", error: "", startedAt: run.startedAt ?? Math.floor(Date.now() / 1000), finishedAt: null });
  startJob(runId, (job) => execute(job, runId));
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

/* ------------------------------- 撤销 ------------------------------- */

/** 这一项在网盘上动过：完成了，或者改了名还没挪走 */
const touched = (it: OrganizeItem): boolean => (it.status === "done" && it.action !== "mkdir" && it.action !== "rmdir") || (it.curPath !== "" && it.status !== "done");

export function revertability(run: OrganizeRun): { ok: boolean; reason?: string } {
  if (!["done", "failed", "cancelled"].includes(run.status)) return { ok: false, reason: "只有执行过的整理能撤销" };
  if (!listItems(run.id).some(touched)) return { ok: false, reason: "这次整理没有改动任何文件" };
  if (hasLaterAppliedRun(run)) return { ok: false, reason: "同一任务后面还有更晚的整理，只能撤销最近一次" };
  return { ok: true };
}

async function revert(job: Job, runId: string): Promise<void> {
  const run = getRun(runId)!;
  const task = getTask(run.taskId);
  if (!task) throw new Error("任务已不存在");
  const provider = providerForTask(task, "write");
  const write = provider.write!;
  const settings = readAppSettings();
  const ctx: ExecCtx = { job, task, provider, settings, tasks: accountTasks(provider.account.name), dirIds: new Map(), listings: new Map() };
  const signal = job.abort.signal;
  const items = listItems(runId).filter((it) => it.status === "done" || touched(it)).reverse();
  const now = () => Math.floor(Date.now() / 1000);
  let n = 0;
  let fatal: string | null = null;
  jobLog(job, `开始撤销：${items.length} 项`);

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

  for (const it of items) {
    if (fatal || signal.aborted) break;
    setProgress(job, "revert", n, items.length, `退回 ${it.dstPath}`);
    try {
      if (it.status !== "done" && it.curPath) {
        // 只改了名还没挪走的：改回去就行，本地没动过
        const node = await ctx.provider.resolvePath(it.curPath, signal);
        if (!node) {
          updateItem(it.id, { status: "skipped", error: "文件已不在改名后的位置，跳过", curPath: "" });
          continue;
        }
        await write.rename({ id: node.id, path: it.curPath, isDir: node.isDir }, baseOf(it.srcPath), signal);
        updateItem(it.id, { status: "reverted", finishedAt: now(), curPath: "", error: "" });
        n++;
        continue;
      }
      if (it.action === "rename" || it.action === "move") {
        const node = await ctx.provider.resolvePath(it.dstPath, signal);
        if (!node) {
          updateItem(it.id, { status: "skipped", error: "文件已不在整理后的位置，跳过" });
          continue;
        }
        if (it.nodeId && node.id !== it.nodeId && provider.kind !== "openlist") {
          updateItem(it.id, { status: "skipped", error: "整理后的位置上已经是另一个文件，跳过" });
          continue;
        }
        let cur: WriteNode = { id: node.id, path: it.dstPath, isDir: node.isDir };
        if (dirOf(it.dstPath) !== dirOf(it.srcPath)) {
          const toId = await ensureDir(dirOf(it.srcPath));
          const [moved] = await write.move([cur], { id: toId, path: dirOf(it.srcPath) }, signal);
          cur = { id: moved.id, path: `${dirOf(it.srcPath)}/${baseOf(it.dstPath)}`, isDir: cur.isDir };
        }
        if (baseOf(it.dstPath) !== baseOf(it.srcPath)) await write.rename(cur, baseOf(it.srcPath), signal);
        let error = "";
        try {
          await mirrorRelocate({ oldPath: it.dstPath, newPath: it.srcPath, isDir: node.isDir }, { tasks: ctx.tasks, settings });
        } catch (err) {
          error = `本地镜像失败：${errMsg(err)}`;
          jobLog(job, `${error}（${it.srcPath}）`);
        }
        updateItem(it.id, { status: "reverted", finishedAt: now(), error });
        n++;
      } else if (it.action === "mkdir") {
        const node = await ctx.provider.resolvePath(it.dstPath, signal);
        if (node?.isDir && (await write.rmdirIfEmpty({ id: node.id, path: it.dstPath, isDir: true }, signal))) {
          await mirrorRmdir(it.dstPath, { tasks: ctx.tasks, settings });
          updateItem(it.id, { status: "reverted", finishedAt: now() });
          n++;
        } else updateItem(it.id, { status: "skipped", error: "目录不是空的，留着" });
      } else if (it.action === "rmdir") {
        // 目录会在挪回文件时按需重建，这里不用做什么
        updateItem(it.id, { status: "reverted", finishedAt: now() });
      }
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      updateItem(it.id, { status: "failed", error: errMsg(err) });
      jobLog(job, `撤销失败 ${it.dstPath}：${errMsg(err)}`);
      if (blockedError(ctx, err)) fatal = `网盘拒绝了请求（${errMsg(err)}），撤销已停下`;
    }
  }

  const units = listUnits(runId);
  const removedDirs = new Set(listItems(runId).filter((it) => it.action === "rmdir").map((it) => relOf(task, it.srcPath)));
  const back = units.filter((u) => u.dstRoot && u.rootPath && removedDirs.has(u.rootPath) && u.rootPath !== u.dstRoot).map((u) => ({ from: u.dstRoot, to: u.rootPath }));
  if (back.length > 0) {
    rewriteFollowSubPaths(task.id, back);
    rewriteOfflineSubPaths(task.id, back);
    for (const m of back) repathMatches(provider.account.name, absOf(task, m.from), absOf(task, m.to));
  }
  const stats = computeStats(units, listItems(runId));
  updateRun(runId, { status: fatal ? "failed" : signal.aborted ? "cancelled" : "reverted", error: fatal ?? "", stats, log: job.logs, finishedAt: now() });
  jobLog(job, fatal ?? `撤销完成：退回 ${n} 项`);
  planStates.delete(runId);
  if (n > 0) scheduleEmbyRefresh();
  if (!signal.aborted) void deps.notify({ type: "organize-done", task, runId, units: stats.units, done: n, failed: stats.failed, reverted: true });
}

export async function revertRun(runId: string): Promise<OrganizeRun> {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  if (jobs.has(runId)) throw new HttpError(409, "这次整理正在进行中");
  const ok = revertability(run);
  if (!ok.ok) throw new HttpError(409, ok.reason ?? "不能撤销");
  const busy = listRunsByStatus(["applying", "reverting", "planning"]).find((r) => r.taskId === run.taskId);
  if (busy) throw new HttpError(409, `任务已有一次整理在进行中（${busy.id}）`);
  updateRun(runId, { status: "reverting", error: "", finishedAt: null });
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

export function getRunDetail(runId: string): OrganizeRunDetail {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  return { run: withProgress(run), units: listUnits(runId), items: listItems(runId), revertable: revertability(run) };
}

/** 进程重启：上次没跑完的 run 标失败，用户可以再执行（done 的项不会重做） */
export function reconcileInterruptedRuns(): number {
  const rows = listRunsByStatus(["planning", "applying", "reverting"]);
  for (const r of rows) {
    updateRun(r.id, {
      status: r.status === "planning" ? "failed" : r.status === "reverting" ? "failed" : "failed",
      error: "进程重启，中断了；可以重新执行（已完成的项不会重做）",
      finishedAt: Math.floor(Date.now() / 1000),
    });
  }
  return rows.length;
}

/** 进程退出：把在跑的都掐掉 */
export function cancelAllRuns(): void {
  for (const job of jobs.values()) job.abort.abort();
}

export type { OrganizeConfidence };
