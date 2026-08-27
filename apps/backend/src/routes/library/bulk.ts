import type { FastifyInstance } from "fastify";
import {
  getById,
  getPending,
  setScrapeStatus,
} from "../../db/repositories/media-library.js";
import { enqueueOne, status as workerStatus } from "../../services/library/scrape-worker.js";
import { readAppSettings } from "../../db/repositories/settings.js";

export default async function (fastify: FastifyInstance) {
  fastify.get(
    "/api/library/scrape-status",
    { preHandler: [fastify.authenticate] },
    async () => {
      const pending = getPending();
      const s = workerStatus();
      return {
        code: 200,
        data: {
          pendingIds: pending.map((e) => e.id),
          pendingCount: pending.length,
          active: s.active,
          queued: s.queued,
        },
      };
    },
  );

  fastify.post(
    "/api/library/:id/scrape",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const entry = getById(id);
      if (!entry) return reply.code(404).send({ code: 404, message: "Entry not found" });

      const settings = readAppSettings();
      const hasTmdb = Boolean(settings.tmdb?.apiKey?.trim());
      if (!hasTmdb) {
        return reply.code(400).send({ code: 400, message: "TMDB 未配置，请先在设置中填入 API Key" });
      }

      setScrapeStatus(id, "pending");
      enqueueOne(id);
      return { code: 200, data: { id, status: "pending" } };
    },
  );
}
