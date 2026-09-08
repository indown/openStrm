import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAccount } from "../../db/repositories/accounts.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { driveErrorToHttp } from "../../services/drive/errors.js";
import { providerFor } from "../../services/drive/registry.js";

const bodySchema = z.object({ account: z.string().min(1, "account is required"), path: z.string().default("") });

/**
 * 新建任务时浏览远程目录：按账号类型分派给对应的 Provider，前端按名字逐层拼路径来导航，id 只当 key。
 * 网盘那边的失败要说出来：以前一律返回空列表，cookie 失效和"目录本来就是空的"在界面上长得一模一样
 */
export default async function (fastify: FastifyInstance) {
  fastify.post("/api/directory/remote/list", { preHandler: [fastify.authenticate] }, async (request) => {
    const { account, path } = parse(bodySchema, request.body);

    const accountInfo = getAccount(account);
    if (!accountInfo) throw new HttpError(404, `account not found: ${account}`);
    const provider = providerFor(accountInfo);

    try {
      let dirId = provider.rootId;
      if (path.trim()) {
        const node = await provider.resolvePath(path);
        if (!node) throw new HttpError(404, `目录不存在: ${path}`);
        if (!node.isDir) throw new HttpError(400, `不是目录: ${path}`);
        dirId = node.id;
      }
      // 文件不进目录树
      return (await provider.listDir(dirId))
        .filter((e) => e.isDir)
        .map((e) => ({ name: e.name, id: e.id, isDir: true, hasChildren: true }));
    } catch (err) {
      throw driveErrorToHttp(err, "列目录失败");
    }
  });
}
