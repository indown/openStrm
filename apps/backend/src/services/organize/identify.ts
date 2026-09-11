/**
 * 识别：一个作品单元 → TMDB 上的哪一部。证据优先级从高到低：
 *   识别词直指 → 用户记忆（organize_matches）→ 影库条目 / nfo 里的 tmdbid → 目录名 / 文件名解析后搜索打分。
 *
 * 打分：标题（归一化后对 title / original_title / 别名）相等 +3；年份相等 +2、差一年 +1；类型和解析一致 +1；
 * popularity 只做同分排序。置信度：来自 id 证据或「标题相等且年份相等」是 high；标题相等但年份缺 / 差一年、
 * 或首选领先第二名 ≥ 3 分是 medium；其余有结果是 low；没结果 none。
 *
 * TMDB 请求都过 TmdbClient：进程内 + 库里两层缓存，节流在 services/tmdb.ts。
 */
import type { OrganizeCandidate, OrganizeConfidence, OrganizeMatch, OrganizeMatchMemory, OrganizeMediaType } from "@openstrm/shared";
import { readTmdbCache, writeTmdbCache } from "../../db/repositories/organize.js";
import { getDetails, getSeasonEpisodes, searchMovie, searchMulti, searchTv, throttleTmdb, type TmdbDetails, type TmdbEpisode, type TmdbSearchResult } from "../tmdb.js";
import type { DirectSpec } from "./rules.js";
import type { Unit } from "./units.js";

/* ------------------------------- TMDB 客户端（带缓存） ------------------------------- */

export interface TmdbApi {
  search(query: string, kind: OrganizeMediaType | "multi", year?: string): Promise<TmdbSearchResult[]>;
  details(kind: OrganizeMediaType, id: number): Promise<TmdbDetails | null>;
  season(tvId: number, season: number): Promise<TmdbEpisode[]>;
}

const SEARCH_TTL = 24 * 3600;
const DETAILS_TTL = 7 * 24 * 3600;
const SEASON_TTL = 24 * 3600;

export class TmdbClient implements TmdbApi {
  private readonly memo = new Map<string, unknown>();

  constructor(
    private readonly apiKey: string,
    private readonly language: string,
  ) {}

  private async cached<T>(key: string, ttl: number, fetcher: () => Promise<T>): Promise<T> {
    const k = `${key}:${this.language}`;
    if (this.memo.has(k)) return this.memo.get(k) as T;
    const hit = readTmdbCache<T>(k, ttl);
    if (hit !== null) {
      this.memo.set(k, hit);
      return hit;
    }
    await throttleTmdb();
    const value = await fetcher();
    this.memo.set(k, value);
    writeTmdbCache(k, value);
    return value;
  }

  search(query: string, kind: OrganizeMediaType | "multi", year?: string): Promise<TmdbSearchResult[]> {
    const q = query.trim();
    if (!q) return Promise.resolve([]);
    // 键里带版本：搜索结果的缓存形状变过（2026-09-11 加了 originalTitle），旧条目让它自然过期
    const key = `search:v2:${kind}:${q.toLowerCase()}:${year ?? ""}`;
    return this.cached(key, SEARCH_TTL, () => {
      if (kind === "movie") return searchMovie(this.apiKey, q, year, this.language);
      if (kind === "tv") return searchTv(this.apiKey, q, year, this.language);
      return searchMulti(this.apiKey, q, this.language);
    });
  }

  details(kind: OrganizeMediaType, id: number): Promise<TmdbDetails | null> {
    return this.cached(`details:${kind}:${id}`, DETAILS_TTL, () => getDetails(this.apiKey, kind, id, this.language));
  }

  season(tvId: number, season: number): Promise<TmdbEpisode[]> {
    return this.cached(`season:${tvId}:${season}`, SEASON_TTL, () => getSeasonEpisodes(this.apiKey, tvId, season, this.language));
  }
}

/* ------------------------------- 打分 ------------------------------- */

/** 标题归一化：小写、去标点和空白、全角转半角 */
export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s\-–—_.,:：;；!！?？'’"“”()（）[\]【】《》「」『』·・&+]/g, "")
    .replace(/^the/, "");
}

interface Scored {
  item: TmdbSearchResult;
  score: number;
  titleEqual: boolean;
  yearEqual: boolean;
}

