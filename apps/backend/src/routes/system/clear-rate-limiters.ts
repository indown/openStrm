import type { FastifyInstance } from "fastify";
import { resetThrottle } from "../../services/throttle.js";

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/clearRateLimiters", { preHandler: [fastify.authenticate] }, async () => {
    resetThrottle();
    return { message: "Rate limiters cleared" };
  });
}
