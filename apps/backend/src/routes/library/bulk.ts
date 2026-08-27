import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getById, getPending, setScrapeStatus } from "../../db/repositories/media-library.js";
import { enqueueOne, status as workerStatus } from "../../services/library/scrape-worker.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";

const idParamsSchema = z.object({ id: z.string().min(1) });

export default async function (fastify: FastifyInstance) {
  fastify.get("/api/library/scrape-status", { preHandler: [fastify.authenticate] }, async () => {
    const pending = getPending();
    const s = workerStatus();
    return {
      pendingIds: pending.map((e) => e.id),
      pendingCount: pending.length,
      active: s.active,
      queued: s.queued,
    };
  });

  fastify.post("/api/library/:id/scrape", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    if (!getById(id)) throw new HttpError(404, "Entry not found");
    if (!readAppSettings().tmdb?.apiKey?.trim()) throw new HttpError(400, "TMDB 未配置，请先在设置中填入 API Key");

    setScrapeStatus(id, "pending");
    enqueueOne(id);
    return { id, status: "pending" };
  });
}
