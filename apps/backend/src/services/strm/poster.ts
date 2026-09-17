/**
 * strm 管理页背景用的海报：本地目录能拿到什么就用什么，四级回退，尽量不碰外网。
 *
 *   ① local 目录里现成的图片（poster / folder / cover）——默认 downloadExtensions 带 .jpg/.png，随片下载过来的
 *   ② tmdb  目录名里的 id 标签（整理后的默认命名就带 `[tmdbid=1]`）→ TMDB 详情缓存
 *   ③ tmdb  目录里的 tvshow.nfo / movie.nfo 给出 tmdbId → 同上
 *   ④ run   这个任务整理过的记录：organize_units.match 自带海报地址
 *
 * ②③ 只在缓存命中时不联网；缓存没有又没配 TMDB key 就跳过——背景图是锦上添花，
 * 任何一步出错都只是这个目录没海报，不许往上抛。
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type { OrganizeMatch, OrganizeMediaType, StrmPoster, TaskDefinition } from "@openstrm/shared";
import { listRuns, listUnits, readTmdbCache, writeTmdbCache } from "../../db/repositories/organize.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { mapLimit } from "../../lib/async.js";
import { readTextCapped } from "../../lib/fs.js";
import { HttpError } from "../../lib/http-error.js";
import { moduleLogger } from "../../lib/logger.js";
import { idTagFromName } from "../organize/identify.js";
import { readNfoFacts } from "../organize/nfo.js";
import { getDetails, throttleTmdb } from "../tmdb.js";
import { resolveManagedPath } from "./manage.js";

const log = moduleLogger("strm-poster");

export const POSTER_LIMITS = {
  /** 一次最多解析这么多目录 */
  PATHS: 48,
  /** 背景图不需要更大的；超过就当没有 */
  MAX_IMAGE_BYTES: 16 * 1024 * 1024,
  /** 找 tmdbid 读这么多字节就够 */
  NFO_BYTES: 256 * 1024,
  /** 第 ④ 级往回翻几次整理记录 */
  RUNS: 10,
} as const;

/** 能当背景图的扩展名 → Content-Type */
const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** 海报文件名（不带扩展名），按优先级：Emby 写 poster，Jellyfin 写 folder，刮削器还会留 cover / default */
const POSTER_STEMS = ["poster", "folder", "cover", "default"];

/** 作品级 nfo，按优先级 */
const NFO_NAMES = ["tvshow.nfo", "movie.nfo"];

/** 和 organize/identify.ts 的 TmdbClient 用同一个缓存键，两边共享一份详情缓存 */
const DETAILS_TTL = 7 * 24 * 3600;
const detailsKey = (kind: OrganizeMediaType, id: number, language: string): string => `details:${kind}:${id}:${language}`;

interface Pending {
  rel: string;
  tmdbId: number;
  /** 目录名 / nfo 只给 id 不给类型，这是按目录结构猜的 */
  guess: OrganizeMediaType;
}

/* ------------------------------- ① 本地图片 ------------------------------- */

function localPosterName(names: string[]): string | null {
  const lower = new Map<string, string>();
  for (const n of names) lower.set(n.toLowerCase(), n);
  for (const stem of POSTER_STEMS) {
    for (const ext of Object.keys(IMAGE_TYPES)) {
      const hit = lower.get(`${stem}${ext}`);
      if (hit) return hit;
    }
  }
  return null;
}

/* ------------------------------- ②③ tmdbId ------------------------------- */

/** 目录里有子目录就当剧集，没有就当电影；任务上配了库类型先验就听它的 */
function guessMediaType(task: TaskDefinition, hasSubdir: boolean): OrganizeMediaType {
  const prior = task.organize?.libraryType;
  if (prior === "movie" || prior === "tv") return prior;
  return hasSubdir ? "tv" : "movie";
}

async function nfoTmdbId(dir: string, names: string[]): Promise<number | null> {
  const lower = new Map<string, string>();
  for (const n of names) lower.set(n.toLowerCase(), n);
  for (const want of NFO_NAMES) {
    const hit = lower.get(want);
    if (!hit) continue;
    try {
      const xml = await readTextCapped(path.join(dir, hit), POSTER_LIMITS.NFO_BYTES);
      const facts = xml ? readNfoFacts(xml) : null;
      if (facts?.tmdbId) return facts.tmdbId;
    } catch {
      /* 读不动就算了 */
    }
  }
  return null;
}

/**
 * 详情缓存先查两种类型（id 标签和 nfo 都不说是电影还是剧），命中哪个算哪个；
 * 都没有才按猜的类型去拉一次，没配 key 就放弃。
 */
