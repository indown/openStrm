import { CronTime } from "cron";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../../lib/http-error.js";
import { messageOf } from "../../lib/errors.js";
import { parse } from "../../lib/validate.js";

/** 表单里边打边试算用，给前三次就够 */
const PREVIEW_COUNT = 3;

const previewBody = z.object({ expression: z.string().trim().min(1, "expression is required").max(200) });

export default async function (fastify: FastifyInstance) {
  // GET: list all scheduled cron jobs
  fastify.get("/api/task/cron", { preHandler: [fastify.authenticate] }, async () => {
    return { jobs: fastify.cron.listJobs() };
  });

  // POST: sync cron jobs from config (useful after task CRUD)
  fastify.post("/api/task/cron/sync", { preHandler: [fastify.authenticate] }, async () => {
    fastify.cron.syncFromConfig();
    return { message: "Cron jobs synced", jobs: fastify.cron.listJobs() };
  });

  /**
   * 试算一个 cron 表达式接下来几次什么时候跑。
   *
   * 放在后端而不是前端算，是因为必须和真正调度它的是同一个解析器、同一个时区：
   * 浏览器算出来的「每天 03:00」是浏览器所在时区的，服务器在别的时区时那句提示就是错的；
   * 而且前端再引一个 cron 库，两边对步长、别名、月末这些写法的理解迟早会分叉。
   */
  fastify.post("/api/task/cron/preview", { preHandler: [fastify.authenticate] }, async (request) => {
    const { expression } = parse(previewBody, request.body, "body");
    let time: CronTime;
    try {
      time = new CronTime(expression);
    } catch (err) {
      // 表达式不合法多半是还没打完，属于正常输入，400 带上库给的原因
      throw new HttpError(400, `cron 表达式不合法：${messageOf(err)}`);
    }
    return { next: time.sendAt(PREVIEW_COUNT).map((d) => d.toISO()) };
  });
}
