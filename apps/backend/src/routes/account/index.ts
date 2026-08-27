import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AccountInfo } from "@openstrm/shared";
import {
  deleteAccount,
  getAccount,
  insertAccount,
  listAccounts,
  updateAccount,
} from "../../db/repositories/accounts.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { accountInputSchema, accountPatchSchema } from "../../schemas/entities.js";

const nameQuerySchema = z.object({ name: z.string().min(1, "Missing name") });

/** 改账号时凭据可以不传（沿用旧值），但传了 accountType 就得配套 */
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
    const account = parse(accountInputSchema, request.body) as AccountInfo;
    if (getAccount(account.name)) throw new HttpError(409, "Account name already exists");
    insertAccount(account);
    return reply.code(201).send(account);
  });

  fastify.put("/api/account", { preHandler: [fastify.authenticate] }, async (request) => {
    const body = parse(accountPatchSchema, request.body);
    const missing = missingCredentials(body);
    if (missing) throw new HttpError(400, missing);
    const updated = updateAccount(body.name, body);
    if (!updated) throw new HttpError(404, "Account not found");
    return updated;
  });

  fastify.delete("/api/account", { preHandler: [fastify.authenticate] }, async (request) => {
    const { name } = parse(nameQuerySchema, request.query, "query");
    if (!deleteAccount(name)) throw new HttpError(404, "Account not found");
    return { message: "Account deleted" };
  });
}
