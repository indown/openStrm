/**
 * Emby 元数据查询，给 302 代理层用。
 *
 * 代理要判断"这个条目该不该 302"，唯一可靠的依据是条目在 Emby 里的 Path——
 * 也就是 strm 文件的内容。所以每次拦截都要回 Emby 问一次条目信息。
 *
 * 配置读取沿用 services/media-server.ts 的范式：每次现读，改了地址不用重启。
 */
import { readSettingsSafe } from "../settings-safe.js";

export type EmbyMediaSource = {
  Id?: string;
  Path?: string;
  Container?: string;
  IsRemote?: boolean;
  IsInfiniteStream?: boolean;
  SupportsDirectPlay?: boolean;
  SupportsDirectStream?: boolean;
  DirectStreamUrl?: string;
  TranscodingUrl?: string;
  [key: string]: unknown;
};

export type EmbyItemLookup = {
  path: string;
  itemName: string;
  mediaSource: EmbyMediaSource | null;
};

const LOOKUP_TIMEOUT_MS = 10_000;

/** Emby 上游地址。默认值和 catch-all 保持一致（docker 网关上的 Emby） */
export function embyUpstream(): string {
  const url = readSettingsSafe().emby?.url || "http://172.17.0.1:8096";
  return url.replace(/\/+$/, "");
}

export function configuredApiKey(): string {
  return readSettingsSafe().emby?.apiKey || "";
}

/**
 * 客户端自己带的 key 优先，兜底用配置里的管理员 key。
 * 老的 Emby TV 客户端不带 key，只能靠配置里的那个。
 */
export function pickApiKey(query: Record<string, unknown> | undefined): string {
  const q = query ?? {};
  const fromQuery = q["X-Emby-Token"] ?? q["api_key"] ?? q["ApiKey"];
  return typeof fromQuery === "string" && fromQuery ? fromQuery : configuredApiKey();
}

/**
 * Emby ≥4.9 的 MediaSourceId 是 `mediasource_447039` 这种格式，
 * 前缀后面那串才是能直接查的 id。
 */
export function normalizeMediaSourceId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return id.startsWith("mediasource_") ? id.slice("mediasource_".length) : id;
}

async function fetchJson(url: string, timeoutMs = LOOKUP_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Emby ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 查同步任务项对应的文件路径（客户端"下载到设备"走的 SyncService 接口）。
 *
 * 这条不能用 /Items?Ids= 查：JobItem 的 id 是同步任务项的 id，不是条目 id，
 * 真正的路径在 OutputPath 上。nginx 版本同样是单独取 /Sync/JobItems 再自己找。
 */
export async function getSyncJobItemPath(
  jobItemId: string,
  opts: { apiKey?: string } = {},
): Promise<EmbyItemLookup | null> {
  const apiKey = opts.apiKey || configuredApiKey();
  const url = `${embyUpstream()}/Sync/JobItems?api_key=${encodeURIComponent(apiKey)}`;

  const body = (await fetchJson(url)) as { Items?: Array<Record<string, unknown>> } | null;
  const item = body?.Items?.find((o) => String(o.Id) === String(jobItemId));
  if (!item) return null;

  return {
    path: typeof item.OutputPath === "string" ? item.OutputPath : "",
    itemName: typeof item.ItemName === "string" ? item.ItemName : "",
    mediaSource: null,
  };
}

/**
 * 查条目的媒体源路径。
 *
 * 带了 mediaSourceId 就按它查（多版本影片时 itemId 指向的是主条目，
 * 真正要播的是某个特定版本），否则按 itemId 查。
 */
export async function getItemMediaSource(
  itemId: string,
  opts: { mediaSourceId?: string; apiKey?: string } = {},
): Promise<EmbyItemLookup | null> {
  const base = embyUpstream();
  const apiKey = opts.apiKey || configuredApiKey();
  const sourceId = normalizeMediaSourceId(opts.mediaSourceId);
  const queryId = sourceId || itemId;
  if (!queryId) return null;

  const url =
    `${base}/Items?Ids=${encodeURIComponent(queryId)}` +
    `&Fields=Path,MediaSources&Limit=1&api_key=${encodeURIComponent(apiKey)}`;

  const body = (await fetchJson(url)) as { Items?: Array<Record<string, unknown>> } | null;
  const item = body?.Items?.[0];
  if (!item) return null;

  const sources = item.MediaSources as EmbyMediaSource[] | undefined;
  if (!Array.isArray(sources) || sources.length === 0) {
    // 图片之类的条目没有 MediaSources，退回条目自己的 Path
    return {
      path: typeof item.Path === "string" ? item.Path : "",
      itemName: typeof item.Name === "string" ? item.Name : "",
      mediaSource: null,
    };
  }

  const picked =
    (opts.mediaSourceId && sources.find((s) => s.Id === opts.mediaSourceId)) ||
    (sourceId && sources.find((s) => s.Id === sourceId)) ||
    sources[0];

  return {
    // MediaSource.Path 偶尔为空，条目自己的 Path 是兜底
    path: picked.Path || (typeof item.Path === "string" ? item.Path : ""),
    itemName: typeof item.Name === "string" ? item.Name : "",
    mediaSource: picked,
  };
}
