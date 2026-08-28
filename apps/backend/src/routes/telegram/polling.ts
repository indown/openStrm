import type { FastifyInstance } from "fastify";
import { getPollingStatus, restartPolling, startPolling, stopPolling } from "../../services/telegram/polling.js";
import { readAppSetting, updateAppSetting } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";

function requireToken() {
  if (!readAppSetting("telegram")?.botToken) throw new HttpError(400, "还没有配置 bot token");
}

/** 记住开关：轮询状态只在内存里，重启后 index.ts 据此决定要不要自动拉起来 */
function rememberPolling(enabled: boolean) {
  updateAppSetting("telegram", (current) => ({ ...(current ?? {}), pollingEnabled: enabled }));
}

export default async function (fastify: FastifyInstance) {
  fastify.get("/api/telegram/polling", { preHandler: [fastify.authenticate] }, async () => {
    const status = getPollingStatus();
    return { polling: status.active, message: status.message };
  });

  fastify.post("/api/telegram/polling", { preHandler: [fastify.authenticate] }, async () => {
    requireToken();
    const started = await startPolling();
    rememberPolling(true);
    return { success: true, message: started ? "轮询已启动" : "轮询已在运行" };
  });

  fastify.delete("/api/telegram/polling", { preHandler: [fastify.authenticate] }, async () => {
    stopPolling();
    rememberPolling(false);
    return { success: true, message: "轮询已停止" };
  });

  // PUT：界面上的"重启"——停掉再起
  fastify.put("/api/telegram/polling", { preHandler: [fastify.authenticate] }, async () => {
    requireToken();
    if (!(await restartPolling())) throw new HttpError(500, "轮询重启失败");
    rememberPolling(true);
    return { success: true, message: "轮询已重启" };
  });
}
