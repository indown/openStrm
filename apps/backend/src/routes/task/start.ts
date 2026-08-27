import type { FastifyInstance } from "fastify";
import { startTask } from "../../services/task/runner.js";

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/startTask", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id } = (request.body ?? {}) as { id?: string };
    if (!id) return reply.code(400).send({ message: "id is required" });
    const result = await startTask(id);
    return reply.code(result.status).send(result.body);
  });
}
