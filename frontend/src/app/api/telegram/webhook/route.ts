// Telegram Bot Webhook 处理
import { NextRequest, NextResponse } from "next/server";
import { createTelegramBot, TelegramUpdate } from "@/lib/telegram";
import { 
  readSettings, 
  isTelegramUserAllowed,
  addTelegramUser,
  readTasks
} from "@/lib/serverUtils";

interface TelegramMessage {
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
}

interface TelegramCallbackQuery {
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
}

export async function POST(request: NextRequest) {
  try {
    // 读取设置
    const settings = readSettings();
    const telegram = settings.telegram;
    
    // 检查 Telegram 配置是否完整
    if (!telegram || !telegram.botToken) {
      console.log("Telegram not configured (missing botToken), skipping webhook processing");
      return NextResponse.json({ error: "Telegram not configured" }, { status: 400 });
    }

    // 创建机器人实例
    const bot = createTelegramBot(telegram.botToken);

    // 解析更新
    const update: TelegramUpdate = await request.json();
    
    // 处理消息
    if (update.message) {
      await handleMessage(bot, update.message);
    }
    
    // 处理回调查询
    if (update.callback_query) {
      await handleCallbackQuery(bot, update.callback_query);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return NextResponse.json({ 
      error: "Internal server error",
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}

// 处理消息
async function handleMessage(bot: ReturnType<typeof createTelegramBot>, message: TelegramMessage) {
  const chatId = message.chat.id.toString();
  const text = message.text;
  const username = message.from.username || message.from.first_name;
  const userId = message.from.id;

  console.log(`[Telegram] Message from ${username} (${userId}): ${text}`);
  console.log(`[Telegram] Chat ID: ${chatId}, User ID: ${userId}`);
  console.log(`[Telegram] Full message data:`, JSON.stringify(message, null, 2));

  // 处理命令
  if (text?.startsWith('/')) {
    await handleCommand(bot, chatId, text, username, userId);
  } else {
    // 处理普通消息
    await bot.sendMessage({
      chat_id: chatId,
      text: `Hello ${username}! 👋\n\nUse /help to see available commands.`,
      parse_mode: 'HTML'
    });
  }
}

// 处理命令
async function handleCommand(bot: ReturnType<typeof createTelegramBot>, chatId: string, command: string, username: string, userId: number) {
  const [cmd, ...args] = command.split(' ');

  // 检查用户权限
  if (!isTelegramUserAllowed(userId)) {
    await bot.sendMessage({
      chat_id: chatId,
      text: `❌ <b>Access Denied</b>\n\n` +
            `You are not authorized to use this bot.\n\n` +
            `Contact the administrator to get access.\n\n` +
            `Your User ID: <code>${userId}</code>`,
      parse_mode: 'HTML'
    });
    return;
  }

  switch (cmd) {
    case '/start':
      await handleStartCommand(bot, chatId, username);
      break;

    case '/help':
      await bot.sendMessage({
        chat_id: chatId,
        text: `<b>🤖 FreeStrm Bot Commands</b>\n\n` +
              `<b>Available Commands:</b>\n` +
              `<b>/start</b> - Start the bot\n` +
              `<b>/help</b> - Show this help message\n` +
              `<b>/ping</b> - Test bot connectivity\n` +
              `<b>/status</b> - Show system status\n` +
              `<b>/tasks</b> - List current tasks\n` +
              `<b>/settings</b> - Show current settings\n` +
              `<b>/users</b> - List authorized users\n` +
              `<b>/adduser &lt;user_id&gt;</b> - Add new user\n` +
              `<b>/removeuser &lt;user_id&gt;</b> - Remove user\n\n` +
              `✅ You are authorized to use all commands.`,
        parse_mode: 'HTML'
      });
      break;

    case '/ping':
      await bot.sendMessage({
        chat_id: chatId,
        text: `🏓 Pong! Bot is working fine.`,
        parse_mode: 'HTML'
      });
      break;

    case '/status':
      await bot.sendMessage({
        chat_id: chatId,
        text: `<b>📊 System Status</b>\n\n` +
              `<b>Bot:</b> ✅ Online\n` +
              `<b>Time:</b> ${new Date().toLocaleString()}\n` +
              `<b>Uptime:</b> ${process.uptime().toFixed(0)}s`,
        parse_mode: 'HTML'
      });
      break;

    case '/tasks':
      await handleTasksCommand(bot, chatId);
      break;

    case '/settings':
      await handleSettingsCommand(bot, chatId);
      break;

    case '/users':
      await handleUsersCommand(bot, chatId);
      break;

    case '/adduser':
      await handleAddUserCommand(bot, chatId, args);
      break;

    case '/removeuser':
      await handleRemoveUserCommand(bot, chatId, args);
      break;

    default:
      await bot.sendMessage({
        chat_id: chatId,
        text: `❓ Unknown command: ${cmd}\n\nUse /help to see available commands.`,
        parse_mode: 'HTML'
      });
  }
}


// 处理任务命令
async function handleTasksCommand(bot: ReturnType<typeof createTelegramBot>, chatId: string) {
  try {
    // 这里可以集成你的任务管理系统
    // 暂时返回示例数据
    await bot.sendMessage({
      chat_id: chatId,
      text: `<b>📋 Current Tasks</b>\n\n` +
            `No active tasks found.\n\n` +
            `Use the web interface to start new download tasks.`,
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.error("Error handling tasks command:", error);
    await bot.sendMessage({
      chat_id: chatId,
      text: `❌ Error retrieving tasks: ${error}`,
      parse_mode: 'HTML'
    });
  }
}

// 处理设置命令
async function handleSettingsCommand(bot: ReturnType<typeof createTelegramBot>, chatId: string) {
  try {
    const settings = readSettings();
    
    let settingsText = `<b>⚙️ Current Settings</b>\n\n`;
    
    if (settings.emby) {
      settingsText += `<b>Emby:</b>\n`;
      settingsText += `• URL: ${settings.emby.url || 'Not set'}\n`;
      settingsText += `• API Key: ${settings.emby.apiKey ? '***' + settings.emby.apiKey.slice(-4) : 'Not set'}\n\n`;
    }
    
    if (settings.telegram) {
      settingsText += `<b>Telegram:</b>\n`;
      settingsText += `• Bot Token: ${settings.telegram.botToken ? '***' + settings.telegram.botToken.slice(-4) : 'Not set'}\n`;
      settingsText += `• Chat ID: ${settings.telegram.chatId || 'Not set'}\n`;
      settingsText += `• Allowed Users: ${settings.telegram.allowedUsers?.length || 0}\n\n`;
    }
    
    settingsText += `<b>User Agent:</b> ${settings['user-agent'] || 'Default'}`;

    await bot.sendMessage({
      chat_id: chatId,
      text: settingsText,
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.error("Error handling settings command:", error);
    await bot.sendMessage({
      chat_id: chatId,
      text: `❌ Error retrieving settings: ${error}`,
      parse_mode: 'HTML'
    });
  }
}

// 处理用户管理命令
async function handleUsersCommand(bot: ReturnType<typeof createTelegramBot>, chatId: string) {
  try {
    const { getTelegramUsers } = await import("@/lib/serverUtils");
    const users = getTelegramUsers();
    
    if (users.length === 0) {
      await bot.sendMessage({
        chat_id: chatId,
        text: `<b>👥 Authorized Users</b>\n\nNo authorized users found.`,
        parse_mode: 'HTML'
      });
      return;
    }

    let usersText = `<b>👥 Authorized Users</b>\n\n`;
    users.forEach((userId, index) => {
      usersText += `<b>${index + 1}.</b> User ID: <code>${userId}</code>\n`;
    });

    await bot.sendMessage({
      chat_id: chatId,
      text: usersText,
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.error("Error handling users command:", error);
    await bot.sendMessage({
      chat_id: chatId,
      text: `❌ Error retrieving users: ${error}`,
      parse_mode: 'HTML'
    });
  }
}

// 处理添加用户命令
async function handleAddUserCommand(bot: ReturnType<typeof createTelegramBot>, chatId: string, args: string[]) {
  try {
    if (args.length < 1) {
      await bot.sendMessage({
        chat_id: chatId,
        text: `<b>❌ Usage:</b> /adduser &lt;user_id&gt;\n\n` +
              `<b>Example:</b> /adduser 123456789`,
        parse_mode: 'HTML'
      });
      return;
    }

    const userId = parseInt(args[0]);

    if (isNaN(userId)) {
      await bot.sendMessage({
        chat_id: chatId,
        text: `❌ Invalid user ID: ${args[0]}`,
        parse_mode: 'HTML'
      });
      return;
    }

    const success = addTelegramUser(userId);

    if (success) {
      await bot.sendMessage({
        chat_id: chatId,
        text: `✅ User added successfully!\n\n` +
              `User ID: <code>${userId}</code>`,
        parse_mode: 'HTML'
      });
    } else {
      await bot.sendMessage({
        chat_id: chatId,
        text: `❌ Failed to add user. User might already exist.`,
        parse_mode: 'HTML'
      });
    }
  } catch (error) {
    console.error("Error handling add user command:", error);
    await bot.sendMessage({
      chat_id: chatId,
      text: `❌ Error adding user: ${error}`,
      parse_mode: 'HTML'
    });
  }
}

// 处理删除用户命令
async function handleRemoveUserCommand(bot: ReturnType<typeof createTelegramBot>, chatId: string, args: string[]) {
  try {
    if (args.length < 1) {
      await bot.sendMessage({
        chat_id: chatId,
        text: `<b>❌ Usage:</b> /removeuser &lt;user_id&gt;\n\n` +
              `<b>Example:</b> /removeuser 123456`,
        parse_mode: 'HTML'
      });
      return;
    }

    const userId = parseInt(args[0]);

    if (isNaN(userId)) {
      await bot.sendMessage({
        chat_id: chatId,
        text: `❌ Invalid user ID: ${args[0]}`,
        parse_mode: 'HTML'
      });
      return;
    }

    const { removeTelegramUser } = await import("@/lib/serverUtils");
    const success = removeTelegramUser(userId);

    if (success) {
      await bot.sendMessage({
        chat_id: chatId,
        text: `✅ User removed successfully!\n\nID: ${userId}`,
        parse_mode: 'HTML'
      });
    } else {
      await bot.sendMessage({
        chat_id: chatId,
        text: `❌ User not found or failed to remove.`,
        parse_mode: 'HTML'
      });
    }
  } catch (error) {
    console.error("Error handling remove user command:", error);
    await bot.sendMessage({
      chat_id: chatId,
      text: `❌ Error removing user: ${error}`,
      parse_mode: 'HTML'
    });
  }
}

// 处理回调查询
async function handleCallbackQuery(bot: ReturnType<typeof createTelegramBot>, callbackQuery: TelegramCallbackQuery) {
  if (!callbackQuery.message) {
    console.error("Callback query has no message");
    return;
  }

  const chatId = callbackQuery.message.chat.id.toString();
  const data = callbackQuery.data;
  const queryId = callbackQuery.id;

  console.log(`[Telegram] Callback query: ${data}`);

  // 回答回调查询
  await bot.answerCallbackQuery(queryId, "Processing...");

  // 处理不同的回调查询
  switch (data) {
    case 'refresh_tasks':
      await handleTasksCommand(bot, chatId);
      break;
    case 'refresh_settings':
      await handleSettingsCommand(bot, chatId);
      break;
    default:
      // 处理任务开始回调
      if (data && data.startsWith('start_task_')) {
        const taskId = data.replace('start_task_', '');
        await handleTaskStartCallback(bot, chatId, taskId);
        return;
      }
      
      await bot.sendMessage({
        chat_id: chatId,
        text: `❓ Unknown callback: ${data}`,
        parse_mode: 'HTML'
      });
  }
}

// 处理 /start 命令 - 显示任务列表
async function handleStartCommand(bot: ReturnType<typeof createTelegramBot>, chatId: string, username: string) {
  try {
    const tasks = readTasks();
    
    if (tasks.length === 0) {
      await bot.sendMessage({
        chat_id: chatId,
        text: `Welcome to FreeStrm Bot! 🤖\n\n` +
              `Hello ${username}! You are authorized to use this bot.\n\n` +
              `📋 <b>Current Tasks:</b> No tasks available\n\n` +
              `Use /help to see all available commands.`,
        parse_mode: 'HTML'
      });
      return;
    }

    // 构建任务列表消息
    let message = `Welcome to FreeStrm Bot! 🤖\n\n` +
                  `Hello ${username}! You are authorized to use this bot.\n\n` +
                  `📋 <b>Current Tasks (${tasks.length}):</b>\n\n`;

    // 为每个任务创建按钮
    const buttons = [];
    
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const taskName = `${task.originPath} → ${task.targetPath}`;
      const taskInfo = `${i + 1}. <b>${taskName}</b>\n` +
                      `   Account: ${task.account}\n` +
                      `   Type: ${task.strmType}\n\n`;
      
      message += taskInfo;
      
      // 添加开始按钮
      buttons.push([{
        text: `▶️ Start Task ${i + 1}`,
        callback_data: `start_task_${task.id}`
      }]);
    }

    message += `Use the buttons below to start tasks, or /help for more commands.`;

    await bot.sendMessageWithButtons(chatId, message, buttons);
  } catch (error) {
    console.error("Error handling start command:", error);
    await bot.sendMessage({
      chat_id: chatId,
      text: `❌ Error loading tasks: ${error}`,
      parse_mode: 'HTML'
    });
  }
}

// 处理任务开始回调
async function handleTaskStartCallback(bot: ReturnType<typeof createTelegramBot>, chatId: string, taskId: string) {
  try {
    const tasks = readTasks();
    const task = tasks.find((t: { id: string }) => t.id === taskId);
    
    if (!task) {
      await bot.sendMessage({
        chat_id: chatId,
        text: `❌ Task not found`,
        parse_mode: 'HTML'
      });
      return;
    }

    // 发送任务开始消息
    await bot.sendMessage({
      chat_id: chatId,
      text: `🚀 <b>Starting Task</b>\n\n` +
            `📁 <b>From:</b> ${task.originPath}\n` +
            `📁 <b>To:</b> ${task.targetPath}\n` +
            `👤 <b>Account:</b> ${task.account}\n` +
            `⚙️ <b>Type:</b> ${task.strmType}\n\n` +
            `⏳ Task is starting...`,
      parse_mode: 'HTML'
    });

    // 调用真正的 startTask API
    try {
      const response = await fetch(`${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/api/startTask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: taskId })
      });

      if (response.ok) {
        await bot.sendMessage({
          chat_id: chatId,
          text: `✅ <b>Task started successfully!</b>\n\n` +
                `Task ID: <code>${taskId}</code>\n` +
                `📁 From: ${task.originPath}\n` +
                `📁 To: ${task.targetPath}\n\n` +
                `You can check the progress in the web interface.`,
          parse_mode: 'HTML'
        });
      } else {
        const errorData = await response.text();
        await bot.sendMessage({
          chat_id: chatId,
          text: `❌ <b>Failed to start task</b>\n\n` +
                `Error: ${errorData}\n` +
                `Task ID: <code>${taskId}</code>`,
          parse_mode: 'HTML'
        });
      }
    } catch (apiError) {
      console.error("Error calling startTask API:", apiError);
      await bot.sendMessage({
        chat_id: chatId,
        text: `❌ <b>API Error</b>\n\n` +
              `Failed to call startTask API: ${apiError}\n` +
              `Task ID: <code>${taskId}</code>`,
        parse_mode: 'HTML'
      });
    }

  } catch (error) {
    console.error("Error starting task:", error);
    await bot.sendMessage({
      chat_id: chatId,
      text: `❌ Error starting task: ${error}`,
      parse_mode: 'HTML'
    });
  }
}
