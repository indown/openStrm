import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword, readAuthConfig } from "../../db/repositories/auth.js";
import { verifyPassword } from "../../services/password.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";

const MIN_LENGTH = 8;

const changeSchema = z.object({
  currentPassword: z.string().default(""),
  newPassword: z.string().min(MIN_LENGTH, `新密码至少 ${MIN_LENGTH} 位`),
});

export default async function (fastify: FastifyInstance) {
  fastify.post(
    "/api/auth/password",
    // allowDefaultPassword：强制改密期间这是唯一还走得通的接口，
    // 不放行的话用户会被锁在自己的实例外面。
    {
      preHandler: [fastify.authenticate],
      config: { allowDefaultPassword: true },
    },
    async (request) => {
      const { currentPassword, newPassword } = parse(changeSchema, request.body);

      const config = readAuthConfig();
      const stored = typeof config.password === "string" ? config.password : "";
      if (!(await verifyPassword(currentPassword, stored))) {
        throw new HttpError(401, "当前密码不正确");
      }
      // 允许改回默认值就等于允许绕过这道强制
      if (newPassword === DEFAULT_AUTH.password) throw new HttpError(400, "不能使用默认密码");
      if (newPassword === currentPassword) throw new HttpError(400, "新密码不能与当前密码相同");

      await writeAuthPassword(newPassword);
      fastify.log.info("[auth] 密码已更新");
      return { message: "密码修改成功" };
    },
  );
}
