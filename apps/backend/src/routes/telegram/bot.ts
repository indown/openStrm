import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createTelegramBot } from "../../services/telegram.js";
import { deleteAppSetting, readAppSetting, writeAppSetting } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";

const configureSchema = z.object({
  botToken: z.string({ error: "Bot token is required" }).regex(/^\d+:[A-Za-z0-9_-]{35}$/, "Invalid bot token format"),
  chatId: z.string().optional(),
  webhookUrl: z.string().optional(),
});

export default async function (fastify: FastifyInstance) {
  // GET: bot info
  fastify.get("/api/telegram/bot", { preHandler: [fastify.authenticate] }, async () => {
    const telegram = readAppSetting("telegram");
    if (!telegram?.botToken) throw new HttpError(400, "Telegram not configured");

    const bot = createTelegramBot(telegram.botToken);
    const botInfo = await bot.getMe();
    const webhookInfo = await bot.getWebhookInfo();

    return { bot: botInfo, webhook: webhookInfo, configured: true, chatId: telegram.chatId || "", botToken: telegram.botToken || "" };
  });

  // POST: configure bot
  fastify.post("/api/telegram/bot", { preHandler: [fastify.authenticate] }, async (request) => {
    const { botToken, chatId, webhookUrl } = parse(configureSchema, request.body);

    const bot = createTelegramBot(botToken);
    const botInfo = await bot.getMe();
    if (!(botInfo as any).ok) {
      throw new HttpError(400, "Invalid bot token", { details: (botInfo as any).description });
    }

    // 只覆盖这次给出的字段：allowedUsers / allowTaskStart 由别的接口维护，不能被这里重置
    const current = readAppSetting("telegram") ?? {};
    writeAppSetting("telegram", {
      ...current,
      botToken,
      chatId: chatId || current.chatId,
      webhookUrl: webhookUrl || current.webhookUrl,
    });

    if (webhookUrl) {
      try { await bot.setWebhook(webhookUrl); } catch { /* ignore */ }
    }

    return { success: true, bot: botInfo, chatId: chatId || "", message: "Telegram bot configured successfully" };
  });

  // DELETE: remove bot config
  fastify.delete("/api/telegram/bot", { preHandler: [fastify.authenticate] }, async () => {
    const current = readAppSetting("telegram");
    if (current?.botToken) {
      try {
        await createTelegramBot(current.botToken).deleteWebhook();
      } catch { /* ignore */ }
    }
    deleteAppSetting("telegram");
    return { success: true, message: "Telegram bot configuration removed" };
  });
}
