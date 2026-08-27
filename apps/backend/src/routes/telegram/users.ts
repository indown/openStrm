import type { FastifyInstance } from "fastify";
import { readAppSetting, writeAppSetting } from "../../db/repositories/settings.js";

function parseUserId(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

export default async function (fastify: FastifyInstance) {
  // GET: list users
  fastify.get("/api/telegram/users", { preHandler: [fastify.authenticate] }, async () => {
    const userIds = readAppSetting("telegram")?.allowedUsers ?? [];
    return { users: userIds.map((id) => ({ id })) };
  });

  // POST: add user
  fastify.post("/api/telegram/users", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { userId } = (request.body ?? {}) as { userId?: string | number };
    if (userId === undefined || userId === "") return reply.code(400).send({ error: "userId is required" });
    const id = parseUserId(userId);
    if (id === null) return reply.code(400).send({ error: "Invalid userId" });

    const telegram = readAppSetting("telegram") ?? {};
    const allowedUsers = telegram.allowedUsers ?? [];
    if (allowedUsers.includes(id)) return reply.code(409).send({ error: "User already exists" });

    writeAppSetting("telegram", { ...telegram, allowedUsers: [...allowedUsers, id] });
    return { success: true, message: "User added successfully" };
  });

  // DELETE: remove user
  fastify.delete("/api/telegram/users", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { userId } = request.query as { userId?: string };
    if (!userId) return reply.code(400).send({ error: "userId is required" });
    const id = parseUserId(userId);
    if (id === null) return reply.code(400).send({ error: "Invalid userId" });

    const telegram = readAppSetting("telegram") ?? {};
    const allowedUsers = telegram.allowedUsers ?? [];
    const remaining = allowedUsers.filter((u) => u !== id);
    if (remaining.length === allowedUsers.length) return reply.code(404).send({ error: "User not found" });

    writeAppSetting("telegram", { ...telegram, allowedUsers: remaining });
    return { success: true, message: "User removed successfully" };
  });
}
