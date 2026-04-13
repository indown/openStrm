import type { FastifyInstance } from "fastify";
import {
  getAllTaskHistory,
  getTaskHistory,
  deleteTaskExecution,
  deleteAllHistory,
} from "../../services/task-history.js";

export default async function (fastify: FastifyInstance) {
  // GET: task history
  fastify.get("/api/task-history", { preHandler: [fastify.authenticate] }, async (request) => {
    const { taskId } = request.query as { taskId?: string };
    if (taskId) {
      return getTaskHistory(taskId);
    }
    return getAllTaskHistory();
  });

  // DELETE: delete task history
  fastify.delete("/api/task-history", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { executionId, action } = request.query as { executionId?: string; action?: string };

    if (action === "cleanup") {
      deleteAllHistory();
      return { success: true, message: "All history deleted" };
    }

    if (!executionId) {
      return reply.code(400).send({ error: "Execution ID is required" });
    }

    deleteTaskExecution(executionId);
    return { success: true };
  });
}
