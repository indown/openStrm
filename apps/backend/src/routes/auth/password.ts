import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { deleteAllApiTokens } from "../../db/repositories/api-tokens.js";
import { deleteAllOAuthGrants } from "../../db/repositories/oauth.js";
import { assertCurrentPassword } from "../../services/current-password.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";

const MIN_LENGTH = 8;

const changeSchema = z.object({
  currentPassword: z.string().default(""),
  newPassword: z.string().min(MIN_LENGTH, `新密码至少 ${MIN_LENGTH} 位`),
  /** 顺带撤销全部智能体令牌（手建的和网页客户端连上的）：它们不随改密码失效，怀疑泄露时改密码要连它们一起收回 */
  revokeAgentTokens: z.boolean().optional(),
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
    async (request, reply) => {
      const { currentPassword, newPassword, revokeAgentTokens } = parse(changeSchema, request.body);

      // 不回 401：401 会让前端当成会话失效，清掉登录状态把人踢回登录页，改密码的表单也就没了。和登录共用失败退避
      await assertCurrentPassword(request, reply, currentPassword);
      // 允许改回默认值就等于允许绕过这道强制
      if (newPassword === DEFAULT_AUTH.password) throw new HttpError(400, "不能使用默认密码");
      if (newPassword === currentPassword) throw new HttpError(400, "新密码不能与当前密码相同");

      await writeAuthPassword(newPassword);
      fastify.log.info("[auth] 密码已更新");
      const revoked = revokeAgentTokens ? deleteAllApiTokens() + deleteAllOAuthGrants() : 0;
      if (revoked > 0) fastify.log.info({ revoked }, "[auth] 改密码时一并撤销了智能体令牌");
      return { message: "密码修改成功", ...(revokeAgentTokens ? { revokedAgentTokens: revoked } : {}) };
    },
  );
}
