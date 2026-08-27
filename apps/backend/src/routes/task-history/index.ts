import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getAllTaskHistory,
  getTaskHistory,
  deleteTaskExecution,
  deleteAllHistory,
} from "../../services/task-history.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";

const listQuerySchema = z.object({ taskId: z.string().optional() });
const deleteQuerySchema = z.object({
  executionId: z.string().optional(),
  action: z.enum(["cleanup"]).optional(),
});

export default async function (fastify: FastifyInstance) {
  fastify.get("/api/taskHistory", { preHandler: [fastify.authenticate] }, async (request) => {
    const { taskId } = parse(listQuerySchema, request.query, "query");
    return taskId ? getTaskHistory(taskId) : getAllTaskHistory();
  });

  fastify.delete("/api/taskHistory", { preHandler: [fastify.authenticate] }, async (request) => {
    const { executionId, action } = parse(deleteQuerySchema, request.query, "query");
    if (action === "cleanup") {
      deleteAllHistory();
      return { success: true, message: "All history deleted" };
    }
    if (!executionId) throw new HttpError(400, "Execution ID is required");
    deleteTaskExecution(executionId);
    return { success: true };
  });
}
