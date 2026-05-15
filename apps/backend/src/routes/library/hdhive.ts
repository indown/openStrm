import type { FastifyInstance } from "fastify";
import { searchMulti, type TmdbSearchResult } from "../../services/tmdb.js";
import {
  getResourcesByTmdbId,
  type HdhiveMediaType,
  type HdhiveResource,
} from "../../services/hdhive.js";

interface SearchBody {
  query?: string;
  tmdbId?: number | string;
  mediaType?: HdhiveMediaType;
  language?: string;
}

export default async function (fastify: FastifyInstance) {
  fastify.post(
    "/api/library/hdhive/search",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const body = (request.body ?? {}) as SearchBody;
      const settings = fastify.readSettings();

      const hdhiveKey = settings.hdhive?.apiKey?.trim();
      if (!hdhiveKey) {
        return reply
          .code(400)
          .send({ code: 400, message: "HDHive 未配置 API Key，请先到「设置」填入 X-API-Key" });
      }
      const hdhiveBaseUrl = settings.hdhive?.baseUrl?.trim();

      const explicitTmdbId =
        body.tmdbId != null && String(body.tmdbId).trim() !== "" ? String(body.tmdbId).trim() : "";
      const explicitMediaType =
        body.mediaType === "movie" || body.mediaType === "tv" ? body.mediaType : undefined;

      let selected: TmdbSearchResult | null = null;
      let alternatives: TmdbSearchResult[] = [];

      if (explicitTmdbId && explicitMediaType) {
        selected = {
          id: Number(explicitTmdbId) || 0,
          mediaType: explicitMediaType,
          title: "",
          year: "",
          posterUrl: "",
          overview: "",
        };
      } else {
        const query = typeof body.query === "string" ? body.query.trim() : "";
        if (!query) {
          return reply.code(400).send({ code: 400, message: "query 不能为空" });
        }
        const tmdbKey = settings.tmdb?.apiKey?.trim();
        if (!tmdbKey) {
          return reply
            .code(400)
            .send({ code: 400, message: "TMDB 未配置 API Key，无法通过关键词搜索 tmdb_id" });
        }
        const language =
          typeof body.language === "string" && body.language
            ? body.language
            : settings.tmdb?.language || "zh-CN";

        let tmdbResults: TmdbSearchResult[] = [];
        try {
          tmdbResults = await searchMulti(tmdbKey, query, language);
        } catch (err) {
          const message = err instanceof Error ? err.message : "TMDB 搜索失败";
          return reply.code(502).send({ code: 502, message });
        }
        const candidates = tmdbResults.filter(
          (r) => r.mediaType === "movie" || r.mediaType === "tv",
        );
        if (candidates.length === 0) {
          return reply
            .code(200)
            .send({ code: 200, data: { tmdb: null, alternatives: [], resources: [], total: 0 } });
        }
        selected = candidates[0];
        alternatives = candidates.slice(1);
      }

      if (!selected) {
        return reply
          .code(200)
          .send({ code: 200, data: { tmdb: null, alternatives: [], resources: [], total: 0 } });
      }

      let resources: HdhiveResource[] = [];
      let total = 0;
      try {
        const resp = await getResourcesByTmdbId(
          selected.mediaType as HdhiveMediaType,
          selected.id,
          { apiKey: hdhiveKey, baseUrl: hdhiveBaseUrl },
        );
        resources = resp.resources;
        total = resp.total;
      } catch (err) {
        const e = err as Error & { status?: number; code?: string | number; retryAfterSeconds?: number };
        const status = e.status && e.status >= 400 ? e.status : 502;
        return reply.code(status).send({
          code: e.code ?? status,
          message: e.message || "HDHive 调用失败",
          retry_after_seconds: e.retryAfterSeconds,
          data: {
            tmdb: selected,
            alternatives,
            resources: [],
            total: 0,
          },
        });
      }

      return {
        code: 200,
        data: {
          tmdb: selected,
          alternatives,
          resources,
          total,
        },
      };
    },
  );
}
