import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isUsingDefaultPassword, writeAuthPassword, readAuthConfig } from "../../db/repositories/auth.js";
import { needsRehash, verifyPassword } from "../../services/password.js";
import { HttpError } from "../../lib/http-error.js";
import { loginThrottle } from "../../services/login-throttle.js";
import { parse } from "../../lib/validate.js";

const loginSchema = z.object({ username: z.string().min(1), password: z.string() });

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/auth/login", async (request, reply) => {
    const { username, password } = parse(loginSchema, request.body);

    // 失败退避先于口令比对：锁定期内连 KDF 都不跑
    const wait = loginThrottle.blockedFor(request.ip);
    if (wait > 0) {
      reply.header("retry-after", String(wait));
      throw new HttpError(429, `尝试过于频繁，请 ${wait} 秒后再试`, { code: "RATE_LIMITED", retryAfterSeconds: wait });
    }

    const config = readAuthConfig();
    const stored = typeof config.password === "string" ? config.password : "";

    if (username !== config.username || !(await verifyPassword(password, stored))) {
      loginThrottle.recordFailure(request.ip);
      throw new HttpError(401, "账号或密码错误");
    }
    loginThrottle.recordSuccess(request.ip);

    // 升级前的库存的是明文，而登录成功是唯一还能拿到明文的时机，就地补上哈希。
    // 用户无感，也不需要任何一次性迁移脚本。
    if (needsRehash(stored)) {
      await writeAuthPassword(password);
      fastify.log.info("[auth] 已把存量口令改为哈希存储");
    }

    const token = await fastify.signJwt({ username });
    // 仍是默认口令时照常发 token——改密码接口需要它，其余接口会被 authenticate 挡下
    return {
      message: "登录成功",
      token,
      user: { username },
      mustChangePassword: isUsingDefaultPassword(),
    };
  });
}
