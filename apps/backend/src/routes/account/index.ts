import type { FastifyInstance } from "fastify";
import type { AccountInfo } from "@openstrm/shared";
import {
  deleteAccount,
  getAccount,
  insertAccount,
  listAccounts,
  updateAccount,
} from "../../db/repositories/accounts.js";

function missingCredentials(body: Record<string, unknown>): string | null {
  if (body.accountType === "115" && !body.cookie) return "cookie is required for 115 accounts";
  if (body.accountType === "openlist" && (!body.account || !body.password || !body.url)) {
    return "account, password, and url are required for openlist accounts";
  }
  return null;
}

export default async function (fastify: FastifyInstance) {
  fastify.get("/api/account", { preHandler: [fastify.authenticate] }, async () => listAccounts());

  fastify.post("/api/account", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { accountType, name } = body;
    if (!accountType || typeof name !== "string" || !name) {
      return reply.code(400).send({ error: "accountType and name are required" });
    }
    const missing = missingCredentials(body);
    if (missing) return reply.code(400).send({ error: missing });
    if (getAccount(name)) return reply.code(400).send({ error: "Account name already exists" });

    const account = { ...body, accountType, name } as AccountInfo;
    insertAccount(account);
    return reply.code(201).send(account);
  });

  fastify.put("/api/account", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { name } = body;
    if (typeof name !== "string" || !name) return reply.code(400).send({ error: "name is required" });
    const missing = missingCredentials(body);
    if (missing) return reply.code(400).send({ error: missing });

    const updated = updateAccount(name, body);
    if (!updated) return reply.code(404).send({ error: "Account not found" });
    return updated;
  });

  fastify.delete("/api/account", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { name } = request.query as { name?: string };
    if (!name) return reply.code(400).send({ error: "Missing name" });
    if (!deleteAccount(name)) return reply.code(404).send({ error: "Account not found" });
    return { message: "Account deleted" };
  });
}
