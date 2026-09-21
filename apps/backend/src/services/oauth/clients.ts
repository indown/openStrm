/**
 * OAuth 客户端：认出是谁（CIMD 地址 / DCR 注册过的 / 预注册的）、动态注册、token 端点上的客户端认证。
 */
import { timingSafeEqual } from "node:crypto";
import type { OAuthClientKind } from "@openstrm/shared";
import { hashToken } from "../../db/repositories/api-tokens.js";
import { createDcrClient, getOAuthClient, saveCimdClient, type OAuthClientRecord } from "../../db/repositories/oauth.js";
import { fetchClientMetadata } from "./cimd.js";
import { CHALLENGE_SCOPE } from "./config.js";
import { OAuthError } from "./errors.js";
import { redirectUriProblem } from "./redirect.js";

const MAX_REDIRECT_URIS = 10;
const MAX_NAME = 100;

const nowS = () => Math.floor(Date.now() / 1000);

export const isUrlClientId = (clientId: string) => /^https:\/\//i.test(clientId);

/** CIMD 客户端的 client_id 是地址：它的域名才证明是谁（名字是元数据里自己写的）；别的客户端没有这个 */
export function clientHostOf(clientKind: OAuthClientKind, clientId: string): string | null {
  if (clientKind !== "cimd") return null;
  try {
    return new URL(clientId).host;
  } catch {
    return null;
  }
}

/**
 * 授权页上认客户端：client_id 是 https 地址就按 CIMD 取元数据（设置里开了才认；按对方的缓存头缓存，最长一天），
 * 否则得是注册过的。force：缓存的回调地址对不上时重取一次（对方可能刚改过）
 */
export async function resolveClient(clientId: string, cimd: boolean, force = false): Promise<OAuthClientRecord> {
  if (isUrlClientId(clientId)) {
    if (!cimd) {
      throw new OAuthError(
        "invalid_client",
        "client ID metadata documents are not enabled on this server; use dynamic client registration",
        400,
        "这个 OpenStrm 没开 CIMD（client_id 是地址的那种），客户端应该改用动态注册。要用 CIMD 到设置的「智能体接入」里打开",
      );
    }
    const cached = getOAuthClient(clientId);
    const now = nowS();
    if (!force && cached?.kind === "cimd" && cached.cacheUntil !== null && cached.cacheUntil > now) return cached;
    const { metadata, cacheSeconds } = await fetchClientMetadata(clientId);
    return saveCimdClient(
      {
        id: clientId,
        name: displayName(metadata.client_name, clientId),
        redirectUris: metadata.redirect_uris,
        scope: metadata.scope ?? "",
        cacheUntil: now + cacheSeconds,
      },
      now,
    );
  }
  const record = getOAuthClient(clientId);
  if (!record) {
    throw new OAuthError(
      "invalid_client",
      "unknown client_id",
      400,
      "不认识这个客户端：没注册过，或者注册太久没用被清掉了。在客户端里重新连接一次",
    );
  }
  return record;
}

function displayName(name: unknown, fallbackUrl?: string): string {
  const n = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME) : "";
  if (n) return n;
  if (fallbackUrl) {
    try {
      return new URL(fallbackUrl).host;
    } catch {
      // 落到下面
    }
  }
  return "未命名客户端";
}

export interface RegistrationResponse {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  scope: string;
}

const GRANT_TYPES = ["authorization_code", "refresh_token"];

/**
 * 动态注册（RFC 7591）。只发公开客户端：要了 client_secret_* 也按 none 注册，回应里如实写
 * （规范允许服务端改值，客户端以回应为准）。grant_types / response_types 同理：多要的（claude.ai 会带上 jwt-bearer）
 * 去掉、回应里写我们给的，缺了 authorization_code / code 才拒。回应要带 scope：有的客户端回应里没有 scope 就把它弄丢。
 * 只存用得上的几样，不存整份请求
 */
