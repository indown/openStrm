import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TaskDefinition } from "@openstrm/shared";
import { deleteTask, insertTask, listTasks, updateTask } from "../../db/repositories/tasks.js";
import { listRunningTaskIds } from "../../services/task/registry.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { taskInputSchema, taskPatchSchema } from "../../schemas/entities.js";

const idQuerySchema = z.object({ id: z.string().min(1, "Task ID required") });

/**
 * 任务定义的增删改查。
 *
 * 302 的挂载路径不再写进 settings.mediaMountPath：代理侧直接从「开了 302 的任务」
 * 现算（services/resolve/direct-link.ts），删任务、关 302 时它自然消失，
 * 不会像以前那样只增不减。
 */
export default async function (fastify: FastifyInstance) {
  // 定时任务跟着任务定义走。以前只在启动时同步一次，改了 cron 表达式要重启才生效
  const resyncCron = () => fastify.cron.syncFromConfig();

  fastify.get("/api/task", { preHandler: [fastify.authenticate] }, async () => {
    const running = new Set(listRunningTaskIds());
    return listTasks().map((task) => ({
      ...task,
      status: running.has(task.id) ? "processing" : "pending",
    }));
  });

  fastify.post("/api/task", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const task: TaskDefinition = { ...parse(taskInputSchema, request.body), id: randomUUID() };
    insertTask(task);
    resyncCron();
    return reply.code(201).send(task);
  });

  fastify.put("/api/task", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id, ...patch } = parse(taskPatchSchema, request.body);
    const updated = updateTask(id, patch);
    if (!updated) throw new HttpError(404, "Task not found");
    resyncCron();
    return updated;
  });

  fastify.delete("/api/task", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idQuerySchema, request.query, "query");
    if (!deleteTask(id)) throw new HttpError(404, "Task not found");
    resyncCron();
    return { success: true };
  });
}
