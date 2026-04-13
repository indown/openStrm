import type { FastifyInstance } from "fastify";
import httpProxy from "@fastify/http-proxy";

/**
 * Catch-all proxy to Emby upstream.
 * This MUST be registered LAST so specific proxy routes take priority.
 * Replaces nginx's default proxy_pass to $emby.
 */
export default async function (fastify: FastifyInstance) {
  const embyUrl = (fastify as any).readSettings?.()?.emby?.url || "http://172.17.0.1:8096";

  await fastify.register(httpProxy, {
    upstream: embyUrl,
    prefix: "/",
    websocket: true,
    replyOptions: {
      rewriteRequestHeaders: (_origReq, headers) => {
        try {
          const host = new URL(embyUrl).host;
          headers.host = host;
        } catch { /* ignore */ }
        return headers;
      },
    },
  });
}
