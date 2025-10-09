import { NextRequest, NextResponse } from "next/server";
import { from, mergeMap, Subject, Subscription } from "rxjs";
import { downloadTasks, DownloadProgress } from "@/lib/downloadTaskManager";
import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import {
  buildTree,
  collectFilesAndTopEmptyDirs,
  getLocalTree,
  normalizeToStrm,
  readTasks,
  removeExtraFiles,
  notifyEmbyRefresh,
  readAccounts,
  readSettings,
} from "@/lib/serverUtils";
import {
  createTaskExecution,
  updateTaskExecution,
  addLogToTaskExecution,
  completeTaskExecution,
} from "@/lib/taskHistoryManager";
import {
  getRealDownloadLink,
  downloadOrCreateStrmLimited,
  downloadOrCreateStrm,
} from "@/lib/enqueueForAccount";
import { exportDirParse, fs_dir_getid } from "@/lib/115";
import { sendTelegramNotification } from "@/lib/telegram";

// openlist API 接口类型定义
interface OpenlistItem {
  name: string;
  is_dir: boolean;
  size?: number;
  modified?: string;
}

interface OpenlistResponse {
  code: number;
  message: string;
  data: {
    content: OpenlistItem[];
  };
}

// 节点类型定义
type TreeNode = {
  depth: number;
  key: number;
  name: string;
  parent_key: number;
};

// 获取 openlist 目录树数据
async function getOpenlistTreeData(
  baseUrl: string,
  token: string,
  originPath: string
): Promise<TreeNode[]> {
  const allPaths: string[] = [];

  // 递归收集所有文件路径
  async function collectPaths(currentPath: string): Promise<void> {
    const response = await axios.post<OpenlistResponse>(
      `${baseUrl}/api/fs/list`,
      {
        path: currentPath,
        page: 1,
        per_page: 0,
        refresh: true,
      },
      {
        headers: { Authorization: token },
      }
    );

    if (response.data.code !== 200) {
      throw new Error(
        `Failed to list directory ${currentPath}: ${response.data.message}`
      );
    }

    const items = response.data.data.content || [];

    for (const item of items) {
      const itemPath = buildPath(currentPath, item.name);
      allPaths.push(itemPath);

      if (item.is_dir) {
        await collectPaths(itemPath);
      }
    }
  }

  // 构建路径的辅助函数
  function buildPath(basePath: string, itemName: string): string {
    if (basePath === "/" || basePath === "") {
      return itemName;
    }
    return basePath.endsWith("/")
      ? `${basePath}${itemName}`
      : `${basePath}/${itemName}`;
  }

  // 清理路径，保留 originPath 的最后一层
  function cleanPaths(paths: string[]): string[] {
    const pathParts = originPath.split("/").filter((part) => part !== "");
    const lastDir = pathParts[pathParts.length - 1] || "";
    const prefixToRemove = originPath.substring(
      0,
      originPath.lastIndexOf("/" + lastDir)
    );

    return paths
      .map((path) => {
        if (prefixToRemove.length === 0) return path;

        if (path.startsWith(prefixToRemove + "/")) {
          return path.substring(prefixToRemove.length + 1);
        }
        if (path.startsWith(prefixToRemove)) {
          const cleaned = path.substring(prefixToRemove.length);
          return cleaned.startsWith("/") ? cleaned.substring(1) : cleaned;
        }
        return path;
      })
      .filter((path) => path.length > 0);
  }

  // 转换为 115 兼容的扁平格式
  function convertToFlatFormat(paths: string[]): TreeNode[] {
    const treeData: TreeNode[] = [];
    const nodeMap = new Map<string, number>(); // path -> key 映射，优化查找性能
    let keyCounter = 1;

    // 添加根节点
    treeData.push({ depth: 0, key: 0, name: "", parent_key: 0 });

    for (const fullPath of paths) {
      const pathParts = fullPath.split("/").filter((part) => part !== "");
      let parentKey = 0;
      let currentPath = "";

      for (let i = 0; i < pathParts.length; i++) {
        const name = pathParts[i].trim();
        const depth = i + 1;
        currentPath = i === 0 ? name : `${currentPath}/${name}`;

        // 使用 Map 优化节点查找
        const nodeKey = `${depth}-${name}-${parentKey}`;
        if (!nodeMap.has(nodeKey)) {
          const newNode: TreeNode = {
            depth,
            key: keyCounter++,
            name,
            parent_key: parentKey,
          };
          treeData.push(newNode);
          nodeMap.set(nodeKey, newNode.key);
          parentKey = newNode.key;
        } else {
          parentKey = nodeMap.get(nodeKey)!;
        }
      }
    }

    return treeData;
  }

  try {
    await collectPaths(originPath);
    const cleanedPaths = cleanPaths(allPaths);
    return convertToFlatFormat(cleanedPaths);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(
        `Openlist API error: ${error.response?.statusText || error.message}`
      );
    }
    throw error;
  }
}

