import type { FastifyInstance } from "fastify";
import { createTelegramBot, formatTaskStatusMessage, formatDownloadCompleteMessage } from "../../services/telegram.js";

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/telegram/send", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { message, type, data } = request.body as { message?: string; type?: string; data?: any };
    const settings = fastify.readSettings();
    const telegram = settings.telegram;

    if (!telegram?.botToken || !telegram?.chatId) {
      return reply.code(400).send({ error: "Telegram not configured (missing botToken or chatId)" });
    }

    const bot = createTelegramBot(telegram.botToken);
    let messageText = message || "";

    if (type === "task_status" && data) messageText = formatTaskStatusMessage(data);
    else if (type === "download_complete" && data) messageText = formatDownloadCompleteMessage(data);
    else if (type === "error" && data) messageText = `❌ <b>Error</b>\n\n${data.message || data}\n\n<b>Time:</b> ${new Date().toLocaleString()}`;
    else if (type === "info" && data) messageText = `ℹ️ <b>Info</b>\n\n${data.message || data}\n\n<b>Time:</b> ${new Date().toLocaleString()}`;

    const result = await bot.sendNotification(messageText, telegram.chatId);
    return { success: true, messageId: (result.result as any)?.message_id, result };
  });
}
