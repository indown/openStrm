import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createTelegramBot } from "../../services/telegram/bot.js";
import { getPollingStatus, restartPolling, stopPolling } from "../../services/telegram/polling.js";
import { DEFAULT_NOTIFY, notifyPrefs } from "../../services/telegram/notify.js";
import { BOT_COMMANDS } from "../../services/telegram/commands.js";
import { deleteAppSetting, readAppSetting, readAppSettings, updateAppSetting } from "../../db/repositories/settings.js";
import { HttpError, upstreamError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { maskSecret, resolveSecret } from "../../lib/secrets.js";

const TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{35}$/;

const configureSchema = z.object({
  botToken: z.string({ error: "Bot token is required" }).min(1, "Bot token is required"),
  chatId: z.string().optional(),
});

/**
 * 机器人的配置与状态，一个接口给页面拿齐：token（掩码）、chatId、bot 信息、轮询状态、
 * 白名单、权限开关、通知开关。webhook 模式已移除——自建环境多数没有公网 HTTPS，轮询哪儿都能用。
 */
export default async function (fastify: FastifyInstance) {
  fastify.get("/api/telegram/bot", { preHandler: [fastify.authenticate] }, async () => {
    const settings = readAppSettings();
    const telegram = settings.telegram ?? {};
    const base = {
      configured: Boolean(telegram.botToken),
      botToken: telegram.botToken ? maskSecret(telegram.botToken) : "",
      chatId: telegram.chatId ?? "",
      allowedUsers: telegram.allowedUsers ?? [],
      permissions: {
        allowTaskStart: telegram.allowTaskStart === true,
        allowOfflineAdd: telegram.allowOfflineAdd === true,
        allowShareReceive: telegram.allowShareReceive === true,
      },
      notify: notifyPrefs(settings),
      notifyDefaults: DEFAULT_NOTIFY,
      polling: getPollingStatus().active,
      commands: BOT_COMMANDS,
    };
    if (!telegram.botToken) return { ...base, bot: null, botError: null };
    // token 配了但 Telegram 连不上（网络、token 被撤销）也要把页面渲染出来
    const me = await createTelegramBot(telegram.botToken).getMe();
    return { ...base, bot: me.ok ? (me.result ?? null) : null, botError: me.ok ? null : (me.error ?? me.description ?? "无法连接 Telegram") };
  });

  fastify.post("/api/telegram/bot", { preHandler: [fastify.authenticate] }, async (request) => {
    const { botToken: submitted, chatId } = parse(configureSchema, request.body);
    // 表单回填的是掩码，原样提交等于沿用已保存的 token
    const current = readAppSetting("telegram") ?? {};
    const botToken = resolveSecret(submitted, current.botToken);
    if (!botToken || !TOKEN_PATTERN.test(botToken)) throw new HttpError(400, "Bot token 格式不对，应形如 123456789:ABC…（从 @BotFather 获取）");

    const me = await createTelegramBot(botToken).getMe();
    if (!me.ok) throw new HttpError(400, "Telegram 不认这个 token", { details: me.error ?? me.description });

    const tokenChanged = botToken !== current.botToken;
    // 只覆盖这次给出的字段：白名单、权限、通知开关由别的接口维护，不能被这里重置。
    // 在事务里重读再写，别拿上面校验 token 时的快照去覆盖这期间别的请求写进去的字段
    updateAppSetting("telegram", (latest) => ({
      ...(latest ?? {}),
      botToken,
      chatId: chatId?.trim() ?? latest?.chatId,
    }));
    // 换了 token 的话在跑的轮询还拿着旧 token
    if (tokenChanged && getPollingStatus().active) await restartPolling();

    return { success: true, bot: me.result, message: "已保存" };
  });

  fastify.delete("/api/telegram/bot", { preHandler: [fastify.authenticate] }, async () => {
    stopPolling();
    deleteAppSetting("telegram");
    return { success: true, message: "已清除 Telegram 配置" };
  });

  /** 发一条测试消息到配置的 chatId */
  fastify.post("/api/telegram/test", { preHandler: [fastify.authenticate] }, async () => {
    const telegram = readAppSetting("telegram");
    if (!telegram?.botToken) throw new HttpError(400, "还没有配置 bot token");
    if (!telegram.chatId) throw new HttpError(400, "还没有填 chat id：给机器人发 /id 就能看到");
    const res = await createTelegramBot(telegram.botToken).sendMessage(
      telegram.chatId,
      "✅ <b>OpenStrm 测试消息</b>\n通知通道正常。任务、云下载、账号异常的通知都会发到这里。",
    );
    if (!res.ok) throw upstreamError(`发送失败：${res.error ?? res.description ?? "unknown"}`);
    return { success: true };
  });
}
