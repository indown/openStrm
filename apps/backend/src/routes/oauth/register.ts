/** 动态注册（RFC 7591）：谁都能发，按来源和全局限流、body 最多 16 KB；只发公开客户端 */
import type { FastifyInstance } from "fastify";
import { ipKey } from "../../lib/ip.js";
import { registrationGlobalBucket, registrationIpBucket } from "../../services/agent/rate-limit.js";
import { registerClient } from "../../services/oauth/clients.js";
import { OAUTH_PATHS } from "../../services/oauth/config.js";
import { requireOAuth, sendOAuthError, throttleAnonymous, useOAuthErrorFormat } from "./common.js";

export default async function (fastify: FastifyInstance) {
  useOAuthErrorFormat(fastify);

  fastify.post(OAUTH_PATHS.register, { bodyLimit: 16 * 1024 }, async (request, reply) => {
    if (!requireOAuth(reply) || !throttleAnonymous(request, reply)) return reply;
    const busy = (retryAfter: number) =>
      reply
        .code(429)
        .header("retry-after", String(retryAfter))
        .send({ error: "temporarily_unavailable", error_description: "too many client registrations, retry later" });
    const perIp = registrationIpBucket.take(`ip:${ipKey(request.ip)}`);
    if (!perIp.ok) return busy(perIp.retryAfterSeconds);
    const global = registrationGlobalBucket.take("all");
    if (!global.ok) return busy(global.retryAfterSeconds);
    try {
      return reply.code(201).header("cache-control", "no-store").send(registerClient(request.body));
    } catch (err) {
      return sendOAuthError(reply, err);
    }
  });
}
