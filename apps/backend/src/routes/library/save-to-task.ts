import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getById } from "../../db/repositories/media-library.js";
import { getTask } from "../../db/repositories/tasks.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { driveErrorToHttp } from "../../services/drive/errors.js";
import { assertSameKind, parseShareRef, providerForTask } from "../../services/drive/registry.js";
import { listWholeShareDir } from "../../services/drive/share-walk.js";
import type { ShareRef } from "../../services/drive/types.js";
import { createFollowAfterSave } from "../../services/follow/service.js";
import { saveSelectionToTask, type SaveItem } from "../../services/share/receive.js";
import { normalizeSubPath } from "../../services/strm/naming.js";
import { followOptionSchema, idParamsSchema } from "../../schemas/entities.js";

const bodySchema = z.object({
  taskId: z.string().trim().min(1, "taskId is required"),
  subPath: z.string().optional(),
  mode: z.enum(["sync", "async"]).optional(),
  /** 转存完顺手建追更订阅：盯这条影库条目对应的分享目录 */
  follow: followOptionSchema.optional(),
  organize: z.boolean().optional(),
});

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/library/:id/save-to-task", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const entry = getById(id);
    if (!entry) throw new HttpError(404, "影库条目不存在");

    const body = parse(bodySchema, request.body);
    const subPath = normalizeSubPath(body.subPath);
    const mode = body.mode === "async" ? "async" : "sync";

    const task = getTask(body.taskId);
    if (!task) throw new HttpError(404, `Task not found: ${body.taskId}`);
    const provider = providerForTask(task, "share");
    const share = provider.share!;
    // 条目存的是分享码和提取码；网盘类型从链接认，认不出就按任务账号的类型来（老数据都是 115）
    const parsed = parseShareRef(entry.shareUrl);
    const ref: ShareRef = {
      kind: parsed?.kind ?? provider.kind,
      code: entry.shareCode,
      password: entry.receiveCode,
      url: entry.shareUrl || parsed?.url || "",
    };
    assertSameKind(ref, provider);

    const trimmedSharePath = (entry.sharePath ?? "").replace(/^\/+/, "");
    const rootCid = entry.shareRootCid ?? "";
    const isShareSubtreeEntry = Boolean(trimmedSharePath) || (rootCid !== "" && rootCid !== "0");

    let items: SaveItem[];
    try {
      const session = await share.open(ref);
      if (isShareSubtreeEntry) {
        const dirName = entry.rawName || entry.title;
        if (!dirName) throw new HttpError(400, "影库条目缺少目录名");
        // 115 转存只要 id，存过的 id 直接用；夸克还要每个条目的 token，必须按路径重新找一遍
        if (rootCid && rootCid !== "0" && provider.kind === "115") {
          items = [{ id: rootCid, name: dirName, isDir: true }];
        } else {
          const hit = await share.resolvePath(session, trimmedSharePath || dirName);
          if (!hit) throw new HttpError(400, `在分享里没找到「${trimmedSharePath || dirName}」，请检查提取码或分享是否仍有效`);
          items = [{ id: hit.id, name: dirName, isDir: hit.isDir, token: hit.token }];
        }
      } else {
        const list = await listWholeShareDir(share, session, "0");
        if (list.length === 0) throw new HttpError(400, "分享为空");
        items = list.map((it) => ({ id: it.id, name: it.name, isDir: it.isDir, token: it.token }));
      }
    } catch (err) {
      throw driveErrorToHttp(err, "列分享目录失败");
    }

    const result = await saveSelectionToTask({ task, provider, ref, items, subPath, mode, settings: readAppSettings(), organize: body.organize });
    if (!body.follow) return result;
    // 子目录条目转存的是目录本身，落在 subPath/目录名 下，追更就盯那个目录、落到同一处；
    // 整个分享的条目盯分享根目录
    const dirName = isShareSubtreeEntry ? items[0].name : "";
    const extra = await createFollowAfterSave({
      shareUrl: ref.url,
      shareCode: entry.shareCode,
      receiveCode: entry.receiveCode,
      watchCid: isShareSubtreeEntry ? items[0].id : "0",
      watchPath: trimmedSharePath || dirName,
      scope: [""],
      taskId: task.id,
      subPath: dirName ? `${subPath}/${dirName}` : subPath,
      intervalMinutes: body.follow.intervalMinutes,
      name: entry.title || entry.rawName,
      libraryId: entry.id,
    });
    return { ...result, ...extra };
  });
}
