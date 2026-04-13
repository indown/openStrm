import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import nodePath from "node:path";

const DATA_DIR = process.env.DATA_DIR || nodePath.resolve(process.cwd(), "../../data");

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/clearDirectory", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { targetPath } = request.body as { targetPath?: string };
    if (!targetPath) {
      return reply.code(400).send({ error: "目标路径不能为空" });
    }

    const localPath = nodePath.join(DATA_DIR, targetPath);
    if (!fs.existsSync(localPath)) {
      return reply.code(404).send({ error: "目录不存在" });
    }
    if (!fs.statSync(localPath).isDirectory()) {
      return reply.code(400).send({ error: "路径不是目录" });
    }

    const clearDir = (dirPath: string) => {
      for (const file of fs.readdirSync(dirPath)) {
        const filePath = nodePath.join(dirPath, file);
        if (fs.statSync(filePath).isDirectory()) {
          clearDir(filePath);
          fs.rmdirSync(filePath);
        } else {
          fs.unlinkSync(filePath);
        }
      }
    };

    clearDir(localPath);
    return { message: "目录清空成功", clearedPath: targetPath };
  });
}
