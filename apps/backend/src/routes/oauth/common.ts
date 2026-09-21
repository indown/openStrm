/**
 * OAuth 路由共用的：没启用时一律 404；错误回 RFC 6749 的 { error, error_description }，不是我们平时的 { message } 壳；
 * 没登录的请求按来源限流。
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ipKey } from "../../lib/ip.js";
import { moduleLogger } from "../../lib/logger.js";
import { anonymousIpBucket } from "../../services/agent/rate-limit.js";
import { oauthConfig, type OAuthConfig } from "../../services/oauth/config.js";
import { OAuthError } from "../../services/oauth/errors.js";

const log = moduleLogger("oauth");

/** 开了智能体接入、填了公网地址才有 OAuth；没有就当这些路径不存在 */
export function requireOAuth(reply: FastifyReply): OAuthConfig | null {
  const cfg = oauthConfig();
  if (!cfg) {
    void reply.code(404).send({ error: "not_found", error_description: "web client access (OAuth) is not enabled on this server" });
    return null;
  }
  return cfg;
}

/** 没登录的请求按来源限流：超了回 429 带 retry-after */
export function throttleAnonymous(request: FastifyRequest, reply: FastifyReply): boolean {
  const quota = anonymousIpBucket.take(`ip:${ipKey(request.ip)}`);
  if (quota.ok) return true;
  void reply
    .code(429)
    .header("retry-after", String(quota.retryAfterSeconds))
    .send({ error: "temporarily_unavailable", error_description: `too many requests, retry in ${quota.retryAfterSeconds} seconds` });
  return false;
}

/**
 * 回 OAuth 格式的错误。basic：客户端用的是 Authorization: Basic，401 时按规范带 WWW-Authenticate；
 * withMessage：授权页自己的脚本来的请求，另外带一句中文 message 给人看
 */
export function sendOAuthError(reply: FastifyReply, err: unknown, opts: { basic?: boolean; withMessage?: boolean } = {}) {
  if (err instanceof OAuthError) {
    if (err.status === 401 && opts.basic) void reply.header("www-authenticate", 'Basic realm="OpenStrm"');
    return reply.code(err.status).send(opts.withMessage ? { ...err.toJSON(), message: err.forHuman } : err.toJSON());
  }
  log.error({ err }, "OAuth 处理出错");
  return reply.code(500).send({ error: "server_error", error_description: "internal server error" });
}

/**
 * 这个插件里的路由出了 Fastify 自己的错（body 不是合法 JSON、太大、content-type 不认）也回 OAuth 格式：
 * 不然客户端拿到的是我们平时的 { message, code }，认不出是 invalid_request
 */
export function useOAuthErrorFormat(fastify: FastifyInstance): void {
  fastify.setErrorHandler((err: FastifyError, _request, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) return sendOAuthError(reply, err);
    return reply.code(status).send({ error: "invalid_request", error_description: `malformed request (${err.code ?? "bad request"})` });
  });
}

/** 查询串、表单里的参数只认单个字符串：同名参数带了两个一律当没带 */
export function stringParams(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === "string") out[k] = x;
  return out;
}
