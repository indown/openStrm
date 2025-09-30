// Telegram Bot API 集成
import axios from "axios";

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

class TelegramBot {
  private botToken: string;
  private baseUrl: string;

  constructor(botToken: string) {
    this.botToken = botToken;
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  // 发送消息
  async sendMessage(message: TelegramMessage): Promise<TelegramResponse> {
    try {
      const response = await axios.post(`${this.baseUrl}/sendMessage`, message);
      return response.data;
    } catch (error) {
      console.error('Telegram sendMessage error:', error);
      throw error;
    }
  }

  // 发送通知消息（简化版本）
  async sendNotification(text: string, chatId?: string): Promise<TelegramResponse> {
    if (!chatId) {
      throw new Error('Chat ID is required for sending notifications');
    }

    return this.sendMessage({
      chat_id: chatId,
      text,
      parse_mode: 'HTML'
    });
  }

  // 获取机器人信息
  async getMe(): Promise<TelegramResponse> {
    try {
      const response = await axios.get(`${this.baseUrl}/getMe`);
      return response.data;
    } catch (error) {
      console.error('Telegram getMe error:', error);
      throw error;
    }
  }

  // 获取更新（用于 webhook 或轮询）
  async getUpdates(offset?: number, limit?: number, timeout?: number): Promise<TelegramUpdate[]> {
    try {
      const params = new URLSearchParams();
      if (offset) params.append('offset', offset.toString());
      if (limit) params.append('limit', limit.toString());
      if (timeout) params.append('timeout', timeout.toString());

      const response = await axios.get(`${this.baseUrl}/getUpdates?${params}`, {
        timeout: (timeout || 30) * 1000 + 5000, // 给额外的5秒缓冲时间
      });
      return response.data.result || [];
    } catch (error: any) {
      // 409 错误表示没有新消息，这是正常的，不需要记录
      if (error.response?.status === 409) {
        throw error; // 重新抛出，让上层处理
      }
      console.error('Telegram getUpdates error:', error);
      throw error;
    }
  }

  // 设置 webhook
  async setWebhook(url: string, secretToken?: string): Promise<TelegramResponse> {
    try {
      const data: { url: string; secret_token?: string } = { url };
      if (secretToken) data.secret_token = secretToken;

      const response = await axios.post(`${this.baseUrl}/setWebhook`, data);
      return response.data;
    } catch (error) {
      console.error('Telegram setWebhook error:', error);
      throw error;
    }
  }

  // 删除 webhook
  async deleteWebhook(): Promise<TelegramResponse> {
    try {
      const response = await axios.post(`${this.baseUrl}/deleteWebhook`);
      return response.data;
    } catch (error) {
      console.error('Telegram deleteWebhook error:', error);
      throw error;
    }
  }

  // 获取 webhook 信息
  async getWebhookInfo(): Promise<TelegramResponse> {
    try {
      const response = await axios.get(`${this.baseUrl}/getWebhookInfo`);
      return response.data;
    } catch (error) {
      console.error('Telegram getWebhookInfo error:', error);
      throw error;
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

      const response = await axios.post(`${this.baseUrl}/editMessageText`, data);
      return response.data;
    } catch (error) {
      console.error('Telegram editMessageText error:', error);
      throw error;
    }
  }

  // 回答回调查询
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<TelegramResponse> {
    try {
      const data: { callback_query_id: string; text?: string } = { callback_query_id: callbackQueryId };
      if (text) data.text = text;

      const response = await axios.post(`${this.baseUrl}/answerCallbackQuery`, data);
      return response.data;
    } catch (error) {
      console.error('Telegram answerCallbackQuery error:', error);
      throw error;
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
