/**
 * Telegram Bot API 的薄封装，只留这个项目用得到的方法。
 *
 * 除 getUpdates 外，出错一律记日志并返回 { ok: false }：通知发不出去不能拖垮同步任务。
 * getUpdates 的错误原样抛给轮询循环，由它决定怎么退避（409 是冲突不是没消息）。
 */
import axios, { type AxiosInstance } from "axios";
import { moduleLogger } from "../../lib/logger.js";

const log = moduleLogger("telegram");

export interface InlineButton {
  text: string;
  callback_data: string;
}
export type InlineKeyboard = InlineButton[][];

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}
export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
}
export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}
export interface TelegramResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  error?: string;
}
export interface BotCommand {
  command: string;
  description: string;
}

export interface SendOptions {
  buttons?: InlineKeyboard;
  /** 回复哪条消息 */
  replyTo?: number;
  /** 静默推送（不响铃） */
  silent?: boolean;
}

/** 命令处理器依赖的最小接口；测试用桩实现，不碰网络 */
export interface BotLike {
  sendMessage(chatId: string | number, text: string, opts?: SendOptions): Promise<TelegramResponse<{ message_id?: number }>>;
  editMessage(chatId: string | number, messageId: number, text: string, buttons?: InlineKeyboard): Promise<TelegramResponse>;
  /** alert=true 弹对话框而不是顶部一闪而过的 toast：给"看不到就等于没发生"的回应用 */
  answerCallback(callbackId: string, text?: string, opts?: { alert?: boolean }): Promise<TelegramResponse>;
}

/** Bot API 地址。默认官方；连不上 api.telegram.org 的环境可以用 TELEGRAM_API_BASE 指到自己的反代 */
function telegramApiBase(): string {
  return (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
}

export class TelegramBot implements BotLike {
  private http: AxiosInstance;

  constructor(botToken: string, apiBase = telegramApiBase()) {
    // 普通调用 10 秒超时：api.telegram.org 挂住时，配置接口不能跟着一起挂。getUpdates 是长轮询，超时另算
    this.http = axios.create({ baseURL: `${apiBase}/bot${botToken}`, timeout: 10_000 });
  }

  private async call<T>(method: string, data: Record<string, unknown> = {}): Promise<TelegramResponse<T>> {
    try {
      const res = await this.http.post<TelegramResponse<T>>(`/${method}`, data);
      return res.data;
    } catch (err) {
      const body = axios.isAxiosError(err) ? (err.response?.data as { description?: string } | undefined) : undefined;
      const reason = body?.description ?? (err instanceof Error ? err.message : String(err));
      log.warn(`Telegram ${method} 失败：${reason}`);
      return { ok: false, error: reason, error_code: axios.isAxiosError(err) ? err.response?.status : undefined };
    }
  }

  sendMessage(chatId: string | number, text: string, opts: SendOptions = {}) {
    return this.call<{ message_id?: number }>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(opts.buttons ? { reply_markup: { inline_keyboard: opts.buttons } } : {}),
      ...(opts.replyTo ? { reply_to_message_id: opts.replyTo } : {}),
      ...(opts.silent ? { disable_notification: true } : {}),
    });
  }

  /** 改写已发出的消息；不传 buttons 就把按钮摘掉（多步交互完成后用） */
  editMessage(chatId: string | number, messageId: number, text: string, buttons?: InlineKeyboard) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: buttons ?? [] },
    });
  }

  answerCallback(callbackId: string, text?: string, opts: { alert?: boolean } = {}) {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackId,
      ...(text ? { text } : {}),
      ...(opts.alert ? { show_alert: true } : {}),
    });
  }

  getMe() {
    return this.call<TelegramUser & { username?: string }>("getMe");
  }

  /** 老版本可能设过 webhook；getUpdates 和 webhook 互斥，起轮询前先摘掉 */
  deleteWebhook() {
    return this.call("deleteWebhook");
  }

  /** 让命令出现在客户端的菜单里 */
  setMyCommands(commands: BotCommand[]) {
    return this.call("setMyCommands", { commands });
  }

  /**
   * 长轮询拉更新，只给轮询循环用。
   * 错误原样抛出，由循环决定怎么退避；signal 让 stopPolling 能立刻掐断挂着的长连接，不用等 timeout 到期。
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
}

export function createTelegramBot(botToken: string): TelegramBot {
  return new TelegramBot(botToken);
}
