import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import { createTelegramBot, formatTaskStatusMessage, formatDownloadCompleteMessage } from "./telegram";

const accountFile = path.join(process.cwd(), "../config", "account.json");

export function readAccounts() {
  return JSON.parse(fs.readFileSync(accountFile, "utf-8"));
}

type Node = {
  key: number;
  name: string;
  parent_key: number;
  depth: number;
  children?: Node[];
};

export function getLocalTree(
  dirPath: string,
  parentKey = 0,
  depth = 0,
  keySeed = { value: 1 }
): Node[] {
  if (!fs.existsSync(dirPath)) return [];
  const nodes: Node[] = [];
  const items = fs.readdirSync(dirPath);

  for (const name of items) {
    const fullPath = path.join(dirPath, name);
    const stat = fs.statSync(fullPath);
    const node: Node = {
      key: keySeed.value++,
      name,
      parent_key: parentKey,
      depth,
      children: [],
    };
    if (stat.isDirectory()) {
      node.children = getLocalTree(fullPath, node.key, depth + 1, keySeed);
    }
    nodes.push(node);
  }
  return nodes;
}

const tasksFile = path.join(process.cwd(), "../config/tasks.json");
const settingsFile = path.join(process.cwd(), "../config/settings.json");

// 工具函数：读取任务
export function readTasks() {
  if (!fs.existsSync(tasksFile)) return [];
  const data = fs.readFileSync(tasksFile, "utf-8");
  return JSON.parse(data);
}

// 工具函数：保存任务
export function saveTasks(tasks: unknown[]) {
  fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2), "utf-8");
}

// 删除多余文件，并清理空父目录
export function removeExtraFiles(extraLocally: string[], saveDir: string) {
  const removeEmptyParents = (dir: string) => {
    if (!dir.startsWith(saveDir)) return; // 防止越界误删
    if (dir === saveDir) return; // 根目录不删
    try {
      const files = fs.readdirSync(dir);
      if (files.length === 0) {
        fs.rmdirSync(dir);
        console.log("删除空目录:", dir);
        removeEmptyParents(path.dirname(dir)); // 递归往上删
      }
    } catch (err) {
      console.error("清理空目录失败:", dir, err);
    }
  };

  extraLocally.forEach((relPath) => {
    const filePath = path.join(saveDir, relPath);
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          fs.unlinkSync(filePath);
          console.log("删除文件:", filePath);
        } else if (stat.isDirectory()) {
          fs.rmSync(filePath, { recursive: true, force: true });
          console.log("删除文件夹:", filePath);
        }
        // 删除完成后检查父目录是否为空
        removeEmptyParents(path.dirname(filePath));
      }
    } catch (err) {
      console.error("删除失败:", filePath, err);
    }
  });
}


// 构建树
export function buildTree(list: Node[]): Node[] {
  const map = new Map<number, Node>();
  const roots: Node[] = [];

  list.forEach((node) => map.set(node.key, { ...node, children: [] }));
  list.forEach((node) => {
    if (node.parent_key === 0) roots.push(map.get(node.key)!);
    else map.get(node.parent_key)?.children!.push(map.get(node.key)!);
  });

  return roots;
}

export function collectFilesAndTopEmptyDirs(
  nodes: Node[],
  parentPath = ""
): string[] {
  const result: string[] = [];

  function dfs(nodeList: Node[], basePath: string): boolean {
    let hasFileInTree = false;

    for (const node of nodeList) {
      const currentPath = basePath ? `${basePath}/${node.name}` : node.name;

      if (
        (!node.children || node.children.length === 0) &&
        /\.[a-z0-9]+$/i.test(node.name)
      ) {
        // 文件
        result.push(currentPath);
        hasFileInTree = true;
      } else if (node.children) {
        if (node.children.length > 0) {
          const subHasFile = dfs(node.children, currentPath);

          if (subHasFile) {
            hasFileInTree = true;
          }
        } else {
          // 真正空目录
          // 先标记它为空目录，但不立即加入结果
        }
      }
    }

    // 遍历完当前层
    if (!hasFileInTree && basePath) {
      // 整个子树没有文件 → 收集最上层目录
      result.push(basePath);
      return true; // 返回 true，防止父目录再收集它
    }

    return hasFileInTree;
  }

  dfs(nodes, parentPath);
  return result;
}

export function normalizeToStrm(path: string): string {
  return path.replace(/\.(mp4|mp3|mkv)$/i, ".strm");
}

// Settings helpers
export type AppSettings = {
  "user-agent"?: string;
  emby?: {
    url?: string;
    apiKey?: string;
  };
  telegram?: {
    botToken?: string;
    chatId?: string;
    webhookUrl?: string;
    allowedUsers?: number[];  // 简化为只存储用户ID列表
  };
} & Record<string, unknown>;

export function readSettings(): AppSettings {
  if (!fs.existsSync(settingsFile)) return {} as AppSettings;
  const raw = fs.readFileSync(settingsFile, "utf-8");
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {} as AppSettings;
  }
}

