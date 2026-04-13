import type { FastifyInstance } from "fastify";
import { fs_dir_getid, fs_files } from "../../services/cloud-115/client.js";

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/directory/remote/list", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { account, path = "" } = request.body as { account: string; path?: string };

    if (!account) {
      return reply.code(400).send({ code: 400, message: "account is required" });
    }

    const accounts = fastify.readAccounts();
    const accountInfo = accounts.find((a) => a.name === account);
    if (!accountInfo || accountInfo.accountType !== "115") {
      return reply.code(400).send({ code: 400, message: "only 115 accounts are supported" });
    }

    const settings = fastify.readSettings();
    const userAgent = settings["user-agent"] || undefined;

    let cid = 0;
    if (path) {
      try {
        const dirResp = await fs_dir_getid(path, { userAgent, accountInfo });
        cid = (dirResp as any).id;
      } catch {
        return { code: 200, message: "success", data: [] };
      }
    }

    try {
      const filesResponse = await fs_files(cid, { userAgent, accountInfo, limit: 1000, offset: 0 });
      const items: any[] = (filesResponse as any).data || [];
      const nodes = items
        .filter((item) => !item.sha || item.sha === "" || item.sha === null)
        .map((item) => ({ name: item.n, id: item.cid, isDir: true, hasChildren: true }));
      return { code: 200, message: "success", data: nodes };
    } catch {
      return { code: 200, message: "success", data: [] };
    }
  });
}
