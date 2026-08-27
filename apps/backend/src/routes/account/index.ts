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
import { maskAccount, unmaskAccountPatch } from "../../lib/secrets.js";

const nameQuerySchema = z.object({ name: z.string().min(1, "Missing name") });

/** 改账号时凭据可以不传（沿用旧值），但传了 accountType 就得配套 */
function missingCredentials(input: object): string | null {
  const body = input as Record<string, unknown>;
  if (body.accountType === "115" && !body.cookie) return "cookie is required for 115 accounts";
  if (body.accountType === "openlist" && (!body.account || !body.password || !body.url)) {
    return "account, password, and url are required for openlist accounts";
  }
  return null;
}

export default async function (fastify: FastifyInstance) {
  // cookie / 密码 / 令牌只给末 4 位；编辑表单原样提交掩码值等于不改（见 lib/secrets.ts）
  fastify.get("/api/account", { preHandler: [fastify.authenticate] }, async () => listAccounts().map(maskAccount));

  fastify.post("/api/account", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = parse(accountInputSchema, request.body) as AccountInfo;
    if (getAccount(body.name)) throw new HttpError(409, "Account name already exists");
    // 新建没有原值可回填：掩码值会变成缺失，被下面的必填校验拒绝
    const account = unmaskAccountPatch(body, null);
    const missing = missingCredentials(account);
    if (missing) throw new HttpError(400, missing);
    insertAccount(account);
    return reply.code(201).send(maskAccount(account));
  });

  fastify.put("/api/account", { preHandler: [fastify.authenticate] }, async (request) => {
    const parsed = parse(accountPatchSchema, request.body);
    const body = unmaskAccountPatch(parsed, getAccount(parsed.name));
    const missing = missingCredentials(body);
    if (missing) throw new HttpError(400, missing);
    const updated = updateAccount(parsed.name, body);
    if (!updated) throw new HttpError(404, "Account not found");
    return maskAccount(updated);
  });

  fastify.delete("/api/account", { preHandler: [fastify.authenticate] }, async (request) => {
    const { name } = parse(nameQuerySchema, request.query, "query");
    if (!deleteAccount(name)) throw new HttpError(404, "Account not found");
    return { message: "Account deleted" };
  });
}
