/**
 * 整理的持久化：run / unit / item 三张表 + 识别记忆 + TMDB 缓存。
 * item 的 src_path / dst_path 是网盘绝对路径（带前导 /）；时间戳一律秒。
 */
import { and, asc, desc, eq, gt, inArray, like, lt, or, sql } from "drizzle-orm";
import type {
  OrganizeAction,
  OrganizeConfidence,
  OrganizeFileKind,
  OrganizeItem,
  OrganizeItemStatus,
  OrganizeMatch,
  OrganizeMatchMemory,
  OrganizeMediaType,
  OrganizeRun,
  OrganizeRunMode,
  OrganizeRunStats,
  OrganizeRunStatus,
  OrganizeTrigger,
  OrganizeUnit,
} from "@openstrm/shared";
import { db } from "../client.js";
import { organizeItems, organizeMatches, organizeRuns, organizeUnits, tmdbCache } from "../schema.js";

type RunRow = typeof organizeRuns.$inferSelect;
type UnitRow = typeof organizeUnits.$inferSelect;
type ItemRow = typeof organizeItems.$inferSelect;
type MatchRow = typeof organizeMatches.$inferSelect;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function emptyStats(): OrganizeRunStats {
  return {
    units: 0,
    items: 0,
    planned: 0,
    keep: 0,
    conflicts: 0,
    skipped: 0,
    done: 0,
    failed: 0,
    confidence: { high: 0, medium: 0, low: 0, none: 0 },
  };
}

const RUN_STATUSES: OrganizeRunStatus[] = ["planning", "ready", "applying", "done", "failed", "cancelled", "reverting", "reverted"];
const ITEM_STATUSES: OrganizeItemStatus[] = ["pending", "done", "failed", "skipped", "reverted"];

const coerce = <T extends string>(v: string, list: readonly T[], fallback: T): T => ((list as readonly string[]).includes(v) ? (v as T) : fallback);

function toRun(row: RunRow): OrganizeRun {
  return {
    id: row.id,
    taskId: row.taskId,
    accountName: row.accountName,
    scopePath: row.scopePath,
    scopePaths: parseJson<string[]>(row.scopePaths, []),
    mode: row.mode === "auto" ? "auto" : row.mode === "review" ? "review" : "manual",
    trigger: coerce<OrganizeTrigger>(row.trigger, ["manual", "share", "follow", "offline", "monitor"], "manual"),
    status: coerce(row.status, RUN_STATUSES, "failed"),
    stats: { ...emptyStats(), ...parseJson<Partial<OrganizeRunStats>>(row.stats, {}) },
    error: row.error,
    log: parseJson<string[]>(row.log, []),
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
  };
}

function toUnit(row: UnitRow): OrganizeUnit {
  return {
    runId: row.runId,
    key: row.key,
    rootPath: row.rootPath,
    rawName: row.rawName,
    parsedTitle: row.parsedTitle,
    parsedYear: row.parsedYear,
    match: parseJson<OrganizeMatch | null>(row.match, null),
    seasonOverride: row.seasonOverride ?? null,
    episodeOffset: row.episodeOffset,
    dstRoot: row.dstRoot,
    selected: row.selected,
    remember: row.remember,
    fileCount: row.fileCount,
    videoCount: row.videoCount,
    referencedBy: row.referencedBy,
    notes: parseJson<string[]>(row.notes, []),
  };
}

function toItem(row: ItemRow): OrganizeItem {
  return {
    id: row.id,
    runId: row.runId,
    unitKey: row.unitKey,
    seq: row.seq,
    kind: row.kind as OrganizeFileKind,
    action: row.action as OrganizeAction,
    srcPath: row.srcPath,
    dstPath: row.dstPath,
    nodeId: row.nodeId,
    reason: row.reason,
    status: coerce(row.status, ITEM_STATUSES, "pending"),
    error: row.error,
    finishedAt: row.finishedAt ?? null,
    curPath: row.curPath,
    hits: row.hits,
  };
}

function toMemory(row: MatchRow): OrganizeMatchMemory {
  return {
    accountName: row.accountName,
    srcPath: row.srcPath,
    mediaType: row.mediaType === "movie" ? "movie" : "tv",
    tmdbId: row.tmdbId,
    title: row.title,
    year: row.year,
    season: row.season ?? null,
    episodeOffset: row.episodeOffset,
    updatedAt: row.updatedAt,
  };
}

