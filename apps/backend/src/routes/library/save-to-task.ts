import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getById } from "../../db/repositories/media-library.js";
import { getShareDirList, resolveLibraryEntryShareReceiveIds } from "../../services/cloud-115/share.js";
import { resolveTaskAccount115, saveSelectionToTask } from "../../services/library/save-to-task.js";
import type { SelectedItem } from "../../services/strm/share-strm.js";
import { listAccounts } from "../../db/repositories/accounts.js";
import { listTasks } from "../../db/repositories/tasks.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";

const idParamsSchema = z.object({ id: z.string().min(1) });
const bodySchema = z.object({
  taskId: z.string().trim().min(1, "taskId is required"),
  subPath: z.string().optional(),
  mode: z.enum(["sync", "async"]).optional(),
});

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/library/:id/save-to-task", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const entry = getById(id);
    if (!entry) throw new HttpError(404, "影库条目不存在");

    const body = parse(bodySchema, request.body);
    const subPath = (body.subPath ?? "").split("/").map((s) => s.trim()).filter(Boolean).join("/");
    const mode = body.mode === "async" ? "async" : "sync";

    const task = listTasks().find((t) => t.id === body.taskId);
    if (!task) throw new HttpError(400, `Task not found: ${body.taskId}`);
    const accountInfo = resolveTaskAccount115(listAccounts(), task);

    const settings = readAppSettings();
    const userAgent = typeof settings["user-agent"] === "string" ? settings["user-agent"] : undefined;

    let fileIds: Array<number | string>;
    let selectedItems: SelectedItem[];
    const trimmedSharePath = (entry.sharePath ?? "").replace(/^\/+/, "");
    const rootCid = entry.shareRootCid ?? "";
    const isShareSubtreeEntry = Boolean(trimmedSharePath) || (rootCid !== "" && rootCid !== "0");

    if (isShareSubtreeEntry) {
      const dirName = entry.rawName || entry.title;
      if (!dirName) throw new HttpError(400, "影库条目缺少目录名");
      if (rootCid && rootCid !== "0") {
        fileIds = [rootCid];
      } else {
        try {
          fileIds = await resolveLibraryEntryShareReceiveIds(
            accountInfo,
            entry.shareCode,
            entry.receiveCode,
            entry.sharePath ?? "",
            dirName,
            { userAgent },
          );
        } catch (err) {
          throw new HttpError(502, err instanceof Error ? err.message : "解析分享目录失败");
        }
      }
      selectedItems = [{ name: dirName, isDir: true }];
    } else {
      try {
        const { list } = await getShareDirList(accountInfo, entry.shareCode, entry.receiveCode, 0, { limit: 1000 });
        if (list.length === 0) throw new HttpError(400, "分享为空");
        fileIds = list.map((it) => String(it.id));
        selectedItems = list.map((it) => ({ name: it.name, isDir: it.is_dir }));
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(502, err instanceof Error ? err.message : "列分享目录失败");
      }
    }

    const result = await saveSelectionToTask({
      task,
      accountInfo,
      shareCode: entry.shareCode,
      receiveCode: entry.receiveCode,
      fileIds,
      selectedItems,
      subPath,
      mode,
      settings,
    });
    return { code: 200, data: result };
  });
}
