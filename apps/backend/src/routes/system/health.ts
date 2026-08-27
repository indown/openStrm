import type { FastifyInstance } from "fastify";
import { sqlite } from "../../db/client.js";
import { HttpError } from "../../lib/http-error.js";

const startedAt = Date.now();

/**
 * 探活。不鉴权：给 Docker HEALTHCHECK、反代和监控用，所以只回"活着 + 库能读"，
 * 不带任何配置或统计。库读不了回 503，容器编排据此判定不健康。
 */
export default async function (fastify: FastifyInstance) {
  fastify.get("/api/health", async () => {
    try {
      sqlite.prepare("select 1").get();
    } catch (err) {
      throw new HttpError(503, `database unavailable: ${err instanceof Error ? err.message : String(err)}`, {
        status: "error",
      });
    }
    return { status: "ok", uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) };
  });
}
