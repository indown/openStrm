import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createTelegramBot } from "../../services/telegram.js";
import { deleteAppSetting, readAppSetting, updateAppSetting } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { maskSecret, resolveSecret } from "../../lib/secrets.js";

const TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{35}$/;

const configureSchema = z.object({
  botToken: z.string({ error: "Bot token is required" }).min(1, "Bot token is required"),
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

    return { bot: botInfo, webhook: webhookInfo, configured: true, chatId: telegram.chatId || "", botToken: maskSecret(telegram.botToken) };
  });

  // POST: configure bot
  fastify.post("/api/telegram/bot", { preHandler: [fastify.authenticate] }, async (request) => {
    const { botToken: submitted, chatId, webhookUrl } = parse(configureSchema, request.body);
    // 表单回填的是掩码，原样提交等于沿用已保存的 token
    const current = readAppSetting("telegram") ?? {};
    const botToken = resolveSecret(submitted, current.botToken);
    if (!botToken || !TOKEN_PATTERN.test(botToken)) throw new HttpError(400, "Invalid bot token format");

    const bot = createTelegramBot(botToken);
    const botInfo = await bot.getMe();
    if (!botInfo.ok) throw new HttpError(400, "Invalid bot token", { details: botInfo.description });

    // 只覆盖这次给出的字段：allowedUsers / allowTaskStart 由别的接口维护，不能被这里重置。
    // 在事务里重读再写，别拿上面校验 token 时的快照去覆盖这期间别的请求写进去的字段
    updateAppSetting("telegram", (latest) => ({
      ...(latest ?? {}),
      botToken,
      chatId: chatId || latest?.chatId,
      webhookUrl: webhookUrl || latest?.webhookUrl,
    }));

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