export function writeSettings(next: AppSettings) {
  const pretty = JSON.stringify(next ?? {}, null, 2);
  fs.writeFileSync(settingsFile, pretty, "utf-8");
}

// 通知 Emby 刷新媒体库（如果在 settings.json 配置了 emby）
export async function notifyEmbyRefresh() {
  try {
    const settingsPath = settingsFile;
    if (!fs.existsSync(settingsPath)) return;
    const settingsRaw = fs.readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(settingsRaw || "{}");
    const emby = settings.emby;
    if (!emby || !emby.url || !emby.apiKey) return;

    const base = String(emby.url).replace(/\/$/, "");
    const url = `${base}/Library/Refresh?api_key=${encodeURIComponent(emby.apiKey)}`;
    // fire-and-forget
    const res = await axios.post(url);
    console.log("Emby 刷新结果", res.status);
    console.log("Emby 刷新成功");
  } catch(err){
    console.log("Emby 刷新失败", err);
    // 忽略通知失败
  }
}

// Telegram 通知功能
export async function notifyTelegram(message: string, type: 'info' | 'error' | 'success' = 'info') {
  try {
    const settings = readSettings();
    const telegram = settings.telegram;
    
    if (!telegram || !telegram.botToken || !telegram.chatId) {
      console.log("Telegram not configured, skipping notification");
      return;
    }

    const bot = createTelegramBot(telegram.botToken);
    
    let emoji = 'ℹ️';
    switch (type) {
      case 'error':
        emoji = '❌';
        break;
      case 'success':
        emoji = '✅';
        break;
      case 'info':
      default:
        emoji = 'ℹ️';
        break;
    }

    const formattedMessage = `${emoji} <b>FreeStrm Notification</b>\n\n${message}\n\n<b>Time:</b> ${new Date().toLocaleString()}`;
    
    await bot.sendNotification(formattedMessage, telegram.chatId);
    console.log("Telegram notification sent successfully");
  } catch (error) {
    console.error("Failed to send Telegram notification:", error);
    // 忽略通知失败，不影响主流程
  }
}

// 发送任务状态通知
export async function notifyTaskStatus(task: { name?: string; progress?: number; [key: string]: unknown }, status: string) {
  try {
    const settings = readSettings();
    const telegram = settings.telegram;
    
    if (!telegram || !telegram.botToken || !telegram.chatId) {
      return;
    }

    const bot = createTelegramBot(telegram.botToken);
    const message = formatTaskStatusMessage({ ...task, status });
    
    await bot.sendNotification(message, telegram.chatId);
    console.log(`Telegram task status notification sent: ${status}`);
  } catch (error) {
    console.error("Failed to send task status notification:", error);
  }
}

// 发送下载完成通知
export async function notifyDownloadComplete(task: { name?: string; size?: number; [key: string]: unknown }) {
  try {
    const settings = readSettings();
    const telegram = settings.telegram;
    
    if (!telegram || !telegram.botToken || !telegram.chatId) {
      return;
    }

    const bot = createTelegramBot(telegram.botToken);
    const message = formatDownloadCompleteMessage(task);
    
    await bot.sendNotification(message, telegram.chatId);
    console.log("Telegram download complete notification sent");
  } catch (error) {
    console.error("Failed to send download complete notification:", error);
  }
}

// Telegram 简单权限管理
export function isTelegramUserAllowed(userId: number): boolean {
  const settings = readSettings();
  const telegram = settings.telegram;
  
  if (!telegram) {
    return false;
  }

  // 检查是否在允许用户列表中
  return telegram.allowedUsers?.includes(userId) || false;
}

export function addTelegramUser(userId: number): boolean {
  try {
    const settings = readSettings();
    if (!settings.telegram) {
      settings.telegram = {};
    }
    if (!settings.telegram.allowedUsers) {
      settings.telegram.allowedUsers = [];
    }

    // 检查用户是否已存在
    if (settings.telegram.allowedUsers.includes(userId)) {
      return false; // 用户已存在
    }

    // 添加新用户
    settings.telegram.allowedUsers.push(userId);
    writeSettings(settings);
    return true;
  } catch (error) {
    console.error("Failed to add Telegram user:", error);
    return false;
  }
}

export function removeTelegramUser(userId: number): boolean {
  try {
    const settings = readSettings();
    if (!settings.telegram?.allowedUsers) {
      return false;
    }

    const initialLength = settings.telegram.allowedUsers.length;
    settings.telegram.allowedUsers = settings.telegram.allowedUsers.filter(id => id !== userId);
    
    if (settings.telegram.allowedUsers.length < initialLength) {
      writeSettings(settings);
      return true;
    }
    
    return false; // 用户不存在
  } catch (error) {
    console.error("Failed to remove Telegram user:", error);
    return false;
  }
}

export function getTelegramUsers(): number[] {
  const settings = readSettings();
  return settings.telegram?.allowedUsers || [];
}
