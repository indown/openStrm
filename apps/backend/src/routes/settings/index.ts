import type { FastifyInstance } from "fastify";
import type { AppSettings } from "@openstrm/shared";
import { patchAppSettings, readAppSettings } from "../../db/repositories/settings.js";

export default async function (fastify: FastifyInstance) {
  fastify.get("/api/settings", { preHandler: [fastify.authenticate] }, async () => readAppSettings());

  /**
   * 按顶层键合并，不是整体替换：设置页只发它自己拥有的键，
   * telegram / lifeMonitor 这些由别的页面写的键不会被一份过期快照盖掉。
   */
  fastify.put("/api/settings", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = request.body as AppSettings;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply.code(400).send({ message: "invalid payload" });
    }
    patchAppSettings(body);
    return { message: "ok" };
  });
}
