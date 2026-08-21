import fp from "fastify-plugin";
import { CronJob } from "cron";

interface ManagedJob {
  taskId: string;
  expression: string;
  job: CronJob;
}

export const cronPlugin = fp(async (fastify) => {
  const jobs = new Map<string, ManagedJob>();

  /** Schedule or replace a cron job for a task */
  function scheduleTask(taskId: string, cronExpression: string) {
    // Stop existing job if any
    unscheduleTask(taskId);

    const job = new CronJob(cronExpression, async () => {
      fastify.log.info(`[CRON] Triggering task ${taskId} (${cronExpression})`);
      try {
        // 复用 startTask 路由，所以要带一个真能过 fastify.authenticate 的凭据。
        // 这里现签一个 JWT——写死的假 token 过不了 verifyJwt，定时任务会静默 401。
        const token = await fastify.signJwt({ username: "cron", taskId });
        const response = await fastify.inject({
          method: "POST",
          url: "/api/startTask",
          payload: { id: taskId },
          headers: { authorization: `Bearer ${token}` },
        });
        // 状态码不够看：startTask 成功时也可能是「无文件可下载」，失败原因都在 body 里
        if (response.statusCode === 200) {
          fastify.log.info(`[CRON] Task ${taskId} triggered: ${response.body}`);
        } else {
          fastify.log.error(
            `[CRON] Task ${taskId} failed with ${response.statusCode}: ${response.body}`,
          );
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

  /** Sync cron jobs from task definitions in config */
  function syncFromConfig() {
    const tasks = fastify.readTasks();
    const scheduled = new Set<string>();

    for (const task of tasks) {
      if (task.cronExpression) {
        scheduleTask(task.id, task.cronExpression);
        scheduled.add(task.id);
      }
    }

    // Remove jobs for tasks that no longer have cron expressions
    for (const [taskId] of jobs) {
      if (!scheduled.has(taskId)) {
        unscheduleTask(taskId);
      }
    }
  }

  /** Get all scheduled jobs info */
  function listJobs() {
    return [...jobs.values()].map((j) => ({
      taskId: j.taskId,
      expression: j.expression,
      nextRun: j.job.nextDate()?.toISO?.() ?? null,
    }));
  }

  fastify.decorate("cron", {
    scheduleTask,
    unscheduleTask,
    syncFromConfig,
    listJobs,
  });

  // Load cron jobs from config on startup
  fastify.addHook("onReady", () => {
    syncFromConfig();
  });

  // Stop all jobs on close
  fastify.addHook("onClose", () => {
    for (const [, managed] of jobs) {
      managed.job.stop();
    }
    jobs.clear();
  });
}, { name: "cron", dependencies: ["config", "auth"] });

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
