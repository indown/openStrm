import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { z } from "zod";
import { resolveInDataDir } from "../../paths.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";

const bodySchema = z.object({ targetPath: z.string().min(1, "目标路径不能为空") });

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/clearDirectory", { preHandler: [fastify.authenticate] }, async (request) => {
    const { targetPath } = parse(bodySchema, request.body);

    const localPath = resolveInDataDir(targetPath);
    if (!localPath) throw new HttpError(400, "目标路径越出了数据目录");
    if (localPath === resolveInDataDir("")) throw new HttpError(400, "不能清空整个数据目录");
    if (!fs.existsSync(localPath)) throw new HttpError(404, "目录不存在");
    if (!fs.statSync(localPath).isDirectory()) throw new HttpError(400, "路径不是目录");

    // 只清内容，目录本身留着：任务的 targetPath 还指着它
    for (const entry of fs.readdirSync(localPath, { withFileTypes: true })) {
      fs.rmSync(`${localPath}/${entry.name}`, { recursive: true, force: true });
    }
    return { message: "目录清空成功", clearedPath: targetPath };
  });
}
