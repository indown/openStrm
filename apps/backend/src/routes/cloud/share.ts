import type { FastifyInstance } from "fastify";
import {
  shareExtractPayload,
  getShareData,
  getShareDirList,
  getShareDownloadUrl,
  receiveToMyDrive,
} from "../../services/cloud-115/share.js";
import { fsDirGetId } from "../../services/cloud-115/client.js";
import { generateStrmForSelected, type SelectedItem } from "../../services/strm/share-strm.js";

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/115/share", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = request.body as Record<string, any>;
    const { action } = body;

    const accounts = fastify.readAccounts();
    const account115 = accounts.find((a) => a.accountType === "115") as any;
    if (!account115) {
      return reply.code(400).send({ code: 400, message: "No 115 account configured" });
    }

    let shareCode: string = body.shareCode || body.share_code || "";
    let receiveCode: string = body.receiveCode || body.receive_code || "";
    if (!shareCode && typeof body.url === "string" && body.url.trim()) {
      try {
        const parsed = shareExtractPayload(body.url);
        shareCode = parsed.share_code;
        if (!receiveCode) receiveCode = parsed.receive_code;
      } catch {
        return reply.code(400).send({ code: 400, message: "Invalid share url" });
      }
    }

    switch (action) {
      case "parse": {
        const { url } = body;
        if (!url) return reply.code(400).send({ code: 400, message: "url is required" });
        const result = shareExtractPayload(url);
        return { code: 200, data: result };
      }
      case "info": {
        if (!shareCode) return reply.code(400).send({ code: 400, message: "shareCode is required" });
        const data = await getShareData(account115, shareCode, receiveCode);
        return { code: 200, data };
      }
      case "list": {
        const cid = body.cid || 0;
        const limit = body.limit || 32;
        const offset = body.offset || 0;
        if (!shareCode) return reply.code(400).send({ code: 400, message: "shareCode is required" });
        const { list, count } = await getShareDirList(account115, shareCode, receiveCode, cid, { limit, offset });
        return { code: 200, data: { list, count, limit, offset } };
      }
      case "download_url": {
        const fileId = body.fileId;
        if (!shareCode || !fileId) return reply.code(400).send({ code: 400, message: "shareCode and fileId are required" });
        const url = await getShareDownloadUrl(account115, shareCode, receiveCode, fileId);
        return { code: 200, data: { url } };
      }
      case "receive": {
        const fileIds = body.fileIds;
        const taskId: string | undefined = body.taskId;
        const mode: "sync" | "async" = body.mode === "async" ? "async" : "sync";
        const selectedItems: SelectedItem[] = Array.isArray(body.selectedItems) ? body.selectedItems : [];
        const subPath: string = typeof body.subPath === "string"
          ? body.subPath.split("/").map((s: string) => s.trim()).filter(Boolean).join("/")
          : "";
        if (!shareCode || !fileIds) return reply.code(400).send({ code: 400, message: "shareCode and fileIds are required" });

        if (taskId) {
          const task = fastify.readTasks().find((t) => t.id === taskId);
          if (!task) return reply.code(400).send({ code: 400, message: `Task not found: ${taskId}` });
          if (!task.targetPath || !task.strmPrefix) {
            return reply.code(400).send({ code: 400, message: "Selected task is missing targetPath or strmPrefix" });
          }
          const fullOriginPath = subPath ? `${task.originPath}/${subPath}` : task.originPath;
          const idRes = (await fsDirGetId(fullOriginPath, { accountInfo: account115 })) as { id?: number | string };
          if (idRes?.id == null) {
            return reply.code(400).send({ code: 400, message: `Cannot resolve save destination on 115: ${fullOriginPath}` });
          }
          await receiveToMyDrive(account115, shareCode, receiveCode, fileIds, idRes.id);

          if (mode === "sync") {
            if (selectedItems.length === 0) {
              return reply.code(400).send({ code: 400, message: "selectedItems is required for sync mode" });
            }
            const settings = fastify.readSettings();
            const { generatedCount, skippedCount } = await generateStrmForSelected({
              task, selectedItems, accountInfo: account115, settings, subPath,
            });
            return { code: 200, data: { strmGenerated: true, mode: "sync", generatedCount, skippedCount } };
          }

          const injectRes = await fastify.inject({
            method: "POST",
            url: "/api/startTask",
            payload: { id: task.id },
            headers: { authorization: request.headers.authorization ?? "" },
          });
          const injectBody = injectRes.json() as { taskId?: string; message?: string };
          if (injectRes.statusCode !== 200) {
            return reply.code(200).send({ code: 200, data: { strmGenerated: false, mode: "async", error: injectBody } });
          }
          return { code: 200, data: { strmGenerated: true, mode: "async", taskId: injectBody.taskId, message: injectBody.message } };
        }

        const toPid = body.toPid ?? 0;
        const result = await receiveToMyDrive(account115, shareCode, receiveCode, fileIds, toPid);
        return { code: 200, data: result };
      }
      default:
        return reply.code(400).send({ code: 400, message: `Unknown action: ${action}` });
    }
  });
}
