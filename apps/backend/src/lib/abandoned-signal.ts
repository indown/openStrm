import type { FastifyReply } from "fastify";

/**
 * 浏览器不等了（换了关键词、关了弹框、离开了页面）就掐掉还在路上的那一问。
 * 盯的是 reply.raw 的 close（和 lib/sse.ts 一样）：POST 的请求流读完 body 就 close 了，`request.signal` 在处理函数开始时就已经是中止的，
 * 不能盯它；已经回完了的那次 close 不算
 */
export function abandonedSignal(reply: FastifyReply): AbortSignal {
  const ac = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) ac.abort();
  });
  return ac.signal;
}
