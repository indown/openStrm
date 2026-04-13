import fs from "node:fs";
import path from "node:path";
import type { TaskExecutionHistory } from "@openstrm/shared";

const LOGS_DIR = process.env.LOGS_DIR || path.resolve(process.cwd(), "logs");
const historyFile = path.join(LOGS_DIR, "task-history.json");

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

export function readTaskHistory(): TaskExecutionHistory[] {
  try {
    if (!fs.existsSync(historyFile)) return [];
    return JSON.parse(fs.readFileSync(historyFile, "utf-8"));
  } catch {
    return [];
  }
}

export function saveTaskHistory(history: TaskExecutionHistory[]): void {
  const limited = history.slice(-1000);
  const tmp = historyFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(limited, null, 2), "utf-8");
  fs.renameSync(tmp, historyFile);
}

export function createTaskExecution(
  taskId: string,
  taskInfo: { account: string; originPath: string; targetPath: string; removeExtraFiles?: boolean }
): TaskExecutionHistory {
  const execution: TaskExecutionHistory = {
    id: `${taskId}_${Date.now()}`,
    taskId,
    startTime: Date.now(),
    status: "running",
    logs: [],
    summary: { totalFiles: 0, downloadedFiles: 0, deletedFiles: 0 },
    taskInfo: {
      account: taskInfo.account,
      originPath: taskInfo.originPath,
      targetPath: taskInfo.targetPath,
      removeExtraFiles: taskInfo.removeExtraFiles || false,
    },
  };

  const all = readTaskHistory();
  all.push(execution);
  saveTaskHistory(all);
  return execution;
}

export function updateTaskExecution(executionId: string, updates: Partial<TaskExecutionHistory>): void {
  const all = readTaskHistory();
  const idx = all.findIndex((h) => h.id === executionId);
  if (idx !== -1) {
    all[idx] = { ...all[idx], ...updates };
    saveTaskHistory(all);
  }
}

export function addLogToTaskExecution(executionId: string, log: string): void {
  const all = readTaskHistory();
  const idx = all.findIndex((h) => h.id === executionId);
  if (idx !== -1) {
    all[idx].logs.push(log);
    if (all[idx].logs.length > 5000) {
      all[idx].logs = all[idx].logs.slice(-3000);
    }
    saveTaskHistory(all);
  }
}

export function completeTaskExecution(
  executionId: string,
  status: "completed" | "failed" | "cancelled",
  summary?: Partial<TaskExecutionHistory["summary"]>
): void {
  const all = readTaskHistory();
  const idx = all.findIndex((h) => h.id === executionId);
  if (idx !== -1) {
    all[idx] = {
      ...all[idx],
      status,
      endTime: Date.now(),
      summary: { ...all[idx].summary, ...summary },
    };
    saveTaskHistory(all);
  }
}

export function getTaskHistory(taskId: string): TaskExecutionHistory[] {
  return readTaskHistory()
    .filter((h) => h.taskId === taskId)
    .sort((a, b) => b.startTime - a.startTime);
}

export function getAllTaskHistory(): TaskExecutionHistory[] {
  return readTaskHistory().sort((a, b) => b.startTime - a.startTime);
}

export function deleteTaskExecution(executionId: string): void {
  const all = readTaskHistory();
  saveTaskHistory(all.filter((h) => h.id !== executionId));
}

export function deleteAllHistory(): void {
  saveTaskHistory([]);
}

export function cleanupOldHistory(): void {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const all = readTaskHistory();
  saveTaskHistory(all.filter((h) => h.startTime > thirtyDaysAgo));
}
