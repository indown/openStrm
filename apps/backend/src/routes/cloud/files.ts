import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fsFiles } from "../../services/cloud-115/client.js";
import { listAccounts } from "../../db/repositories/accounts.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { cidSchema } from "../../schemas/entities.js";

const bodySchema = z.object({ account: z.string().optional(), cid: cidSchema.default(0) });

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/115/files", { preHandler: [fastify.authenticate] }, async (request) => {
    const { account, cid } = parse(bodySchema, request.body);

    const accounts = listAccounts();
    const accountName = account ?? accounts.find((a) => a.accountType === "115")?.name;
    if (!accountName) throw new HttpError(400, "account is required and at least one 115 account must exist");

    const accountInfo = accounts.find((a) => a.name === accountName);
    if (!accountInfo || accountInfo.accountType !== "115") throw new HttpError(404, "115 account not found");
    if (!(accountInfo as any).cookie) throw new HttpError(400, "115 account cookie is required");

    const data = await fsFiles(cid, { accountInfo });
    return (data as any).data ?? [];
  });
}
