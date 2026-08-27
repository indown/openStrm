import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fsDirGetId, fsFiles } from "../../services/cloud-115/client.js";
import { listAccounts } from "../../db/repositories/accounts.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";

const bodySchema = z.object({ account: z.string().min(1, "account is required"), path: z.string().default("") });

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/directory/remote/list", { preHandler: [fastify.authenticate] }, async (request) => {
    const { account, path } = parse(bodySchema, request.body);

    const accountInfo = listAccounts().find((a) => a.name === account);
    if (!accountInfo || accountInfo.accountType !== "115") {
      throw new HttpError(400, "only 115 accounts are supported");
    }

    const userAgent = readAppSettings()["user-agent"] || undefined;

    let cid = 0;
    if (path) {
      try {
        const dirResp = await fsDirGetId(path, { userAgent, accountInfo });
        cid = dirResp.id;
      } catch {
        return [];
      }
    }

    try {
      const filesResponse = await fsFiles(cid, { userAgent, accountInfo, limit: 1000, offset: 0 });
      // 目录没有 sha；文件不进目录树
      return (filesResponse.data || [])
        .filter((item) => !item.sha)
        .map((item) => ({ name: item.n, id: item.cid, isDir: true, hasChildren: true }));
    } catch {
      return [];
    }
  });
}