/* ------------------------------- runs ------------------------------- */

export interface NewRun {
  id: string;
  taskId: string;
  accountName: string;
  scopePath: string;
  scopePaths: string[];
  mode: OrganizeRunMode;
  trigger: OrganizeTrigger;
}

export function insertRun(run: NewRun): OrganizeRun {
  const createdAt = Math.floor(Date.now() / 1000);
  db.insert(organizeRuns)
    .values({
      id: run.id,
      taskId: run.taskId,
      accountName: run.accountName,
      scopePath: run.scopePath,
      scopePaths: JSON.stringify(run.scopePaths),
      mode: run.mode,
      trigger: run.trigger,
      status: "planning",
      stats: JSON.stringify(emptyStats()),
      createdAt,
    })
    .run();
  return getRun(run.id)!;
}

export function getRun(id: string): OrganizeRun | null {
  const row = db.select().from(organizeRuns).where(eq(organizeRuns.id, id)).get();
  return row ? toRun(row) : null;
}

export interface RunPatch {
  status?: OrganizeRunStatus;
  stats?: OrganizeRunStats;
  error?: string;
  log?: string[];
  startedAt?: number | null;
  finishedAt?: number | null;
}

export function updateRun(id: string, patch: RunPatch): void {
  const set: Partial<typeof organizeRuns.$inferInsert> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.stats !== undefined) set.stats = JSON.stringify(patch.stats);
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.log !== undefined) set.log = JSON.stringify(patch.log.slice(-300));
  if (patch.startedAt !== undefined) set.startedAt = patch.startedAt;
  if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt;
  if (Object.keys(set).length === 0) return;
  db.update(organizeRuns).set(set).where(eq(organizeRuns.id, id)).run();
}

export function listRuns(opts: { taskId?: string; limit?: number; offset?: number } = {}): OrganizeRun[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const q = db
    .select()
    .from(organizeRuns)
    .where(opts.taskId ? eq(organizeRuns.taskId, opts.taskId) : undefined)
    .orderBy(desc(organizeRuns.createdAt), desc(sql`${organizeRuns}.rowid`))
    .limit(limit)
    .offset(opts.offset ?? 0);
  return q.all().map(toRun);
}

export function listRunsByStatus(statuses: OrganizeRunStatus[]): OrganizeRun[] {
  if (statuses.length === 0) return [];
  return db.select().from(organizeRuns).where(inArray(organizeRuns.status, statuses)).all().map(toRun);
}

/**
 * 同一任务里比这次更晚、且已经执行过（有 done 的项）的 run：撤销只允许最近一次。
 * 「更晚」按 rowid（插入顺序）比：created_at 只有秒，同一秒里建的两次 run 分不出先后
 */
export function hasLaterAppliedRun(run: OrganizeRun): boolean {
  const row = db
    .select({ id: organizeRuns.id })
    .from(organizeRuns)
    .where(
      and(
        eq(organizeRuns.taskId, run.taskId),
        inArray(organizeRuns.status, ["applying", "done", "reverting", "cancelled", "failed"]),
        sql`${organizeRuns}.rowid > (select rowid from ${organizeRuns} where ${organizeRuns.id} = ${run.id})`,
        // 从没执行过一条的 failed / cancelled 不算
        sql`exists (select 1 from ${organizeItems} where ${organizeItems.runId} = ${organizeRuns.id} and ${organizeItems.status} = 'done')`,
      ),
    )
    .get();
  return !!row;
}

export function deleteRun(id: string): boolean {
  return db.transaction((tx) => {
    tx.delete(organizeItems).where(eq(organizeItems.runId, id)).run();
    tx.delete(organizeUnits).where(eq(organizeUnits.runId, id)).run();
    return tx.delete(organizeRuns).where(eq(organizeRuns.id, id)).run().changes > 0;
  });
}

/** 留存清理：删掉早于 cutoff 且已结束的 run（连同 unit / item） */
export function deleteFinishedRunsBefore(cutoffSec: number, keepLatestPerTask = 5): number {
  const rows = db
    .select({ id: organizeRuns.id, taskId: organizeRuns.taskId })
    .from(organizeRuns)
    .where(and(lt(organizeRuns.createdAt, cutoffSec), inArray(organizeRuns.status, ["done", "failed", "cancelled", "reverted"])))
    .orderBy(desc(organizeRuns.createdAt))
    .all();
  const seen = new Map<string, number>();
  let n = 0;
  for (const r of rows) {
    const k = seen.get(r.taskId) ?? 0;
    seen.set(r.taskId, k + 1);
    if (k < keepLatestPerTask) continue;
    if (deleteRun(r.id)) n++;
  }
  return n;
}

