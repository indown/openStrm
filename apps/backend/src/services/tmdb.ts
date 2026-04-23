import axios from "axios";

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p/w500";

export interface TmdbSearchResult {
  id: number;
  mediaType: "movie" | "tv" | "person";
  title: string;
  year: string;
  posterUrl: string;
  overview: string;
}

interface TmdbRawItem {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
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
      year: date ? date.slice(0, 4) : "",
      posterUrl: poster ? `${IMAGE_BASE}${poster}` : "",
      overview: r.overview ?? "",
    };
  });
}
