/**
 * 定期清理只增不减的表。启动时跑一次，之后每天一次。
 *
 * - task_history：30 天。每条最多带几千行日志。
 * - life_events：按 115 的 update_time 留 30 天。游标早就越过它们，删了不会被重拉。
 * - path_cache：180 天没被任何目录列举刷新过的条目。它是 move/rename 找旧路径的唯一依据，
 *   删掉后对应文件的改名事件退化成"按新增处理"，旧 strm 由全量任务的 removeExtraFiles 兜底。
 */
import { deleteLifeEventsBefore, deletePathCacheNotTouchedSince } from "../db/repositories/life.js";
import { cleanupOldHistory } from "./task-history.js";
import { moduleLogger } from "../lib/logger.js";

const DAY_S = 24 * 60 * 60;
export const LIFE_EVENT_RETENTION_S = 30 * DAY_S;
export const PATH_CACHE_RETENTION_S = 180 * DAY_S;

const log = moduleLogger("housekeeping");

export function runHousekeeping(now = Math.floor(Date.now() / 1000)): { lifeEvents: number; pathCache: number } {
  cleanupOldHistory();
  const lifeEvents = deleteLifeEventsBefore(now - LIFE_EVENT_RETENTION_S);
  const pathCache = deletePathCacheNotTouchedSince(now - PATH_CACHE_RETENTION_S);
  if (lifeEvents || pathCache) log.info({ lifeEvents, pathCache }, "清理过期记录");
  return { lifeEvents, pathCache };
}

/** 启动时一次 + 每天一次；定时器不阻止进程退出 */
export function startHousekeeping(): void {
  runHousekeeping();
  setInterval(() => {
    try {
      runHousekeeping();
    } catch (err) {
      log.warn({ err }, "清理失败，下次再试");
    }
  }, DAY_S * 1000).unref();
}
