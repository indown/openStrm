import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getRunningTask, isTaskRunning, waitForTaskStart, type StartOutcome } from "../../services/task/registry.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { openSse } from "../../lib/sse.js";

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

    // SSE：响应头、心跳、客户端断开的收尾都在 openSse 里
    const sse = openSse(reply);

    if (!task) {
      // 先告诉页面正在启动，再等启动阶段结束；客户端中途断开就不等了
      sse.send({ starting: true, at: Date.now() });
      const outcome = await waitForTaskStart(taskId, sse.signal);
      if (sse.signal.aborted) return;
      task = getRunningTask(taskId);
      if (!task) {
        sse.send(startOutcomeEvent(outcome));
        sse.close();
        return;
      }
    }

    // 先补发已经产生的日志（本来就是 JSON 行，原样发），再订阅实时进度
    for (const line of task.logs) sse.send(line);
    const subscription = task.subject.subscribe({
      next: (data) => sse.send(data),
      error: () => sse.close(),
      complete: () => sse.close(),
    });
    sse.signal.addEventListener("abort", () => subscription.unsubscribe(), { once: true });
  });
}
