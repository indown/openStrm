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
    // data 可以是对象（带 message）也可以是一段文本
    const payload = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const plain = () => String(payload.message ?? (typeof data === "string" ? data : JSON.stringify(data)));

    if (type === "task_status" && data) messageText = formatTaskStatusMessage(payload as Parameters<typeof formatTaskStatusMessage>[0]);
    else if (type === "download_complete" && data) messageText = formatDownloadCompleteMessage(payload as Parameters<typeof formatDownloadCompleteMessage>[0]);
    else if (type === "error" && data) messageText = `❌ <b>Error</b>\n\n${plain()}\n\n<b>Time:</b> ${new Date().toLocaleString()}`;
    else if (type === "info" && data) messageText = `ℹ️ <b>Info</b>\n\n${plain()}\n\n<b>Time:</b> ${new Date().toLocaleString()}`;

    const result = await bot.sendNotification(messageText, telegram.chatId);
    const sent = result.result as { message_id?: number } | undefined;
    return { success: true, messageId: sent?.message_id, result };
  });
}
