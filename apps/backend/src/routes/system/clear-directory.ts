import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { resolveInDataDir } from "../../paths.js";

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/clearDirectory", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { targetPath } = (request.body ?? {}) as { targetPath?: string };
    if (!targetPath) return reply.code(400).send({ error: "目标路径不能为空" });

    const localPath = resolveInDataDir(targetPath);
    if (!localPath) return reply.code(400).send({ error: "目标路径越出了数据目录" });
    if (localPath === resolveInDataDir("")) return reply.code(400).send({ error: "不能清空整个数据目录" });
    if (!fs.existsSync(localPath)) return reply.code(404).send({ error: "目录不存在" });
    if (!fs.statSync(localPath).isDirectory()) return reply.code(400).send({ error: "路径不是目录" });

    // 只清内容，目录本身留着：任务的 targetPath 还指着它
    for (const entry of fs.readdirSync(localPath, { withFileTypes: true })) {
      fs.rmSync(`${localPath}/${entry.name}`, { recursive: true, force: true });
    }
    return { message: "目录清空成功", clearedPath: targetPath };
  });
}
