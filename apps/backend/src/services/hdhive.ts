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

export interface HdhiveUnlockResult {
  url: string;
  access_code: string;
  full_url: string;
  already_owned: boolean;
}

function buildHeaders(opts: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "X-API-Key": opts.apiKey,
    Accept: "application/json",
  };
  if (opts.userAccessToken) {
    headers.Authorization = `Bearer ${opts.userAccessToken}`;
  }
  return headers;
}

function makeHdhiveError(
  resp: { status: number; data?: unknown; headers?: Record<string, unknown> },
): Error & { status?: number; code?: string | number; retryAfterSeconds?: number } {
  const data = (resp.data ?? {}) as Record<string, unknown>;
  const code = (data.code as string | number | undefined) ?? resp.status;
  const message =
    (data.message as string | undefined) ||
    (data.description as string | undefined) ||
    `HDHive request failed (${resp.status})`;
  const err = new Error(typeof message === "string" ? message : String(message)) as Error & {
    status?: number;
    code?: string | number;
    retryAfterSeconds?: number;
  };
  err.status = resp.status;
  err.code = code;
  const retryRaw =
    (data.retry_after_seconds as number | string | undefined) ??
    (resp.headers?.["retry-after"] as number | string | undefined);
  if (retryRaw != null) {
    const n = Number(retryRaw);
    if (!Number.isNaN(n)) err.retryAfterSeconds = n;
  }
  return err;
}

export async function getResourcesByTmdbId(
  type: HdhiveMediaType,
  tmdbId: number | string,
  opts: RequestOptions,
): Promise<HdhiveResourcesResponse> {
  const base = resolveBaseUrl(opts.baseUrl);
  const url = `${base}/api/open/resources/${type}/${encodeURIComponent(String(tmdbId))}`;

  const resp = await axios.get(url, {
    headers: buildHeaders(opts),
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

  throw makeHdhiveError(resp);
}

export async function unlockResource(
  slug: string,
  opts: RequestOptions,
): Promise<HdhiveUnlockResult> {
  const base = resolveBaseUrl(opts.baseUrl);
  const url = `${base}/api/open/resources/unlock`;

  const resp = await axios.post(
    url,
    { slug },
    {
      headers: { ...buildHeaders(opts), "Content-Type": "application/json" },
      timeout: opts.timeout ?? 20000,
      validateStatus: () => true,
    },
  );

  if (resp.status === 200 && resp.data?.success !== false) {
    const data = (resp.data?.data ?? {}) as Partial<HdhiveUnlockResult>;
    return {
      url: typeof data.url === "string" ? data.url : "",
      access_code: typeof data.access_code === "string" ? data.access_code : "",
      full_url: typeof data.full_url === "string" ? data.full_url : (data.url as string) || "",
      already_owned: Boolean(data.already_owned),
    };
  }

  throw makeHdhiveError(resp);
}
