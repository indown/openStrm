/**
 * PlaybackInfo 改写。
 *
 * Emby 认为 strm 指向的是"远端"资源，默认会把 SupportsDirectPlay 判成 false，
 * 客户端于是去要转码流——转码流不走我们的 302，全部字节又回到 Node 身上。
 * 所以命中挂载点的媒体源要显式标成可直连，并把 DirectStreamUrl 指回本代理，
 * 让客户端最终落到 /Videos/{id}/stream 上吃到 302。
 *
 * 对应 nginx 时代 redirect-core.js 的 transferPlaybackInfo / modifyDirectPlaySupports /
 * modifyDirectStreamUrl。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { EmbyMediaSource } from "../../services/emby/api.js";
import { embyUpstream } from "../../services/emby/api.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { safeDecode, stripMountPath } from "../../services/resolve/direct-link.js";
import { applyForwardedHeaders, toEmby } from "./upstream.js";

const UPSTREAM_TIMEOUT_MS = 15_000;

/** 这个媒体源是不是我们生成的 strm（落在某个 mediaMountPath 下面） */
function isOurs(source: EmbyMediaSource): boolean {
  if (!source.Path) return false;
  const mountPaths = readAppSettings().mediaMountPath ?? [];
  return stripMountPath(safeDecode(source.Path).replace(/\/{2,}/g, "/"), mountPaths) !== null;
}

/**
 * 把 DirectStreamUrl 指向本代理的 stream 路径。
 * 保留原来的查询串（api_key / MediaSourceId 都在里面，少一个客户端就播不了）。
 */
function rewriteDirectStreamUrl(source: EmbyMediaSource, itemId: string): void {
  const container = source.Container || "mp4";
  const original = typeof source.DirectStreamUrl === "string" ? source.DirectStreamUrl : "";
  const queryIndex = original.indexOf("?");
  const query = queryIndex >= 0 ? original.slice(queryIndex) : "";
  const id = source.Id || itemId;
  source.DirectStreamUrl = encodeURI(`/emby/Videos/${id}/stream.${container}${query}`);
}

export function rewritePlaybackInfo(body: Record<string, unknown>, itemId: string): boolean {
  const sources = body.MediaSources;
  if (!Array.isArray(sources)) return false;

  let touched = false;
  for (const source of sources as EmbyMediaSource[]) {
    if (!isOurs(source)) continue;
    // 直播流不做直连改写
    if (source.IsInfiniteStream) continue;

    source.SupportsDirectPlay = true;
    source.SupportsDirectStream = true;
    rewriteDirectStreamUrl(source, itemId);
    touched = true;
  }
  return touched;
}

async function handlePlaybackInfo(request: FastifyRequest, reply: FastifyReply) {
  const params = request.params as Record<string, string>;
  const itemId = params.id;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    // 自己回源拿 body 才能改写。转发头和 catch-all 用同一套，避免行为分叉。
    const headers = applyForwardedHeaders(request, {
      ...(request.headers as Record<string, string | string[] | undefined>),
    });
    delete headers["content-length"];
    delete headers["accept-encoding"]; // 让上游别压缩，省一次解压

    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const upstream = await fetch(`${embyUpstream()}${request.url}`, {
      method: request.method,
      headers: headers as Record<string, string>,
      body: hasBody && request.body ? JSON.stringify(request.body) : undefined,
      signal: controller.signal,
    });

    if (!upstream.ok) {
      request.log.warn({ itemId, status: upstream.status }, "PlaybackInfo 回源异常，透传");
      const text = await upstream.text();
      return reply.code(upstream.status).type(upstream.headers.get("content-type") ?? "application/json").send(text);
    }

    const body = (await upstream.json()) as Record<string, unknown>;
    const touched = rewritePlaybackInfo(body, itemId);
    if (touched) request.log.info({ itemId }, "PlaybackInfo 已改写为直连");

    return reply.type("application/json;charset=utf-8").send(JSON.stringify(body));
  } catch (err) {
    request.log.error({ err, itemId }, "PlaybackInfo 改写失败，回源");
    return toEmby(request, reply);
  } finally {
    clearTimeout(timer);
  }
}

export default async function playbackInfoRoutes(fastify: FastifyInstance) {
  // PlaybackInfo 是 POST 带 JSON body，也有客户端用 GET
  for (const prefix of ["", "/emby"]) {
    for (const items of ["Items", "items"]) {
      fastify.route({
        method: ["GET", "POST"],
        url: `${prefix}/${items}/:id/PlaybackInfo`,
        handler: handlePlaybackInfo,
      });
    }
  }
}
