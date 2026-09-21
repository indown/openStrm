/**
 * token 端点（授权码换令牌、刷新）和撤销端点（RFC 7009）。客户端按规范发 application/x-www-form-urlencoded，
 * 这两个路由自己认这种 body（只在这个插件里生效）；发 JSON 的也收。body 不合法也回 OAuth 格式的 invalid_request。
 */
import type { FastifyInstance } from "fastify";
import { authenticateClient, parseClientCredentials } from "../../services/oauth/clients.js";
import { OAUTH_PATHS } from "../../services/oauth/config.js";
import { OAuthError } from "../../services/oauth/errors.js";
import { exchangeAuthorizationCode, refreshAccessToken, revokeToken } from "../../services/oauth/tokens.js";
import { requireOAuth, sendOAuthError, stringParams, throttleAnonymous, useOAuthErrorFormat } from "./common.js";

export default async function (fastify: FastifyInstance) {
  useOAuthErrorFormat(fastify);
  fastify.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  fastify.post(OAUTH_PATHS.token, { bodyLimit: 16 * 1024 }, async (request, reply) => {
    void reply.header("cache-control", "no-store").header("pragma", "no-cache");
    const cfg = requireOAuth(reply);
    if (!cfg || !throttleAnonymous(request, reply)) return reply;
    const body = stringParams(request.body);
    const creds = parseClientCredentials(request.headers.authorization, body);
    try {
      if (!body.grant_type) throw new OAuthError("invalid_request", "grant_type is required", 400, "缺少 grant_type");
      const client = authenticateClient(creds);
      switch (body.grant_type) {
        case "authorization_code":
          return exchangeAuthorizationCode(body, client, cfg);
        case "refresh_token":
          return refreshAccessToken(body, client, cfg);
        default:
          throw new OAuthError("unsupported_grant_type", "only authorization_code and refresh_token are supported", 400, "只支持 authorization_code 和 refresh_token");
      }
    } catch (err) {
      return sendOAuthError(reply, err, { basic: creds.basic });
    }
  });

  fastify.post(OAUTH_PATHS.revoke, { bodyLimit: 16 * 1024 }, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    if (!requireOAuth(reply) || !throttleAnonymous(request, reply)) return reply;
    const body = stringParams(request.body);
    const creds = parseClientCredentials(request.headers.authorization, body);
    try {
      revokeToken(body, authenticateClient(creds));
      return {};
    } catch (err) {
      return sendOAuthError(reply, err, { basic: creds.basic });
    }
  });
}
