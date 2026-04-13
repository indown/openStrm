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
        // Call the startTask logic via internal HTTP to reuse existing route handler
        const response = await fastify.inject({
          method: "POST",
          url: "/api/task/start",
          payload: { id: taskId },
          headers: { authorization: `Bearer __internal__` },
        });
        fastify.log.info(`[CRON] Task ${taskId} triggered, status: ${response.statusCode}`);
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
}, { name: "cron", dependencies: ["config"] });

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
