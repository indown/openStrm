import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { resolveAlistPath } from "../../services/resolve/direct-link.js";

/** 解析失败的原因映射成对外的状态码，保持原有契约不变 */
const FAILURE_RESPONSE = {
  "no-account": { code: 404, message: "no 115 account configured" },
  "not-mounted": { code: 404, message: "file not found" },
  "not-found": { code: 404, message: "file not found" },
  "no-url": { code: 500, message: "failed to get download url" },
} as const;

export default async function (fastify: FastifyInstance) {
  // Internal token auth for Alist-compatible endpoint
  const verifyInternalToken = async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization || "";
    const settings = fastify.readSettings();
    const internalToken = settings.internalToken || "";
    if (!internalToken || authHeader !== internalToken) {
      reply.code(401).send({ code: 401, message: "unauthorized" });
    }
  };

  fastify.post("/api/fs/get", { preHandler: [verifyInternalToken] }, async (request, reply) => {
    const { path } = request.body as { path?: string };
    if (!path) {
      return reply.code(400).send({ code: 400, message: "path is required" });
    }

    // 这条接口是给 CD2/OpenList 回源用的，UA 用配置里的那个
    const userAgent = fastify.readSettings()["user-agent"] as string | undefined;
    const resolved = await resolveAlistPath(path, userAgent);

    if (!resolved.ok) {
      const { code, message } =
        FAILURE_RESPONSE[resolved.reason] ?? { code: 500, message: "failed to resolve path" };
      return reply.code(code).send({ code, message });
    }

    const fileName = resolved.panPath.split("/").pop() || "";
    return {
      code: 200,
      message: "success",
      data: { raw_url: resolved.url, name: fileName, provider: "115" },
    };
  });
}
