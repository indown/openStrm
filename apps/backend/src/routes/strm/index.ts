import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TaskDefinition } from "@openstrm/shared";
import { getTask } from "../../db/repositories/tasks.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { providerForTask } from "../../services/drive/registry.js";
import { deletePaths, listDir, readStrm, regenerate, rewrite, scan, search, STRM_LIMITS, verify } from "../../services/strm/manage.js";

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

  /** 逐个目录到网盘确认；范围太大回 400 */
  fastify.post("/api/strm/verify", auth, async (request) => {
    const body = parse(verifyBody, request.body);
    const task = loadTask(body.taskId);
    const provider = providerForTask(task);
    return verify(task, provider, body.path);
  });
}