function scoreCandidate(item: TmdbSearchResult, titles: string[], year: string | undefined, kindHint: Unit["kindHint"]): Scored {
  const norm = titles.map(normalizeTitle).filter(Boolean);
  // 搜索结果的 title 是本地化的（zh-CN 下是译名），文件名里多半是原名：两个都对
  const itemTitles = [item.title, item.originalTitle ?? ""].map(normalizeTitle).filter(Boolean);
  const titleEqual = norm.some((t) => itemTitles.includes(t));
  let score = 0;
  if (titleEqual) score += 3;
  else if (norm.some((t) => t.length >= 2 && itemTitles.some((it) => it.includes(t) || t.includes(it)))) score += 1;
  let yearEqual = false;
  if (year && item.year) {
    const d = Math.abs(Number(year) - Number(item.year));
    if (d === 0) {
      score += 2;
      yearEqual = true;
    } else if (d === 1) score += 1;
    else score -= 1;
  }
  if (kindHint !== "unknown" && item.mediaType === kindHint) score += 1;
  return { item, score, titleEqual, yearEqual };
}

function toCandidate(s: Scored): OrganizeCandidate {
  return {
    tmdbId: s.item.id,
    mediaType: s.item.mediaType === "movie" ? "movie" : "tv",
    title: s.item.title,
    year: s.item.year,
    posterUrl: s.item.posterUrl,
    overview: s.item.overview,
    score: s.score,
  };
}

/* ------------------------------- 识别 ------------------------------- */

const RE_ID_TAG = /[[{]\s*(tmdbid|tmdb)\s*[=-]\s*(\d+)\s*[\]}]/i;

/** 目录名里已经写了 id 标签（Emby `[tmdbid=1]`、Jellyfin `[tmdbid-1]`、Plex `{tmdb-1}`）：最硬的证据 */
export function idTagFromName(name: string, kindHint: Unit["kindHint"]): IdEvidence["known"] {
  const m = RE_ID_TAG.exec(name);
  if (!m) return null;
  return { tmdbId: Number(m[2]), mediaType: kindHint === "movie" ? "movie" : "tv", source: "目录名里的 tmdbid 标签" };
}

export interface IdEvidence {
  direct?: DirectSpec;
  memory?: OrganizeMatchMemory | null;
  /** 影库条目 / 本地 nfo 里的 tmdbid */
  known?: { tmdbId: number; mediaType: OrganizeMediaType; source: string } | null;
}

export interface IdentifyOptions {
  unit: Unit;
  evidence: IdEvidence;
  libraryType?: "movie" | "tv" | "mixed";
  /** 拉季集标题（开了集标题才要） */
  episodeTitles: boolean;
}

export interface IdentifyResult {
  match: OrganizeMatch | null;
  /** `season:episode` → 集标题 */
  episodeTitles: Map<string, string>;
}

async function fromDetails(tmdb: TmdbApi, kind: OrganizeMediaType, id: number, confidence: OrganizeConfidence, reason: string, candidates: OrganizeCandidate[] = []): Promise<OrganizeMatch | null> {
  const d = await tmdb.details(kind, id);
  if (!d) return null;
  return {
    mediaType: kind,
    tmdbId: d.id,
    title: d.title || d.originalTitle,
    originalTitle: d.originalTitle,
    enTitle: d.enTitle,
    year: d.year,
    posterUrl: d.posterUrl,
    imdbId: d.imdbId || undefined,
    confidence,
    reason,
    genreIds: d.genreIds,
    countries: d.countries,
    originalLanguage: d.originalLanguage,
    seasons: d.seasons,
    candidates,
  };
}

