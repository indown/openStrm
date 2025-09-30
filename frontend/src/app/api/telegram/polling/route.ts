// Telegram 轮询 API
import { NextResponse } from "next/server";
import { createTelegramBot } from "@/lib/telegram";
import { readSettings } from "@/lib/serverUtils";
import { stopPolling, getPollingStatus, forceCleanup, safeStartPolling } from "@/lib/telegramPolling";

// 启动轮询
export async function POST() {
  try {
    // 读取设置
    const settings = readSettings();
    const telegram = settings.telegram;
    
    if (!telegram || !telegram.botToken) {
      return NextResponse.json({ error: "Telegram not configured" }, { status: 400 });
    }

    // 创建机器人实例
    const bot = createTelegramBot(telegram.botToken);

    // 删除现有的 webhook（如果存在）
    try {
      await bot.deleteWebhook();
      console.log("Deleted existing webhook for polling mode");
    } catch (error) {
      console.log("No webhook to delete or error deleting webhook:", error);
    }

    // 使用安全启动轮询
    await safeStartPolling();

    return NextResponse.json({ 
      success: true, 
      message: "Polling started successfully" 
    });
  } catch (error) {
    console.error("Telegram polling start error:", error);
    return NextResponse.json({ 
      error: "Failed to start polling", 
      details: error instanceof Error ? error.message : String(error) 
    }, { status: 500 });
  }
}

// 停止轮询
export async function DELETE() {
  try {
    // 读取设置
    const settings = readSettings();
    const telegram = settings.telegram;
    
    if (!telegram || !telegram.botToken) {
      return NextResponse.json({ error: "Telegram not configured" }, { status: 400 });
    }

    // 停止轮询
    stopPolling();

    // 如果有 webhook URL，设置 webhook
    if (telegram.webhookUrl) {
      const bot = createTelegramBot(telegram.botToken);
      await bot.setWebhook(telegram.webhookUrl);
      console.log("Stopped polling, webhook enabled");
    }

    return NextResponse.json({ 
      success: true, 
      message: "Polling stopped successfully" 
    });
  } catch (error) {
    console.error("Telegram polling stop error:", error);
    return NextResponse.json({ 
      error: "Failed to stop polling", 
      details: error instanceof Error ? error.message : String(error) 
    }, { status: 500 });
  }
}

// 轮询状态
export async function GET() {
  try {
    // 读取设置
    const settings = readSettings();
    const telegram = settings.telegram;
    
    if (!telegram || !telegram.botToken) {
      return NextResponse.json({ error: "Telegram not configured" }, { status: 400 });
    }

    // 获取轮询状态
    const pollingStatus = getPollingStatus();
    
    // 创建机器人实例获取 webhook 信息
    const bot = createTelegramBot(telegram.botToken);
    const webhookInfo = await bot.getWebhookInfo();

    return NextResponse.json({ 
      polling: pollingStatus.active,
      webhook: webhookInfo.result,
      message: pollingStatus.message
    });
  } catch (error) {
    console.error("Telegram polling status error:", error);
    return NextResponse.json({ 
      error: "Failed to get polling status", 
      details: error instanceof Error ? error.message : String(error) 
    }, { status: 500 });
  }
}

// 强制清理 webhook 和轮询状态
export async function PUT() {
  try {
    const success = await forceCleanup();
    
    if (success) {
      return NextResponse.json({ 
        success: true, 
        message: "Force cleanup completed, polling will restart automatically" 
      });
    } else {
      return NextResponse.json({ 
        error: "Failed to perform force cleanup" 
      }, { status: 500 });
    }
  } catch (error) {
    console.error("Telegram force cleanup error:", error);
    return NextResponse.json({ 
      error: "Failed to perform force cleanup", 
      details: error instanceof Error ? error.message : String(error) 
    }, { status: 500 });
  }
}

