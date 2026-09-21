/**
 * token 端点和撤销端点背后的事：授权码换令牌、刷新（每次都换一对新的）、撤销，以及 /mcp 上认访问令牌。
 * 令牌都是不透明的串，库里只有哈希；校验时核对过期、绑定的资源（RFC 8707）。
 *
 * 重复使用：同一个授权码 / 刷新令牌一分钟内又来了（客户端并发刷新、回应丢了重试），
 * 而且之后没再刷新过，就原样回当时那一对（令牌是派生的，算得出来，见 repositories/oauth.ts）；
 * 过了一分钟、或者之后已经刷新过了还拿旧的来，才当成被偷了拿去重放，整个授权作废。
 */
import { createHash } from "node:crypto";
import type { AgentToken } from "@openstrm/shared";
import {
  createOAuthGrant,
  deleteOAuthGrant,
  expireOAuthAccessToken,
  findGrantByAccessToken,
  findGrantByRefreshToken,
  findOAuthRequestByCode,
  getOAuthGrant,
  markOAuthCodeUsed,
  replayTokens,
  rotateOAuthGrant,
  touchOAuthClient,
  touchOAuthGrant,
  usedRefreshToken,
  type IssuedTokens,
  type OAuthClientRecord,
  type OAuthGrantRecord,
} from "../../db/repositories/oauth.js";
import { moduleLogger } from "../../lib/logger.js";
import { ACCESS_TOKEN_TTL_S, OFFLINE_ACCESS, REFRESH_TOKEN_TTL_S, REUSE_GRACE_S, sameResource, type OAuthConfig } from "./config.js";
import { OAuthError } from "./errors.js";

const log = moduleLogger("oauth");

const TTL = { accessSeconds: ACCESS_TOKEN_TTL_S, refreshSeconds: REFRESH_TOKEN_TTL_S };

const nowS = () => Math.floor(Date.now() / 1000);

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function tokenResponse(grant: Pick<OAuthGrantRecord, "scopes" | "offline">, tokens: IssuedTokens, now = nowS()): TokenResponse {
  return {
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: Math.max(0, tokens.accessExpiresAt - now),
    refresh_token: tokens.refreshToken,
    scope: [...grant.scopes, ...(grant.offline ? [OFFLINE_ACCESS] : [])].join(" "),
  };
}

const invalidGrant = (en: string, zh: string) => new OAuthError("invalid_grant", en, 400, zh);

/** resource 参数（RFC 8707）：带了就得是本实例的 /mcp（大小写、默认端口、结尾的 / 都不计较） */
function checkResource(resource: string | undefined, expected: string): void {
  if (resource && !sameResource(resource, expected)) {
    throw new OAuthError("invalid_target", `resource must be ${expected}`, 400, `resource 要是 ${expected}`);
  }
}

