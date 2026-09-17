/**
 * 影库刮削：把「待刮削」的条目排队去问 TMDB，回填标题 / 封面 / 年份 / TMDB id。
 *
 * 队列就是一条流：Subject 收 id，mergeMap 按 CONCURRENCY 取，每条自带重试。
 * 以前是手写的 queue + activeCount + scheduleTick，而且一次失败就定死——TMDB 的 429
 * （一批条目一起进来很容易撞上）或者网络抖一下，条目直接记 failed，人得回影库页手动重刮。
 * 现在瞬时失败退避重试几次（429 优先听 Retry-After），还不行才记 failed。
 * 重试挂在**单次搜索**上，不是整条 scrapeOne：一条剧集要问两三次 TMDB，包在外面重试会把
 * 已经问成功的那几次重发一遍——偏偏只有 429 / 5xx 才触发重试，等于在人家限速时加倍地打。
 *
 * 节流和整理功能共用 services/tmdb.ts 的 throttleTmdb（同一条时间线，≈4 req/s），
 * 所以这里并发留 1：真正的闸门在节流那边，多开只是在它前面排队。
 */
import { EMPTY, Subject, catchError, defer, finalize, lastValueFrom, mergeMap, retry, throwError } from "rxjs";
import type { MediaType } from "@openstrm/shared";
import {
  searchMovie,
  searchMulti,
  searchTv,
  throttleTmdb,
  tmdbRetryAfterMs,
  tmdbRetryable,
  type TmdbSearchResult,
} from "../tmdb.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import {
  getById,
  getPending,
  setScrapeStatus,
  updateScrape,
} from "../../db/repositories/media-library.js";
import { normalizeTitle } from "../media-title.js";
import { messageOf } from "../../lib/errors.js";
import { moduleLogger } from "../../lib/logger.js";
import { unrefTimer } from "../../lib/rx.js";

const log = moduleLogger("scrape-worker");

const CONCURRENCY = 1;
/** 瞬时失败最多再试这么多次；之后才把条目记成 failed */
const MAX_RETRIES = 2;

/* ------------------------------- 依赖注入 ------------------------------- */

interface Deps {
  searchMulti: typeof searchMulti;
  searchTv: typeof searchTv;
  searchMovie: typeof searchMovie;
  throttle: typeof throttleTmdb;
  /** 第 n 次重试前等多久（n 从 1 起）；429 自带 Retry-After 时优先听它 */
  retryDelayMs: (attempt: number) => number;
}

const realDeps: Deps = {
  searchMulti,
  searchTv,
  searchMovie,
  throttle: throttleTmdb,
  retryDelayMs: (attempt) => 1000 * 2 ** (attempt - 1),
};
let deps: Deps = { ...realDeps };

/** 仅供测试：换掉会碰网络的部分和等待时长；传 null 恢复 */
export function setScrapeWorkerDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/* ------------------------------- 一次搜索 ------------------------------- */

/** 问 TMDB 没问成（重试也没救回来）。和本地 / 库里的失败分开，写进条目的说明不一样 */
class TmdbSearchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TmdbSearchError";
  }
}

/** 过一次全局节流再发；429 / 5xx / 连不上退避重试，只重发这一次 */
async function runSearch(id: string, fn: () => Promise<TmdbSearchResult[]>): Promise<TmdbSearchResult[]> {
  try {
    return await lastValueFrom(
      defer(async () => {
        await deps.throttle();
        return fn();
      }).pipe(
        retry({
          delay: (err: unknown, attempt: number) => {
            if (attempt > MAX_RETRIES || !tmdbRetryable(err)) return throwError(() => err);
            const wait = tmdbRetryAfterMs(err) ?? deps.retryDelayMs(attempt);
            log.warn({ err, id }, `TMDB 这次没问到（第 ${attempt} 次），${Math.round(wait / 1000)}s 后重试`);
            return unrefTimer(wait);
          },
        }),
      ),
    );
  } catch (err) {
    throw new TmdbSearchError(messageOf(err), { cause: err });
  }
}

/* ------------------------------- 一条 ------------------------------- */

function coerceMediaType(mt: string | undefined): MediaType {
  if (mt === "movie" || mt === "tv") return mt;
  return "unknown";
}

/**
 * 刮一条。TMDB 的失败原样抛出去交给重试；「没标题」「没匹配」这种问多少次都一样的，
 * 自己记 failed 收尾。
 */
