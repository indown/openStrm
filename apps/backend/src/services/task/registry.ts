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
  cancelled?: boolean;
  error?: string;
  message?: string;
}

export interface RunningTask {
  subject: Subject<DownloadProgress>;
  subscription: Subscription;
  logs: string[];
  /** 取消时的收尾（把执行历史标成 cancelled 等），由 runner 提供 */
  onCancel?: (reason: string) => void;
}

const running = new Map<string, RunningTask>();
/** 正在准备启动（拉远端目录树等）、还没注册进 running 的任务 */
const starting = new Set<string>();

export function getRunningTask(id: string): RunningTask | undefined {
  return running.get(id);
}

export function isTaskRunning(id: string): boolean {
  return running.has(id) || starting.has(id);
}

export function listRunningTaskIds(): string[] {
  return [...new Set([...starting, ...running.keys()])];
}

/**
 * 占住启动权。startTask 在第一个 await 之前调它：拉远端目录树可能要几分钟，
 * 这期间 cron 和手动点击都会再进来，只查 running 表挡不住第二次——
 * 同一任务跑两遍，下载翻倍，后注册的把先注册的进度流顶掉。
 */
export function reserveTaskStart(id: string): boolean {
  if (running.has(id) || starting.has(id)) return false;
  starting.add(id);
  return true;
}

export function releaseTaskStart(id: string): void {
  starting.delete(id);
}

export function registerRunningTask(id: string, task: RunningTask): void {
  running.set(id, task);
}

export function unregisterRunningTask(id: string): void {
  running.delete(id);
}

/**
 * 取消：退订下载流（进行中的被中止、排队的不再发出）、收尾执行历史、通知订阅者、从表里摘掉。
 * 以前只退订：历史一直挂着 running 到下次重启，已经交给限流器的下载还在继续写盘。
 * 没在跑返回 false。
 */
export function cancelRunningTask(id: string, reason = "用户取消"): boolean {
  const task = running.get(id);
  if (!task) return false;
  // 先摘掉：退订过程中还会有零星进度事件，runner 的 pushLog 靠这个判断不再往流里写
  running.delete(id);
  task.subscription.unsubscribe();
  try {
    task.onCancel?.(reason);
  } catch {
    /* 收尾失败不影响取消本身 */
  }
  task.subject.next({ done: true, cancelled: true, message: `任务已取消：${reason}` });
  task.subject.complete();
  return true;
}

/** 进程退出时把所有订阅者收尾，SSE 连接才会正常关闭 */
export function cancelAllRunningTasks(): void {
  for (const id of [...running.keys()]) cancelRunningTask(id, "进程退出");
}
