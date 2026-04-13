import type { FastifyInstance } from "fastify";

export default async function (fastify: FastifyInstance) {
  // GET: list all scheduled cron jobs
  fastify.get("/api/task/cron", { preHandler: [fastify.authenticate] }, async () => {
    return { jobs: fastify.cron.listJobs() };
  });

  // POST: sync cron jobs from config (useful after task CRUD)
  fastify.post("/api/task/cron/sync", { preHandler: [fastify.authenticate] }, async () => {
    fastify.cron.syncFromConfig();
    return { message: "Cron jobs synced", jobs: fastify.cron.listJobs() };
  });
}
