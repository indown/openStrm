import type { FastifyInstance } from "fastify";
import type { Dirent } from "node:fs";
import fsp from "node:fs/promises";
import nodePath from "node:path";
import { z } from "zod";
import { resolveInDataDir } from "../../paths.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { mapLimit } from "../../lib/async.js";
import { isDirectoryEntry } from "../../lib/fs.js";

const bodySchema = z.object({ basePath: z.string().default("") });

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/directory/local/list", { preHandler: [fastify.authenticate] }, async (request) => {
    const { basePath } = parse(bodySchema, request.body);

    const targetPath = resolveInDataDir(basePath);
    if (!targetPath) throw new HttpError(400, "Invalid path");

    let entries: Dirent[];
    try {
      entries = await fsp.readdir(targetPath, { withFileTypes: true });
    } catch {
      return []; // 不存在，或者不是目录
    }

    // 以前每个子项 statSync、每个孙项再 statSync：大目录下一次点开要在事件循环上做几千次系统调用
    const nodes = (
      await mapLimit(entries, 16, async (entry) => {
        const itemPath = nodePath.join(targetPath, entry.name);
        if (!(await isDirectoryEntry(targetPath, entry))) return null;
        let hasChildren = false;
        try {
          const subs = await fsp.readdir(itemPath, { withFileTypes: true });
          for (const sub of subs) {
            if (await isDirectoryEntry(itemPath, sub)) {
              hasChildren = true;
              break;
            }
          }
        } catch {
          /* 读不了就当没有子目录 */
        }
        return { name: entry.name, id: basePath ? `${basePath}/${entry.name}` : entry.name, isDir: true, hasChildren };
      })
    ).filter((n): n is NonNullable<typeof n> => n !== null);

    nodes.sort((a, b) => a.name.localeCompare(b.name));
    return nodes;
  });
}