/* ------------------------------- units ------------------------------- */

export function replaceUnits(runId: string, units: OrganizeUnit[]): void {
  db.transaction((tx) => {
    tx.delete(organizeUnits).where(eq(organizeUnits.runId, runId)).run();
    for (const u of units) {
      tx.insert(organizeUnits)
        .values({
          runId,
          key: u.key,
          rootPath: u.rootPath,
          rawName: u.rawName,
          parsedTitle: u.parsedTitle,
          parsedYear: u.parsedYear,
          match: u.match ? JSON.stringify(u.match) : null,
          seasonOverride: u.seasonOverride,
          episodeOffset: u.episodeOffset,
          dstRoot: u.dstRoot,
          selected: u.selected,
          remember: u.remember,
          fileCount: u.fileCount,
          videoCount: u.videoCount,
          referencedBy: u.referencedBy,
          notes: JSON.stringify(u.notes),
        })
        .run();
    }
  });
}

export function listUnits(runId: string): OrganizeUnit[] {
  return db.select().from(organizeUnits).where(eq(organizeUnits.runId, runId)).orderBy(asc(organizeUnits.rootPath), asc(organizeUnits.key)).all().map(toUnit);
}

export function getUnit(runId: string, key: string): OrganizeUnit | null {
  const row = db.select().from(organizeUnits).where(and(eq(organizeUnits.runId, runId), eq(organizeUnits.key, key))).get();
  return row ? toUnit(row) : null;
}

export function updateUnit(runId: string, key: string, patch: Partial<OrganizeUnit>): OrganizeUnit | null {
  return db.transaction((tx) => {
    const row = tx.select().from(organizeUnits).where(and(eq(organizeUnits.runId, runId), eq(organizeUnits.key, key))).get();
    if (!row) return null;
    const merged: OrganizeUnit = { ...toUnit(row), ...patch, runId, key };
    tx.update(organizeUnits)
      .set({
        match: merged.match ? JSON.stringify(merged.match) : null,
        seasonOverride: merged.seasonOverride,
        episodeOffset: merged.episodeOffset,
        dstRoot: merged.dstRoot,
        selected: merged.selected,
        remember: merged.remember,
        referencedBy: merged.referencedBy,
        notes: JSON.stringify(merged.notes),
        parsedTitle: merged.parsedTitle,
        parsedYear: merged.parsedYear,
      })
      .where(and(eq(organizeUnits.runId, runId), eq(organizeUnits.key, key)))
      .run();
    return merged;
  });
}

/* ------------------------------- items ------------------------------- */

export type NewItem = Omit<OrganizeItem, "runId" | "status" | "error" | "finishedAt" | "curPath" | "hits"> & {
  status?: OrganizeItemStatus;
  error?: string;
};

function itemValues(runId: string, it: NewItem): typeof organizeItems.$inferInsert {
  return {
    id: it.id,
    runId,
    unitKey: it.unitKey,
    seq: it.seq,
    kind: it.kind,
    action: it.action,
    srcPath: it.srcPath,
    dstPath: it.dstPath,
    nodeId: it.nodeId,
    reason: it.reason,
    status: it.status ?? "pending",
    error: it.error ?? "",
  };
}

export function replaceItems(runId: string, items: NewItem[]): void {
  db.transaction((tx) => {
    tx.delete(organizeItems).where(eq(organizeItems.runId, runId)).run();
    for (const it of items) tx.insert(organizeItems).values(itemValues(runId, it)).run();
  });
}

/** 只换掉某个单元的项（用户改匹配后重新规划），其它单元不动 */
export function replaceUnitItems(runId: string, unitKey: string, items: NewItem[]): void {
  db.transaction((tx) => {
    tx.delete(organizeItems).where(and(eq(organizeItems.runId, runId), eq(organizeItems.unitKey, unitKey))).run();
    for (const it of items) tx.insert(organizeItems).values(itemValues(runId, it)).run();
  });
}