/** 按候选标题依次搜；带年份先搜，没结果再不带 */
async function searchAll(tmdb: TmdbApi, titles: string[], year: string | undefined, kind: OrganizeMediaType | "multi"): Promise<TmdbSearchResult[]> {
  const seen = new Set<string>();
  const out: TmdbSearchResult[] = [];
  const add = (list: TmdbSearchResult[]) => {
    for (const r of list) {
      const k = `${r.mediaType}:${r.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
  };
  for (const t of titles.slice(0, 3)) {
    if (year && kind !== "multi") add(await tmdb.search(t, kind, year));
    if (out.length === 0 || !year) add(await tmdb.search(t, kind));
    if (out.some((r) => normalizeTitle(r.title) === normalizeTitle(t))) break;
  }
  return out.filter((r) => r.mediaType === "movie" || r.mediaType === "tv");
}

export async function identifyUnit(opts: IdentifyOptions, tmdb: TmdbApi): Promise<IdentifyResult> {
  const { unit, evidence } = opts;
  const episodeTitles = new Map<string, string>();
  let match: OrganizeMatch | null = null;

  const direct = evidence.direct ?? unit.direct;
  if (direct) {
    const kind = direct.mediaType ?? (unit.kindHint === "movie" ? "movie" : "tv");
    match = await fromDetails(tmdb, kind, direct.tmdbId, "high", "识别词直接指定");
  }
  if (!match && evidence.memory) {
    match = await fromDetails(tmdb, evidence.memory.mediaType, evidence.memory.tmdbId, "high", "上次确认过的识别结果");
  }
  if (!match && evidence.known) {
    match = await fromDetails(tmdb, evidence.known.mediaType, evidence.known.tmdbId, "high", evidence.known.source);
  }

  if (!match) {
    const titles = unit.parsed.titles.length > 0 ? unit.parsed.titles : unit.parsed.title ? [unit.parsed.title] : [];
    if (titles.length === 0) return { match: null, episodeTitles };
    const year = unit.parsed.year;
    const kindHint: Unit["kindHint"] = unit.kindHint !== "unknown" ? unit.kindHint : opts.libraryType && opts.libraryType !== "mixed" ? opts.libraryType : "unknown";
    const searchKind: OrganizeMediaType | "multi" = kindHint === "unknown" ? "multi" : kindHint;
    let results = await searchAll(tmdb, titles, year, searchKind);
    // 剧集库里搜不到就放宽到 multi（电影 / 剧集分错了的情况）
    if (results.length === 0 && searchKind !== "multi") results = await searchAll(tmdb, titles, year, "multi");
    if (results.length === 0) {
      // 最后一搏：去掉最后一个词再搜（标题尾巴带了没认出的噪音）
      const tokens = titles[0].split(/\s+/);
      if (tokens.length > 2) results = await searchAll(tmdb, [tokens.slice(0, -1).join(" ")], year, "multi");
    }
    if (results.length === 0) return { match: null, episodeTitles };

    const scored = results.map((r) => scoreCandidate(r, titles, year, kindHint)).sort((a, b) => b.score - a.score);
    const kindOf = (s: Scored): OrganizeMediaType => (s.item.mediaType === "movie" ? "movie" : "tv");
    let pick = scored[0];
    const second = scored[1];
    let confidence: OrganizeConfidence = "low";
    let reason = "只是搜索结果里最像的";
    if (pick.titleEqual && pick.yearEqual) {
      confidence = "high";
      reason = "标题和年份都对上";
    } else if (pick.titleEqual && (!year || !pick.item.year || Math.abs(Number(year) - Number(pick.item.year)) === 1)) {
      confidence = "medium";
      reason = year ? "标题对上，年份差一年" : "标题对上，文件名里没有年份";
    } else if (!second || pick.score - second.score >= 3) {
      confidence = pick.titleEqual ? "medium" : "low";
      reason = pick.titleEqual ? "标题对上，年份对不上" : "搜索结果里明显领先";
    }
    if (!pick.titleEqual) {
      // 标题和原名都没对上（文件名用的是别的语言的译名）：拿前五名的详情看别名，谁的别名命中就选谁；详情有缓存，不多花请求
      const norm = titles.map(normalizeTitle);
      for (const s of scored.slice(0, 5)) {
        const d = await tmdb.details(kindOf(s), s.item.id);
        if (!d) continue;
        const aliases = [d.title, d.originalTitle, d.enTitle ?? "", ...d.aliases].map(normalizeTitle);
        if (!norm.some((t) => aliases.includes(t)) || (year && year !== d.year)) continue;
        pick = s;
        confidence = year ? "high" : "medium";
        reason = year ? "别名和年份都对上" : "别名对上，文件名里没有年份";
        break;
      }
    }
    match = await fromDetails(tmdb, kindOf(pick), pick.item.id, confidence, reason, scored.slice(0, 8).map(toCandidate));
  }

  if (match && match.mediaType === "tv" && opts.episodeTitles) {
    const seasonsNeeded = new Set<number>();
    for (const f of unit.files) {
      if (f.kind !== "video") continue;
      const s = f.parsed.season ?? f.seasonFromDir ?? unit.parsed.season ?? 1;
      seasonsNeeded.add(s);
    }
    for (const s of seasonsNeeded) {
      try {
        for (const e of await tmdb.season(match.tmdbId, s)) if (e.name) episodeTitles.set(`${s}:${e.episode}`, e.name);
      } catch {
        /* 集标题只是锦上添花，拉不到就不写 */
      }
    }
  }
  return { match, episodeTitles };
}
