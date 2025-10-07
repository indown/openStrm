import * as fs from "fs";
import * as path from "path";

export interface TaskExecutionHistory {
  id: string;
  taskId: string;
  startTime: number;
  endTime?: number;
  status: "running" | "completed" | "failed" | "cancelled";
  logs: string[];
  summary: {
    totalFiles: number;
    downloadedFiles: number;
    deletedFiles: number;
    errorMessage?: string;
  };
  taskInfo: {
    account: string;
    originPath: string;
    targetPath: string;
    removeExtraFiles: boolean;
  };
}

const historyDir = path.join(process.cwd(), "../logs");
const historyFile = path.join(historyDir, "task-history.json");

// 确保历史记录目录存在
if (!fs.existsSync(historyDir)) {
  fs.mkdirSync(historyDir, { recursive: true });
}

// 读取任务历史记录
export function readTaskHistory(): TaskExecutionHistory[] {
  if (!fs.existsSync(historyFile)) {
    return [];
  }
  
  try {
    const data = fs.readFileSync(historyFile, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    console.error("Failed to read task history:", error);
    return [];
  }
}

// 保存任务历史记录
export function saveTaskHistory(history: TaskExecutionHistory[]): void {
  try {
    // 只保留最近1000条记录，避免文件过大
    const limitedHistory = history.slice(-1000);
    fs.writeFileSync(historyFile, JSON.stringify(limitedHistory, null, 2), "utf-8");
  } catch (error) {
    console.error("Failed to save task history:", error);
  }
}

// 创建新的任务执行记录
export function createTaskExecution(taskId: string, taskInfo: any): TaskExecutionHistory {
  const history: TaskExecutionHistory = {
    id: `${taskId}_${Date.now()}`,
    taskId,
    startTime: Date.now(),
    status: "running",
    logs: [],
    summary: {
      totalFiles: 0,
      downloadedFiles: 0,
      deletedFiles: 0,
    },
    taskInfo: {
      account: taskInfo.account,
      originPath: taskInfo.originPath,
      targetPath: taskInfo.targetPath,
      removeExtraFiles: taskInfo.removeExtraFiles || false,
    },
  };

  const allHistory = readTaskHistory();
  allHistory.push(history);
  saveTaskHistory(allHistory);

  return history;
}

// 更新任务执行记录
export function updateTaskExecution(executionId: string, updates: Partial<TaskExecutionHistory>): void {
  const allHistory = readTaskHistory();
  const index = allHistory.findIndex(h => h.id === executionId);
  
  if (index !== -1) {
    allHistory[index] = { ...allHistory[index], ...updates };
    saveTaskHistory(allHistory);
  }
}

// 添加日志到任务执行记录
export function addLogToTaskExecution(executionId: string, log: string): void {
  const allHistory = readTaskHistory();
  const index = allHistory.findIndex(h => h.id === executionId);
  
  if (index !== -1) {
    allHistory[index].logs.push(log);
    // 限制日志数量，避免内存过大
    if (allHistory[index].logs.length > 5000) {
      // 保留最新的3000条日志
      allHistory[index].logs = allHistory[index].logs.slice(-3000);
    }
    saveTaskHistory(allHistory);
  }
}

// 完成任务执行记录
export function completeTaskExecution(executionId: string, status: "completed" | "failed" | "cancelled", summary?: Partial<TaskExecutionHistory["summary"]>): void {
  const allHistory = readTaskHistory();
  const index = allHistory.findIndex(h => h.id === executionId);
  
  if (index !== -1) {
    allHistory[index] = {
      ...allHistory[index],
      status,
      endTime: Date.now(),
      summary: { ...allHistory[index].summary, ...summary },
    };
    saveTaskHistory(allHistory);
  }
}

// 获取任务的历史执行记录
export function getTaskHistory(taskId: string): TaskExecutionHistory[] {
  const allHistory = readTaskHistory();
  return allHistory.filter(h => h.taskId === taskId).sort((a, b) => b.startTime - a.startTime);
}

// 获取所有任务历史记录
export function getAllTaskHistory(): TaskExecutionHistory[] {
  return readTaskHistory().sort((a, b) => b.startTime - a.startTime);
}

// 删除任务历史记录
export function deleteTaskHistory(executionId: string): void {
  const allHistory = readTaskHistory();
  const filtered = allHistory.filter(h => h.id !== executionId);
  saveTaskHistory(filtered);
}

// 清理旧的历史记录（保留最近30天）
export function cleanupOldHistory(): void {
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const allHistory = readTaskHistory();
  const filtered = allHistory.filter(h => h.startTime > thirtyDaysAgo);
  saveTaskHistory(filtered);
}

// 删除所有历史记录
export function deleteAllHistory(): void {
  // 直接保存空数组，删除所有历史记录
  saveTaskHistory([]);
}
