/**
 * 检查更新。GET 只读缓存（刷新页面不会去联网），POST 才真的问一次 GitHub。
 * 开关在设置里（`app.update.enabled`，默认关）；POST 是用户自己按的，关着也能按，但有节流。
 */
import type { FastifyInstance } from "fastify";
import { checkForUpdates, ThrottledError, updateStatus } from "../../services/update/service.js";
import { HttpError } from "../../lib/http-error.js";

export default async function (fastify: FastifyInstance) {
  fastify.get("/api/update", { preHandler: [fastify.authenticate] }, async () => updateStatus());

  fastify.post("/api/update/check", { preHandler: [fastify.authenticate] }, async () => {
    try {
      await checkForUpdates({ manual: true });
    } catch (err) {
      // 连点：不当失败，把还要等多久告诉页面
      if (err instanceof ThrottledError) throw new HttpError(429, err.message, { retryAfter: err.retryAfter });
      throw err;
    }
    return updateStatus();
  });
}
