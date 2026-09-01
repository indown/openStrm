import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getRunningTask, isTaskRunning, waitForTaskStart, type StartOutcome } from "../../services/task/registry.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";

const paramsSchema = z.object({ taskId: z.string().min(1) });

/** 启动阶段就结束了、没有注册进 running：无事可做算完成，其余按失败收尾 */
function startOutcomeEvent(outcome: StartOutcome | undefined) {
  const at = Date.now();
  if (!outcome) return { done: true, status: "failed", message: "任务没有起来，原因见执行历史", at };
  if (outcome.status === 200) {
    return { done: true, status: "completed", total: 0, finished: 0, failed: 0, message: "本地已是最新，没有需要处理的文件", at };
  }
  return { done: true, status: "failed", message: outcome.details ? `${outcome.message}：${outcome.details}` : outcome.message, at };
}

export default async function (fastify: FastifyInstance) {
  fastify.get("/api/taskLog/:taskId", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { taskId } = parse(paramsSchema, request.params, "params");
    let task = getRunningTask(taskId);
    // 拉远端目录树期间任务只在 starting 里、还没有进度流。任务列表这时已经显示"运行中"，
    // 这里要是 404，日志页会当它没在跑、跳去看上一次的记录——取消后立刻重启时就是那条已取消的
    const starting = !task && isTaskRunning(taskId);

    // 没在跑就直接 404：以前 SSE 分支会把响应头写出去然后一直挂着，前端永远显示"已连接"
    if (!task && !starting) throw new HttpError(404, "Task is not running");

    const accept = request.headers.accept || "";
    if (!accept.includes("text/event-stream")) {
      return { message: starting ? "Task starting" : "Task found", taskId, starting };
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
    // 连接收尾的信号：客户端断开、流结束都走 stop；订阅在下面挂上后跟着它退
    const closed = new AbortController();
    const stop = () => {
      clearInterval(heartbeat);
      closed.abort();
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    request.raw.on("close", stop);

    if (!task) {
      // 先告诉页面正在启动，再等启动阶段结束；客户端中途断开就不等了
      write(`data: ${JSON.stringify({ starting: true, at: Date.now() })}\n\n`);
      const outcome = await waitForTaskStart(taskId, closed.signal);
      if (closed.signal.aborted) return;
      task = getRunningTask(taskId);
      if (!task) {
        write(`data: ${JSON.stringify(startOutcomeEvent(outcome))}\n\n`);
        stop();
        return;
      }
    }

    // 先补发已经产生的日志，再订阅实时进度
    for (const line of task.logs) write(`data: ${line}\n\n`);
    const subscription = task.subject.subscribe({
      next: (data) => write(`data: ${JSON.stringify(data)}\n\n`),
      error: stop,
      complete: stop,
    });
    closed.signal.addEventListener("abort", () => subscription.unsubscribe(), { once: true });
  });
}
