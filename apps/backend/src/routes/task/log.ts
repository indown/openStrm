import type { FastifyInstance } from "fastify";

export default async function (fastify: FastifyInstance) {
  fastify.get("/api/task/:taskId/log", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = fastify.downloadTasks[taskId];

    const accept = request.headers.accept || "";
    if (!accept.includes("text/event-stream")) {
      if (!task) {
        return reply.code(404).send({ error: "Task not found" });
      }
      return { message: "Task found", taskId };
    }

    // SSE
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Push historical logs
    if (task) {
      for (const line of task.logs) {
        reply.raw.write(`data: ${line}\n\n`);
      }
    }

    // Subscribe to real-time updates
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
