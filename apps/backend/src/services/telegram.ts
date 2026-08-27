// Telegram Bot API 集成
import axios, { type AxiosInstance } from "axios";
import { readAppSettings } from "../db/repositories/settings.js";
import { moduleLogger } from "../lib/logger.js";

const log = moduleLogger("telegram");

export interface TelegramConfig {
  botToken: string;
  chatId?: string; // 可选，用于发送消息到特定聊天
}

export interface TelegramMessage {
  chat_id: string;
  text: string;
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  reply_markup?: {
    inline_keyboard?: Array<Array<{ text: string; callback_data: string }>>;
  };
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: {
      id: number;
      is_bot: boolean;
      first_name: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    date: number;
    text?: string;
  };
  callback_query?: {
    id: string;
    from: {
      id: number;
      is_bot: boolean;
      first_name: string;
      username?: string;
    };
    message?: {
      message_id: number;
      chat: { id: number; type: string };
      text?: string;
    };
    data?: string;
  };
}

export interface TelegramResponse {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  error?: string;
}

export interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
  can_join_groups: boolean;
  can_read_all_group_messages: boolean;
  supports_inline_queries: boolean;
}

/** Bot API 地址。默认官方；连不上 api.telegram.org 的环境可以用 TELEGRAM_API_BASE 指到自己的反代 */
function telegramApiBase(): string {
  return (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
}

class TelegramBot {
  private http: AxiosInstance;

  constructor(botToken: string, apiBase = telegramApiBase()) {
    /**
     * 普通调用 10 秒超时：api.telegram.org 挂住时，POST /api/telegram/bot 之类的请求
     * 不能跟着一起挂到天荒地老。getUpdates 是长轮询，超时自己另算。
     */
    this.http = axios.create({ baseURL: `${apiBase}/bot${botToken}`, timeout: 10_000 });
  }

  // 发送消息
  async sendMessage(message: TelegramMessage): Promise<TelegramResponse> {
    try {
      const response = await this.http.post("/sendMessage", message);
      return response.data;
    } catch (error) {
      log.error({ err: error }, 'Telegram sendMessage error');
      // 不抛出错误，避免影响主流程，只记录日志
      return { ok: false, error: `Telegram API error: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // 发送通知消息（简化版本）
  async sendNotification(text: string, chatId?: string): Promise<TelegramResponse> {
    if (!chatId) {
      log.warn('Chat ID is required for sending notifications, skipping...');
      return { ok: false, error: 'Chat ID is required for sending notifications' };
    }

    try {
      return await this.sendMessage({
        chat_id: chatId,
        text,
        parse_mode: 'HTML'
      });
    } catch (error) {
      log.error({ err: error }, 'Failed to send Telegram notification');
      return { ok: false, error: `Failed to send notification: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // 获取机器人信息
  async getMe(): Promise<TelegramResponse> {
    try {
      const response = await this.http.get("/getMe");
      return response.data;
    } catch (error) {
      log.error({ err: error }, 'Telegram getMe error');
      return { ok: false, error: `Failed to get bot info: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 长轮询拉更新，只给轮询循环用。
   *
   * 错误原样抛出，由循环决定怎么退避：以前这里把 409 当"没有新消息"吞掉，
   * 循环永远看不到冲突。signal 让 stopPolling 能立刻掐断挂着的长连接，不用等 timeout 到期。
   */
  async getUpdates(offset: number, limit: number, timeout: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    const params: Record<string, number> = { limit, timeout };
    if (offset > 0) params.offset = offset;
    const response = await this.http.get<{ result?: TelegramUpdate[] }>("/getUpdates", {
      params,
      timeout: timeout * 1000 + 5000, // 服务端最长挂 timeout 秒，再给 5 秒网络余量
      signal,
    });
    return response.data.result ?? [];
  }

  // 设置 webhook
  async setWebhook(url: string, secretToken?: string): Promise<TelegramResponse> {
    try {
      const data: { url: string; secret_token?: string } = { url };
      if (secretToken) data.secret_token = secretToken;

      const response = await this.http.post("/setWebhook", data);
      return response.data;
    } catch (error) {
      log.error({ err: error }, 'Telegram setWebhook error');
      return { ok: false, error: `Failed to set webhook: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // 删除 webhook
  async deleteWebhook(): Promise<TelegramResponse> {
    try {
      const response = await this.http.post("/deleteWebhook");
      return response.data;
    } catch (error) {
      log.error({ err: error }, 'Telegram deleteWebhook error');
      return { ok: false, error: `Failed to delete webhook: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // 获取 webhook 信息
  async getWebhookInfo(): Promise<TelegramResponse> {
    try {
      const response = await this.http.get("/getWebhookInfo");
      return response.data;
    } catch (error) {
      log.error({ err: error }, 'Telegram getWebhookInfo error');
      return { ok: false, error: `Failed to get webhook info: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // 发送带按钮的消息
  async sendMessageWithButtons(
    chatId: string, 
    text: string, 
    buttons: Array<Array<{ text: string; callback_data: string }>>
  ): Promise<TelegramResponse> {
    return this.sendMessage({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: buttons
      }
    });
  }

  // 编辑消息
  async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> }
  ): Promise<TelegramResponse> {
    try {
      const data: {
        chat_id: string;
        message_id: number;
        text: string;
        parse_mode: string;
        reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> };
      } = {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML'
      };
      if (replyMarkup) data.reply_markup = replyMarkup;

      const response = await this.http.post("/editMessageText", data);
      return response.data;
    } catch (error) {
      log.error({ err: error }, 'Telegram editMessageText error');
      return { ok: false, error: `Failed to edit message: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // 回答回调查询
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<TelegramResponse> {
    try {
      const data: { callback_query_id: string; text?: string } = { callback_query_id: callbackQueryId };
      if (text) data.text = text;

      const response = await this.http.post("/answerCallbackQuery", data);
      return response.data;
    } catch (error) {
      log.error({ err: error }, 'Telegram answerCallbackQuery error');
      return { ok: false, error: `Failed to answer callback query: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

// 创建机器人实例的工厂函数
export function createTelegramBot(botToken: string): TelegramBot {
  return new TelegramBot(botToken);
}

// 验证 Telegram 配置
export function validateTelegramConfig(config: unknown): config is TelegramConfig {
  return config !== null && typeof config === 'object' && 
         'botToken' in config && 
         typeof (config as { botToken: unknown }).botToken === 'string' && 
         (config as { botToken: string }).botToken.length > 0;
}

// 格式化任务状态消息
export function formatTaskStatusMessage(task: { name?: string; progress?: number; status?: string; [key: string]: unknown }): string {
  const status = task.status || 'unknown';
  const name = task.name || 'Unknown Task';
  const progress = task.progress || 0;
  
  let statusEmoji = '⏳';
  switch (status) {
    case 'completed':
      statusEmoji = '✅';
      break;
    case 'failed':
      statusEmoji = '❌';
      break;
    case 'running':
      statusEmoji = '🔄';
      break;
    case 'paused':
      statusEmoji = '⏸️';
      break;
  }

  return `<b>${statusEmoji} Task Update</b>\n\n` +
         `<b>Name:</b> ${name}\n` +
         `<b>Status:</b> ${status}\n` +
         `<b>Progress:</b> ${progress}%\n` +
         `<b>Time:</b> ${new Date().toLocaleString()}`;
}

// 格式化下载完成消息
export function formatDownloadCompleteMessage(task: { name?: string; size?: number; [key: string]: unknown }): string {
  const name = task.name || 'Unknown File';
  const size = task.size ? formatFileSize(task.size) : 'Unknown size';
  
  return `<b>🎉 Download Complete!</b>\n\n` +
         `<b>File:</b> ${name}\n` +
         `<b>Size:</b> ${size}\n` +
         `<b>Completed:</b> ${new Date().toLocaleString()}`;
}

// 格式化文件大小
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 发送 Telegram 通知的公共方法
export async function sendTelegramNotification(message: string, type: 'start' | 'complete' | 'error' = 'start') {
  try {
    const settings = readAppSettings();
    const telegram = settings.telegram;
    
    // 检查 Telegram 配置是否完整
    if (!telegram || !telegram.botToken || !telegram.chatId) {
      log.info('Telegram not configured (missing botToken or chatId), skipping notification');
      return;
    }
    const bot = createTelegramBot(telegram.botToken);
    
    let emoji = 'ℹ️';
    let prefix = '';
    
    switch (type) {
      case 'start':
        emoji = '🚀';
        prefix = 'Task Started';
        break;
      case 'complete':
        emoji = '✅';
        prefix = 'Task Completed';
        break;
      case 'error':
        emoji = '❌';
        prefix = 'Task Error';
        break;
    }
    
    const formattedMessage = `${emoji} <b>${prefix}</b>\n\n${message}\n\n<b>Time:</b> ${new Date().toLocaleString()}`;
    
    await bot.sendNotification(formattedMessage, telegram.chatId);
    log.info(`Telegram notification sent: ${type}`);
  } catch (error) {
    log.error({ err: error }, 'Failed to send Telegram notification');
    // 不抛出错误，避免影响主流程
  }
}
