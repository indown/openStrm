import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getAllTaskHistory,
  getTaskExecution,
  getTaskHistory,
  deleteTaskExecution,
  deleteAllHistory,
} from "../../services/task-history.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";

const listQuerySchema = z.object({ taskId: z.string().optional() });
const executionParamsSchema = z.object({ executionId: z.string().min(1) });
const deleteQuerySchema = z.object({
  executionId: z.string().optional(),
  action: z.enum(["cleanup"]).optional(),
});

export default async function (fastify: FastifyInstance) {
  // 列表不带 logs：每条记录几千行日志，列表里没人看，以前一页历史就是几十 MB
  fastify.get("/api/taskHistory", { preHandler: [fastify.authenticate] }, async (request) => {
    const { taskId } = parse(listQuerySchema, request.query, "query");
    return taskId ? getTaskHistory(taskId) : getAllTaskHistory();
  });

  fastify.get("/api/taskHistory/:executionId", { preHandler: [fastify.authenticate] }, async (request) => {
    const { executionId } = parse(executionParamsSchema, request.params, "params");
    const execution = getTaskExecution(executionId);
    if (!execution) throw new HttpError(404, "Execution not found");
    return execution;
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
