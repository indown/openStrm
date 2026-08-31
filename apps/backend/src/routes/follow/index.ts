import type { FastifyInstance } from "fastify";
import { checkFollow, createFollow, deleteFollow, listFollows, updateFollow } from "../../services/follow/service.js";
import { parse } from "../../lib/validate.js";
import { idParamsSchema, shareFollowCreateSchema, shareFollowPatchSchema } from "../../schemas/entities.js";

/**
 * 分享追更订阅。转存接口（/api/115/share、/api/library/:id/save-to-task）带 follow 参数时会顺手建订阅，
 * 这里是之后的管理：列表、改、删、立即检查。
 */
export default async function (fastify: FastifyInstance) {
  fastify.get("/api/follow", { preHandler: [fastify.authenticate] }, async () => listFollows());

  fastify.post("/api/follow", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = parse(shareFollowCreateSchema, request.body);
    return reply.code(201).send(await createFollow(body));
  });

  fastify.put("/api/follow/:id", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    return updateFollow(id, parse(shareFollowPatchSchema, request.body));
  });

  fastify.delete("/api/follow/:id", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    deleteFollow(id);
    return { success: true };
  });

  /** 立即检查一次：要递归列分享目录，有新增还要转存，可能要等几十秒 */
  fastify.post("/api/follow/:id/check", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    return checkFollow(id);
  });
}
