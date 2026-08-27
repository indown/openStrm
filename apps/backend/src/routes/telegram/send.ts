import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createTelegramBot, formatTaskStatusMessage, formatDownloadCompleteMessage } from "../../services/telegram.js";
import { readAppSetting } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";

const bodySchema = z.object({
  message: z.string().optional(),
  type: z.string().optional(),
  data: z.unknown().optional(),
});

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/telegram/send", { preHandler: [fastify.authenticate] }, async (request) => {
    const { message, type, data } = parse(bodySchema, request.body);
    const telegram = readAppSetting("telegram");
    if (!telegram?.botToken || !telegram?.chatId) {
      throw new HttpError(400, "Telegram not configured (missing botToken or chatId)");
    }

    const bot = createTelegramBot(telegram.botToken);
    let messageText = message || "";
    const payload = data as any;

    if (type === "task_status" && payload) messageText = formatTaskStatusMessage(payload);
    else if (type === "download_complete" && payload) messageText = formatDownloadCompleteMessage(payload);
    else if (type === "error" && payload) messageText = `❌ <b>Error</b>\n\n${payload.message || payload}\n\n<b>Time:</b> ${new Date().toLocaleString()}`;
    else if (type === "info" && payload) messageText = `ℹ️ <b>Info</b>\n\n${payload.message || payload}\n\n<b>Time:</b> ${new Date().toLocaleString()}`;

    const result = await bot.sendNotification(messageText, telegram.chatId);
    return { success: true, messageId: (result.result as any)?.message_id, result };
  });
}
