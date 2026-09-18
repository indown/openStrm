/**
 * 海报背景用的图片地址：外链原样用；本地图片（source === "local"）要带令牌取成 blob 再给 object URL——
 * <img> 带不了 Authorization 头，令牌又不能放进 URL（会落到日志和 referrer 里）。
 *
 *   - 本地图同时最多取 2 张：它和接口是同一个源，HTTP/1.1 一个源只开 6 条连接，墙要是把连接占满，
 *     点「执行」、刷新列表都得排在几 MB 的图后面；
 *   - object URL 按最近使用淘汰，个数和字节数都封顶；正在墙上的图是钉住的，淘汰不到它，换下来（release）才放——
 *     不然 revoke 掉之后窗口一缩放、列重排，新挂上去的 <img> 指着一个没了的 blob，就是一块空白；
 *   - 后端把太大的本地图换成了外链小图（fallback 是本地那张）：先看这个外链的主机连不连得上，连不上退回本地图。
 */
import type { StrmPoster } from "@openstrm/shared";
import type { BackdropPoster } from "@/components/poster-backdrop";
import { api } from "@/lib/api";

const BLOB_CACHE_MAX = 80;
const BLOB_CACHE_BYTES = 32 * 1024 * 1024;
const FETCH_CONCURRENCY = 2;
/** 试一个外链主机连不连得上，最多等这么久 */
const PROBE_TIMEOUT_MS = 8000;

interface CachedBlob {
  url: string;
  bytes: number;
}

/** 按最近使用排，最旧的在前 */
const blobCache = new Map<string, CachedBlob>();
let cachedBytes = 0;
/** object URL → 有几批墙正用着它 */
const pins = new Map<string, number>();
/** 正在取的：同一张图两处同时要，只取一次 */
const inflight = new Map<string, Promise<CachedBlob>>();

function pin(url: string): void {
  pins.set(url, (pins.get(url) ?? 0) + 1);
}

function unpin(url: string): void {
  const n = (pins.get(url) ?? 0) - 1;
  if (n > 0) pins.set(url, n);
  else pins.delete(url);
}

/** 超了上限就从最旧的开始放，钉住的跳过（所以可能暂时超一点，等它们换下来再放） */
function trim(): void {
  for (const [key, entry] of blobCache) {
    if (blobCache.size <= BLOB_CACHE_MAX && cachedBytes <= BLOB_CACHE_BYTES) return;
    if (pins.has(entry.url)) continue;
    blobCache.delete(key);
    cachedBytes -= entry.bytes;
    URL.revokeObjectURL(entry.url);
  }
}

/** 取一张本地图（命中缓存就挪到最新）。返回的 object URL 已经钉住，用完要 unpin */
async function localImage(taskId: string, rel: string): Promise<string> {
  const key = JSON.stringify([taskId, rel]);
  const hit = blobCache.get(key);
  if (hit) {
    blobCache.delete(key);
    blobCache.set(key, hit);
    pin(hit.url);
    return hit.url;
  }
  let pending = inflight.get(key);
  if (!pending) {
    pending = api.strm
      .image(taskId, rel)
      .then((blob) => {
        const entry = { url: URL.createObjectURL(blob), bytes: blob.size };
        blobCache.set(key, entry);
        cachedBytes += entry.bytes;
        return entry;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const entry = await pending;
  pin(entry.url);
  return entry.url;
}

/** 每个外链主机只试一次：连得上就都用外链，连不上就都退回本地图 */
const hostVerdicts = new Map<string, Promise<boolean>>();

function reachable(url: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return Promise.resolve(false);
  }
  let verdict = hostVerdicts.get(host);
  if (!verdict) {
    verdict = new Promise<boolean>((resolve) => {
      const img = new Image();
      const settle = (ok: boolean) => {
        window.clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
        resolve(ok);
      };
      const timer = window.setTimeout(() => settle(false), PROBE_TIMEOUT_MS);
      img.onload = () => settle(true);
      img.onerror = () => settle(false);
      img.src = url;
    });
    hostVerdicts.set(host, verdict);
  }
  return verdict;
}

export interface PosterToShow {
  /** 墙上这一块的键，一般是目录路径 */
  key: string;
  taskId: string;
  poster: Pick<StrmPoster, "source" | "url" | "fallback">;
}

/** 墙上显示的一批：posters 直接给 <img>；release 把其中的本地图解钉，换下来或者卸载时调一次 */
export interface ShownPosters {
  posters: BackdropPoster[];
  release: () => void;
}

export const NO_POSTERS: ShownPosters = { posters: [], release: () => {} };

/**
 * 换成墙上能直接用的地址，顺序不变；读不到的那张就少一张。
 * alive() 变成 false（组件卸了、换了目录）就不再发新的请求；这时候返回的这批没人要，调用方直接 release。
 */
export async function toBackdropPosters(items: PosterToShow[], alive: () => boolean): Promise<ShownPosters> {
  const out: Array<BackdropPoster | null> = items.map(() => null);
  const held: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length && alive()) {
      const i = next++;
      const { key, taskId, poster } = items[i];
      const local = poster.source === "local" ? poster.url : poster.fallback;
      try {
        // 外链：没有本地后备就直接用；有后备的，先看这个主机连不连得上
        if (poster.source !== "local" && (!local || (await reachable(poster.url)))) {
          out[i] = { key, url: poster.url };
          continue;
        }
        if (!local) continue;
        const url = await localImage(taskId, local);
        held.push(url);
        out[i] = { key, url };
      } catch {
        /* 这张读不到就少一张 */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, items.length) }, worker));
  // 这一批已经钉住了，超出上限的只会从别处淘汰
  trim();
  let released = false;
  return {
    posters: out.filter((p): p is BackdropPoster => p !== null),
    release: () => {
      if (released) return;
      released = true;
      for (const url of held) unpin(url);
      trim();
    },
  };
}
