import fp from "fastify-plugin";
import { Subject, Subscription } from "rxjs";

export interface DownloadProgress {
  filePath?: string;
  percent?: number;
  overallPercent?: string;
  done?: boolean;
  error?: string;
  message?: string;
}

export interface DownloadTask {
  subject: Subject<DownloadProgress>;
  subscription: Subscription;
  logs: string[];
}

export const taskManagerPlugin = fp(async (fastify) => {
  const tasks: Record<string, DownloadTask> = {};

  fastify.decorate("downloadTasks", tasks);

  fastify.addHook("onClose", () => {
    for (const [id, task] of Object.entries(tasks)) {
      task.subscription.unsubscribe();
      task.subject.complete();
      delete tasks[id];
    }
  });
}, { name: "task-manager" });

declare module "fastify" {
  interface FastifyInstance {
    downloadTasks: Record<string, DownloadTask>;
  }
}
