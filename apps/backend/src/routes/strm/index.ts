import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { StrmVerifyEvent, TaskDefinition } from "@openstrm/shared";
import { getTask } from "../../db/repositories/tasks.js";
import { HttpError } from "../../lib/http-error.js";
import { messageOf } from "../../lib/errors.js";
import { openSse } from "../../lib/sse.js";
import { parse } from "../../lib/validate.js";
import { providerForTask } from "../../services/drive/registry.js";
import { deletePaths, listDir, readStrm, regenerate, rewrite, scan, search, STRM_LIMITS, verify, verify$ } from "../../services/strm/manage.js";
import { POSTER_LIMITS, resolvePosters, statImage } from "../../services/strm/poster.js";

/**
 * strm 管理：按同步任务浏览 / 检查 / 删除 / 修正 / 重建本地 strm。
 * 规则都在 services/strm/manage.ts，这里只管入参和账号；path 一律相对任务 targetPath，"" 是根。
 */
const taskId = z.string().trim().min(1, "taskId is required");
const optionalPath = z.string().max(4096).default("");
const requiredPath = z.string().min(1, "path is required").max(4096);

const listQuery = z.object({ taskId, path: optionalPath });
const fileQuery = z.object({ taskId, path: requiredPath });
const searchQuery = z.object({
  taskId,
  q: z.string().trim().min(1, "q is required").max(200),
  limit: z.coerce.number().int().min(1).max(STRM_LIMITS.SEARCH_MAX).default(STRM_LIMITS.SEARCH_DEFAULT),
});
const deleteBody = z.object({ taskId, paths: z.array(z.string().min(1)).min(1, "paths is required").max(STRM_LIMITS.DELETE_MAX) });
const scanBody = z.object({ taskId, path: optionalPath });
const rewriteBody = z.object({ taskId, path: optionalPath, dryRun: z.boolean().default(false) });
const regenerateBody = z.object({ taskId, path: requiredPath, mode: z.enum(["fill", "rebuild"]).default("fill") });
const verifyBody = z.object({ taskId, path: optionalPath });
const postersBody = z.object({
  taskId,
  paths: z.array(z.string().max(4096)).min(1, "paths is required").max(POSTER_LIMITS.PATHS),
});

function loadTask(id: string): TaskDefinition {
  const task = getTask(id);
  if (!task) throw new HttpError(404, `Task not found: ${id}`);
  return task;
}

export default async function (fastify: FastifyInstance) {
  const auth = { preHandler: [fastify.authenticate] };

  fastify.get("/api/strm/list", auth, async (request) => {
    const q = parse(listQuery, request.query, "query");
    return listDir(loadTask(q.taskId), q.path);
  });

  fastify.get("/api/strm/file", auth, async (request) => {
    const q = parse(fileQuery, request.query, "query");
    return readStrm(loadTask(q.taskId), q.path);
  });

  /** 背景海报：一批目录各拿一张，拿不到的不在结果里。纯装饰，任何一步失败都只是没有海报 */
  fastify.post("/api/strm/posters", auth, async (request) => {
    const body = parse(postersBody, request.body);
    return { posters: await resolvePosters(loadTask(body.taskId), body.paths) };
  });

  /** 本地图片（海报用）。<img> 带不了 Authorization 头，前端是取 blob 再显示的 */
  fastify.get("/api/strm/image", auth, async (request, reply) => {
    const q = parse(fileQuery, request.query, "query");
    const img = await statImage(loadTask(q.taskId), q.path);
    const etag = `"${img.size.toString(36)}-${Math.floor(img.mtimeMs).toString(36)}"`;
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    return reply
      .header("Content-Type", img.contentType)
      .header("Content-Length", img.size)
      .header("Cache-Control", "private, max-age=86400")
      .header("ETag", etag)
      .send(createReadStream(img.full));
  });

  fastify.get("/api/strm/search", auth, async (request) => {
    const q = parse(searchQuery, request.query, "query");
    return search(loadTask(q.taskId), q.q, q.limit);
  });

  fastify.post("/api/strm/delete", auth, async (request) => {
    const body = parse(deleteBody, request.body);
    return deletePaths(loadTask(body.taskId), body.paths);
  });

  /** 整棵扫一遍要读每个 strm，大库要一两分钟 */
  fastify.post("/api/strm/scan", auth, async (request) => {
    const body = parse(scanBody, request.body);
    return scan(loadTask(body.taskId), body.path);
  });

  fastify.post("/api/strm/rewrite", auth, async (request) => {
    const body = parse(rewriteBody, request.body);
    return rewrite(loadTask(body.taskId), body.path, { dryRun: body.dryRun });
  });

  /** 要读网盘目录再生成，最长可能等 5 分钟；根目录 400、任务同步中 409、网盘目录没了 404 */
  fastify.post("/api/strm/regenerate", auth, async (request) => {
    const body = parse(regenerateBody, request.body);
    const task = loadTask(body.taskId);
    const provider = providerForTask(task);
    return regenerate(task, provider, body.path, { mode: body.mode });
  });

  /** 逐个目录到网盘确认；范围太大回 400。单个文件用这个就够，整目录走下面的流式版 */
  fastify.post("/api/strm/verify", auth, async (request) => {
    const body = parse(verifyBody, request.body);
    const task = loadTask(body.taskId);
    const provider = providerForTask(task);
    return verify(task, provider, body.path);
  });

  /**
   * 校验的流式版（SSE）：进度一路推，最后一条是结果。
   *
   * 一个大目录要读上万个 strm、再到网盘逐个目录确认，挂成一个长 POST 有两个毛病：
   * 界面只有一个转圈、中途不能取消；反代 / Cloudflare 的空闲超时一掐整轮白跑，
   * 后端还蒙在鼓里照样打网盘。这里连接上一直有数据，客户端一断就退订、活儿立刻停。
   *
   * 出错也走事件（type: "error"）而不是非 200：响应头早就发出去了，改不了状态码，
   * 何况 Cloudflare 见到 5xx 会把响应体换成它自己的错误页。
   */
  fastify.post("/api/strm/verify/stream", auth, async (request, reply) => {
    const body = parse(verifyBody, request.body);
    const task = loadTask(body.taskId);
    const provider = providerForTask(task);
    const sse = openSse(reply);
    const subscription = verify$(task, provider, body.path).subscribe({
      next: (event) => sse.send(event),
      error: (err: unknown) => {
        sse.send({ type: "error", message: messageOf(err) } satisfies StrmVerifyEvent);
        sse.close();
      },
      complete: () => sse.close(),
    });
    // 关掉弹框 / 刷新页面：退订，正在跑的校验跟着停
    sse.signal.addEventListener("abort", () => subscription.unsubscribe(), { once: true });
  });
}
