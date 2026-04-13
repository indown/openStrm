import type { FastifyInstance } from "fastify";
import type { AppSettings } from "@openstrm/shared";

export default async function (fastify: FastifyInstance) {
  // GET: read settings
  fastify.get("/api/settings", { preHandler: [fastify.authenticate] }, async () => {
    return fastify.readSettings();
  });

  // PUT: update settings
  fastify.put("/api/settings", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = request.body as AppSettings;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ message: "invalid payload" });
    }

    // Check for running tasks (will be wired up in Phase 3)
    // const runningTasks = fastify.downloadTasks?.getRunningTaskIds() ?? [];
    // if (runningTasks.length > 0) {
    //   return reply.code(409).send({
    //     message: "有任务正在执行中，无法保存设置。请等待任务完成后再试。",
    //     hasRunningTasks: true,
    //     runningTasks,
    //   });
    // }

    fastify.writeSettings(body);

    // Rate limiter clearing will be added in Phase 3
    // nginx reload no longer needed — we are the proxy now

    return { message: "ok" };
  });
}
