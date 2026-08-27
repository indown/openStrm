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

    const accept = request.headers.accept || "";
    if (!accept.includes("text/event-stream")) {
      if (!task) throw new HttpError(404, "Task not found");
      return { message: "Task found", taskId };
    }

    // SSE
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // 先补发已经产生的日志，再订阅实时进度
    if (task) {
      for (const line of task.logs) reply.raw.write(`data: ${line}\n\n`);
    }
    const subscription = task?.subject.subscribe({
      next: (data) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`),
      error: () => reply.raw.end(),
      complete: () => reply.raw.end(),
    });

    request.raw.on("close", () => {
      subscription?.unsubscribe();
      reply.raw.end();
    });
  });
}
