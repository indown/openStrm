/**
 * SSE 的公共壳：响应头、心跳、客户端断开时的收尾。
 *
 * 两处在用：同步任务的实时日志（routes/task/log.ts）和 strm 校验（routes/strm/index.ts）。
 * 有两件事各写各的很容易漏，都收在这里：
 *   - `X-Accel-Buffering: no`：nginx 默认把代理响应攒够了才发，实时进度就成了隔很久倒一批
 *   - 心跳注释行：活儿在等限流 / 等网盘时可能几十秒没有事件，反代和浏览器的空闲超时会掐连接
 */
import type { FastifyReply } from "fastify";

const HEARTBEAT_MS = 15_000;

export interface SseChannel {
  /** 推一条 data 行。字符串原样发（调用方已经序列化好的），其余 JSON 序列化 */
  send(data: unknown): void;
  /** 客户端断开或这边收尾时触发：订阅挂上去，断开即退订 */
  readonly signal: AbortSignal;
  close(): void;
}

/** 写响应头、起心跳，返回一个往外推事件的口子。调用方负责在流结束时 close() */
export function openSse(reply: FastifyReply, heartbeatMs = HEARTBEAT_MS): SseChannel {
  // 接管这条响应：下面直接往 raw 上写，handler 返回时 Fastify 不该再想着发一次
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const write = (chunk: string) => {
    if (!reply.raw.writableEnded) reply.raw.write(chunk);
  };

  const heartbeat = setInterval(() => write(": ping\n\n"), heartbeatMs);
  heartbeat.unref?.();

  const closed = new AbortController();
  const close = () => {
    if (closed.signal.aborted) return;
    clearInterval(heartbeat);
    closed.abort();
    if (!reply.raw.writableEnded) reply.raw.end();
  };
  // 盯 reply.raw 而不是 request.raw：POST 进到 handler 时请求体已经被 Fastify 读完了，
  // request 那条流当场就 'close'——按它收尾的话，流式接口一开就把自己关掉（只发得出第一条）。
  // reply 这条只在真正断开（或我们自己 end 掉）时才 close。
  reply.raw.on("close", close);

  return {
    send: (data: unknown) => write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`),
    signal: closed.signal,
    close,
  };
}
