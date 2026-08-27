import fp from "fastify-plugin";
import { CronJob } from "cron";
import { listTasks } from "../db/repositories/tasks.js";
import { startTask } from "../services/task/runner.js";

interface ManagedJob {
  taskId: string;
  expression: string;
  job: CronJob;
}

export const cronPlugin = fp(async (fastify) => {
  const jobs = new Map<string, ManagedJob>();

  /** Schedule or replace a cron job for a task */
  function scheduleTask(taskId: string, cronExpression: string) {
    unscheduleTask(taskId);

    const job = new CronJob(cronExpression, async () => {
      fastify.log.info(`[CRON] Triggering task ${taskId} (${cronExpression})`);
      try {
        const result = await startTask(taskId);
        // 状态码不够看：成功时也可能是「无文件可下载」，失败原因都在 body 里
        if (result.status === 200) {
          fastify.log.info(`[CRON] Task ${taskId} triggered: ${JSON.stringify(result.body)}`);
        } else {
          fastify.log.error(`[CRON] Task ${taskId} failed with ${result.status}: ${JSON.stringify(result.body)}`);
        }
      } catch (err) {
        fastify.log.error(`[CRON] Failed to trigger task ${taskId}: ${err}`);
      }
    });

    job.start();
    jobs.set(taskId, { taskId, expression: cronExpression, job });
    fastify.log.info(`[CRON] Scheduled task ${taskId} with cron: ${cronExpression}`);
  }

  /** Stop and remove a cron job for a task */
  function unscheduleTask(taskId: string) {
    const existing = jobs.get(taskId);
    if (existing) {
      existing.job.stop();
      jobs.delete(taskId);
      fastify.log.info(`[CRON] Unscheduled task ${taskId}`);
    }
  }

  /** 按任务定义同步：有 cron 表达式的排上，没有的摘掉。任务增删改后必须调一次 */
  function syncFromConfig() {
    const scheduled = new Set<string>();
    for (const task of listTasks()) {
      if (task.cronExpression) {
        scheduleTask(task.id, task.cronExpression);
        scheduled.add(task.id);
      }
    }
    for (const [taskId] of jobs) {
      if (!scheduled.has(taskId)) unscheduleTask(taskId);
    }
  }

  function listJobs() {
    return [...jobs.values()].map((j) => ({
      taskId: j.taskId,
      expression: j.expression,
      nextRun: j.job.nextDate()?.toISO?.() ?? null,
    }));
  }

  fastify.decorate("cron", { scheduleTask, unscheduleTask, syncFromConfig, listJobs });

  fastify.addHook("onReady", () => {
    syncFromConfig();
  });

  fastify.addHook("onClose", () => {
    for (const [, managed] of jobs) managed.job.stop();
    jobs.clear();
  });
}, { name: "cron" });

declare module "fastify" {
  interface FastifyInstance {
    cron: {
      scheduleTask: (taskId: string, cronExpression: string) => void;
      unscheduleTask: (taskId: string) => void;
      syncFromConfig: () => void;
      listJobs: () => Array<{ taskId: string; expression: string; nextRun: string | null }>;
    };
  }
}