/** PKCE：只收 S256，校验值是 code_verifier 的 SHA-256 的 base64url */
function pkceOk(verifier: string | undefined, challenge: string): boolean {
  if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

export function exchangeAuthorizationCode(body: Record<string, string>, client: OAuthClientRecord, cfg: OAuthConfig): TokenResponse {
  const code = body.code;
  if (!code) throw new OAuthError("invalid_request", "code is required", 400, "缺少 code");
  const request = findOAuthRequestByCode(code);
  if (!request) throw invalidGrant("invalid authorization code", "授权码无效");
  const now = nowS();
  if (request.status === "used") {
    // 宽限期内、同一个客户端、PKCE 也对得上（截获了授权码的人没有 code_verifier）、换出的授权之后没刷新过：回同一对
    const grant = request.grantId ? getOAuthGrant(request.grantId) : undefined;
    if (
      grant &&
      request.usedAt !== null &&
      now - request.usedAt <= REUSE_GRACE_S &&
      request.clientId === client.id &&
      pkceOk(body.code_verifier, request.codeChallenge)
    ) {
      const tokens = replayTokens(grant, code);
      if (tokens) {
        log.info({ grantId: grant.id, client: client.name }, "授权码在宽限期内重复使用，回同一对令牌");
        return tokenResponse(grant, tokens, now);
      }
    }
    // 多半是被截获了拿来重放：用它换出去的令牌整个作废（RFC 6749 §4.1.2）
    if (request.grantId) deleteOAuthGrant(request.grantId);
    log.warn({ requestId: request.id, client: request.clientName }, "授权码被重复使用，已撤销用它换的令牌");
    throw invalidGrant("authorization code already used; the tokens issued with it have been revoked", "授权码已经用过了，用它换的令牌也作废了，重新连接一次");
  }
  if (request.status !== "issued" || request.codeExpiresAt === null || request.codeExpiresAt <= now) {
    throw invalidGrant("authorization code expired", "授权码过期了，重新连接一次");
  }
  if (request.clientId !== client.id) throw invalidGrant("authorization code was issued to another client", "授权码不是发给这个客户端的");
  if (body.redirect_uri !== undefined && body.redirect_uri !== request.redirectUri) {
    throw invalidGrant("redirect_uri does not match the authorization request", "redirect_uri 和授权时的不一样");
  }
  if (!pkceOk(body.code_verifier, request.codeChallenge)) throw invalidGrant("code_verifier missing or does not match", "code_verifier 缺了或者和授权时的 code_challenge 对不上");
  checkResource(body.resource, request.resource);
  // 公网地址改过了：授权时绑的资源已经不是现在的 /mcp
  if (!sameResource(request.resource, cfg.resource)) throw invalidGrant("the server address has changed; authorize again", "公网地址改过了，重新连接一次");

  const { grant, tokens } = createOAuthGrant(
    {
      clientId: client.id,
      clientName: request.clientName,
      scopes: request.grantedScopes ?? ["read"],
      toolsets: request.grantedToolsets ?? [],
      offline: request.requestedScope.split(/\s+/).includes(OFFLINE_ACCESS),
      resource: cfg.resource,
      approvedVia: request.approvedVia,
      approvedAt: request.decidedAt,
      requestIp: request.ip || null,
    },
    code,
    TTL,
    now,
  );
  // 整个换令牌是同步的（中间没有 await），两个并发的请求不会都走到这里；标记失败就是被别人抢先用了
  if (!markOAuthCodeUsed(request.id, grant.id, now)) {
    deleteOAuthGrant(grant.id);
    throw invalidGrant("authorization code already used", "授权码已经用过了");
  }
  touchOAuthClient(client.id, now);
  log.info({ grantId: grant.id, client: grant.clientName, scopes: grant.scopes }, "OAuth 授权完成，发了令牌");
  return tokenResponse(grant, tokens, now);
}

export function refreshAccessToken(body: Record<string, string>, client: OAuthClientRecord, cfg: OAuthConfig): TokenResponse {
  const refresh = body.refresh_token;
  if (!refresh) throw new OAuthError("invalid_request", "refresh_token is required", 400, "缺少 refresh_token");
  const now = nowS();
  const used = usedRefreshToken(refresh);
  if (used) {
    const grant = getOAuthGrant(used.grantId);
    if (grant && grant.clientId === client.id && now - used.usedAt <= REUSE_GRACE_S) {
      const tokens = replayTokens(grant, refresh);
      if (tokens) {
        log.info({ grantId: grant.id, client: client.name }, "刷新令牌在宽限期内重复使用（并发刷新或重试），回同一对令牌");
        return tokenResponse(grant, tokens, now);
      }
    }
    // 换过的刷新令牌又出现了，而且不是刚换完的重试：要么客户端出了错，要么令牌被偷了。分不清就一起作废，让客户端重新授权
    if (grant) deleteOAuthGrant(grant.id);
    log.warn({ grantId: used.grantId, client: client.name }, "刷新令牌被重复使用，已撤销这次授权");
    throw invalidGrant("refresh token already used; this authorization has been revoked", "刷新令牌已经用过了，这次授权已作废，重新连接一次");
  }
  const grant = findGrantByRefreshToken(refresh);
  if (!grant || grant.clientId !== client.id) throw invalidGrant("invalid refresh token", "刷新令牌无效");
  if (grant.refreshExpiresAt <= now) {
    deleteOAuthGrant(grant.id);
    throw invalidGrant("refresh token expired", "刷新令牌过期了，重新连接一次");
  }
  checkResource(body.resource, grant.resource);
  if (!sameResource(grant.resource, cfg.resource)) throw invalidGrant("the server address has changed; authorize again", "公网地址改过了，重新连接一次");
  const tokens = rotateOAuthGrant(grant.id, refresh, TTL, now);
  if (!tokens) throw invalidGrant("invalid refresh token", "刷新令牌无效");
  touchOAuthClient(client.id, now);
  return tokenResponse(grant, tokens, now);
}

/** 撤销（RFC 7009）：认不出的令牌也回成功。刷新令牌 → 整个授权作废；访问令牌 → 只作废它 */
export function revokeToken(body: Record<string, string>, client: OAuthClientRecord): void {
  const token = body.token;
  if (!token) throw new OAuthError("invalid_request", "token is required", 400, "缺少 token");
  const refreshGrant = findGrantByRefreshToken(token);
  if (refreshGrant) {
    if (refreshGrant.clientId === client.id) deleteOAuthGrant(refreshGrant.id);
    return;
  }
  const accessGrant = findGrantByAccessToken(token, 0);
  if (accessGrant && accessGrant.clientId === client.id) expireOAuthAccessToken(token);
}

/**
 * /mcp 上认访问令牌：没过期（当前的，或刷新前的那个）、绑定的资源就是现在的 /mcp。
 * 返回和手建令牌一样形状的「令牌」，后面的档位、工具集、限流、调用记录都不用分两套
 */
export function verifyOAuthAccessToken(raw: string, ip: string | null, cfg: OAuthConfig): AgentToken | null {
  const grant = findGrantByAccessToken(raw);
  if (!grant || !sameResource(grant.resource, cfg.resource)) return null;
  touchOAuthGrant(grant.id, ip);
  return {
    id: grant.id,
    name: `${grant.clientName}（OAuth）`,
    prefix: raw.slice(0, 12),
    scopes: grant.scopes,
    toolsets: grant.toolsets,
    createdAt: grant.createdAt,
    expiresAt: grant.accessExpiresAt,
    lastUsedAt: grant.lastUsedAt,
    lastUsedIp: grant.lastUsedIp,
  };
}