async function scrapeOne(id: string): Promise<void> {
  const entry = getById(id);
  if (!entry) return;
  if (entry.scrapeStatus !== "pending") return;

  const settings = readAppSettings();
  const apiKey = settings.tmdb?.apiKey?.trim() || "";
  const language = settings.tmdb?.language || "zh-CN";

  if (!apiKey) {
    setScrapeStatus(id, "done");
    return;
  }

  const queryBase = entry.rawName || entry.title || "";
  const { title: normalized, year, isTv } = normalizeTitle(queryBase);
  const query = normalized || queryBase;

  if (!query) {
    updateScrape(id, { status: "failed", notesAppend: "TMDB 查询失败：无标题" });
    return;
  }

  const search = (fn: () => Promise<TmdbSearchResult[]>) => runSearch(id, fn);

  // 两条分支都会赋值，不给初值，免得看着像「先空着再说」
  let results: TmdbSearchResult[];
  if (isTv) {
    results = await search(() => deps.searchTv(apiKey, query, year, language));
    if (results.length === 0) {
      results = await search(() => deps.searchMulti(apiKey, query, language));
    }
  } else {
    results = await search(() => deps.searchMulti(apiKey, query, language));
    if (results.length === 0 && year) {
      results = await search(() => deps.searchMovie(apiKey, query, year, language));
    }
  }
  // Last-chance fallback: trim trailing token and retry multi
  if (results.length === 0) {
    const tokens = query.split(/\s+/).filter(Boolean);
    if (tokens.length > 2) {
      const trimmed = tokens.slice(0, -1).join(" ");
      results = await search(() => deps.searchMulti(apiKey, trimmed, language));
    }
  }

  const top = results[0];
  if (!top) {
    updateScrape(id, { status: "failed", notesAppend: `TMDB 无匹配：${query}` });
    return;
  }

  updateScrape(id, {
    status: "done",
    title: top.title,
    coverUrl: top.posterUrl,
    year: top.year,
    tmdbId: top.id,
    mediaType: coerceMediaType(top.mediaType),
    overview: top.overview,
  });
}

/**
 * 救不回来了：把原因写进条目，人在影库页看得见，也能手动重刮。
 * 分清是「问 TMDB 没问成」还是本地 / 库里出的岔子——后者写成 TMDB 请求失败会让人往错的方向查。
 */
function markFailed(id: string, err: unknown): void {
  const msg = messageOf(err);
  const note = err instanceof TmdbSearchError ? `TMDB 请求失败：${msg}` : `刮削异常：${msg}`;
  try {
    updateScrape(id, { status: "failed", notesAppend: note });
  } catch (dbErr) {
    log.warn({ err: dbErr, id }, "刮削失败的原因没能写进条目");
  }
}

/* ------------------------------- 队列 ------------------------------- */

const queue$ = new Subject<string>();
/** 排队中、还没轮到的：status() 要报数，重复入队也靠它去重 */
const waiting = new Set<string>();
let activeCount = 0;
const idle$ = new Subject<void>();

function subscribeQueue(): void {
  queue$
    .pipe(
      mergeMap((id) => {
        // mergeMap 到了这里才是真轮到它：并发满的时候值先攒在 mergeMap 里
        waiting.delete(id);
        activeCount += 1;
        return defer(() => scrapeOne(id)).pipe(
          catchError((err: unknown) => {
            markFailed(id, err);
            return EMPTY;
          }),
          finalize(() => {
            activeCount -= 1;
            if (activeCount === 0 && waiting.size === 0) idle$.next();
          }),
        );
      }, CONCURRENCY),
    )
    .subscribe({
      // 上面每条都 catchError 过了，走到这里说明流本身出了意外。
      // 不重新挂上的话这个进程之后所有的刮削都会石沉大海（Subject 没人听），所以退一步重挂
      error: (err: unknown) => {
        log.error({ err }, "[scrape-worker] 队列异常退出，重新挂上");
        activeCount = 0;
        setTimeout(subscribeQueue, 0).unref?.();
      },
    });
}

subscribeQueue();

export function enqueue(ids: string[]): void {
  for (const id of ids) {
    if (waiting.has(id)) continue;
    waiting.add(id);
    queue$.next(id);
  }
}

export function enqueueOne(id: string): void {
  enqueue([id]);
}

export function start(): void {
  const pending = getPending();
  if (pending.length === 0) {
    log.info("[scrape-worker] no pending tasks");
    return;
  }
  log.info(`[scrape-worker] resumed ${pending.length} tasks`);
  enqueue(pending.map((p) => p.id));
}

export interface ScrapeWorkerStatus {
  queued: number;
  active: number;
}

export function status(): ScrapeWorkerStatus {
  return { queued: waiting.size, active: activeCount };
}

/** 仅供测试：等队列跑空 */
export function __test_whenIdle(): Promise<void> {
  if (activeCount === 0 && waiting.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const sub = idle$.subscribe(() => {
      sub.unsubscribe();
      resolve();
    });
  });
}
