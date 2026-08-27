import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { searchMulti, type TmdbSearchResult } from "../../services/tmdb.js";
import {
  getResourcesByTmdbId,
  unlockResource,
  type HdhiveMediaType,
} from "../../services/hdhive.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";

const searchSchema = z.object({
  query: z.string().optional(),
  tmdbId: z.union([z.number(), z.string()]).optional(),
  mediaType: z.enum(["movie", "tv"]).optional(),
  language: z.string().optional(),
});

const unlockSchema = z.object({ slug: z.string().trim().min(1, "slug 不能为空") });

type HdhiveFailure = Error & { status?: number; code?: string | number; retryAfterSeconds?: number };

/** HDHive 的失败带着它自己的状态码和限流提示，原样转给前端 */
function hdhiveError(err: unknown, fallback: string, data?: unknown): HttpError {
  const e = err as HdhiveFailure;
  const status = e.status && e.status >= 400 ? e.status : 502;
  return new HttpError(status, e.message || fallback, {
    code: e.code ?? status,
    retry_after_seconds: e.retryAfterSeconds,
    ...(data !== undefined ? { data } : {}),
  });
}

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/library/hdhive/search", { preHandler: [fastify.authenticate] }, async (request) => {
    const body = parse(searchSchema, request.body);
    const settings = readAppSettings();

    const hdhiveKey = settings.hdhive?.apiKey?.trim();
    if (!hdhiveKey) throw new HttpError(400, "HDHive 未配置 API Key，请先到「设置」填入 X-API-Key");
    const hdhiveBaseUrl = settings.hdhive?.baseUrl?.trim();

    const explicitTmdbId = body.tmdbId != null && String(body.tmdbId).trim() !== "" ? String(body.tmdbId).trim() : "";

    let picked: { selected: TmdbSearchResult; alternatives: TmdbSearchResult[] };
    if (explicitTmdbId && body.mediaType) {
      picked = {
        selected: { id: Number(explicitTmdbId) || 0, mediaType: body.mediaType, title: "", year: "", posterUrl: "", overview: "" },
        alternatives: [],
      };
    } else {
      const query = (body.query ?? "").trim();
      if (!query) throw new HttpError(400, "query 或 tmdbId+mediaType 至少提供一个");

      const tmdbKey = settings.tmdb?.apiKey?.trim();
      if (!tmdbKey) throw new HttpError(400, "TMDB 未配置 API Key，无法通过关键词搜索 tmdb_id");
      const language = body.language || settings.tmdb?.language || "zh-CN";

      const tmdbResults = await searchMulti(tmdbKey, query, language).catch((err: unknown) => {
        throw new HttpError(502, err instanceof Error ? err.message : "TMDB 搜索失败");
      });
      const candidates = tmdbResults.filter((r) => r.mediaType === "movie" || r.mediaType === "tv");
      if (candidates.length === 0) {
        return { tmdb: null, alternatives: [], resources: [], total: 0 };
      }
      picked = { selected: candidates[0], alternatives: candidates.slice(1) };
    }
    const { selected, alternatives } = picked;

    const { resources, total } = await getResourcesByTmdbId(selected.mediaType as HdhiveMediaType, selected.id, {
      apiKey: hdhiveKey,
      baseUrl: hdhiveBaseUrl,
    }).catch((err: unknown) => {
      // 前端拿着 data 里的 tmdb 结果还能展示，只是没有资源列表
      throw hdhiveError(err, "HDHive 调用失败", { tmdb: selected, alternatives, resources: [], total: 0 });
    });

    return { tmdb: selected, alternatives, resources, total };
  });

  fastify.post("/api/library/hdhive/unlock", { preHandler: [fastify.authenticate] }, async (request) => {
    const { slug } = parse(unlockSchema, request.body);

    const settings = readAppSettings();
    const hdhiveKey = settings.hdhive?.apiKey?.trim();
    if (!hdhiveKey) throw new HttpError(400, "HDHive 未配置 API Key，请先到「设置」填入 X-API-Key");

    try {
      const data = await unlockResource(slug, { apiKey: hdhiveKey, baseUrl: settings.hdhive?.baseUrl?.trim() });
      return data;
    } catch (err) {
      throw hdhiveError(err, "HDHive 解锁失败");
    }
  });
}
