import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getTask } from "../../db/repositories/tasks.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { driveErrorToHttp } from "../../services/drive/errors.js";
import { isSafeItemName } from "../../services/strm/share-strm.js";
import { assertSameKind, providerForTask, shareForLink } from "../../services/drive/registry.js";
import { createFollowAfterSave } from "../../services/follow/service.js";
import { scopeFromSelection } from "../../services/follow/diff.js";
import { saveSelectionToTask } from "../../services/share/receive.js";
import { normalizeSubPath } from "../../services/strm/naming.js";
import { followOptionSchema } from "../../schemas/entities.js";

const itemSchema = z.object({
  id: z.string().min(1),
  name: z.string().refine(isSafeItemName, "文件名不能为空，也不能是 . / .. 或含有 /"),
  isDir: z.boolean(),
  token: z.string().optional(),
});

/**
 * 一个接口多个动作；各动作的必填项在 switch 里再查，这里只管类型。
 * 账号由链接决定：先认出是哪家的分享，再挑同类账号（也可以用 account 指定）。
 */
const bodySchema = z.looseObject({
  action: z.enum(["parse", "info", "list", "download_url", "receive"]),
  url: z.string().trim().min(1, "url is required"),
  account: z.string().optional(),
  dirId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
  fileId: z.string().optional(),
  items: z.array(itemSchema).optional(),
  taskId: z.string().optional(),
  mode: z.enum(["sync", "async"]).optional(),
  subPath: z.string().optional(),
  /** 不经任务、直接转存到网盘某个目录：给目录 id 或路径 */
  toDirId: z.string().optional(),
  toPath: z.string().optional(),
  /** receive 到任务目录时：转存完顺手建追更订阅，盯的是 watchDirId 这一层 */
  follow: followOptionSchema.optional(),
  watchDirId: z.string().optional(),
  watchPath: z.string().optional(),
  name: z.string().optional(),
});

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/share", { preHandler: [fastify.authenticate] }, async (request) => {
    const body = parse(bodySchema, request.body);
    const { provider, ref } = shareForLink(body.url, { account: body.account });
    const share = provider.share!;
    const base = { kind: ref.kind, account: provider.account.name };

    try {
      switch (body.action) {
        case "parse":
          return { ...base, code: ref.code, password: ref.password, url: ref.url };
        case "info": {
          const session = await share.open(ref);
          return { ...base, ...(await share.info(session)) };
        }
        case "list": {
          const session = await share.open(ref);
          const page = await share.list(session, body.dirId || "0", body.cursor, { limit: body.limit });
          return { ...base, ...page };
        }
        case "download_url": {
          if (!body.fileId) throw new HttpError(400, "fileId is required");
          if (!share.downloadUrl) throw new HttpError(400, `${ref.kind} 的分享没有直链`);
          const session = await share.open(ref);
          return { url: await share.downloadUrl(session, body.fileId) };
        }
        case "receive": {
          const items = body.items ?? [];
          if (items.length === 0) throw new HttpError(400, "items is required");
          const subPath = normalizeSubPath(body.subPath);

          if (body.taskId) {
            const task = getTask(body.taskId);
            if (!task) throw new HttpError(404, `Task not found: ${body.taskId}`);
            const target = providerForTask(task, "share");
            assertSameKind(ref, target);
            const result = await saveSelectionToTask({
              task,
              provider: target,
              ref,
              items,
              subPath,
              mode: body.mode === "async" ? "async" : "sync",
              settings: readAppSettings(),
            });
            // async 模式下引擎拒绝启动时仍是 200：转存已经成功，只是没排上后台同步
            const strmGenerated = !("error" in result);
            if (!body.follow) return { strmGenerated, ...result };
            // 订阅建不成也不影响这次转存：只把原因带回去
            const extra = await createFollowAfterSave({
              shareUrl: ref.url,
              shareCode: ref.code,
              receiveCode: ref.password,
              watchCid: body.watchDirId ?? "0",
              watchPath: body.watchPath,
              scope: scopeFromSelection(items),
              taskId: task.id,
              subPath,
              intervalMinutes: body.follow.intervalMinutes,
              name: body.name,
            });
            return { strmGenerated, ...result, ...extra };
          }

          // 直接转存到网盘目录（不生成 strm）
          let toDirId = body.toDirId;
          if (!toDirId && body.toPath != null) {
            const node = await provider.resolvePath(body.toPath);
            if (!node || !node.isDir) throw new HttpError(404, `目录不存在: ${body.toPath}`);
            toDirId = node.id;
          }
          if (toDirId == null) throw new HttpError(400, "taskId, toDirId or toPath is required");
          const session = await share.open(ref);
          const received = await share.receive(session, items.map((i) => ({ id: i.id, token: i.token })), toDirId);
          return { ...base, received: items.length, topIds: received.topIds ?? [] };
        }
      }
    } catch (err) {
      throw driveErrorToHttp(err, "分享操作失败");
    }
  });
}
