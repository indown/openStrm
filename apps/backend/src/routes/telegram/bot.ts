import type { FastifyInstance } from "fastify";
import { createTelegramBot } from "../../services/telegram.js";

export default async function (fastify: FastifyInstance) {
  // GET: bot info
  fastify.get("/api/telegram/bot", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const settings = fastify.readSettings();
    const telegram = settings.telegram;
    if (!telegram?.botToken) {
      return reply.code(400).send({ error: "Telegram not configured" });
    }

    const bot = createTelegramBot(telegram.botToken);
    const botInfo = await bot.getMe();
    const webhookInfo = await bot.getWebhookInfo();

    return { bot: botInfo, webhook: webhookInfo, configured: true, chatId: telegram.chatId || "", botToken: telegram.botToken || "" };
  });

  // POST: configure bot
  fastify.post("/api/telegram/bot", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { botToken, chatId, webhookUrl } = request.body as { botToken?: string; chatId?: string; webhookUrl?: string };
    if (!botToken) {
      return reply.code(400).send({ error: "Bot token is required" });
    }

    const tokenPattern = /^\d+:[A-Za-z0-9_-]{35}$/;
    if (!tokenPattern.test(botToken)) {
      return reply.code(400).send({ error: "Invalid bot token format" });
    }

    const bot = createTelegramBot(botToken);
    const botInfo = await bot.getMe();
    if (!(botInfo as any).ok) {
      return reply.code(400).send({ error: "Invalid bot token", details: (botInfo as any).description });
    }

    const settings = fastify.readSettings();
    settings.telegram = {
      botToken,
      chatId: chatId || settings.telegram?.chatId,
      webhookUrl: webhookUrl || settings.telegram?.webhookUrl,
      allowedUsers: settings.telegram?.allowedUsers,
    };
    fastify.writeSettings(settings);

    if (webhookUrl) {
      try { await bot.setWebhook(webhookUrl); } catch { /* ignore */ }
    }

    return { success: true, bot: botInfo, chatId: chatId || "", message: "Telegram bot configured successfully" };
  });

  // DELETE: remove bot config
  fastify.delete("/api/telegram/bot", { preHandler: [fastify.authenticate] }, async () => {
    const settings = fastify.readSettings();
    if (settings.telegram?.botToken) {
      try {
        const bot = createTelegramBot(settings.telegram.botToken);
        await bot.deleteWebhook();
      } catch { /* ignore */ }
    }
    delete settings.telegram;
    fastify.writeSettings(settings);
    return { success: true, message: "Telegram bot configuration removed" };
  });
}
