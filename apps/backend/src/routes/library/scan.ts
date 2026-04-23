import type { FastifyInstance } from "fastify";
import { expandCandidate, scanShare } from "../../services/library/scan.js";

export default async function (fastify: FastifyInstance) {
  fastify.post(
    "/api/library/scan",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const shareUrl = typeof body.shareUrl === "string" ? body.shareUrl.trim() : "";
      if (!shareUrl) return reply.code(400).send({ code: 400, message: "shareUrl is required" });

      const accounts = fastify.readAccounts();
      const account115 = accounts.find((a) => a.accountType === "115") as any;
      if (!account115) return reply.code(400).send({ code: 400, message: "未配置 115 账号" });

      const settings = fastify.readSettings();
      const userAgent = typeof settings["user-agent"] === "string" ? settings["user-agent"] : undefined;

      try {
        const result = await scanShare({ accountInfo: account115, shareUrl, userAgent });
        return { code: 200, data: result };
      } catch (err) {
        const message = err instanceof Error ? err.message : "扫描失败";
        return reply.code(502).send({ code: 502, message });
      }
    },
  );

  fastify.post(
    "/api/library/scan/expand",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const shareCode = typeof body.shareCode === "string" ? body.shareCode.trim() : "";
      const receiveCode = typeof body.receiveCode === "string" ? body.receiveCode : "";
      const rawPc = body.parentCid;
      let parentCid: number | string;
      if (typeof rawPc === "string") {
        const t = rawPc.trim();
        if (!t) return reply.code(400).send({ code: 400, message: "parentCid is required" });
        parentCid = /^-?\d+$/.test(t) && Number.isSafeInteger(Number(t)) ? Number(t) : t;
      } else if (typeof rawPc === "number" && Number.isFinite(rawPc)) {
        parentCid = rawPc;
      } else {
        return reply.code(400).send({ code: 400, message: "parentCid is required" });
      }
      if (parentCid === 0 || parentCid === "0") {
        return reply.code(400).send({ code: 400, message: "parentCid is required" });
      }
      const parentName = typeof body.parentName === "string" ? body.parentName : "";
      const parentPath = typeof body.parentPath === "string" ? body.parentPath : "";
      if (!shareCode) return reply.code(400).send({ code: 400, message: "shareCode is required" });
      if (!parentPath) return reply.code(400).send({ code: 400, message: "parentPath is required" });

      const accounts = fastify.readAccounts();
      const account115 = accounts.find((a) => a.accountType === "115") as any;
      if (!account115) return reply.code(400).send({ code: 400, message: "未配置 115 账号" });

      const settings = fastify.readSettings();
      const userAgent = typeof settings["user-agent"] === "string" ? settings["user-agent"] : undefined;

      try {
        const candidates = await expandCandidate({
          accountInfo: account115,
          shareCode,
          receiveCode,
          parentCid,
          parentName,
          parentPath,
          userAgent,
        });
        return { code: 200, data: { candidates } };
      } catch (err) {
        const message = err instanceof Error ? err.message : "展开失败";
        return reply.code(502).send({ code: 502, message });
      }
    },
  );
}
