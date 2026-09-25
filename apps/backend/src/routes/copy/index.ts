import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canRetryCopy, dropCopy, getCopyWatcherStatus, listCopies, retryCopy, type CopyRecord } from "../../services/copy/service.js";
import { parse } from "../../lib/validate.js";

const idParams = z.object({ id: z.string().min(1) });

/** 列表里的先后：能重试的 → 还在跑的 → 其余 */
const rank = (c: CopyRecord) => (canRetryCopy(c) ? 0 : c.status === "pending" ? 1 : 2);
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() });

/**
 * 「复制到 OpenList」的队列：看进度、失败了重排、不想跟了就删掉。
 * 登记是各个来源（云下载 / 转存 / 追更 / 监控）自己做的，这里没有「新建」。
 * 看和重试对智能体令牌开放（和 copy_list / copy_retry 同一组、同一档）；「不跟了」只认会话，智能体用不着
 */
export default async function (fastify: FastifyInstance) {
  fastify.get("/api/copy", { preHandler: [fastify.authenticate], config: { agentScope: "read", agentToolset: "transfer" } }, async (request) => {
    const { limit = 50 } = parse(listQuery, request.query, "query");
    const items = listCopies();
    return {
      // 要人动手的排在前面：能重试的、再是还在跑的，各自新的在前。界面只拿前面一截，老的失败不能被一季几十集的成功挤出去
      items: [...items].sort((a, b) => rank(a) - rank(b) || b.addedAt - a.addedAt).slice(0, limit).map((c) => ({ ...c, canRetry: canRetryCopy(c) })),
      total: items.length,
      // 队列已经读出来了，别让状态再读一遍
      watcher: getCopyWatcherStatus(items),
    };
  });

  fastify.post("/api/copy/:id/retry", { preHandler: [fastify.authenticate], config: { agentScope: "write", agentToolset: "transfer" } }, async (request) => {
    const { id } = parse(idParams, request.params, "params");
    return retryCopy(id);
  });

  fastify.delete("/api/copy/:id", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParams, request.params, "params");
    dropCopy(id);
    return { success: true };
  });
}
