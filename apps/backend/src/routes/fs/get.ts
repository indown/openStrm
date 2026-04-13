import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { get_id_to_path, getDownloadUrlWeb } from "../../services/cloud-115/client.js";

export default async function (fastify: FastifyInstance) {
  // Internal token auth for Alist-compatible endpoint
  const verifyInternalToken = async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization || "";
    const settings = fastify.readSettings();
    const internalToken = settings.internalToken || process.env.ALIST_API_TOKEN || "";
    if (!internalToken || authHeader !== internalToken) {
      reply.code(401).send({ code: 401, message: "unauthorized" });
    }
  };

  fastify.post("/api/fs/get", { preHandler: [verifyInternalToken] }, async (request, reply) => {
    const { path } = request.body as { path?: string };
    if (!path) {
      return reply.code(400).send({ code: 400, message: "path is required" });
    }

    const decodedPath = decodeURIComponent(path);
    const accounts = fastify.readAccounts();
    const accounts115 = accounts.filter((a) => a.accountType === "115");
    if (accounts115.length === 0) {
      return reply.code(404).send({ code: 404, message: "no 115 account configured" });
    }

    let account = accounts115.find((a) => decodedPath.includes(`/${a.name}/`));
    let actualPath = decodedPath;

    if (!account) {
      account = accounts115[0];
    } else {
      const pattern = `/${account.name}/`;
      const idx = decodedPath.indexOf(pattern);
      if (idx !== -1) {
        actualPath = decodedPath.substring(idx + pattern.length);
      }
    }

    const settings = fastify.readSettings();
    const userAgent = settings["user-agent"] || undefined;

    const pickcode = await get_id_to_path({ path: actualPath, userAgent, accountInfo: account });
    if (!pickcode) {
      return reply.code(404).send({ code: 404, message: "file not found" });
    }

    const rawUrl = await getDownloadUrlWeb(pickcode, { userAgent, accountInfo: account });
    if (!rawUrl) {
      return reply.code(500).send({ code: 500, message: "failed to get download url" });
    }

    const fileName = decodedPath.split("/").pop() || "";
    return { code: 200, message: "success", data: { raw_url: rawUrl, name: fileName, provider: "115" } };
  });
}
