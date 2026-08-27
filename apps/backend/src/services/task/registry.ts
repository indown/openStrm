/**
 * 正在执行的全量任务。
 *
 * 只存在于内存：进度流、订阅句柄和最近的日志行。重启后自然清空，
 * 落库的执行历史由 services/task-history.ts 负责。
 */
import type { Subject, Subscription } from "rxjs";

export interface DownloadProgress {
  filePath?: string;
  percent?: number;
  overallPercent?: string;
  done?: boolean;
  error?: string;
  message?: string;
}

export interface RunningTask {
  subject: Subject<DownloadProgress>;
  subscription: Subscription;
  logs: string[];
}

const running = new Map<string, RunningTask>();

export function getRunningTask(id: string): RunningTask | undefined {
  return running.get(id);
}

export function isTaskRunning(id: string): boolean {
  return running.has(id);
}

export function listRunningTaskIds(): string[] {
  return [...running.keys()];
}

export function registerRunningTask(id: string, task: RunningTask): void {
  running.set(id, task);
}

export function unregisterRunningTask(id: string): void {
  running.delete(id);
}

/** 取消：退订下载流、通知订阅者、从表里摘掉。没在跑返回 false */
export function cancelRunningTask(id: string): boolean {
  const task = running.get(id);
  if (!task) return false;
  task.subscription.unsubscribe();
  task.subject.next({ done: true, message: "任务已取消" });
  task.subject.complete();
  running.delete(id);
  return true;
}

/** 进程退出时把所有订阅者收尾，SSE 连接才会正常关闭 */
export function cancelAllRunningTasks(): void {
  for (const id of [...running.keys()]) cancelRunningTask(id);
}
