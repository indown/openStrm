import axios from "axios";

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p/w500";

export interface TmdbSearchResult {
  id: number;
  mediaType: "movie" | "tv" | "person";
  /** 按请求语言本地化的标题（zh-CN 下是译名） */
  title: string;
  /** 原名（original_title / original_name）：文件名多半是原名，识别打分要对它 */
  originalTitle?: string;
  year: string;
  posterUrl: string;
  overview: string;
}

interface TmdbRawItem {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  profile_path?: string | null;
  overview?: string;
}

export async function searchMulti(
  apiKey: string,
  query: string,
  language = "zh-CN",
): Promise<TmdbSearchResult[]> {
  const q = query.trim();
  if (!q) return [];

  const resp = await axios.get(`${TMDB_BASE}/search/multi`, {
    params: { query: q, language, include_adult: false, page: 1 },
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    timeout: 15000,
  });

  const results = (resp.data?.results ?? []) as TmdbRawItem[];
  return results
    .filter((r) => r.media_type !== "person")
    .slice(0, 10)
    .map<TmdbSearchResult>((r) => {
      const date = r.release_date || r.first_air_date || "";
      const poster = r.poster_path || r.profile_path || "";
      return {
        id: r.id,
        mediaType: (r.media_type as TmdbSearchResult["mediaType"]) ?? "movie",
        title: r.title || r.name || "",
        originalTitle: r.original_title || r.original_name || "",
        year: date ? date.slice(0, 4) : "",
        posterUrl: poster ? `${IMAGE_BASE}${poster}` : "",
        overview: r.overview ?? "",
      };
    });
}

export async function searchTv(
  apiKey: string,
  query: string,
  year: string | undefined,
  language = "zh-CN",
): Promise<TmdbSearchResult[]> {
  const q = query.trim();
  if (!q) return [];

  const params: Record<string, string | number | boolean> = {
    query: q,
    language,
    include_adult: false,
    page: 1,
  };
  if (year && /^(19|20)\d{2}$/.test(year)) params.first_air_date_year = year;

  const resp = await axios.get(`${TMDB_BASE}/search/tv`, {
    params,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    timeout: 15000,
  });

  const results = (resp.data?.results ?? []) as TmdbRawItem[];
  return results.slice(0, 10).map<TmdbSearchResult>((r) => {
    const date = r.first_air_date || "";
    const poster = r.poster_path || "";
    return {
      id: r.id,
      mediaType: "tv",
      title: r.name || r.title || "",
      originalTitle: r.original_name || r.original_title || "",
      year: date ? date.slice(0, 4) : "",
      posterUrl: poster ? `${IMAGE_BASE}${poster}` : "",
      overview: r.overview ?? "",
    };
  });
}

export async function searchMovie(
  apiKey: string,
  query: string,
  year: string | undefined,
  language = "zh-CN",
): Promise<TmdbSearchResult[]> {
  const q = query.trim();
  if (!q) return [];

  const params: Record<string, string | number | boolean> = {
    query: q,
    language,
    include_adult: false,
    page: 1,
  };
  if (year && /^(19|20)\d{2}$/.test(year)) params.year = year;

  const resp = await axios.get(`${TMDB_BASE}/search/movie`, {
    params,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    timeout: 15000,
  });

  const results = (resp.data?.results ?? []) as TmdbRawItem[];
  return results.slice(0, 10).map<TmdbSearchResult>((r) => {
    const date = r.release_date || "";
    const poster = r.poster_path || "";
    return {
      id: r.id,
      mediaType: "movie",
      title: r.title || r.name || "",
      originalTitle: r.original_title || r.original_name || "",
      year: date ? date.slice(0, 4) : "",
      posterUrl: poster ? `${IMAGE_BASE}${poster}` : "",
      overview: r.overview ?? "",
    };
  });
}

/* ------------------------------- 详情（整理用） ------------------------------- */

const MIN_INTERVAL_MS = 250;
let lastRequestAt = 0;
let chain: Promise<void> = Promise.resolve();

/** 全局节流：TMDB 约 40 req/10s，这里按 4 req/s 排队；影库刮削和整理共用一条时间线 */
export function throttleTmdb(): Promise<void> {
  const next = chain.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
  });
  chain = next.catch(() => {});
  return next;
}

