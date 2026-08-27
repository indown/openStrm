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

export function addLogsToTaskExecution(executionId: string, lines: string[]): void {
  repo.appendLogs(executionId, lines);
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

const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 每条记录最多带几千行日志，不清的话这张表只增不减。启动时和之后每天各跑一次 */
export function cleanupOldHistory(): void {
  repo.cleanupOlderThan(Date.now() - HISTORY_RETENTION_MS);
}

/** 运行中的任务只存在于内存，进程重启后历史里不能永远挂着 running */
export function reconcileInterruptedExecutions(): number {
  return repo.failInterrupted("进程重启，执行中断");
}
