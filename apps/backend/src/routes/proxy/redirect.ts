/**
 * 302 直链重定向——整个代理层存在的理由。
 *
 * 命中的请求不再由 Node 转发媒体字节，而是回一个 115 直链让客户端自己去取。
 * 任何一步出问题都回源 Emby：宁可走中转，也不能让播放直接失败。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { LRUCache } from "lru-cache";
import type { EmbyItemLookup } from "../../services/emby/api.js";
import { clientApiKey, getItemMediaSource, getSyncJobItemPath } from "../../services/emby/api.js";
import { readSettingsSafe } from "../../services/settings-safe.js";
import { configRevision } from "../../services/config-revision.js";
import { resolveEmbyPath } from "../../services/resolve/direct-link.js";
import { toEmby } from "./upstream.js";

/**
 * 直链缓存。
 *
 * 没有它的话，客户端每拖一次进度条都要重新走「查 Emby → 查 115 目录 → 换直链」，
 * 起播和 seek 都会明显卡顿。115 的直链和 UA 绑定，所以 UA 必须进 key。
 */
const linkCache = new LRUCache<string, string>({ max: 2000, ttl: 15 * 60 * 1000 });

/** 换了 115 账号或改了挂载配置之后，旧直链就不该再用了 */
export function clearLinkCache(): void {
  linkCache.clear();
}

/**
 * 直链解析实现。抽成可替换的，离线测试才能在不碰 115 接口的情况下
 * 验证 302、回源和缓存这几条分支。
 */
let resolveLink = resolveEmbyPath;
export function setLinkResolver(fn: typeof resolveEmbyPath): void {
  resolveLink = fn;
}

/** 只有这些动作才 302；live / master / hls 之类交给 Emby 自己处理 */
const REDIRECTABLE = new Set(["stream", "original", "universal"]);

/** `/emby` 前缀是标准反代路径，裸路径是客户端直连时用的 */
const PREFIXES = ["", "/emby"];

/** 客户端对大小写并不统一，nginx 用的是 ~* 匹配，这里把两种都注册上 */
function caseVariants(segment: string): string[] {
  const lower = segment.toLowerCase();
  const capitalized = lower.charAt(0).toUpperCase() + lower.slice(1);
  return lower === capitalized ? [lower] : [lower, capitalized];
}

