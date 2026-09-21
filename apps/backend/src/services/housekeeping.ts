/**
 * 定期清理只增不减的表。启动时跑一次，之后每天一次。
 *
 * - task_history：30 天。每条最多带几千行日志。
 * - life_events：按 115 的 update_time 留 30 天。游标早就越过它们，删了不会被重拉。
 * - path_cache：180 天没被任何目录列举刷新过的条目。它是 move/rename 找旧路径的唯一依据，
 *   删掉后对应文件的改名事件退化成"按新增处理"，旧 strm 由全量任务的 removeExtraFiles 兜底。
 * - agent_audit：智能体的调用记录，30 天。
 * - OAuth：过期的授权请求、30 天没用又没连着的动态注册 / CIMD 客户端、刷新令牌过期的授权、过期了的「换过的刷新令牌」。
 */
import { deleteLifeEventsBefore, deletePathCacheNotTouchedSince } from "../db/repositories/life.js";
import { deleteFinishedRunsBefore, deleteTmdbCacheBefore } from "../db/repositories/organize.js";
import { deleteAgentCallsBefore } from "../db/repositories/agent-audit.js";
import {
  deleteExpiredOAuthGrants,
  deleteExpiredOAuthRequests,
  deleteStaleOAuthClients,
  deleteUsedRefreshBefore,
} from "../db/repositories/oauth.js";
import { REFRESH_TOKEN_TTL_S } from "./oauth/config.js";
import { cleanupOldHistory } from "./task-history.js";
import { moduleLogger } from "../lib/logger.js";

const DAY_S = 24 * 60 * 60;
export const LIFE_EVENT_RETENTION_S = 30 * DAY_S;
export const PATH_CACHE_RETENTION_S = 180 * DAY_S;
/** 整理记录：30 天，且每个任务至少留最近 5 次（撤销要用） */
export const ORGANIZE_RUN_RETENTION_S = 30 * DAY_S;
export const TMDB_CACHE_RETENTION_S = 30 * DAY_S;
export const AGENT_AUDIT_RETENTION_S = 30 * DAY_S;
/** 动态注册谁都能发、CIMD 谁都能让我们去取：30 天没用、也没有连着的，清掉 */
export const OAUTH_CLIENT_RETENTION_S = 30 * DAY_S;

const log = moduleLogger("housekeeping");

export function runHousekeeping(now = Math.floor(Date.now() / 1000)): { lifeEvents: number; pathCache: number } {
  cleanupOldHistory();
  const lifeEvents = deleteLifeEventsBefore(now - LIFE_EVENT_RETENTION_S);
  const pathCache = deletePathCacheNotTouchedSince(now - PATH_CACHE_RETENTION_S);
  const organizeRuns = deleteFinishedRunsBefore(now - ORGANIZE_RUN_RETENTION_S);
  const tmdbCache = deleteTmdbCacheBefore(now - TMDB_CACHE_RETENTION_S);
  const agentCalls = deleteAgentCallsBefore(now - AGENT_AUDIT_RETENTION_S);
  const oauth =
    deleteExpiredOAuthRequests(now) +
    deleteExpiredOAuthGrants(now) +
    deleteStaleOAuthClients(now - OAUTH_CLIENT_RETENTION_S) +
    // 刷新令牌最长 30 天：再早换过的，就算被重放也早过期了
    deleteUsedRefreshBefore(now - REFRESH_TOKEN_TTL_S);
  if (lifeEvents || pathCache || organizeRuns || tmdbCache || agentCalls || oauth) {
    log.info({ lifeEvents, pathCache, organizeRuns, tmdbCache, agentCalls, oauth }, "清理过期记录");
  }
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
