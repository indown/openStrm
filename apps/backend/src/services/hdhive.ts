import axios from "axios";

const DEFAULT_BASE_URL = "https://hdhive.com";

export type HdhiveMediaType = "movie" | "tv";

export interface HdhiveResource {
  slug: string;
  title: string | null;
  pan_type: string | null;
  share_size: string | null;
  video_resolution: string[];
  source: string[];
  subtitle_language: string[];
  subtitle_type: string[];
  unlock_points: number | null;
  is_unlocked: boolean;
  user: Record<string, unknown> | null;
  remark?: string | null;
}

export interface HdhiveResourcesResponse {
  resources: HdhiveResource[];
  total: number;
}

interface RequestOptions {
  apiKey: string;
  baseUrl?: string;
  userAccessToken?: string;
  timeout?: number;
}

function resolveBaseUrl(baseUrl: string | undefined): string {
  const v = (baseUrl ?? "").trim();
  return (v || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export async function getResourcesByTmdbId(
  type: HdhiveMediaType,
  tmdbId: number | string,
  opts: RequestOptions,
): Promise<HdhiveResourcesResponse> {
  const base = resolveBaseUrl(opts.baseUrl);
  const url = `${base}/api/open/resources/${type}/${encodeURIComponent(String(tmdbId))}`;
  const headers: Record<string, string> = {
    "X-API-Key": opts.apiKey,
    Accept: "application/json",
  };
  if (opts.userAccessToken) {
    headers.Authorization = `Bearer ${opts.userAccessToken}`;
  }

  const resp = await axios.get(url, {
    headers,
    timeout: opts.timeout ?? 15000,
    validateStatus: () => true,
  });

  if (resp.status === 200 && resp.data?.success !== false) {
    const items = Array.isArray(resp.data?.data) ? (resp.data.data as HdhiveResource[]) : [];
    const total =
      typeof resp.data?.meta?.total === "number"
        ? (resp.data.meta.total as number)
        : items.length;
    return { resources: items, total };
  }

  const code = resp.data?.code ?? resp.status;
  const message = resp.data?.message ?? resp.data?.description ?? `HDHive request failed (${resp.status})`;
  const err = new Error(typeof message === "string" ? message : String(message)) as Error & {
    status?: number;
    code?: string | number;
    retryAfterSeconds?: number;
  };
  err.status = resp.status;
  err.code = code;
  const retry = resp.data?.retry_after_seconds ?? resp.headers?.["retry-after"];
  if (retry != null) err.retryAfterSeconds = Number(retry) || undefined;
  throw err;
}
