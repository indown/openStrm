import type { FastifyInstance } from "fastify";

export default async function (fastify: FastifyInstance) {
  // GET: list users
  fastify.get("/api/telegram/users", { preHandler: [fastify.authenticate] }, async () => {
    const settings = fastify.readSettings();
    const userIds = settings.telegram?.allowedUsers || [];
    return { users: userIds.map((id: number) => ({ id })) };
  });

  // POST: add user
  fastify.post("/api/telegram/users", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { userId } = request.body as { userId?: string | number };
    if (!userId) return reply.code(400).send({ error: "userId is required" });

    const userIdNum = Number(userId);
    if (isNaN(userIdNum)) return reply.code(400).send({ error: "Invalid userId" });

    const settings = fastify.readSettings();
    if (!settings.telegram) settings.telegram = {};
    if (!settings.telegram.allowedUsers) settings.telegram.allowedUsers = [];

    if (settings.telegram.allowedUsers.includes(userIdNum)) {
      return reply.code(409).send({ error: "User already exists" });
    }

    settings.telegram.allowedUsers.push(userIdNum);
    fastify.writeSettings(settings);
    return { success: true, message: "User added successfully" };
  });

  // DELETE: remove user
  fastify.delete("/api/telegram/users", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { userId } = request.query as { userId?: string };
    if (!userId) return reply.code(400).send({ error: "userId is required" });

    const userIdNum = Number(userId);
    if (isNaN(userIdNum)) return reply.code(400).send({ error: "Invalid userId" });

    const settings = fastify.readSettings();
    if (!settings.telegram?.allowedUsers) return reply.code(404).send({ error: "User not found" });

    const before = settings.telegram.allowedUsers.length;
    settings.telegram.allowedUsers = settings.telegram.allowedUsers.filter((id: number) => id !== userIdNum);

    if (settings.telegram.allowedUsers.length === before) {
      return reply.code(404).send({ error: "User not found" });
    }

    fastify.writeSettings(settings);
    return { success: true, message: "User removed successfully" };
  });
}
