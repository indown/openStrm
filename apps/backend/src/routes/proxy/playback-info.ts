/**
 * PlaybackInfo 改写。
 *
 * Emby 认为 strm 指向的是"远端"资源，默认把 SupportsDirectPlay/DirectStream 判成 false
 * 并给出 TranscodingUrl，客户端于是去要转码流——转码流不走 302，全部字节又回到 Node 身上。
 * 所以命中挂载点的媒体源要标成可直连、关掉转码，并把 DirectStreamUrl 指回本代理。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { EmbyMediaSource } from "../../services/emby/api.js";
import { embyUpstream } from "../../services/emby/api.js";
import { readSettingsSafe } from "../../services/settings-safe.js";
import { safeDecode, stripMountPath } from "../../services/resolve/direct-link.js";
import { fetchUpstream, relayResponse, toEmby } from "./upstream.js";

/** 这个媒体源是不是我们生成的 strm（落在某个 mediaMountPath 下面） */
function isOurs(source: EmbyMediaSource): boolean {
  if (!source.Path) return false;
  const mountPaths = readSettingsSafe().mediaMountPath ?? [];
  return stripMountPath(safeDecode(source.Path).replace(/\/{2,}/g, "/"), mountPaths) !== null;
}

/**
 * 把 DirectStreamUrl 指向本代理的 stream 路径。
 *
 * 路径里必须用**条目 id**，不能用 MediaSource.Id——Emby 4.9 的 MediaSource.Id 长
 * `mediasource_11` 这样，而 Emby 自己给的 DirectStreamUrl 是 `/videos/11/stream`。
 * 查询串沿用上游的，但要去掉 TranscodeReasons 并补上 Static=true，
 * 否则客户端会以为这是个转码流。
 */
function rewriteDirectStreamUrl(
  source: EmbyMediaSource,
  itemId: string,
  requestQuery: Record<string, unknown>,
): void {
  const container = source.Container || "mp4";
  const original = typeof source.DirectStreamUrl === "string" ? source.DirectStreamUrl : "";
  const queryIndex = original.indexOf("?");

  const params = new URLSearchParams(queryIndex >= 0 ? original.slice(queryIndex + 1) : "");
  params.delete("TranscodeReasons");

  // 上游没给 DirectStreamUrl 时（部分条目就是没有），从请求本身补齐必要参数
  if (!params.has("api_key")) {
    const key = requestQuery["api_key"] ?? requestQuery["X-Emby-Token"];
    if (typeof key === "string" && key) params.set("api_key", key);
  }
  if (!params.has("MediaSourceId") && source.Id) params.set("MediaSourceId", source.Id);
  params.set("Static", "true");

  source.DirectStreamUrl = `/emby/Videos/${itemId}/stream.${container}?${params.toString()}`;
}

export function rewritePlaybackInfo(
  body: Record<string, unknown>,
  itemId: string,
  requestQuery: Record<string, unknown> = {},
): boolean {
  const sources = body.MediaSources;
  if (!Array.isArray(sources)) return false;

  let touched = false;
  for (const source of sources as EmbyMediaSource[]) {
    if (!isOurs(source)) continue;
    if (source.IsInfiniteStream) continue; // 直播流不做直连改写

    source.SupportsDirectPlay = true;
    source.SupportsDirectStream = true;
    /**
     * 转码必须关掉。留着的话限码率的客户端会判定超标、转而去要 TranscodingUrl，
     * 那条路不走 302，字节全程过 Node。
     */
    source.SupportsTranscoding = false;
    delete source.TranscodingUrl;

    rewriteDirectStreamUrl(source, itemId, requestQuery);
    touched = true;
  }
  return touched;
}

async function handlePlaybackInfo(request: FastifyRequest, reply: FastifyReply) {
  const params = request.params as Record<string, string>;
  const itemId = params.id;

  let upstream: Awaited<ReturnType<typeof fetchUpstream>> | undefined;
  try {
    upstream = await fetchUpstream(request);

    if (!upstream.res.ok) {
      request.log.warn({ itemId, status: upstream.res.status }, "PlaybackInfo 回源异常，透传");
      return relayResponse(reply, upstream.res, await upstream.res.arrayBuffer());
    }

    const raw = await upstream.res.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // 不是 JSON 就原样透传，别把响应吞掉
      return relayResponse(reply, upstream.res, raw);
    }

    const touched = rewritePlaybackInfo(
      body,
      itemId,
      (request.query ?? {}) as Record<string, unknown>,
    );
    if (touched) request.log.info({ itemId }, "PlaybackInfo 已改写为直连");

    return relayResponse(reply, upstream.res, JSON.stringify(body), {
      "content-type": "application/json;charset=utf-8",
    });
  } catch (err) {
    request.log.error({ err, itemId }, "PlaybackInfo 改写失败，回源");
    return toEmby(request, reply);
  } finally {
    upstream?.done();
  }
}

export default async function playbackInfoRoutes(fastify: FastifyInstance) {
  /**
   * 这些路由不在 @fastify/http-proxy 的封装作用域里，拿不到它注册的透传解析器，
   * Fastify 默认的 JSON 解析器会先把空 body 判成 400、把表单 content-type 判成 415，
   * handler 根本轮不到——"失败一律回源"的保证也就失效了。
   * 这里自己装一个原样收下的解析器。
   */
  const keepRaw = (_req: unknown, body: Buffer, done: (e: Error | null, b: Buffer) => void) =>
    done(null, body);
  fastify.addContentTypeParser("*", { parseAs: "buffer" }, keepRaw as never);
  fastify.addContentTypeParser("application/json", { parseAs: "buffer" }, keepRaw as never);

  for (const prefix of ["", "/emby"]) {
    for (const items of ["Items", "items"]) {
      for (const action of ["PlaybackInfo", "playbackinfo"]) {
        fastify.route({
          method: ["GET", "POST"],
          url: `${prefix}/${items}/:id/${action}`,
          handler: handlePlaybackInfo,
        });
      }
    }
  }
}
