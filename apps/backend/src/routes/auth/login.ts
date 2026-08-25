import type { FastifyInstance } from "fastify";

import { isUsingDefaultPassword, writeAuthPassword } from "../../db/repositories/auth.js";
import { needsRehash, verifyPassword } from "../../services/password.js";

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/auth/login", async (request, reply) => {
    const { username, password } = request.body as { username: string; password: string };

    const config = fastify.readConfig();
    const stored = typeof config.password === "string" ? config.password : "";

    if (username === config.username && (await verifyPassword(password, stored))) {
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
    }

    return reply.code(401).send({ error: "账号或密码错误" });
  });
}
