import type { FastifyInstance } from "fastify";

export default async function (fastify: FastifyInstance) {
  // GET: list all accounts
  fastify.get("/api/account", { preHandler: [fastify.authenticate] }, async () => {
    return fastify.readAccounts();
  });

  // POST: create account
  fastify.post("/api/account", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const { accountType, name } = body;

    if (!accountType || !name) {
      return reply.code(400).send({ error: "accountType and name are required" });
    }

    if (accountType === "115") {
      if (!body.cookie) {
        return reply.code(400).send({ error: "cookie is required for 115 accounts" });
      }
    } else if (accountType === "openlist") {
      if (!body.account || !body.password || !body.url) {
        return reply.code(400).send({ error: "account, password, and url are required for openlist accounts" });
      }
    }

    const accounts = fastify.readAccounts();
    if (accounts.find((a) => a.name === name)) {
      return reply.code(400).send({ error: "Account name already exists" });
    }

    const newAccount = { ...body, accountType, name } as any;
    accounts.push(newAccount);
    fastify.writeAccounts(accounts);

    return reply.code(201).send(newAccount);
  });

  // PUT: update account
  fastify.put("/api/account", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const { name, accountType } = body;

    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }

    if (accountType === "115" && !body.cookie) {
      return reply.code(400).send({ error: "cookie is required for 115 accounts" });
    }
    if (accountType === "openlist" && (!body.account || !body.password || !body.url)) {
      return reply.code(400).send({ error: "account, password, and url are required for openlist accounts" });
    }

    const accounts = fastify.readAccounts();
    const idx = accounts.findIndex((a) => a.name === name);
    if (idx === -1) {
      return reply.code(404).send({ error: "Account not found" });
    }

    accounts[idx] = { ...accounts[idx], ...body } as any;
    fastify.writeAccounts(accounts);
    return accounts[idx];
  });

  // DELETE: delete account
  fastify.delete("/api/account", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { name } = request.query as { name?: string };
    if (!name) {
      return reply.code(400).send({ error: "Missing name" });
    }

    const accounts = fastify.readAccounts();
    const filtered = accounts.filter((a) => a.name !== name);
    if (filtered.length === accounts.length) {
      return reply.code(404).send({ error: "Account not found" });
    }

    fastify.writeAccounts(filtered);
    return { message: "Account deleted" };
  });
}
