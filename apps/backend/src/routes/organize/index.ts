/**
 * 整理与规范化命名。预览 / 执行 / 撤销都是后台作业，接口立刻返回，页面轮询 GET /runs/:id 看进度。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OrganizeTemplatePreview } from "@openstrm/shared";
import { forgetMatch, listMatches } from "../../db/repositories/organize.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { parse } from "../../lib/validate.js";
import {
  applyRun,
  cancelRun,
  createRun,
  deleteRun,
  getRunDetail,
  getRunSummary,
  listAttention,
  listRunItems,
  listRuns,
  lookupCandidate,
  patchItems,
  patchUnit,
  patchUnits,
  repreviewRun,
  revertRun,
  searchCandidates,
  skipItems,
} from "../../services/organize/run.js";
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

/** 批量勾选单元：全选、全不选、只选把握大的 */
const unitsPatchSchema = z
  .object({ keys: z.array(z.string().min(1)).min(1).max(5000), selected: z.boolean().optional(), remember: z.boolean().optional() })
  .refine((b) => b.selected !== undefined || b.remember !== undefined, { message: "selected 或 remember 至少给一个" });

/** 按文件勾选：ids 是当前清单里的项 */
const itemsPatchSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(5000), selected: z.boolean() });

/** 换匹配弹框的 TMDB 搜索：可以限定类型和年份 */
const tmdbSearchSchema = z.object({
  query: z.string().trim().min(1, "query is required").max(200),
  type: z.enum(["movie", "tv"]).optional(),
  year: z.string().regex(/^\d{4}$/, "年份是四位数字").optional(),
});
const tmdbParamsSchema = z.object({ type: z.enum(["movie", "tv"]), id: z.coerce.number().int().positive() });

/** 按需拉项：一个单元的（unit 空串是建目录 / 删空目录），或者失败面板的一组 */
const itemsQuerySchema = z
  .object({
    unit: z.string().optional(),
    group: z.enum(["transient", "blocked", "stale", "rejected", "mirror", "lost", "pending"]).optional(),
  })
  .refine((q) => q.unit !== undefined || q.group !== undefined, { message: "unit 或 group 至少给一个" });

/** 执行：不带 ids 做全部（ready）或默认重试集；带 ids 只重试点名的项（stale / rejected 的要这样才会重试） */
const applySchema = z.object({ ids: z.array(z.string().min(1)).max(5000).optional() });
const skipSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(5000) });

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

  /** 要人管的 run（跨任务）：待执行、进行中、有失败或做了一半、撤销有没退回的、自动触发的预览失败 */
  fastify.get("/api/organize/attention", { preHandler: [fastify.authenticate] }, async () => ({ runs: listAttention() }));

  fastify.get("/api/organize/runs/:id", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    return getRunDetail(id);
  });

  /** 执行 / 撤销进行中页面轮询它：run（含进度 / 日志）+ 分组 + 按钮开关，不带单元和项 */
  fastify.get("/api/organize/runs/:id/summary", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    return getRunSummary(id);
  });

  fastify.get("/api/organize/runs/:id/items", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const q = parse(itemsQuerySchema, request.query, "query");
    return { items: listRunItems(id, q) };
  });

  /** 批量勾选单元：一次重规划 */
  fastify.put("/api/organize/runs/:id/units", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const body = parse(unitsPatchSchema, request.body);
    return patchUnits(id, body.keys, { selected: body.selected, remember: body.remember });
  });

  /** 按文件勾选：取消勾选的文件跳过，跟着它的字幕 / nfo 一起留下 */
  fastify.put("/api/organize/runs/:id/items", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const body = parse(itemsPatchSchema, request.body);
    return patchItems(id, body.ids, body.selected);
  });

  /** 换匹配弹框：按关键词搜（可限类型、年份） */
  fastify.post("/api/organize/tmdb/search", { preHandler: [fastify.authenticate] }, async (request) => {
    const body = parse(tmdbSearchSchema, request.body);
    return { results: await searchCandidates(body) };
  });

  /** 换匹配弹框：按 TMDB 编号查 */
  fastify.get("/api/organize/tmdb/:type/:id", { preHandler: [fastify.authenticate] }, async (request) => {
    const p = parse(tmdbParamsSchema, request.params, "params");
    return lookupCandidate(p.type, p.id);
  });

  /** 单元 key 里可能带 /，放 body 里 */
  fastify.put("/api/organize/runs/:id/unit", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const { key, ...patch } = parse(unitPatchSchema, request.body);
    return patchUnit(id, key, patch);
  });

  fastify.post("/api/organize/runs/:id/apply", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const body = parse(applySchema, request.body ?? {});
    return applyRun(id, body.ids);
  });

  /** 放弃失败项：标成「已放弃」让 run 收口；原地改了名还没挪走的先在网盘上改回原名 */
  fastify.post("/api/organize/runs/:id/skip", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const body = parse(skipSchema, request.body);
    return skipItems(id, body.ids);
  });

  /** 按原范围、原触发来源重新预览：新的手动预览，不自动执行 */
  fastify.post("/api/organize/runs/:id/repreview", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    return reply.code(201).send(await repreviewRun(id));
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