export function registerClient(body: unknown): RegistrationResponse {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new OAuthError("invalid_client_metadata", "registration body must be a JSON object", 400, "注册信息要是 JSON 对象");
  }
  const m = body as Record<string, unknown>;

  const uris = m.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.some((u) => typeof u !== "string")) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must be a non-empty array of strings", 400, "redirect_uris 要是非空的字符串数组");
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    throw new OAuthError("invalid_redirect_uri", `at most ${MAX_REDIRECT_URIS} redirect_uris`, 400, `回调地址最多 ${MAX_REDIRECT_URIS} 个`);
  }
  for (const u of uris as string[]) {
    const problem = redirectUriProblem(u);
    if (problem) throw new OAuthError("invalid_redirect_uri", problem.en, 400, problem.zh);
  }

  const askedGrants = m.grant_types === undefined ? GRANT_TYPES : m.grant_types;
  if (!Array.isArray(askedGrants)) throw new OAuthError("invalid_client_metadata", "grant_types must be an array", 400, "grant_types 要是数组");
  const grantTypes = GRANT_TYPES.filter((g) => askedGrants.includes(g));
  if (!grantTypes.includes("authorization_code")) {
    throw new OAuthError("invalid_client_metadata", "grant_types must include authorization_code", 400, "grant_types 里得有 authorization_code");
  }
  const askedResponses = m.response_types === undefined ? ["code"] : m.response_types;
  if (!Array.isArray(askedResponses) || !askedResponses.includes("code")) {
    throw new OAuthError("invalid_client_metadata", "response_types must include code", 400, "response_types 里得有 code");
  }

  const scope = typeof m.scope === "string" && m.scope.trim() ? m.scope.trim().slice(0, 200) : CHALLENGE_SCOPE;
  const record = createDcrClient({ name: displayName(m.client_name), redirectUris: uris as string[], scope });
  return {
    client_id: record.id,
    client_id_issued_at: record.createdAt,
    client_name: record.name,
    redirect_uris: record.redirectUris,
    grant_types: grantTypes,
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope,
  };
}

/** token / revoke 端点上的客户端身份：Basic 头或表单里的 client_id / client_secret */
export interface ClientCredentials {
  clientId?: string;
  clientSecret?: string;
  /** 用的是 Authorization: Basic（认证失败时要回 401 带 WWW-Authenticate） */
  basic: boolean;
}

export function parseClientCredentials(authorization: string | undefined, body: Record<string, string>): ClientCredentials {
  // 认证方案名不分大小写（RFC 9110 §11.1）
  const m = authorization ? /^basic\s+(.*)$/i.exec(authorization.trim()) : null;
  if (m) {
    // base64 解不出来的字符 Buffer 直接跳过，不会抛
    const decoded = Buffer.from(m[1].trim(), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i > 0) {
      // RFC 6749 §2.3.1：Basic 里的 id 和 secret 是先按表单编码过的
      const unescape = (s: string) => {
        try {
          return decodeURIComponent(s.replace(/\+/g, " "));
        } catch {
          return s;
        }
      };
      return { clientId: unescape(decoded.slice(0, i)), clientSecret: unescape(decoded.slice(i + 1)), basic: true };
    }
    return { basic: true };
  }
  return { clientId: body.client_id || undefined, clientSecret: body.client_secret || undefined, basic: false };
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * 认客户端：预注册的必须带对 secret；公开客户端（DCR、CIMD）只看 client_id 认不认得，带了 secret 也不看。
 * 失败回 invalid_client：用 Basic 认证的回 401（路由会带上 WWW-Authenticate），没用的回 400（RFC 6749 §5.2 两样都许）
 */
export function authenticateClient(creds: ClientCredentials): OAuthClientRecord {
  const status = creds.basic ? 401 : 400;
  if (!creds.clientId) throw new OAuthError("invalid_client", "client_id is missing", status, "缺少 client_id");
  const record = getOAuthClient(creds.clientId);
  if (!record) throw new OAuthError("invalid_client", "unknown client", status, "不认识这个客户端");
  if (record.kind === "manual") {
    if (!creds.clientSecret || !record.secretHash || !sameHash(hashToken(creds.clientSecret), record.secretHash)) {
      throw new OAuthError("invalid_client", "client authentication failed", status, "client_secret 不对");
    }
  }
  return record;
}
