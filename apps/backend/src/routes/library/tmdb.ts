import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { searchMulti } from "../../services/tmdb.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { HttpError, upstreamError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";

const bodySchema = z.object({ query: z.string().trim().min(1, "query is required"), language: z.string().optional() });

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/library/tmdb/search", { preHandler: [fastify.authenticate] }, async (request) => {
    const { query, language } = parse(bodySchema, request.body);

    const settings = readAppSettings();
    const apiKey = settings.tmdb?.apiKey?.trim();
    if (!apiKey) throw new HttpError(400, "TMDB 未配置 apiKey，请先在设置中填入");

    try {
      const results = await searchMulti(apiKey, query, language || settings.tmdb?.language || "zh-CN");
      return results;
    } catch (err) {
      throw upstreamError(err instanceof Error ? err.message : "TMDB 搜索失败");
    }
  });
}
