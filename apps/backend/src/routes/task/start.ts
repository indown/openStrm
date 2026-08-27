import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { startTask } from "../../services/task/runner.js";
import { parse } from "../../lib/validate.js";

const startSchema = z.object({ id: z.string().min(1) });

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/startTask", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id } = parse(startSchema, request.body);
    const result = await startTask(id);
    return reply.code(result.status).send(result.body);
  });
}
