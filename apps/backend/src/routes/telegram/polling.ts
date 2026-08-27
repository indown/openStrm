import type { FastifyInstance } from "fastify";
import { createTelegramBot } from "../../services/telegram.js";
import { stopPolling, getPollingStatus, forceCleanup, safeStartPolling } from "../../services/telegram-polling.js";
import { readAppSetting } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";

function configuredTelegram() {
  const telegram = readAppSetting("telegram");
  if (!telegram?.botToken) throw new HttpError(400, "Telegram not configured");
  return telegram as typeof telegram & { botToken: string };
}

export default async function (fastify: FastifyInstance) {
  // POST: start polling
  fastify.post("/api/telegram/polling", { preHandler: [fastify.authenticate] }, async () => {
    const telegram = configuredTelegram();
    const bot = createTelegramBot(telegram.botToken);
    try { await bot.deleteWebhook(); } catch { /* ignore */ }

    await safeStartPolling();
    return { success: true, message: "Polling started successfully" };
  });

  // DELETE: stop polling
  fastify.delete("/api/telegram/polling", { preHandler: [fastify.authenticate] }, async () => {
    const telegram = configuredTelegram();
    stopPolling();
    if (telegram.webhookUrl) {
      await createTelegramBot(telegram.botToken).setWebhook(telegram.webhookUrl);
    }
    return { success: true, message: "Polling stopped successfully" };
  });

  // GET: polling status
  fastify.get("/api/telegram/polling", { preHandler: [fastify.authenticate] }, async () => {
    const telegram = configuredTelegram();
    const pollingStatus = getPollingStatus();
    const webhookInfo = await createTelegramBot(telegram.botToken).getWebhookInfo();
    return { polling: pollingStatus.active, webhook: webhookInfo.result, message: pollingStatus.message };
  });

  // PUT: force cleanup
  fastify.put("/api/telegram/polling", { preHandler: [fastify.authenticate] }, async () => {
    if (!(await forceCleanup())) throw new HttpError(500, "Failed to perform force cleanup");
    return { success: true, message: "Force cleanup completed" };
  });
}
