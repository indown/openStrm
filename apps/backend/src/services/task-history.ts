import type { TaskExecutionHistory } from "@openstrm/shared";
import * as repo from "../db/repositories/task-history.js";

export function readTaskHistory(): TaskExecutionHistory[] {
  return repo.getAll();
}

export function createTaskExecution(
  taskId: string,
  taskInfo: { account: string; originPath: string; targetPath: string; removeExtraFiles?: boolean },
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
  repo.insert(execution);
  return execution;
}

export function updateTaskExecution(executionId: string, updates: Partial<TaskExecutionHistory>): void {
  repo.update(executionId, updates);
}

export function addLogToTaskExecution(executionId: string, log: string): void {
  repo.appendLog(executionId, log);
}

export function completeTaskExecution(
  executionId: string,
  status: "completed" | "failed" | "cancelled",
  summary?: Partial<TaskExecutionHistory["summary"]>,
): void {
  repo.complete(executionId, status, summary);
}

export function getTaskHistory(taskId: string): TaskExecutionHistory[] {
  return repo.getByTaskId(taskId);
}

export function getAllTaskHistory(): TaskExecutionHistory[] {
  return repo.getAll();
}

export function deleteTaskExecution(executionId: string): void {
  repo.remove(executionId);
}

export function deleteAllHistory(): void {
  repo.removeAll();
}

export function cleanupOldHistory(): void {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  repo.cleanupOlderThan(cutoff);
}
