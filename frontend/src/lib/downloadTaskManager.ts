import { Subject, Subscription } from "rxjs";

export interface DownloadProgress {
  filePath?: string;
  percent?: number;
  overallPercent?: string;
  done?: boolean;
  error?: string;
}
// 每个任务存 subject 和 subscription
export interface DownloadTask {
  subject: Subject<DownloadProgress>;
  subscription: Subscription;
  logs: string[];
}

const g = globalThis as unknown as {
  __downloadTasks?: Record<string, DownloadTask>;
};


if (!g.__downloadTasks) {
  g.__downloadTasks = {};
}

export const downloadTasks = g.__downloadTasks;
