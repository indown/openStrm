import type { FastifyInstance } from "fastify";
import { searchMulti } from "../../services/tmdb.js";

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/library/tmdb/search", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) {
      return reply.code(400).send({ code: 400, message: "query is required" });
    }

    const settings = fastify.readSettings();
    const apiKey = settings.tmdb?.apiKey?.trim();
    if (!apiKey) {
      return reply.code(400).send({ code: 400, message: "TMDB 未配置 apiKey，请先在设置中填入" });
    }

    const language = typeof body.language === "string" && body.language
      ? body.language
      : settings.tmdb?.language || "zh-CN";

    try {
      const results = await searchMulti(apiKey, query, language);
      return { code: 200, data: results };
    } catch (err) {
      const message = err instanceof Error ? err.message : "TMDB 搜索失败";
      return reply.code(502).send({ code: 502, message });
    }
  });
}
