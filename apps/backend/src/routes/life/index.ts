import type { FastifyInstance } from "fastify";
import type { LifeMonitorSettings } from "@openstrm/shared";
import {
  getLifeMonitorStatus,
  probeLifeEvents,
  startLifeMonitor,
  stopLifeMonitor,
} from "../../services/life/monitor.js";
import { listRecentLifeEvents } from "../../db/repositories/life.js";
import { BEHAVIOR_TYPE_TO_NAME } from "../../services/cloud-115/life.js";

export default async function (fastify: FastifyInstance) {
  /** 运行状态 + 统计 + 最近日志 */
  fastify.get("/api/life/monitor", { preHandler: [fastify.authenticate] }, async () => {
    return getLifeMonitorStatus();
  });

  /** 启动监控；可选地在启动前写入配置 */
  fastify.post("/api/life/monitor", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = (request.body ?? {}) as { config?: LifeMonitorSettings };
    if (body.config) {
      const settings = fastify.readSettings();
      fastify.writeSettings({
        ...settings,
        lifeMonitor: { ...(settings.lifeMonitor ?? {}), ...body.config, enabled: true },
      });
    }
    const res = await startLifeMonitor();
    if (!res.ok) return reply.code(400).send({ error: res.message });
    return { success: true, message: res.message, status: getLifeMonitorStatus() };
  });

  /** 停止监控 */
  fastify.delete("/api/life/monitor", { preHandler: [fastify.authenticate] }, async () => {
    const res = await stopLifeMonitor();
    const settings = fastify.readSettings();
    fastify.writeSettings({
      ...settings,
      lifeMonitor: { ...(settings.lifeMonitor ?? {}), enabled: false },
    });
    return { success: res.ok, message: res.message };
  });

  /** 只拉不处理，用来确认账号能不能读到生活事件 */
  fastify.post("/api/life/probe", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = (request.body ?? {}) as { limit?: number };
    const res = await probeLifeEvents(Number(body.limit) || 20);
    if (!res.ok) return reply.code(400).send({ error: res.message });
    return res;
  });

  /** 已处理事件的历史记录 */
  fastify.get("/api/life/events", { preHandler: [fastify.authenticate] }, async (request) => {
    const q = (request.query ?? {}) as { limit?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 500);
    return {
      events: listRecentLifeEvents(limit).map((e) => ({
        ...e,
        typeName: BEHAVIOR_TYPE_TO_NAME[e.type] ?? `type_${e.type}`,
      })),
    };
  });
}
