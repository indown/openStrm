import type { FastifyInstance } from "fastify";
import { clearRateLimiters } from "../../services/download/rate-limited.js";

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/clearRateLimiters", { preHandler: [fastify.authenticate] }, async () => {
    clearRateLimiters();
    return { message: "Rate limiters cleared" };
  });
}
