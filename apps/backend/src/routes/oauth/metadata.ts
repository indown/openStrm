/**
 * 两份元数据：受保护资源元数据（RFC 9728，claude.ai、ChatGPT 从 401 的 WWW-Authenticate 找到它），
 * 授权服务器元数据（RFC 8414）。不挂 OIDC 发现地址：我们不是 OIDC 提供方（没有 id_token、jwks），
 * 严格的客户端在那儿拿到缺必填项的文档反而会报错；按规范它们会先试 RFC 8414 的地址。
 */
import type { FastifyInstance } from "fastify";
import { MCP_PATH } from "../../services/agent/access.js";
import { OAUTH_PATHS, RESOURCE_SCOPES, SUPPORTED_SCOPES, WELL_KNOWN_AS, WELL_KNOWN_PRM, endpoint, type OAuthConfig } from "../../services/oauth/config.js";
import { requireOAuth } from "./common.js";

/** 客户端认证方式：none 必须排第一——有的客户端做动态注册时直接取列表里的第一种 */
const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"];

/** 资源这边只列日常三档（见 config.ts 的 RESOURCE_SCOPES）：有的客户端照单全要 */
export function resourceMetadata(cfg: OAuthConfig) {
  return {
    resource: cfg.resource,
    authorization_servers: [cfg.issuer],
    scopes_supported: [...RESOURCE_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "OpenStrm",
  };
}

export function authorizationServerMetadata(cfg: OAuthConfig) {
  return {
    issuer: cfg.issuer,
    authorization_endpoint: endpoint(cfg, OAUTH_PATHS.authorize),
    token_endpoint: endpoint(cfg, OAUTH_PATHS.token),
    registration_endpoint: endpoint(cfg, OAUTH_PATHS.register),
    revocation_endpoint: endpoint(cfg, OAUTH_PATHS.revoke),
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: AUTH_METHODS,
    revocation_endpoint_auth_methods_supported: AUTH_METHODS,
    scopes_supported: [...SUPPORTED_SCOPES],
    // 设置里开了才声明 CIMD：声明了客户端就只走 CIMD、不会退回动态注册，本机取不到元数据就谁也连不上
    ...(cfg.cimd ? { client_id_metadata_document_supported: true } : {}),
    // 每次授权回跳都带 iss（RFC 9207）
    authorization_response_iss_parameter_supported: true,
  };
}

export default async function (fastify: FastifyInstance) {
  for (const path of [WELL_KNOWN_PRM, `${WELL_KNOWN_PRM}${MCP_PATH}`]) {
    fastify.get(path, async (_request, reply) => {
      const cfg = requireOAuth(reply);
      if (!cfg) return reply;
      return reply.header("cache-control", "public, max-age=300").send(resourceMetadata(cfg));
    });
  }
  fastify.get(WELL_KNOWN_AS, async (_request, reply) => {
    const cfg = requireOAuth(reply);
    if (!cfg) return reply;
    return reply.header("cache-control", "public, max-age=300").send(authorizationServerMetadata(cfg));
  });
}
