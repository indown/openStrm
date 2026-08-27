import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { sqlite } from "../../db/client.js";

/**
 * 一致性备份。
 *
 * 库是 WAL 模式：直接拷 openstrm.db 会漏掉还在 WAL 里的事务，拷到一半的库打开就是坏的。
 * SQLite 的 backup API 把当前已提交的状态完整写进一个新文件，这里先落到临时目录，
 * 流式回给客户端，发完即删。
 */
export default async function (fastify: FastifyInstance) {
  fastify.get("/api/system/backup", { preHandler: [fastify.authenticate] }, async (_request, reply) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openstrm-backup-"));
    const file = path.join(dir, `openstrm-${stamp}.db`);
    await sqlite.backup(file);

    const stream = fs.createReadStream(file);
    stream.on("close", () => fs.rm(dir, { recursive: true, force: true }, () => {}));
    return reply
      .header("content-type", "application/vnd.sqlite3")
      .header("content-disposition", `attachment; filename="openstrm-${stamp}.db"`)
      .send(stream);
  });
}