// 启动下载任务
function startDownloadTask({
  filePaths,
  saveDir,
  account,
  taskId,
  strmPrefix,
  originPath,
  targetPath,
  removeExtraFiles,
}: {
  filePaths: string[];
  saveDir: string;
  account: string;
  taskId: string;
  strmPrefix?: string;
  originPath: string;
  targetPath: string;
  removeExtraFiles?: boolean;
}): string {
  const total = filePaths.length;
  const taskSubject = new Subject<DownloadProgress>();
  const perFile = new Map<string, number>();
  for (const fp of filePaths) perFile.set(fp, 0);

  // 创建任务执行历史记录
  const executionHistory = createTaskExecution(taskId, {
    account,
    originPath,
    targetPath,
    removeExtraFiles,
  });

  // 更新历史记录，包含文件统计信息
  updateTaskExecution(executionHistory.id, {
    summary: {
      totalFiles: total,
      downloadedFiles: 0,
      deletedFiles: 0,
    },
  });

  // 初始化 downloadTasks
  downloadTasks[taskId] = {
    subject: taskSubject,
    subscription: new Subscription(),
    logs: [],
  };

  // 发送任务开始通知
  const startMessage =
    `<b>Task ID:</b> ${taskId}\n` +
    `<b>Account:</b> ${account}\n` +
    `<b>Target Path:</b> ${targetPath}\n` +
    `<b>Files to Download:</b> ${total}\n` +
    `<b>Origin Path:</b> ${originPath}`;

  sendTelegramNotification(startMessage, "start");

  // 用于跟踪每个文件的最后记录进度，避免重复记录
  const lastRecordedProgress = new Map<string, number>();
  
  const pushLog = (log: DownloadProgress) => {
    const line = JSON.stringify(log);
    const task = downloadTasks[taskId];
    
    // 实时推送给前端（保持原有行为）
    if (task) {
      task.logs.push(line);
      if (task.logs.length > 20000) task.logs.shift(); // 防止无限增长
      task.subject.next(log);
    }
    
    // 智能记录到历史记录：只记录进度达到100%的文件
    let shouldRecordToHistory = false;
    
    if (log.filePath && log.percent !== undefined) {
      // 只记录进度达到100%的文件
      if (log.percent === 100) {
        shouldRecordToHistory = true;
        lastRecordedProgress.set(log.filePath, log.percent);
      }
    } else if (log.done || log.error) {
      // 任务完成或出错时总是记录
      shouldRecordToHistory = true;
    }
    
    if (shouldRecordToHistory) {
      addLogToTaskExecution(executionHistory.id, line);
    }
  };

  // 从配置文件读取扩展名配置
  const settings = readSettings();
  const strmExtensions = (settings.strmExtensions || []).map((ext) =>
    ext.toLowerCase()
  );
  const downloadExtensions = (settings.downloadExtensions || []).map((ext) =>
    ext.toLowerCase()
  );

  // strm 文件
  const strmFiles = filePaths.filter((fp) =>
    strmExtensions.includes(path.extname(fp).toLowerCase())
  );
  strmFiles.forEach((filePath) => {
    const savePath = path.join(saveDir, filePath);
    downloadOrCreateStrm(targetPath + "/" + filePath, savePath, {
      asStrm: true,
      displayPath: filePath,
      strmPrefix,
    }).subscribe({
      next: (p) => {
        perFile.set(p.filePath!, 100);
        pushLog({ filePath: p.filePath, percent: 100 });
      },
      error: (err) => pushLog({ error: err.message }),
    });
  });

  // 普通下载（限流）- 使用downloadExtensions过滤
  const downloadFiles = filePaths.filter((fp) =>
    downloadExtensions.includes(path.extname(fp).toLowerCase())
  );
  console.log("downloadFiles: ", downloadFiles);
  const subscription = from(downloadFiles)
    .pipe(
      mergeMap(
        (filePath) =>
          from(
            getRealDownloadLink(originPath + "/" + filePath, account)
          ).pipe(
            mergeMap((url) =>
              downloadOrCreateStrmLimited(
                url,
                path.join(saveDir, filePath),
                account,
                {
                  asStrm: false,
                  displayPath: filePath,
                }
              )
            )
          ),
        10
      )
    )
    .subscribe({
      next: (p) => {
        perFile.set(p.filePath!, Math.min(100, Math.max(0, p.percent)));
        const sum = [...perFile.values()].reduce((a, b) => a + b, 0);
        const overallPercent = (sum / total).toFixed(2);
        pushLog({ filePath: p.filePath, percent: p.percent, overallPercent });
      },
      complete: () => {
        // 记录任务完成，包含100%的总体进度
        pushLog({ done: true, overallPercent: "100.00" });
        taskSubject.complete();


        // 发送任务完成通知
        const completeMessage =
          `<b>Task ID:</b> ${taskId}\n` +
          `<b>Account:</b> ${account}\n` +
          `<b>Target Path:</b> ${targetPath}\n` +
          `<b>Files Downloaded:</b> ${total}\n` +
          `<b>Status:</b> Successfully completed`;

        sendTelegramNotification(completeMessage, "complete");

        // 更新历史记录为完成状态
        completeTaskExecution(executionHistory.id, "completed", {
          totalFiles: total,
          downloadedFiles: total,
        });

        // 下载完成后通知 Emby 刷新
        notifyEmbyRefresh();
        delete downloadTasks[taskId];
      },
      error: (err) => {
        pushLog({ error: err.message });


        // 发送任务错误通知
        const errorMessage =
          `<b>Task ID:</b> ${taskId}\n` +
          `<b>Account:</b> ${account}\n` +
          `<b>Target Path:</b> ${targetPath}\n` +
          `<b>Error:</b> ${err.message}\n` +
          `<b>Status:</b> Failed`;

        sendTelegramNotification(errorMessage, "error");

        // 更新历史记录为失败状态
        completeTaskExecution(executionHistory.id, "failed", {
          totalFiles: total,
          downloadedFiles: 0,
          errorMessage: err.message,
        });

        taskSubject.complete();
        delete downloadTasks[taskId];
      },
    });
  if (downloadTasks[taskId]) {
    downloadTasks[taskId].subscription = subscription;
  }
  return taskId;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const tasks = readTasks();
    const task = tasks.find((t: { id: string }) => t.id === body.id);
    
    if (!task) {
      return NextResponse.json({ 
        message: "Task not found", 
        error: `Task with id ${body.id} not found` 
      }, { status: 404 });
    }
    
    const { id, account, originPath, targetPath, strmPrefix } = task;

  // 从 account.json 中读取账户信息
  const accounts = readAccounts();
  const accountInfo = accounts.find(
    (acc: {
      name: string;
      accountType?: string;
      cookie?: string;
      account?: string;
      password?: string;
      url?: string;
      token?: string;
      expiresAt?: number;
    }) => acc.name === account
  );
  if (!accountInfo) {
    throw new Error(`No account found: ${account}`);
  }

  // 从 accountInfo 中获取 accountType
  const accountType = accountInfo.accountType;
  
  let tree;
  if (accountType === "115") {
    // 检查 115 必要字段
    if (!accountInfo.cookie) {
      throw new Error(`Missing cookie for 115 account: ${account}`);
    }

    const idRes = await fs_dir_getid(originPath, { accountInfo });
    // const data = await getData({ account, id, originPath });

    try {
      const data = await exportDirParse({
        exportFileIds: idRes.id, // or ['123','456'] or a string
        targetPid: 0,
        layerLimit: 0,
        deleteAfter: true,
        timeoutMs: 300000,
        checkIntervalMs: 1000,
        accountInfo,
      });
      console.log("data: ", data);
      tree = buildTree(data);
    } catch (error) {
      console.error("Failed to parse 115 directory: ", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // 检测115账号封控错误
      if (errorMessage.includes('<!doctypehtml>') || 
          errorMessage.includes('405') || 
          errorMessage.includes('您的访问被阻断') ||
          errorMessage.includes('potential threats to the server')) {
        return NextResponse.json({ 
          message: "115账号被封控", 
          error: "账号访问被阿里云阻断，请检查账号状态或稍后重试" 
        }, { status: 403 });
      }
      
      return NextResponse.json({ 
        message: "Failed to parse 115 directory", 
        error: errorMessage 
      }, { status: 500 });
    }
  } else if (accountType === "openlist") {
    // 检查 openlist 必要字段
    if (!accountInfo.account || !accountInfo.password || !accountInfo.url) {
      throw new Error(`Missing openlist credentials for account: ${account}`);
    }

    let token = accountInfo.token;

    // 检查 token 是否过期
    if (
      !token ||
      (accountInfo.expiresAt && Date.now() / 1000 > accountInfo.expiresAt)
    ) {
      // 获取新的 JWT token
      try {
        const loginResponse = await axios.post(
          `${accountInfo.url}/api/auth/login`,
          {
            username: accountInfo.account,
            password: accountInfo.password,
          }
        );

        const loginData = loginResponse.data;
        console.log("loginData: ", loginData);
        if (loginData.code !== 200) {
          throw new Error(`Openlist login failed: ${loginData.message}`);
        }

        token = loginData.data.token;
      } catch (error) {
        if (axios.isAxiosError(error)) {
          throw new Error(
            `Failed to login to openlist: ${
              error.response?.statusText || error.message
            }`
          );
        }
        throw error;
      }

      // 更新账户信息中的 token 和过期时间
      accountInfo.token = token;
      accountInfo.expiresAt = Math.floor(Date.now() / 1000) + 47 * 60 * 60; // 48小时后过期

      // 保存更新后的账户信息
      const accountPath = path.join(process.cwd(), "../config/account.json");
      fs.writeFileSync(accountPath, JSON.stringify(accounts, null, 2));
    }

    // 获取 openlist 目录树并转换为 115 兼容格式
    const openlistTreeData = await getOpenlistTreeData(
      accountInfo.url,
      token,
      originPath
    );
    tree = buildTree(openlistTreeData);
  }

  // 对于 115 网盘，继续使用原有的 buildTree 逻辑
  // const tree = buildTree(data);

  const saveDir = path.resolve(process.cwd(), `../data/${targetPath}`);
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

  // 现在 openlist 和 115 都使用相同的树结构格式，可以统一处理
  const remoteFiles: string[] = [];
  for (const node of tree) {
    if (node.children && node.children.length > 0) {
      remoteFiles.push(...collectFilesAndTopEmptyDirs(node.children));
    } else if (/\.[a-z0-9]+$/i.test(node.name)) {
      remoteFiles.push(node.name);
    }
  }
  const remotePaths = new Set(remoteFiles.map(normalizeToStrm));
  const localPaths = new Set(
    collectFilesAndTopEmptyDirs(getLocalTree(saveDir))
  );

  const missingLocally = remoteFiles.filter(
    (p) => !localPaths.has(normalizeToStrm(p))
  );
  const extraLocally = [...localPaths].filter((p) => !remotePaths.has(p));

  // 根据任务配置决定是否删除多余文件
  if (task.removeExtraFiles) {
    removeExtraFiles(extraLocally, saveDir);
  }

  if (missingLocally.length === 0) {
    return NextResponse.json({ message: "no files to download" });
  }
  console.log("missingLocally: ", missingLocally);
  startDownloadTask({
    originPath: task.originPath,
    targetPath: task.targetPath,
    filePaths: missingLocally,
    saveDir,
    account: task.account,
    taskId: task.id,
    strmPrefix,
    removeExtraFiles: task.removeExtraFiles,
  });

  const deleteMessage = task.removeExtraFiles 
    ? `${extraLocally.length} files to delete.`
    : `${extraLocally.length} extra files found (not deleted due to task settings).`;
    
  return NextResponse.json({
    message: `${missingLocally.length} files to download for task, ${deleteMessage}`,
    taskId: id,
    extraFilesCount: extraLocally.length,
    willDeleteExtraFiles: task.removeExtraFiles || false,
  });
  } catch (error) {
    console.error("StartTask error: ", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ 
      message: "Failed to start task", 
      error: errorMessage 
    }, { status: 500 });
  }
}
