import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import nodePath from "node:path";
import { DATA_DIR } from "../../paths.js";

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/directory/local/list", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { basePath = "" } = request.body as { basePath?: string };

    const targetPath = basePath ? nodePath.join(DATA_DIR, basePath) : DATA_DIR;
    const normalizedTarget = nodePath.normalize(targetPath);
    if (!normalizedTarget.startsWith(nodePath.normalize(DATA_DIR))) {
      return reply.code(400).send({ code: 400, message: "Invalid path" });
    }

    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
      return { code: 200, message: "success", data: [] };
    }

    const items = fs.readdirSync(targetPath);
    const nodes: { name: string; id: string; isDir: boolean; hasChildren?: boolean }[] = [];

    for (const item of items) {
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
    return { code: 200, message: "success", data: nodes };
  });
}
