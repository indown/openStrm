import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import nodePath from "node:path";
import { z } from "zod";
import { resolveInDataDir } from "../../paths.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";

const bodySchema = z.object({ basePath: z.string().default("") });

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/directory/local/list", { preHandler: [fastify.authenticate] }, async (request) => {
    const { basePath } = parse(bodySchema, request.body);

    const targetPath = resolveInDataDir(basePath);
    if (!targetPath) throw new HttpError(400, "Invalid path");

    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
      return [];
    }

    const nodes: { name: string; id: string; isDir: boolean; hasChildren?: boolean }[] = [];
    for (const item of fs.readdirSync(targetPath)) {
      const itemPath = nodePath.join(targetPath, item);
      try {
        if (!fs.statSync(itemPath).isDirectory()) continue;
        let hasChildren = false;
        try {
          hasChildren = fs.readdirSync(itemPath).some((sub) => {
            try { return fs.statSync(nodePath.join(itemPath, sub)).isDirectory(); } catch { return false; }
          });
        } catch { /* ignore */ }
        nodes.push({ name: item, id: basePath ? `${basePath}/${item}` : item, isDir: true, hasChildren });
      } catch { /* ignore */ }
    }

    nodes.sort((a, b) => a.name.localeCompare(b.name));
    return nodes;
  });
}
