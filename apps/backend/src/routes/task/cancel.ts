import type { FastifyInstance } from "fastify";

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/task/cancel", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = request.body as { taskId?: string; id?: string };
    const taskId = body.taskId || body.id;

    if (!taskId) {
      return reply.code(400).send({ error: "taskId is required" });
    }

    const task = fastify.downloadTasks[taskId];
    if (!task) {
      return reply.code(404).send({ error: "Task not found" });
    }

    task.subscription.unsubscribe();
    task.subject.next({ done: true, message: "任务已取消" });
    task.subject.complete();
    delete fastify.downloadTasks[taskId];

    return { message: "Task cancelled successfully", taskId };
  });
}
