import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getRunningTask } from "../../services/task/registry.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";

const paramsSchema = z.object({ taskId: z.string().min(1) });

export default async function (fastify: FastifyInstance) {
  fastify.get("/api/taskLog/:taskId", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { taskId } = parse(paramsSchema, request.params, "params");
    const task = getRunningTask(taskId);

    // 没在跑就直接 404：以前 SSE 分支会把响应头写出去然后一直挂着，前端永远显示"已连接"
    if (!task) throw new HttpError(404, "Task is not running");

    const accept = request.headers.accept || "";
    if (!accept.includes("text/event-stream")) {
      return { message: "Task found", taskId };
    }

    // SSE
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // nginx 默认把代理响应攒够了再发，实时日志就成了隔很久倒一批；这个头让它别缓冲
      "X-Accel-Buffering": "no",
    });

    const write = (chunk: string) => {
      if (!reply.raw.writableEnded) reply.raw.write(chunk);
    };
    // 每 15 秒一行注释当心跳：任务在等限流时可能几十秒没有事件，反代和浏览器的空闲超时会把连接掐掉
    const heartbeat = setInterval(() => write(": ping\n\n"), 15_000);
    heartbeat.unref?.();
    const stop = () => {
      clearInterval(heartbeat);
      subscription.unsubscribe();
      if (!reply.raw.writableEnded) reply.raw.end();
    };

    // 先补发已经产生的日志，再订阅实时进度
    for (const line of task.logs) write(`data: ${line}\n\n`);
    const subscription = task.subject.subscribe({
      next: (data) => write(`data: ${JSON.stringify(data)}\n\n`),
      error: stop,
      complete: stop,
    });

    request.raw.on("close", stop);
  });
}
