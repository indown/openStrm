/**
 * 整理与规范化命名。预览 / 执行 / 撤销都是后台作业，接口立刻返回，页面轮询 GET /runs/:id 看进度。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OrganizeTemplatePreview } from "@openstrm/shared";
import { forgetMatch, listMatches } from "../../db/repositories/organize.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { parse } from "../../lib/validate.js";
import { applyRun, cancelRun, createRun, deleteRun, getRunDetail, listRuns, patchUnit, revertRun } from "../../services/organize/run.js";
import { parseRules } from "../../services/organize/rules.js";
import { DEFAULT_TEMPLATES, resolveOrganizeSettings } from "../../services/organize/settings.js";
import { idTagFor, renderTemplate, validateTemplate } from "../../services/organize/template.js";
import { idParamsSchema } from "../../schemas/entities.js";

const createSchema = z.object({
  taskId: z.string().trim().min(1, "taskId is required"),
  subPath: z.string().optional(),
  paths: z.array(z.string()).max(5000).optional(),
});

const listQuerySchema = z.object({
  taskId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const unitPatchSchema = z.object({
  key: z.string().min(1),
  match: z.object({ mediaType: z.enum(["movie", "tv"]), tmdbId: z.number().int().positive() }).optional(),
  seasonOverride: z.number().int().min(0).max(99).nullable().optional(),
  episodeOffset: z.number().int().min(-2000).max(2000).optional(),
  selected: z.boolean().optional(),
  remember: z.boolean().optional(),
});

const previewNameSchema = z.object({
  templates: z.object({ movie: z.string().optional(), tv: z.string().optional() }).optional(),
  idTag: z.enum(["emby", "jellyfin", "plex", "none"]).optional(),
  colon: z.enum(["smart", "delete", "dash", "spaceDash"]).optional(),
  episodeTitle: z.boolean().optional(),
  rules: z.array(z.string()).optional(),
});

const forgetSchema = z.object({ accountName: z.string().min(1), srcPath: z.string().min(1) });

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/organize/runs", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = parse(createSchema, request.body);
    const run = await createRun({ taskId: body.taskId, subPath: body.subPath, paths: body.paths, mode: "manual", trigger: "manual" });
    return reply.code(201).send(run);
  });

  fastify.get("/api/organize/runs", { preHandler: [fastify.authenticate] }, async (request) => {
    const q = parse(listQuerySchema, request.query, "query");
    return { runs: listRuns({ taskId: q.taskId || undefined, limit: q.limit, offset: q.offset }) };
  });

  fastify.get("/api/organize/runs/:id", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    return getRunDetail(id);
  });

  /** 单元 key 里可能带 /，放 body 里 */
  fastify.put("/api/organize/runs/:id/unit", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const { key, ...patch } = parse(unitPatchSchema, request.body);
    return patchUnit(id, key, patch);
  });

  fastify.post("/api/organize/runs/:id/apply", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    return applyRun(id);
  });

  fastify.post("/api/organize/runs/:id/cancel", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    return cancelRun(id);
  });

  fastify.post("/api/organize/runs/:id/revert", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    return revertRun(id);
  });

  fastify.delete("/api/organize/runs/:id", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    deleteRun(id);
    return { success: true };
  });

  /** 设置页实时试算：拿两个固定样例套模板 */
  fastify.post("/api/organize/preview-name", { preHandler: [fastify.authenticate] }, async (request) => {
    const body = parse(previewNameSchema, request.body);
    const current = resolveOrganizeSettings(readAppSettings());
    const movieTpl = body.templates?.movie?.trim() || current.templates.movie || DEFAULT_TEMPLATES.movie;
    const tvTpl = body.templates?.tv?.trim() || current.templates.tv || DEFAULT_TEMPLATES.tv;
    const idTag = body.idTag ?? current.idTag;
    const colon = body.colon ?? current.colon;
    const episodeTitle = body.episodeTitle ?? current.episodeTitle;
    const errors = [
      ...validateTemplate(movieTpl).map((e) => `电影模板：${e}`),
      ...validateTemplate(tvTpl).map((e) => `剧集模板：${e}`),
      ...(body.rules ? parseRules(body.rules).errors.map((e) => `识别词${e}`) : []),
    ];
    const movie = renderTemplate(
      movieTpl,
      { title: "沙丘：第二部", originalTitle: "Dune: Part Two", enTitle: "Dune: Part Two", year: "2024", tmdbId: 693134, imdbId: "tt15239678", idTag: idTagFor(idTag, 693134), resolution: "2160p", source: "WEB-DL", videoCodec: "H.265", audio: "DDP", hdr: "DV", group: "FLUX", ext: "mkv", category: "" },
      { colon },
    ).path;
    const tv = renderTemplate(
      tvTpl,
      { title: "怒呛人生", originalTitle: "BEEF", enTitle: "BEEF", year: "2023", tmdbId: 153312, idTag: idTagFor(idTag, 153312), season: 1, season00: "01", episode: "1", episode00: "01", episodeTitle: episodeTitle ? "飞鸟不鸣" : "", resolution: "1080p", source: "WEB-DL", ext: "mkv", category: "" },
      { colon },
    ).path;
    const out: OrganizeTemplatePreview = { movie, tv, errors };
    return out;
  });

  fastify.get("/api/organize/matches", { preHandler: [fastify.authenticate] }, async (request) => {
    const q = parse(z.object({ account: z.string().optional() }), request.query, "query");
    return { matches: listMatches(q.account || undefined) };
  });

  fastify.delete("/api/organize/matches", { preHandler: [fastify.authenticate] }, async (request) => {
    const body = parse(forgetSchema, request.body);
    return { success: forgetMatch(body.accountName, body.srcPath) };
  });
}
