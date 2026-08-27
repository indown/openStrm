import type { FastifyInstance } from "fastify";
import { cancelRunningTask } from "../../services/task/registry.js";

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/cancelTask", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = (request.body ?? {}) as { taskId?: string; id?: string };
    const taskId = body.taskId || body.id;
    if (!taskId) return reply.code(400).send({ error: "taskId is required" });
    if (!cancelRunningTask(taskId)) return reply.code(404).send({ error: "Task not found" });
    return { message: "Task cancelled successfully", taskId };
  });
}
