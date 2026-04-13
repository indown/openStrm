import type { FastifyInstance } from "fastify";
import {
  shareExtractPayload,
  getShareData,
  getShareDirList,
  getShareDownloadUrl,
  receiveToMyDrive,
} from "../../services/cloud-115/share.js";

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/115/share", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = request.body as Record<string, any>;
    const { action } = body;

    const accounts = fastify.readAccounts();
    const account115 = accounts.find((a) => a.accountType === "115") as any;
    if (!account115) {
      return reply.code(400).send({ code: 400, message: "No 115 account configured" });
    }

    switch (action) {
      case "parse": {
        const { url } = body;
        if (!url) return reply.code(400).send({ code: 400, message: "url is required" });
        const result = shareExtractPayload(url);
        return { code: 200, data: result };
      }
      case "info": {
        const shareCode = body.shareCode || body.share_code;
        const receiveCode = body.receiveCode || body.receive_code || "";
        if (!shareCode) return reply.code(400).send({ code: 400, message: "shareCode is required" });
        const data = await getShareData(account115, shareCode, receiveCode);
        return { code: 200, data };
      }
      case "list": {
        const shareCode = body.shareCode || body.share_code;
        const receiveCode = body.receiveCode || body.receive_code || "";
        const cid = body.cid || 0;
        const limit = body.limit || 32;
        const offset = body.offset || 0;
        if (!shareCode) return reply.code(400).send({ code: 400, message: "shareCode is required" });
        const list = await getShareDirList(account115, shareCode, receiveCode, cid, { limit, offset });
        return { code: 200, data: list };
      }
      case "download_url": {
        const shareCode = body.shareCode || body.share_code;
        const receiveCode = body.receiveCode || body.receive_code || "";
        const fileId = body.fileId;
        if (!shareCode || !fileId) return reply.code(400).send({ code: 400, message: "shareCode and fileId are required" });
        const url = await getShareDownloadUrl(account115, shareCode, receiveCode, fileId);
        return { code: 200, data: { url } };
      }
      case "receive": {
        const shareCode = body.shareCode || body.share_code;
        const receiveCode = body.receiveCode || body.receive_code || "";
        const fileIds = body.fileIds;
        const toPid = body.toPid || 0;
        if (!shareCode || !fileIds) return reply.code(400).send({ code: 400, message: "shareCode and fileIds are required" });
        const result = await receiveToMyDrive(account115, shareCode, receiveCode, fileIds, toPid);
        return { code: 200, data: result };
      }
      default:
        return reply.code(400).send({ code: 400, message: `Unknown action: ${action}` });
    }
  });
}