export function listItems(runId: string): OrganizeItem[] {
  return db.select().from(organizeItems).where(eq(organizeItems.runId, runId)).orderBy(asc(organizeItems.seq)).all().map(toItem);
}

export function updateItem(id: string, patch: Partial<Pick<OrganizeItem, "status" | "error" | "nodeId" | "finishedAt" | "dstPath" | "srcPath" | "curPath" | "hits">>): void {
  const set: Partial<typeof organizeItems.$inferInsert> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.nodeId !== undefined) set.nodeId = patch.nodeId;
  if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt;
  if (patch.dstPath !== undefined) set.dstPath = patch.dstPath;
  if (patch.srcPath !== undefined) set.srcPath = patch.srcPath;
  if (patch.curPath !== undefined) set.curPath = patch.curPath;
  if (patch.hits !== undefined) set.hits = patch.hits;
  if (Object.keys(set).length === 0) return;
  db.update(organizeItems).set(set).where(eq(organizeItems.id, id)).run();
}

export function updateItems(ids: string[], patch: Partial<Pick<OrganizeItem, "status" | "error" | "finishedAt">>): void {
  if (ids.length === 0) return;
  const set: Partial<typeof organizeItems.$inferInsert> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt;
  if (Object.keys(set).length === 0) return;
  db.update(organizeItems).set(set).where(inArray(organizeItems.id, ids)).run();
}

const OWN_WINDOW_S = 24 * 3600;
/** 一条 rename + 一条 move（115 分两条事件报同一次整理），再多就是别人动的 */
const OWN_MAX_HITS = 2;
const dirOfPath = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf("/")));
const baseOfPath = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/**
 * 网盘监控用：这条事件（节点 nodeId 出现在 path，时间 at）是不是整理自己做的。
 *   - 执行过的项（done）：新路径是 dstPath，或者先原地改名后的中间路径 `源目录/新名字`
 *   - 撤销过的项（reverted）：新路径是 srcPath，或者反向的中间路径 `目标目录/旧名字`
 *   - 建目录项（mkdir done）：夸克快照会把新目录报成 create，115 报成 folder
 *   - 删目录的事件（kind = remove）：只按节点认执行时删掉的源目录（rmdir done）和撤销时删掉的自建目录（mkdir reverted）
 * 只认操作之后 24 小时内、且事件时间不早于操作的；每项最多认 OWN_MAX_HITS 条，之后同一节点再动就是用户动的
 */
export function findOwnOperation(nodeId: string, path: string, at: number, kind: "remove" | "other" = "other"): OrganizeItem | null {
  if (!nodeId) return null;
  const cutoff = Math.floor(Date.now() / 1000) - OWN_WINDOW_S;
  const rows = db
    .select()
    .from(organizeItems)
    .where(and(eq(organizeItems.nodeId, nodeId), gt(organizeItems.finishedAt, cutoff), inArray(organizeItems.status, ["done", "reverted"]), lt(organizeItems.hits, OWN_MAX_HITS)))
    .orderBy(desc(organizeItems.finishedAt))
    .limit(10)
    .all()
    .map(toItem);
  for (const it of rows) {
    // 事件比操作还早（快照式来源的时间是扫描时间，给 5 分钟余量）
    if (it.finishedAt !== null && at > 0 && at < it.finishedAt - 300) continue;
    // 删目录的事件：目录已经不在路径缓存里，事件报的路径靠不住，按节点认——执行时删掉的腾空源目录（撤销时重建的是新节点，
    // 旧节点的删除只可能是我们做的，所以不看状态）、撤销时删掉的自建目录（done 的自建目录被删就是用户删的，要照常处理）。
    // 文件从来不删，所以文件节点的删除一定是用户做的
    if (kind === "remove") {
      if (it.action === "rmdir" || (it.action === "mkdir" && it.status === "reverted")) return it;
      continue;
    }
    if (it.status === "done") {
      const intermediate = `${dirOfPath(it.srcPath)}/${baseOfPath(it.dstPath)}`;
      if (path === it.dstPath || path === intermediate) return it;
    } else {
      const back = `${dirOfPath(it.dstPath)}/${baseOfPath(it.srcPath)}`;
      if (path === it.srcPath || path === back) return it;
    }
  }
  return null;
}

/** 监控跳过了一条：计一次，超过 OWN_MAX_HITS 就不再认 */
export function bumpOwnHit(id: string): void {
  db.update(organizeItems).set({ hits: sql`${organizeItems.hits} + 1` }).where(eq(organizeItems.id, id)).run();
}

