import type { TaskExecutionHistory, TaskExecutionSummary } from "@openstrm/shared";
import * as repo from "../db/repositories/task-history.js";

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

/** 列表不带 logs；要看日志走 getTaskExecution */
export function getTaskHistory(taskId: string): TaskExecutionSummary[] {
  return repo.getByTaskId(taskId);
}

export function getAllTaskHistory(): TaskExecutionSummary[] {
  return repo.getAll();
}

/** taskId → 最近一次执行 */
export function getLatestExecutions(): Map<string, TaskExecutionSummary> {
  return new Map(repo.getLatestPerTask().map((e) => [e.taskId, e]));
}

export function getTaskExecution(executionId: string): TaskExecutionHistory | undefined {
  return repo.getById(executionId);
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
