import type { FastifyInstance } from "fastify";
import { createTelegramBot } from "../../services/telegram.js";
import { stopPolling, getPollingStatus, forceCleanup, safeStartPolling } from "../../services/telegram-polling.js";

export default async function (fastify: FastifyInstance) {
  // POST: start polling
  fastify.post("/api/telegram/polling", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const settings = fastify.readSettings();
    const telegram = settings.telegram;
    if (!telegram?.botToken) {
      return reply.code(400).send({ error: "Telegram not configured" });
    }

    const bot = createTelegramBot(telegram.botToken);
    try { await bot.deleteWebhook(); } catch { /* ignore */ }

    await safeStartPolling();
    return { success: true, message: "Polling started successfully" };
  });

  // DELETE: stop polling
  fastify.delete("/api/telegram/polling", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const settings = fastify.readSettings();
    const telegram = settings.telegram;
    if (!telegram?.botToken) {
      return reply.code(400).send({ error: "Telegram not configured" });
    }

    stopPolling();

    if (telegram.webhookUrl) {
      const bot = createTelegramBot(telegram.botToken);
      await bot.setWebhook(telegram.webhookUrl);
    }

    return { success: true, message: "Polling stopped successfully" };
  });

  // GET: polling status
  fastify.get("/api/telegram/polling", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const settings = fastify.readSettings();
    const telegram = settings.telegram;
    if (!telegram?.botToken) {
      return reply.code(400).send({ error: "Telegram not configured" });
    }

    const pollingStatus = getPollingStatus();
    const bot = createTelegramBot(telegram.botToken);
    const webhookInfo = await bot.getWebhookInfo();

    return { polling: pollingStatus.active, webhook: (webhookInfo as any).result, message: pollingStatus.message };
  });

  // PUT: force cleanup
  fastify.put("/api/telegram/polling", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const success = await forceCleanup();
    if (success) {
      return { success: true, message: "Force cleanup completed" };
    }
    return reply.code(500).send({ error: "Failed to perform force cleanup" });
  });
}
