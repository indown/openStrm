import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getLifeMonitorStatus,
  probeLifeEvents,
  startLifeMonitor,
  stopLifeMonitor,
} from "../../services/life/monitor.js";
import { listRecentLifeEvents } from "../../db/repositories/life.js";
import { BEHAVIOR_TYPE_TO_NAME } from "../../services/cloud-115/life.js";
import { readAppSetting, writeAppSetting } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { lifeMonitorSchema } from "../../schemas/entities.js";

const startSchema = z.object({ config: lifeMonitorSchema.optional() });
const probeSchema = z.object({ limit: z.number().int().positive().optional() });
const eventsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) });

export default async function (fastify: FastifyInstance) {
  /** 运行状态 + 统计 + 最近日志 */
  fastify.get("/api/life/monitor", { preHandler: [fastify.authenticate] }, async () => getLifeMonitorStatus());

  /** 启动监控；可选地在启动前写入配置 */
  fastify.post("/api/life/monitor", { preHandler: [fastify.authenticate] }, async (request) => {
    const { config } = parse(startSchema, request.body);
    if (config) {
      writeAppSetting("lifeMonitor", { ...(readAppSetting("lifeMonitor") ?? {}), ...config, enabled: true });
    }
    const res = await startLifeMonitor();
    if (!res.ok) throw new HttpError(400, res.message);
    return { success: true, message: res.message, status: getLifeMonitorStatus() };
  });

  /** 停止监控 */
  fastify.delete("/api/life/monitor", { preHandler: [fastify.authenticate] }, async () => {
    const res = await stopLifeMonitor();
    writeAppSetting("lifeMonitor", { ...(readAppSetting("lifeMonitor") ?? {}), enabled: false });
    return { success: res.ok, message: res.message };
  });

  /** 只拉不处理，用来确认账号能不能读到生活事件 */
  fastify.post("/api/life/probe", { preHandler: [fastify.authenticate] }, async (request) => {
    const { limit } = parse(probeSchema, request.body);
    const res = await probeLifeEvents(limit ?? 20);
    if (!res.ok) throw new HttpError(400, res.message);
    return res;
  });

  /** 已处理事件的历史记录 */
  fastify.get("/api/life/events", { preHandler: [fastify.authenticate] }, async (request) => {
    const { limit } = parse(eventsQuerySchema, request.query, "query");
    return {
      events: listRecentLifeEvents(limit).map((e) => ({
        ...e,
        typeName: BEHAVIOR_TYPE_TO_NAME[e.type] ?? `type_${e.type}`,
      })),
    };
  });
}
