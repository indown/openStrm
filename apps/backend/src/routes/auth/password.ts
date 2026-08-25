import type { FastifyInstance } from "fastify";

import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";

const MIN_LENGTH = 8;

export default async function (fastify: FastifyInstance) {
  fastify.post(
    "/api/auth/password",
    // allowDefaultPassword：强制改密期间这是唯一还走得通的接口，
    // 不放行的话用户会被锁在自己的实例外面。
    {
      preHandler: [fastify.authenticate],
      config: { allowDefaultPassword: true },
    },
    async (request, reply) => {
      const { currentPassword, newPassword } = (request.body ?? {}) as {
        currentPassword?: string;
        newPassword?: string;
      };

      const config = fastify.readConfig();
      if (currentPassword !== config.password) {
        return reply.code(401).send({ error: "当前密码不正确" });
      }
      if (typeof newPassword !== "string" || newPassword.length < MIN_LENGTH) {
        return reply.code(400).send({ error: `新密码至少 ${MIN_LENGTH} 位` });
      }
      // 允许改回默认值就等于允许绕过这道强制
      if (newPassword === DEFAULT_AUTH.password) {
        return reply.code(400).send({ error: "不能使用默认密码" });
      }
      if (newPassword === currentPassword) {
        return reply.code(400).send({ error: "新密码不能与当前密码相同" });
      }

      writeAuthPassword(newPassword);
      fastify.log.info("[auth] 密码已更新");
      return { message: "密码修改成功" };
    },
  );
}