async function posterFromTmdb(pending: Pending, apiKey: string, language: string): Promise<StrmPoster | null> {
  const kinds: OrganizeMediaType[] = pending.guess === "movie" ? ["movie", "tv"] : ["tv", "movie"];
  for (const kind of kinds) {
    const hit = readTmdbCache<{ posterUrl?: string; title?: string; year?: string } | null>(
      detailsKey(kind, pending.tmdbId, language),
      DETAILS_TTL,
    );
    if (hit?.posterUrl) return { source: "tmdb", url: hit.posterUrl, title: hit.title, year: hit.year, tmdbId: pending.tmdbId };
  }
  if (!apiKey) return null;
  const kind = kinds[0];
  try {
    await throttleTmdb();
    const details = await getDetails(apiKey, kind, pending.tmdbId, language);
    writeTmdbCache(detailsKey(kind, pending.tmdbId, language), details);
    if (details?.posterUrl) {
      return { source: "tmdb", url: details.posterUrl, title: details.title, year: details.year, tmdbId: pending.tmdbId };
    }
  } catch (err) {
    log.debug(`TMDB 详情拿不到（${kind} ${pending.tmdbId}）：${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

/* ------------------------------- ④ 整理记录 ------------------------------- */

/**
 * 最近几次整理记录里，按整理后的作品目录索引识别结果。
 * unit.dstRoot 是相对任务 originPath 的，本地 strm 目录相对 targetPath 是同一串，可以直接对上。
 */
function matchesByDstRoot(taskId: string): Map<string, OrganizeMatch> {
  const out = new Map<string, OrganizeMatch>();
  for (const run of listRuns({ taskId, limit: POSTER_LIMITS.RUNS })) {
    for (const unit of listUnits(run.id)) {
      if (!unit.dstRoot || !unit.match?.posterUrl) continue;
      // 新的 run 先遍历到，旧的不覆盖
      if (!out.has(unit.dstRoot)) out.set(unit.dstRoot, unit.match);
    }
  }
  return out;
}

/* ------------------------------- 对外 ------------------------------- */

/**
 * 一批目录（相对任务根）各自的海报。拿不到的不出现在结果里。
 * 超过 POSTER_LIMITS.PATHS 的部分直接丢掉——界面一屏也放不下那么多。
 */
export async function resolvePosters(task: TaskDefinition, rels: string[]): Promise<Record<string, StrmPoster>> {
  const wanted = [...new Set(rels)].slice(0, POSTER_LIMITS.PATHS);
  const out: Record<string, StrmPoster> = {};
  const pending: Pending[] = [];

  await mapLimit(wanted, 8, async (rel) => {
    let dir: string;
    try {
      dir = (await resolveManagedPath(task, rel)).full;
    } catch {
      return; // 路径不合法：当这个目录没有海报
    }
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = entries.map((e) => e.name);

    const local = localPosterName(names);
    if (local) {
      out[rel] = { source: "local", url: rel ? `${rel}/${local}` : local };
      return;
    }

    const guess = guessMediaType(
      task,
      entries.some((e) => e.isDirectory()),
    );
    const tag = idTagFromName(path.basename(rel), guess === "movie" ? "movie" : "tv");
    if (tag) {
      pending.push({ rel, tmdbId: tag.tmdbId, guess });
      return;
    }
    const fromNfo = await nfoTmdbId(dir, names);
    if (fromNfo) pending.push({ rel, tmdbId: fromNfo, guess });
  });

  if (pending.length > 0) {
    const settings = readAppSettings();
    const apiKey = settings.tmdb?.apiKey?.trim() ?? "";
    const language = settings.tmdb?.language || "zh-CN";
    // 串行：没命中缓存的要走 TMDB，那边本来就是限速的
    for (const p of pending) {
      const poster = await posterFromTmdb(p, apiKey, language);
      if (poster) out[p.rel] = poster;
    }
  }

  const missing = wanted.filter((rel) => !out[rel]);
  if (missing.length > 0) {
    const index = matchesByDstRoot(task.id);
    if (index.size > 0) {
      for (const rel of missing) {
        const m = index.get(rel);
        if (m) out[rel] = { source: "run", url: m.posterUrl, title: m.title, year: m.year, tmdbId: m.tmdbId };
      }
    }
  }

  return out;
}

export interface StrmImageFile {
  full: string;
  contentType: string;
  size: number;
  mtimeMs: number;
}

/** 本地图片：只放行图片扩展名，路径照旧过 resolveManagedPath 的越界 / 符号链接检查 */
export async function statImage(task: TaskDefinition, rel: string): Promise<StrmImageFile> {
  const mp = await resolveManagedPath(task, rel, { mustExist: true });
  const contentType = IMAGE_TYPES[path.extname(mp.rel).toLowerCase()];
  if (!contentType) throw new HttpError(400, "只能读图片");
  const st = await fsp.stat(mp.full);
  if (!st.isFile()) throw new HttpError(400, `不是文件：${mp.rel}`);
  if (st.size > POSTER_LIMITS.MAX_IMAGE_BYTES) throw new HttpError(413, "图片太大");
  return { full: mp.full, contentType, size: st.size, mtimeMs: st.mtimeMs };
}
