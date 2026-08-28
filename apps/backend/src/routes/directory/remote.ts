import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Cloud115Error, fsDirGetId, listDirEntries } from "../../services/cloud-115/client.js";
import { getAccount } from "../../db/repositories/accounts.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";

const bodySchema = z.object({ account: z.string().min(1, "account is required"), path: z.string().default("") });

/** 115 的失败要说出来：以前一律返回空列表，cookie 失效和"目录本来就是空的"在界面上长得一模一样 */
function upstreamFailure(err: unknown, fallback: string): HttpError {
  if (err instanceof Cloud115Error) return new HttpError(502, err.message, { upstreamStatus: err.status });
  return new HttpError(502, err instanceof Error && err.message ? err.message : fallback);
}

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/directory/remote/list", { preHandler: [fastify.authenticate] }, async (request) => {
    const { account, path } = parse(bodySchema, request.body);

    const accountInfo = getAccount(account);
    if (!accountInfo) throw new HttpError(404, `account not found: ${account}`);
    if (accountInfo.accountType !== "115") throw new HttpError(400, "only 115 accounts are supported");

    const userAgent = readAppSettings()["user-agent"] || undefined;

    let cid = 0;
    if (path) {
      try {
        cid = (await fsDirGetId(path, { userAgent, accountInfo })).id;
      } catch (err) {
        if (err instanceof Cloud115Error) throw upstreamFailure(err, "解析目录失败");
        throw new HttpError(404, `目录不存在: ${path}`);
      }
    }

    let entries;
    try {
      // 翻页：超过 1000 项的目录，后面的子目录以前根本列不出来
      entries = await listDirEntries(cid, { userAgent, accountInfo });
    } catch (err) {
      throw upstreamFailure(err, "列目录失败");
    }
    // 目录没有 sha；文件不进目录树
    return entries
      .filter((item) => !item.sha)
      .map((item) => ({ name: item.n, id: item.cid, isDir: true, hasChildren: true }));
  });
}
