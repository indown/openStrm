import type { FastifyInstance } from "fastify";

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/auth/login", async (request, reply) => {
    const { username, password } = request.body as { username: string; password: string };

    const config = fastify.readConfig();
    if (username === config.username && password === config.password) {
      const token = await fastify.signJwt({ username });
      return { message: "登录成功", token, user: { username } };
    }

    return reply.code(401).send({ error: "账号或密码错误" });
  });
}
