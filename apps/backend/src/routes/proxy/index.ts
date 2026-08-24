import type { FastifyInstance } from "fastify";
import replyFrom from "@fastify/reply-from";
import redirectRoutes from "./redirect.js";
import playbackInfoRoutes from "./playback-info.js";
import systemInfoRoutes from "./system-info.js";
import catchAllProxy from "./catch-all.js";

/**
 * Emby 代理层，替代原来的 nginx/njs emby2Alist。
 *
 * 职责就两件：
 * - 播放请求换成 115 直链后 302 给客户端，媒体字节不经过本进程
 * - 其余请求原样回源 Emby
 *
 * 所有拦截逻辑失败时都回源，绝不让播放因为代理出错而直接失败。
 */
export default async function proxyPlugin(fastify: FastifyInstance) {
  // 不设 base：设了之后 undici 会把 origin 固定成注册时的地址，
  // 每请求的 getUpstream 就白给了。地址一律由 upstream.ts 现读。
  await fastify.register(replyFrom);

  // 注册顺序：具体路由在前，catch-all 最后
  await fastify.register(redirectRoutes);
  await fastify.register(playbackInfoRoutes);
  await fastify.register(systemInfoRoutes);
  await fastify.register(catchAllProxy);
}
