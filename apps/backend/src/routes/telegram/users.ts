import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readAppSetting, updateAppSetting } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";

const addSchema = z.object({ userId: z.union([z.string().min(1), z.number()], { error: "userId is required" }) });
const removeQuerySchema = z.object({ userId: z.string().min(1, "userId is required") });

function parseUserId(raw: string | number): number {
  const n = Number(raw);
  if (Number.isNaN(n)) throw new HttpError(400, "Invalid userId");
  return n;
}

export default async function (fastify: FastifyInstance) {
  // GET: list users
  fastify.get("/api/telegram/users", { preHandler: [fastify.authenticate] }, async () => {
    const userIds = readAppSetting("telegram")?.allowedUsers ?? [];
    return { users: userIds.map((id) => ({ id })) };
  });

  // POST: add user
  fastify.post("/api/telegram/users", { preHandler: [fastify.authenticate] }, async (request) => {
    const id = parseUserId(parse(addSchema, request.body).userId);

    // 查重和写入在同一个事务里：连点两下不会加出两条
    updateAppSetting("telegram", (telegram) => {
      const allowedUsers = telegram?.allowedUsers ?? [];
      if (allowedUsers.includes(id)) throw new HttpError(409, "User already exists");
      return { ...(telegram ?? {}), allowedUsers: [...allowedUsers, id] };
    });
    return { success: true, message: "User added successfully" };
  });

  // DELETE: remove user
  fastify.delete("/api/telegram/users", { preHandler: [fastify.authenticate] }, async (request) => {
    const id = parseUserId(parse(removeQuerySchema, request.query, "query").userId);

    updateAppSetting("telegram", (telegram) => {
      const allowedUsers = telegram?.allowedUsers ?? [];
      const remaining = allowedUsers.filter((u) => u !== id);
      if (remaining.length === allowedUsers.length) throw new HttpError(404, "User not found");
      return { ...(telegram ?? {}), allowedUsers: remaining };
    });
    return { success: true, message: "User removed successfully" };
  });
}
