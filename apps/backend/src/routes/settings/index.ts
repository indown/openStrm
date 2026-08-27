import type { FastifyInstance } from "fastify";
import { patchAppSettings, readAppSettings } from "../../db/repositories/settings.js";
import { maskSettings, unmaskSettingsPatch } from "../../lib/secrets.js";
import { parse } from "../../lib/validate.js";
import { settingsPatchSchema } from "../../schemas/entities.js";

export default async function (fastify: FastifyInstance) {
  // 密钥只给末 4 位；表单原样提交掩码值等于不改（见 lib/secrets.ts）
  fastify.get("/api/settings", { preHandler: [fastify.authenticate] }, async () => maskSettings(readAppSettings()));

  /**
   * 按顶层键合并，不是整体替换：设置页只发它自己拥有的键，
   * telegram / lifeMonitor 这些由别的页面写的键不会被一份过期快照盖掉。
   */
  fastify.put("/api/settings", { preHandler: [fastify.authenticate] }, async (request) => {
    patchAppSettings(unmaskSettingsPatch(parse(settingsPatchSchema, request.body), readAppSettings()));
    return { message: "ok" };
  });
}
