import fp from "fastify-plugin";
import { SignJWT, jwtVerify } from "jose";
import type { FastifyRequest, FastifyReply } from "fastify";

import { isUsingDefaultPassword, resolveJwtSecret } from "../db/repositories/auth.js";
import { HttpError } from "../lib/http-error.js";

/** 前端据此把用户引导到改密码页，不要改动字面量。 */
export const PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED";

export const authPlugin = fp(async (fastify) => {
  // 必须在插件体内取密钥：ESM 的 import 求值早于 index.ts 里的 initDb()，
  // 放在模块顶层读库会撞上还没建好的表。
  const JWT_SECRET = new TextEncoder().encode(resolveJwtSecret());

  if (isUsingDefaultPassword()) {
    fastify.log.warn("[auth] 仍在使用默认密码，除修改密码外的接口一律拒绝");
  }

  // JWT sign helper
  fastify.decorate("signJwt", async (payload: Record<string, unknown>) => {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("24h")
      .sign(JWT_SECRET);
  });

  // JWT verify helper
  fastify.decorate("verifyJwt", async (token: string) => {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload;
  });

  // Auth preHandler hook
  fastify.decorate("authenticate", async (request: FastifyRequest, _reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      throw new HttpError(401, "Unauthorized", { code: "UNAUTHORIZED" });
    }
    try {
      request.user = await fastify.verifyJwt(authHeader.slice(7));
    } catch {
      throw new HttpError(401, "Invalid or expired token", { code: "UNAUTHORIZED" });
    }

    // 默认口令是公开的，此时拿到 token 不代表这个人有权限。除改密码本身外
    // 一律挡下——判断放在这里，是因为所有受保护路由共用这一个 preHandler，
    // 逐个路由加守卫早晚会漏掉一个。
    if (!request.routeOptions.config?.allowDefaultPassword && isUsingDefaultPassword()) {
      throw new HttpError(403, "请先修改默认密码", { code: PASSWORD_CHANGE_REQUIRED });
    }
  });
}, { name: "auth" });

declare module "fastify" {
  interface FastifyContextConfig {
    /** 置为 true 的路由在强制改密码期间依然可以访问 */
    allowDefaultPassword?: boolean;
  }
  interface FastifyInstance {
    signJwt: (payload: Record<string, unknown>) => Promise<string>;
    verifyJwt: (token: string) => Promise<Record<string, unknown>>;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user?: Record<string, unknown>;
  }
}
