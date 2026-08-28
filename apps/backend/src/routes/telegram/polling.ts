import type { FastifyInstance } from "fastify";
import { createTelegramBot } from "../../services/telegram.js";
import { getPollingStatus, restartPolling, startPolling, stopPolling } from "../../services/telegram-polling.js";
import { readAppSetting, updateAppSetting } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";

function configuredTelegram() {
  const telegram = readAppSetting("telegram");
  if (!telegram?.botToken) throw new HttpError(400, "Telegram not configured");
  return telegram as typeof telegram & { botToken: string };
}

/** 记住开关：轮询状态只在内存里，重启后 index.ts 据此决定要不要自动拉起来 */
function rememberPolling(enabled: boolean) {
  updateAppSetting("telegram", (current) => ({ ...(current ?? {}), pollingEnabled: enabled }));
}

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/telegram/polling", { preHandler: [fastify.authenticate] }, async () => {
    configuredTelegram();
    const started = await startPolling();
    rememberPolling(true);
    return { success: true, message: started ? "Polling started" : "Polling already running" };
  });

  fastify.delete("/api/telegram/polling", { preHandler: [fastify.authenticate] }, async () => {
    const telegram = configuredTelegram();
    stopPolling();
    rememberPolling(false);
    if (telegram.webhookUrl) {
      await createTelegramBot(telegram.botToken).setWebhook(telegram.webhookUrl);
    }
    return { success: true, message: "Polling stopped" };
  });

  fastify.get("/api/telegram/polling", { preHandler: [fastify.authenticate] }, async () => {
    const telegram = configuredTelegram();
    const pollingStatus = getPollingStatus();
    const webhookInfo = await createTelegramBot(telegram.botToken).getWebhookInfo();
    return { polling: pollingStatus.active, webhook: webhookInfo.result, message: pollingStatus.message };
  });

  // PUT：界面上的"强制清理"——停掉再起
  fastify.put("/api/telegram/polling", { preHandler: [fastify.authenticate] }, async () => {
    configuredTelegram();
    if (!(await restartPolling())) throw new HttpError(500, "Failed to restart polling");
    rememberPolling(true);
    return { success: true, message: "Polling restarted" };
  });
}