function queryValue(query: unknown, ...keys: string[]): string | undefined {
  const q = (query ?? {}) as Record<string, unknown>;
  for (const key of keys) {
    const value = q[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** `stream.mkv` / `stream/真实文件名.mkv` 都归一成 `stream` */
function actionOf(rest: string): string {
  return (rest.split("/")[0] ?? "").split(".")[0].toLowerCase();
}

/**
 * Location 头只能放 ASCII，非 ASCII 会让 setHeader 抛 ERR_INVALID_CHAR。
 *
 * 但**不能**用 encodeURI 兜底：它会把 `%` 转成 `%25`。115 返回的直链本来就是
 * 转义过的（中文文件名、签名里的 `+` 和 `=`），再过一遍 encodeURI 就成了
 * `%25E4%25B8%25AD`，CDN 直接 403。
 * 所以纯 ASCII 原样返回，只有混进非 ASCII 时才逐字符转义。
 */
function safeLocation(url: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(url)) return url;
  return url.replace(/[^\x00-\x7F]/g, (c) => encodeURIComponent(c));
}

/** 查路径的方式：普通条目走 /Items，同步任务项走 /Sync/JobItems */
type PathLookup = (
  id: string,
  opts: { mediaSourceId?: string; apiKey?: string },
) => Promise<EmbyItemLookup | null>;

async function redirectWithLookup(
  request: FastifyRequest,
  reply: FastifyReply,
  itemId: string,
  lookup: PathLookup,
) {
  const mediaSourceId = queryValue(request.query, "MediaSourceId", "mediaSourceId");
  const userAgent = request.headers["user-agent"];

  /**
   * 没有客户端凭据就不往下走，而且必须在查缓存之前拦——否则匿名请求能白拿
   * 别人解析好的缓存直链。
   *
   * 不带凭据时不能回落到配置里的管理员 key：那等于任何能访问代理端口的人
   * 报一个条目 id 就拿到 115 直链，完全绕过 Emby 的登录。透传交给 Emby 自己
   * 裁决——upstream 原样转发请求头，靠头认证的客户端照样能播，只是不走 302。
   */
  const apiKey = clientApiKey(request.query as Record<string, unknown>, request.headers);
  if (!apiKey && !readSettingsSafe().emby?.allowAnonymousRedirect) {
    request.log.debug({ itemId }, "请求未携带 Emby 凭据，透传回源");
    return toEmby(request, reply);
  }

  /**
   * key 里带配置版本：改了账号或挂载点之后旧条目自然失效。
   * 代理是独立进程，收不到 API 进程的失效通知，只能这样跨进程对齐。
   */
  const cacheKey = `${configRevision()}:${itemId}:${mediaSourceId ?? ""}:${userAgent ?? ""}`;

  const cached = linkCache.get(cacheKey);
  if (cached) {
    request.log.info({ itemId }, "302 缓存命中");
    return reply.redirect(cached, 302);
  }

  // 解析和响应分开：redirect 一旦写了 location 头再抛错，
  // catch 里的回源会带着这个坏头去发流，兜底也跟着崩。
  let target: string;
  try {
    const item = await lookup(itemId, { mediaSourceId, apiKey });
    if (!item?.path) {
      request.log.info({ itemId }, "Emby 未返回路径，回源");
      return toEmby(request, reply);
    }

    // 直播流没有固定直链，也不该被 302
    if (item.mediaSource?.IsInfiniteStream) {
      return toEmby(request, reply);
    }

    const resolved = await resolveLink(item.path, userAgent);
    if (!resolved.ok) {
      // not-mounted 是正常情况：本地文件本来就该回源，不值得记 warn
      const detail = { itemId, path: item.path, reason: resolved.reason };
      if (resolved.reason === "not-mounted") {
        request.log.debug(detail, "路径不在挂载点下，回源");
      } else {
        request.log.warn(detail, "未取到直链，回源");
      }
      return toEmby(request, reply);
    }

    target = safeLocation(resolved.url);
    linkCache.set(cacheKey, target);
    request.log.info({ itemId, account: resolved.accountName }, "302 到 115 直链");
  } catch (err) {
    request.log.error({ err, itemId }, "302 解析失败，回源");
    return toEmby(request, reply);
  }

  return reply.redirect(target, 302);
}

async function handleRedirect(request: FastifyRequest, reply: FastifyReply) {
  const params = request.params as Record<string, string>;
  const itemId = params.id;
  const rest = params["*"] ?? "";

  // HEAD 是客户端在探测，让 Emby 自己答，别为了一次探测去换直链
  if (request.method === "HEAD") return toEmby(request, reply);
  if (!REDIRECTABLE.has(actionOf(rest))) return toEmby(request, reply);
  if (!itemId) return toEmby(request, reply);

  return redirectWithLookup(request, reply, itemId, (id, opts) =>
    getItemMediaSource(id, opts),
  );
}

/**
 * 客户端"下载到设备"（SyncService）走的路径。
 * 不 302 的话，整个离线下载的字节都从 Node 过。
 */
async function handleSyncDownload(request: FastifyRequest, reply: FastifyReply) {
  const params = request.params as Record<string, string>;
  const jobItemId = params.id;
  if (request.method === "HEAD") return toEmby(request, reply);
  if (!jobItemId) return toEmby(request, reply);

  return redirectWithLookup(request, reply, jobItemId, (id, opts) =>
    getSyncJobItemPath(id, { apiKey: opts.apiKey }),
  );
}

export default async function redirectRoutes(fastify: FastifyInstance) {
  const routes: string[] = [];

  for (const prefix of PREFIXES) {
    // Videos/Audio 下面的动作很多（Subtitles、live、master、hls…），
    // 用通配接住再在 handler 里挑，比穷举路径稳妥
    for (const resource of ["videos", "audio"]) {
      for (const variant of caseVariants(resource)) {
        routes.push(`${prefix}/${variant}/:id/*`);
      }
    }
    // Items 下面还有 PlaybackInfo 要单独拦，这里不能用通配
    for (const variant of caseVariants("items")) {
      for (const action of caseVariants("download")) {
        routes.push(`${prefix}/${variant}/:id/${action}`);
      }
    }
  }

  // 同步下载单独一条：id 是同步任务项 id，查法和普通条目不一样
  for (const prefix of PREFIXES) {
    for (const sync of caseVariants("sync")) {
      for (const file of caseVariants("file")) {
        fastify.route({
          method: ["GET", "HEAD"],
          url: `${prefix}/${sync}/JobItems/:id/${file}`,
          handler: handleSyncDownload,
        });
      }
    }
  }

  for (const url of routes) {
    fastify.route({
      method: ["GET", "HEAD"],
      url,
      handler: (request, reply) => {
        // Items/:id/Download 没有通配段，补一个让 handler 的判断统一
        const params = request.params as Record<string, string>;
        if (params["*"] === undefined) params["*"] = "stream";
        return handleRedirect(request, reply);
      },
    });
  }
}
