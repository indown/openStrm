import type { FastifyInstance } from "fastify";

import { isUsingDefaultPassword } from "../../db/repositories/auth.js";

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/auth/login", async (request, reply) => {
    const { username, password } = request.body as { username: string; password: string };

    const config = fastify.readConfig();
    if (username === config.username && password === config.password) {
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
