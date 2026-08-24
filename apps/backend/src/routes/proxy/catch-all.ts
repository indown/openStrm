import type { FastifyInstance } from "fastify";
import httpProxy from "@fastify/http-proxy";
import { embyUpstream } from "../../services/emby/api.js";
import { applyForwardedHeaders } from "./upstream.js";

/**
 * 兜底反代到 Emby，替代 nginx 的默认 proxy_pass。
 * 必须最后注册，让拦截路由优先。
 */
export default async function catchAllProxy(fastify: FastifyInstance) {
  await fastify.register(httpProxy, {
    /**
     * 故意不填 upstream，全部交给 getUpstream 每请求现读。
     *
     * 填了的话 reply-from 会在注册时就把 base 的 origin 固定下来
     * （lib/request.js 的 `origin: baseUrl || opts.url.origin`），
     * undici 之后一直连那个地址，getUpstream 就只剩改路径的作用了——
     * 表现是改完 Emby 地址不重启就不生效。
     */
    upstream: "",
    prefix: "/",
    websocket: true,
    replyOptions: {
      getUpstream: () => embyUpstream(),
      rewriteRequestHeaders: (request, headers) =>
        applyForwardedHeaders(request as never, headers),
    },
  });
}
