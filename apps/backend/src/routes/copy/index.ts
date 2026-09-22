import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { dropCopy, getCopyWatcherStatus, listCopies, retryCopy } from "../../services/copy/service.js";
import { parse } from "../../lib/validate.js";

const idParams = z.object({ id: z.string().min(1) });
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() });

/**
 * 「复制到 OpenList」的队列：看进度、失败了重排、不想跟了就删掉。
 * 登记是各个来源（云下载 / 转存 / 追更 / 监控）自己做的，这里没有「新建」。
 */
export default async function (fastify: FastifyInstance) {
  fastify.get("/api/copy", { preHandler: [fastify.authenticate] }, async (request) => {
    const { limit = 50 } = parse(listQuery, request.query, "query");
    const items = listCopies();
    return {
      items: items.slice(0, limit),
      total: items.length,
      // 队列已经读出来了，别让状态再读一遍
      watcher: { ...getCopyWatcherStatus(), pending: items.filter((c) => c.status === "pending").length },
    };
  });

  fastify.post("/api/copy/:id/retry", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParams, request.params, "params");
    return retryCopy(id);
  });

  fastify.delete("/api/copy/:id", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParams, request.params, "params");
    dropCopy(id);
    return { success: true };
  });
}
