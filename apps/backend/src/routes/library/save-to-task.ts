import type { FastifyInstance } from "fastify";
import { getById } from "../../db/repositories/media-library.js";
import {
  getShareDirList,
  resolveLibraryEntryShareReceiveIds,
} from "../../services/cloud-115/share.js";
import {
  resolveTaskAccount115,
  saveSelectionToTask,
  SaveToTaskError,
} from "../../services/library/save-to-task.js";
import type { SelectedItem } from "../../services/strm/share-strm.js";

function normalizeSubPath(input: unknown): string {
  return typeof input === "string"
    ? input.split("/").map((s) => s.trim()).filter(Boolean).join("/")
    : "";
}

export default async function (fastify: FastifyInstance) {
  fastify.post(
    "/api/library/:id/save-to-task",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const entry = getById(id);
      if (!entry) return reply.code(404).send({ code: 404, message: "影库条目不存在" });

      const body = (request.body ?? {}) as Record<string, unknown>;
      const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
      const subPath = normalizeSubPath(body.subPath);
      const mode: "sync" | "async" = body.mode === "async" ? "async" : "sync";
      if (!taskId) return reply.code(400).send({ code: 400, message: "taskId is required" });

      const task = fastify.readTasks().find((t) => t.id === taskId);
      if (!task) return reply.code(400).send({ code: 400, message: `Task not found: ${taskId}` });

      let accountInfo;
      try {
        accountInfo = resolveTaskAccount115(fastify.readAccounts(), task);
      } catch (err) {
        if (err instanceof SaveToTaskError) {
          return reply.code(err.statusCode).send({ code: err.statusCode, message: err.message });
        }
        throw err;
      }

      const settings = fastify.readSettings();
      const userAgent = typeof settings["user-agent"] === "string" ? settings["user-agent"] : undefined;

      let fileIds: Array<number | string>;
      let selectedItems: SelectedItem[];
      const trimmedSharePath = (entry.sharePath ?? "").replace(/^\/+/, "");
      const rootCid = entry.shareRootCid ?? "";
      const isShareSubtreeEntry = Boolean(trimmedSharePath) || (rootCid !== "" && rootCid !== "0");

      if (isShareSubtreeEntry) {
        const dirName = entry.rawName || entry.title;
        if (!dirName) return reply.code(400).send({ code: 400, message: "影库条目缺少目录名" });
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
            const msg = err instanceof Error ? err.message : "解析分享目录失败";
            return reply.code(502).send({ code: 502, message: msg });
          }
        }
        selectedItems = [{ name: dirName, isDir: true }];
      } else {
        try {
          const { list } = await getShareDirList(
            accountInfo,
            entry.shareCode,
            entry.receiveCode,
            0,
            { limit: 1000 },
          );
          if (list.length === 0) {
            return reply.code(400).send({ code: 400, message: "分享为空" });
          }
          fileIds = list.map((it) => String(it.id));
          selectedItems = list.map((it) => ({ name: it.name, isDir: it.is_dir }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : "列分享目录失败";
          return reply.code(502).send({ code: 502, message: msg });
        }
      }

      try {
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
          fastify,
          authHeader: request.headers.authorization ?? "",
        });
        return { code: 200, data: result };
      } catch (err) {
        if (err instanceof SaveToTaskError) {
          return reply.code(err.statusCode).send({ code: err.statusCode, message: err.message });
        }
        throw err;
      }
    },
  );
}
