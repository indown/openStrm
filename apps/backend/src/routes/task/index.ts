import type { FastifyInstance } from "fastify";

export default async function (fastify: FastifyInstance) {
  // GET: list tasks with status
  fastify.get("/api/task", { preHandler: [fastify.authenticate] }, async () => {
    const tasks = fastify.readTasks();

    const runningTaskIds = new Set(Object.keys(fastify.downloadTasks));

    return tasks.map((task) => ({
      ...task,
      status: runningTaskIds.has(task.id) ? "processing" : "pending",
    }));
  });

  // POST: create task
  fastify.post("/api/task", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const tasks = fastify.readTasks();

    const newTask = {
      id: Date.now().toString(),
      ...body,
    } as any;

    tasks.push(newTask);
    fastify.writeTasks(tasks);

    // mediaMountPath update for 302 mode
    if (newTask.enable302 && newTask.strmPrefix) {
      const fullPath = (newTask.strmPrefix as string).replace(/\/+$/, "");
      const settings = fastify.readSettings();
      const mediaMountPath: string[] = Array.isArray(settings.mediaMountPath)
        ? settings.mediaMountPath
        : [];
      if (!mediaMountPath.includes(fullPath)) {
        mediaMountPath.push(fullPath);
        settings.mediaMountPath = mediaMountPath;
        fastify.writeSettings(settings);
      }
    }

    return reply.code(201).send(newTask);
  });

  // PUT: update task
  fastify.put("/api/task", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const { id, ...updateData } = body;

    const tasks = fastify.readTasks();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) {
      return reply.code(404).send({ error: "Task not found" });
    }

    tasks[idx] = { ...tasks[idx], ...updateData } as any;
    fastify.writeTasks(tasks);

    // mediaMountPath update for 302 mode
    const task = tasks[idx];
    if (task.enable302 && task.strmPrefix) {
      const fullPath = task.strmPrefix.replace(/\/+$/, "");
      const settings = fastify.readSettings();
      const mediaMountPath: string[] = Array.isArray(settings.mediaMountPath)
        ? settings.mediaMountPath
        : [];
      if (!mediaMountPath.includes(fullPath)) {
        mediaMountPath.push(fullPath);
        settings.mediaMountPath = mediaMountPath;
        fastify.writeSettings(settings);
      }
    }

    return tasks[idx];
  });

  // DELETE: delete task
  fastify.delete("/api/task", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id } = request.query as { id?: string };
    if (!id) {
      return reply.code(400).send({ error: "Task ID required" });
    }

    const tasks = fastify.readTasks();
    const filtered = tasks.filter((t) => t.id !== id);
    if (filtered.length === tasks.length) {
      return reply.code(404).send({ error: "Task not found" });
    }

    fastify.writeTasks(filtered);
    return { success: true };
  });
}
