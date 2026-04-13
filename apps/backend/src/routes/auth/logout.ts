import type { FastifyInstance } from "fastify";

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/auth/logout", async () => {
    return { message: "已退出" };
  });
}
