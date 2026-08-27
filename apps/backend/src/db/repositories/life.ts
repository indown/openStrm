import { sql, eq, inArray, desc, lt } from "drizzle-orm";
import { db } from "../client.js";
import { settings, pathCache, lifeEvents } from "../schema.js";
import type { PathCacheRow, LifeEventRow } from "../schema.js";

/* ------------------------------------------------------------------ *
 * 内部 KV：直接借用 settings 表，但不带 `app.` 前缀。
 * readAppSettings/patchAppSettings 只认 `app.%`，所以这里的键既不会
 * 出现在设置接口里，也不会被整体覆写设置时误删。
 * ------------------------------------------------------------------ */

export function readKv<T>(key: string): T | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function writeKv(key: string, value: unknown): void {
  db.insert(settings)
    .values({ key, value: JSON.stringify(value), updatedAt: sql`(unixepoch())` })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: JSON.stringify(value), updatedAt: sql`(unixepoch())` },
    })
    .run();
}

/* ------------------------------- path_cache ------------------------------- */

export interface PathCacheInput {
  fileId: string;
  parentId: string;
  name: string;
  path: string;
  isDir: boolean;
  accountName: string;
}

export function upsertPathCache(rows: PathCacheInput[]): void {
  if (rows.length === 0) return;
  const values = rows.map((r) => ({
    fileId: r.fileId,
    parentId: r.parentId,
    name: r.name,
    path: r.path,
    isDir: r.isDir ? 1 : 0,
    accountName: r.accountName,
    updatedAt: sql`(unixepoch())`,
  }));
  // 分批，避免超过 SQLite 999 个绑定参数的上限
  const CHUNK = 100;
  db.transaction((tx) => {
    for (let i = 0; i < values.length; i += CHUNK) {
      tx.insert(pathCache)
        .values(values.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: pathCache.fileId,
          set: {
            parentId: sql`excluded.parent_id`,
            name: sql`excluded.name`,
            path: sql`excluded.path`,
            isDir: sql`excluded.is_dir`,
            accountName: sql`excluded.account_name`,
            updatedAt: sql`(unixepoch())`,
          },
        })
        .run();
    }
  });
}

export function getPathCacheRow(fileId: string): PathCacheRow | undefined {
  return db.select().from(pathCache).where(eq(pathCache.fileId, fileId)).get();
}

export function deletePathCache(fileIds: string[]): void {
  if (fileIds.length === 0) return;
  db.delete(pathCache).where(inArray(pathCache.fileId, fileIds)).run();
}

/** 目录改名/移动后，把该目录自身及其所有后代的 path 前缀整体重写 */
export function repathSubtree(oldPath: string, newPath: string): number {
  if (!oldPath || !newPath || oldPath === newPath) return 0;
  const res = db
    .update(pathCache)
    .set({
      path: sql`${newPath} || substr(${pathCache.path}, ${oldPath.length + 1})`,
      updatedAt: sql`(unixepoch())`,
    })
    // 自身 + 后代（后代一定以 oldPath + "/" 开头）
    .where(sql`(${pathCache.path} = ${oldPath} OR ${pathCache.path} LIKE ${oldPath + "/%"})`)
    .run();
  return res.changes ?? 0;
}

/** 删除目录时清掉整棵子树的缓存 */
export function dropSubtree(path: string): void {
  if (!path) return;
  db.delete(pathCache)
    .where(sql`(${pathCache.path} = ${path} OR ${pathCache.path} LIKE ${path + "/%"})`)
    .run();
}

export function countPathCache(): number {
  const row = db.select({ n: sql<number>`count(*)` }).from(pathCache).get();
  return row?.n ?? 0;
}

/* ------------------------------- life_events ------------------------------ */

export interface LifeEventInput {
  id: string;
  accountName: string;
  type: number;
  fileId: string;
  parentId: string;
  fileName: string;
  fileCategory: number;
  fileSize: number;
  sha1: string;
  pickCode: string;
  updateTime: number;
  createTime: number;
}

export function upsertLifeEvents(rows: LifeEventInput[]): void {
  if (rows.length === 0) return;
  const CHUNK = 60;
  db.transaction((tx) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      tx.insert(lifeEvents)
        .values(rows.slice(i, i + CHUNK))
        .onConflictDoNothing({ target: lifeEvents.id })
        .run();
    }
  });
}

export function markLifeEvent(id: string, status: string, detail = ""): void {
  db.update(lifeEvents)
    .set({ status, detail: detail.slice(0, 500), handledAt: Math.floor(Date.now() / 1000) })
    .where(eq(lifeEvents.id, id))
    .run();
}

export function listRecentLifeEvents(limit = 50): LifeEventRow[] {
  return db.select().from(lifeEvents).orderBy(desc(lifeEvents.updateTime)).limit(limit).all();
}

export function countLifeEvents(): number {
  const row = db.select({ n: sql<number>`count(*)` }).from(lifeEvents).get();
  return row?.n ?? 0;
}

/** 只在事件表已存在该 id 且已处理成功时返回 true，用于跨重启去重 */
export function isLifeEventHandled(id: string): boolean {
  const row = db
    .select({ status: lifeEvents.status })
    .from(lifeEvents)
    .where(eq(lifeEvents.id, id))
    .get();
  return row?.status === "done" || row?.status === "skipped";
}

/* -------------------------------- 留存清理 -------------------------------- */

/** 删掉 115 侧 update_time 早于 cutoff（unix 秒）的事件，返回条数 */
export function deleteLifeEventsBefore(cutoffSec: number): number {
  return db.delete(lifeEvents).where(lt(lifeEvents.updateTime, cutoffSec)).run().changes;
}

/** 删掉自 cutoff（unix 秒）以来没被任何目录列举刷新过的路径缓存，返回条数 */
export function deletePathCacheNotTouchedSince(cutoffSec: number): number {
  return db.delete(pathCache).where(lt(pathCache.updatedAt, cutoffSec)).run().changes;
}
