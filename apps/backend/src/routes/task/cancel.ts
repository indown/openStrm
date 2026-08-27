import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { cancelRunningTask } from "../../services/task/registry.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";

// 两个名字都收：任务页发 id，日志页发 taskId
const cancelSchema = z.object({ taskId: z.string().optional(), id: z.string().optional() });

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/cancelTask", { preHandler: [fastify.authenticate] }, async (request) => {
    const body = parse(cancelSchema, request.body);
    const taskId = body.taskId || body.id;
    if (!taskId) throw new HttpError(400, "taskId is required");
    if (!cancelRunningTask(taskId)) throw new HttpError(404, "Task not found");
    return { message: "Task cancelled successfully", taskId };
  });
}
