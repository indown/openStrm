// Telegram 发送消息 API
import { NextRequest, NextResponse } from "next/server";
import { createTelegramBot, formatTaskStatusMessage, formatDownloadCompleteMessage } from "@/lib/telegram";
import { readSettings } from "@/lib/serverUtils";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { message, type, data } = body;

    // 读取设置
    const settings = readSettings();
    const telegram = settings.telegram;
    
    if (!telegram || !telegram.botToken) {
      return NextResponse.json({ error: "Telegram not configured" }, { status: 400 });
    }

    if (!telegram.chatId) {
      return NextResponse.json({ error: "Chat ID not configured" }, { status: 400 });
    }

    // 创建机器人实例
    const bot = createTelegramBot(telegram.botToken);

    let messageText = message;

    // 根据类型格式化消息
    if (type === 'task_status' && data) {
      messageText = formatTaskStatusMessage(data);
    } else if (type === 'download_complete' && data) {
      messageText = formatDownloadCompleteMessage(data);
    } else if (type === 'error' && data) {
      messageText = `❌ <b>Error</b>\n\n${data.message || data}\n\n<b>Time:</b> ${new Date().toLocaleString()}`;
    } else if (type === 'info' && data) {
      messageText = `ℹ️ <b>Info</b>\n\n${data.message || data}\n\n<b>Time:</b> ${new Date().toLocaleString()}`;
    }

    // 发送消息
    const result = await bot.sendNotification(messageText, telegram.chatId);

    return NextResponse.json({ 
      success: true, 
      messageId: (result.result as { message_id?: number })?.message_id,
      result 
    });
  } catch (error) {
    console.error("Telegram send error:", error);
    return NextResponse.json({ 
      error: "Failed to send Telegram message", 
      details: error instanceof Error ? error.message : String(error) 
    }, { status: 500 });
  }
}

// 发送任务状态通知
export async function sendTaskNotification(task: any, status: string) {
  try {
    const response = await fetch('/api/telegram/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'task_status',
        data: { ...task, status }
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to send task notification:', error);
    throw error;
  }
}

// 发送下载完成通知
export async function sendDownloadCompleteNotification(task: any) {
  try {
    const response = await fetch('/api/telegram/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'download_complete',
        data: task
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to send download complete notification:', error);
    throw error;
  }
}

// 发送错误通知
export async function sendErrorNotification(error: any) {
  try {
    const response = await fetch('/api/telegram/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'error',
        data: error
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json();
  } catch (err) {
    console.error('Failed to send error notification:', err);
    throw err;
  }
}
