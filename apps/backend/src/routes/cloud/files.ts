import type { FastifyInstance } from "fastify";
import { fs_files } from "../../services/cloud-115/client.js";

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/115/files", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { account, cid = 0 } = request.body as { account?: string; cid?: number };

    const accounts = fastify.readAccounts();
    const accountName = account ?? accounts.find((a) => a.accountType === "115")?.name;
    if (!accountName) {
      return reply.code(400).send({ code: 400, message: "account is required and at least one 115 account must exist" });
    }

    const accountInfo = accounts.find((a) => a.name === accountName);
    if (!accountInfo || accountInfo.accountType !== "115") {
      return reply.code(404).send({ code: 404, message: "115 account not found" });
    }
    if (!(accountInfo as any).cookie) {
      return reply.code(400).send({ code: 400, message: "115 account cookie is required" });
    }

    const data = await fs_files(cid, { accountInfo });
    return { code: 200, data: (data as any).data };
  });
}
