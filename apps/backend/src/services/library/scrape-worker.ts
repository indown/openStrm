import { searchMulti, searchMovie, searchTv, type TmdbSearchResult } from "../tmdb.js";
import { readSettings } from "../cloud-115/settings-reader.js";
import {
  getById,
  getPending,
  setScrapeStatus,
  updateScrape,
} from "../../db/repositories/media-library.js";
import { normalizeTitle } from "../media-title.js";
import type { MediaType } from "@openstrm/shared";

/** 全局 throttle 用的是同一条 `lastRequestAt` 时间线，因此并行 worker 实际被串行化。
 *  保持 CONCURRENCY=1 以避免 "伪并发" 带来的误解；TMDB 速率由 MIN_INTERVAL_MS 控制 (≈4 req/s)。 */
const CONCURRENCY = 1;
const MIN_INTERVAL_MS = 250;

let lastRequestAt = 0;
let activeCount = 0;
const queue: string[] = [];
const queued = new Set<string>();
const recentlyCompleted = new Map<string, number>();
let tickScheduled = false;

async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = lastRequestAt + MIN_INTERVAL_MS - now;
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequestAt = Date.now();
}

function scheduleTick() {
  if (tickScheduled) return;
  tickScheduled = true;
  setImmediate(() => {
    tickScheduled = false;
    tick();
  });
}

function markCompleted(id: string) {
  recentlyCompleted.set(id, Date.now());
  const cutoff = Date.now() - 60_000;
  for (const [k, t] of recentlyCompleted) {
    if (t < cutoff) recentlyCompleted.delete(k);
  }
}

function coerceMediaType(mt: string | undefined): MediaType {
  if (mt === "movie" || mt === "tv") return mt;
  return "unknown";
}

async function processOne(id: string) {
  try {
    const entry = getById(id);
    if (!entry) return;
    if (entry.scrapeStatus !== "pending") return;

    const settings = readSettings();
    const apiKey = settings.tmdb?.apiKey?.trim() || "";
    const language = settings.tmdb?.language || "zh-CN";

    if (!apiKey) {
      setScrapeStatus(id, "done");
      markCompleted(id);
      return;
    }

    const queryBase = entry.rawName || entry.title || "";
    const { title: normalized, year, isTv } = normalizeTitle(queryBase);
    const query = normalized || queryBase;

    if (!query) {
      updateScrape(id, { status: "failed", notesAppend: "TMDB 查询失败：无标题" });
      markCompleted(id);
      return;
    }

    const runSearch = async (fn: () => Promise<TmdbSearchResult[]>): Promise<TmdbSearchResult[]> => {
      await throttle();
      return fn();
    };

    let results: TmdbSearchResult[] = [];
    try {
      if (isTv) {
        results = await runSearch(() => searchTv(apiKey, query, year, language));
        if (results.length === 0) {
          results = await runSearch(() => searchMulti(apiKey, query, language));
        }
      } else {
        results = await runSearch(() => searchMulti(apiKey, query, language));
        if (results.length === 0 && year) {
          results = await runSearch(() => searchMovie(apiKey, query, year, language));
        }
      }
      // Last-chance fallback: trim trailing token and retry multi
      if (results.length === 0) {
        const tokens = query.split(/\s+/).filter(Boolean);
        if (tokens.length > 2) {
          const trimmed = tokens.slice(0, -1).join(" ");
          results = await runSearch(() => searchMulti(apiKey, trimmed, language));
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "TMDB 请求失败";
      updateScrape(id, { status: "failed", notesAppend: `TMDB 请求失败：${msg}` });
      markCompleted(id);
      return;
    }

    const top = results[0];
    if (!top) {
      updateScrape(id, { status: "failed", notesAppend: `TMDB 无匹配：${query}` });
      markCompleted(id);
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
    markCompleted(id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      updateScrape(id, { status: "failed", notesAppend: `刮削异常：${msg}` });
    } catch {
      // ignore
    }
    markCompleted(id);
  }
}

function tick() {
  while (activeCount < CONCURRENCY && queue.length > 0) {
    const id = queue.shift()!;
    queued.delete(id);
    activeCount += 1;
    processOne(id)
      .catch(() => {})
      .finally(() => {
        activeCount -= 1;
        scheduleTick();
      });
  }
}

export function enqueue(ids: string[]): void {
  for (const id of ids) {
    if (queued.has(id)) continue;
    queued.add(id);
    queue.push(id);
  }
  scheduleTick();
}

export function enqueueOne(id: string): void {
  enqueue([id]);
}

export function start(): void {
  const pending = getPending();
  if (pending.length === 0) {
    console.log("[scrape-worker] no pending tasks");
    return;
  }
  console.log(`[scrape-worker] resumed ${pending.length} tasks`);
  enqueue(pending.map((p) => p.id));
}

export interface ScrapeWorkerStatus {
  queued: number;
  active: number;
  pending: number;
  recentlyCompleted: string[];
}

export function status(): ScrapeWorkerStatus {
  const pending = getPending();
  return {
    queued: queue.length,
    active: activeCount,
    pending: pending.length,
    recentlyCompleted: Array.from(recentlyCompleted.keys()),
  };
}