/* ------------------------------- 识别记忆 ------------------------------- */

export function rememberMatch(m: Omit<OrganizeMatchMemory, "updatedAt">): void {
  const updatedAt = Math.floor(Date.now() / 1000);
  db.insert(organizeMatches)
    .values({
      accountName: m.accountName,
      srcPath: m.srcPath,
      mediaType: m.mediaType,
      tmdbId: m.tmdbId,
      title: m.title,
      year: m.year,
      season: m.season,
      episodeOffset: m.episodeOffset,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [organizeMatches.accountName, organizeMatches.srcPath],
      set: { mediaType: m.mediaType, tmdbId: m.tmdbId, title: m.title, year: m.year, season: m.season, episodeOffset: m.episodeOffset, updatedAt },
    })
    .run();
}

export function recallMatch(accountName: string, srcPath: string): OrganizeMatchMemory | null {
  const row = db
    .select()
    .from(organizeMatches)
    .where(and(eq(organizeMatches.accountName, accountName), eq(organizeMatches.srcPath, srcPath)))
    .get();
  return row ? toMemory(row) : null;
}

export function forgetMatch(accountName: string, srcPath: string): boolean {
  return db.delete(organizeMatches).where(and(eq(organizeMatches.accountName, accountName), eq(organizeMatches.srcPath, srcPath))).run().changes > 0;
}

/** 目录被整理挪走后，记忆跟着改路径，下次在新位置也认得 */
export function repathMatches(accountName: string, oldPath: string, newPath: string): number {
  const rows = db
    .select()
    .from(organizeMatches)
    .where(and(eq(organizeMatches.accountName, accountName), or(eq(organizeMatches.srcPath, oldPath), like(organizeMatches.srcPath, `${oldPath}/%`))))
    .all();
  let n = 0;
  db.transaction((tx) => {
    for (const r of rows) {
      const next = r.srcPath === oldPath ? newPath : `${newPath}${r.srcPath.slice(oldPath.length)}`;
      tx.delete(organizeMatches).where(and(eq(organizeMatches.accountName, accountName), eq(organizeMatches.srcPath, r.srcPath))).run();
      tx.insert(organizeMatches)
        .values({ ...r, srcPath: next })
        .onConflictDoUpdate({ target: [organizeMatches.accountName, organizeMatches.srcPath], set: { tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title, year: r.year, season: r.season, episodeOffset: r.episodeOffset, updatedAt: r.updatedAt } })
        .run();
      n++;
    }
  });
  return n;
}

export function listMatches(accountName?: string): OrganizeMatchMemory[] {
  return db
    .select()
    .from(organizeMatches)
    .where(accountName ? eq(organizeMatches.accountName, accountName) : undefined)
    .orderBy(desc(organizeMatches.updatedAt))
    .all()
    .map(toMemory);
}

/* ------------------------------- TMDB 缓存 ------------------------------- */

export function readTmdbCache<T>(key: string, maxAgeSec: number): T | null {
  const row = db.select().from(tmdbCache).where(eq(tmdbCache.key, key)).get();
  if (!row) return null;
  if (Math.floor(Date.now() / 1000) - row.fetchedAt > maxAgeSec) return null;
  return parseJson<T | null>(row.value, null);
}

export function writeTmdbCache(key: string, value: unknown): void {
  const fetchedAt = Math.floor(Date.now() / 1000);
  db.insert(tmdbCache)
    .values({ key, value: JSON.stringify(value), fetchedAt })
    .onConflictDoUpdate({ target: tmdbCache.key, set: { value: JSON.stringify(value), fetchedAt } })
    .run();
}

export function deleteTmdbCacheBefore(cutoffSec: number): number {
  return db.delete(tmdbCache).where(lt(tmdbCache.fetchedAt, cutoffSec)).run().changes;
}

export function clearTmdbCache(): void {
  db.delete(tmdbCache).run();
}

/** 仅供测试 */
export function __test_resetOrganize(): void {
  db.delete(organizeItems).run();
  db.delete(organizeUnits).run();
  db.delete(organizeRuns).run();
  db.delete(organizeMatches).run();
  db.delete(tmdbCache).run();
}

export type { OrganizeConfidence, OrganizeMediaType };
