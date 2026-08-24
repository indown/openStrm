/**
 * 回源 Emby 的共用逻辑。
 *
 * 拦截路由和 catch-all 都从这里取转发配置，保证两条路径的请求头一致——
 * 否则会出现"直连能播、被拦截的路径播不了"这种极难查的问题。
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { embyUpstream } from "../../services/emby/api.js";

type Headers = Record<string, string | string[] | undefined>;

function firstForwarded(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  return raw.split(",")[0]?.trim() || undefined;
}

/**
 * 补齐转发头。
 *
 * nginx 时代由 includes/proxy-header.conf 设置 Host / X-Real-IP / X-Forwarded-For，
 * reply-from 一个都不发，而且会把 Host 强制改成上游的 host。不修的话 Emby 会把
 * 所有客户端都记成容器 IP，外部地址也会拼错。
 */
export function applyForwardedHeaders(request: FastifyRequest, headers: Headers): Headers {
  const incoming = request.headers;
  const priorChain = incoming["x-forwarded-for"];
  const prior = Array.isArray(priorChain) ? priorChain.join(", ") : priorChain;

  headers["x-forwarded-for"] = prior ? `${prior}, ${request.ip}` : request.ip;
  // 前面还有一层反代时，真正的客户端是链条里的第一个
  headers["x-real-ip"] = firstForwarded(priorChain) ?? request.ip;
  headers["x-forwarded-proto"] =
    firstForwarded(incoming["x-forwarded-proto"]) ?? request.protocol;

  // reply-from 已经把 host 改成上游的了，改回客户端原本请求的 host
  if (incoming.host) headers.host = incoming.host;

  return headers;
}

/**
 * 每次现读上游地址，设置里改了 Emby 地址不用重启。
 * getUpstream 是 per-reply 选项，reply-from 的 URL 缓存以 upstream 为 key 的一部分，不会读到旧值。
 */
export function replyFromOptions(request: FastifyRequest) {
  return {
    getUpstream: () => embyUpstream(),
    rewriteRequestHeaders: (_req: unknown, headers: Headers) =>
      applyForwardedHeaders(request, headers),
  };
}

/** 原样回源。拦截逻辑任何一步失败都走这里，行为等同于没有拦截。 */
export function toEmby(request: FastifyRequest, reply: FastifyReply) {
  return reply.from(undefined, replyFromOptions(request));
}
