import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Account115 } from "@openstrm/shared";
import {
  shareExtractPayload,
  getShareData,
  getShareDirList,
  getShareDownloadUrl,
  receiveToMyDrive,
} from "../../services/cloud-115/share.js";
import { resolveTaskAccount115, saveSelectionToTask } from "../../services/library/save-to-task.js";
import { listAccounts } from "../../db/repositories/accounts.js";
import { getTask } from "../../db/repositories/tasks.js";
import { normalizeSubPath } from "../../services/strm/naming.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { cidSchema } from "../../schemas/entities.js";

const idSchema = z.union([z.string(), z.number()]);

/** 一个接口多个动作；各动作的必填项在 switch 里再查，这里只管类型 */
const bodySchema = z.looseObject({
  action: z.enum(["parse", "info", "list", "download_url", "receive"]),
  url: z.string().optional(),
  shareCode: z.string().optional(),
  share_code: z.string().optional(),
  receiveCode: z.string().optional(),
  receive_code: z.string().optional(),
  cid: cidSchema.optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().min(0).optional(),
  fileId: idSchema.optional(),
  fileIds: z.union([z.array(idSchema), idSchema]).optional(),
  taskId: z.string().optional(),
  mode: z.enum(["sync", "async"]).optional(),
  selectedItems: z.array(z.object({ name: z.string(), isDir: z.boolean() })).optional(),
  subPath: z.string().optional(),
  toPid: cidSchema.optional(),
});

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/115/share", { preHandler: [fastify.authenticate] }, async (request) => {
    const body = parse(bodySchema, request.body);
    const { action } = body;

    const accounts = listAccounts();
    const account115 = accounts.find((a): a is Account115 => a.accountType === "115");
    if (!account115) throw new HttpError(400, "No 115 account configured");

    let shareCode = body.shareCode || body.share_code || "";
    let receiveCode = body.receiveCode || body.receive_code || "";
    if (!shareCode && body.url?.trim()) {
      try {
        const parsed = shareExtractPayload(body.url);
        shareCode = parsed.share_code;
        if (!receiveCode) receiveCode = parsed.receive_code;
      } catch {
        throw new HttpError(400, "Invalid share url");
      }
    }

    switch (action) {
      case "parse": {
        if (!body.url) throw new HttpError(400, "url is required");
        return shareExtractPayload(body.url);
      }
      case "info": {
        if (!shareCode) throw new HttpError(400, "shareCode is required");
        return getShareData(account115, shareCode, receiveCode);
      }
      case "list": {
        const cid = body.cid || 0;
        const limit = body.limit || 32;
        const offset = body.offset || 0;
        if (!shareCode) throw new HttpError(400, "shareCode is required");
        const { list, count } = await getShareDirList(account115, shareCode, receiveCode, cid, { limit, offset });
        return { list, count, limit, offset };
      }
      case "download_url": {
        if (!shareCode || !body.fileId) throw new HttpError(400, "shareCode and fileId are required");
        const url = await getShareDownloadUrl(account115, shareCode, receiveCode, body.fileId);
        return { url };
      }
      case "receive": {
        const fileIds = body.fileIds;
        const mode = body.mode === "async" ? "async" : "sync";
        const selectedItems = body.selectedItems ?? [];
        const subPath = normalizeSubPath(body.subPath);
        if (!shareCode || !fileIds) throw new HttpError(400, "shareCode and fileIds are required");

        if (body.taskId) {
          const task = getTask(body.taskId);
          if (!task) throw new HttpError(404, `Task not found: ${body.taskId}`);
          const taskAccount = resolveTaskAccount115(accounts, task);
          const result = await saveSelectionToTask({
            task,
            accountInfo: taskAccount,
            shareCode,
            receiveCode,
            fileIds: Array.isArray(fileIds) ? fileIds : [fileIds],
            selectedItems,
            subPath,
            mode,
            settings: readAppSettings(),
          });
          // async 模式下引擎拒绝启动时仍是 200：转存已经成功，只是没排上后台同步
          return { strmGenerated: !("error" in result), ...result };
        }

        return receiveToMyDrive(account115, shareCode, receiveCode, fileIds, body.toPid ?? 0);
      }
    }
  });
}