function headers(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
}

export interface TmdbSeasonSummary {
  season: number;
  episodeCount: number;
  name?: string;
}

/** 电影 / 剧集详情里整理要用的那几项，两种类型统一成一个形状 */
export interface TmdbDetails {
  id: number;
  mediaType: "movie" | "tv";
  title: string;
  originalTitle: string;
  /** 英文名（translations 里的 en），没有就是空串 */
  enTitle: string;
  year: string;
  posterUrl: string;
  imdbId: string;
  genreIds: number[];
  countries: string[];
  originalLanguage: string;
  /** 各种别名：alternative_titles + translations 里的标题，识别时拿来对标题 */
  aliases: string[];
  seasons?: TmdbSeasonSummary[];
}

interface RawDetails {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  imdb_id?: string | null;
  genres?: Array<{ id: number }>;
  production_countries?: Array<{ iso_3166_1: string }>;
  origin_country?: string[];
  original_language?: string;
  seasons?: Array<{ season_number: number; episode_count: number; name?: string }>;
  external_ids?: { imdb_id?: string | null };
  alternative_titles?: { titles?: Array<{ title: string }>; results?: Array<{ title: string }> };
  translations?: { translations?: Array<{ iso_639_1: string; data?: { title?: string; name?: string } }> };
}

function toDetails(raw: RawDetails, mediaType: "movie" | "tv"): TmdbDetails {
  const date = raw.release_date || raw.first_air_date || "";
  const translations = raw.translations?.translations ?? [];
  const en = translations.find((t) => t.iso_639_1 === "en")?.data;
  const altList = raw.alternative_titles?.titles ?? raw.alternative_titles?.results ?? [];
  const aliases = new Set<string>();
  for (const a of altList) if (a.title) aliases.add(a.title);
  for (const t of translations) {
    const v = t.data?.title || t.data?.name;
    if (v) aliases.add(v);
  }
  return {
    id: raw.id,
    mediaType,
    title: raw.title || raw.name || "",
    originalTitle: raw.original_title || raw.original_name || "",
    enTitle: en?.title || en?.name || "",
    year: date ? date.slice(0, 4) : "",
    posterUrl: raw.poster_path ? `${IMAGE_BASE}${raw.poster_path}` : "",
    imdbId: raw.imdb_id || raw.external_ids?.imdb_id || "",
    genreIds: (raw.genres ?? []).map((g) => g.id),
    countries: mediaType === "tv" ? (raw.origin_country ?? []) : (raw.production_countries ?? []).map((c) => c.iso_3166_1),
    originalLanguage: raw.original_language ?? "",
    aliases: [...aliases],
    seasons:
      mediaType === "tv"
        ? (raw.seasons ?? []).map((s) => ({ season: s.season_number, episodeCount: s.episode_count, name: s.name }))
        : undefined,
  };
}

export async function getDetails(apiKey: string, mediaType: "movie" | "tv", id: number, language = "zh-CN"): Promise<TmdbDetails | null> {
  const append = mediaType === "movie" ? "alternative_titles,translations" : "external_ids,alternative_titles,translations";
  const resp = await axios.get(`${TMDB_BASE}/${mediaType}/${id}`, {
    params: { language, append_to_response: append },
    headers: headers(apiKey),
    timeout: 15000,
    validateStatus: (s) => s === 200 || s === 404,
  });
  if (resp.status === 404) return null;
  return toDetails(resp.data as RawDetails, mediaType);
}

export interface TmdbEpisode {
  episode: number;
  name: string;
}

export async function getSeasonEpisodes(apiKey: string, tvId: number, season: number, language = "zh-CN"): Promise<TmdbEpisode[]> {
  const resp = await axios.get(`${TMDB_BASE}/tv/${tvId}/season/${season}`, {
    params: { language },
    headers: headers(apiKey),
    timeout: 15000,
    validateStatus: (s) => s === 200 || s === 404,
  });
  if (resp.status === 404) return [];
  const eps = (resp.data?.episodes ?? []) as Array<{ episode_number: number; name?: string }>;
  return eps.map((e) => ({ episode: e.episode_number, name: e.name ?? "" }));
}
