/**
 * 「再输一次当前密码」的核对：建智能体令牌、批准网页客户端、改密码都要。
 * 走和登录同一套失败退避（services/password-check.ts）：拿着偷来的会话在这些接口上试密码，和在登录框上试一样慢。
 * 密码错回 400 不回 401：401 会让前端当成会话失效、把人踢回登录页。
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { readAuthConfig } from "../db/repositories/auth.js";
import { HttpError } from "../lib/http-error.js";
import { checkAdminPassword } from "./password-check.js";
import { verifyPassword } from "./password.js";

export async function assertCurrentPassword(request: FastifyRequest, reply: FastifyReply, password: string): Promise<void> {
  const check = await checkAdminPassword(request, async () => {
    const stored = readAuthConfig().password;
    return verifyPassword(password, typeof stored === "string" ? stored : "");
  });
  if (check.kind === "throttled") {
    void reply.header("retry-after", String(check.wait));
    throw new HttpError(429, `尝试过于频繁，请 ${check.wait} 秒后再试`, { code: "RATE_LIMITED", retryAfterSeconds: check.wait });
  }
  if (!check.ok) throw new HttpError(400, "当前密码不正确", { code: "WRONG_PASSWORD" });
}
