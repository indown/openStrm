/**
 * 授权请求从头到尾：授权页发起 → 管理员在管理界面（或 Telegram）里输入授权页上的配对码、选档位、批准
 * → 授权页轮询到「已批准」，这时才生成授权码，带着它跳回客户端。
 *
 * 为什么要输配对码而不是点一下：授权码是发给「拿着这个授权页」的人的（页面轮询拿到它），谁都能打开授权页，
 * 也能冒充 claude.ai 发起。批准时输入自己眼前授权页上的配对码，批的才一定是自己这一条；列表里只有别人冒充的那条时，
 * 管理员手里没有它的配对码，批不了。
 *
 * 授权页在公网上，默认不收管理员密码：批准只在管理界面（局域网）或 Telegram 里做，
 * 公网上就没有能暴力破解的登录框。设置里可以另开「授权页用密码批准」，有单独的失败退避和总量上限。
 */
import type { AgentScope, AgentToolset, OAuthPendingRequest } from "@openstrm/shared";
import { readAuthConfig } from "../../db/repositories/auth.js";
import { AGENT_SCOPES, AGENT_TOOLSETS } from "../../db/repositories/api-tokens.js";
import {
  countOAuthRequestsSince,
  countPendingOAuthRequests,
  createOAuthRequest,
  decideOAuthRequest,
  denyAllPendingOAuthRequests,
  getOAuthRequest,
  getOAuthRequestForPoll,
  hostOf,
  issueOAuthCode,
  normalizePairingCode,
  touchOAuthClient,
  type OAuthClientRecord,
  type OAuthRequestRecord,
} from "../../db/repositories/oauth.js";
import { ipKey } from "../../lib/ip.js";
import { moduleLogger } from "../../lib/logger.js";
import { createLoginThrottle } from "../login-throttle.js";
import { verifyPassword } from "../password.js";
import { notifyOAuthRequest } from "../telegram/notify.js";
import { clientHostOf, isUrlClientId, resolveClient } from "./clients.js";
import {
  CODE_TTL_S,
  MAX_PENDING_REQUESTS,
  PENDING_PER_IP,
  REQUESTS_PER_IP_PER_HOUR,
  REQUEST_TTL_S,
  sameResource,
  type OAuthConfig,
} from "./config.js";
import { OAuthError } from "./errors.js";
import { isInsecureUri, isLoopbackUri, redirectUriMatches, withParams } from "./redirect.js";

const log = moduleLogger("oauth");

const nowS = () => Math.floor(Date.now() / 1000);

/** 授权页上的两个预设：只读、日常。danger 只能在管理界面里勾 */
export const PASSWORD_PRESETS: Readonly<Record<string, readonly AgentScope[]>> = Object.freeze({
  read: ["read"],
  daily: ["read", "run", "write"],
});

/** 「read」「daily」之外（包括 constructor 这种原型上的名字）都当不认识 */
export function presetScopes(preset: string): readonly AgentScope[] | undefined {
  return Object.hasOwn(PASSWORD_PRESETS, preset) ? PASSWORD_PRESETS[preset] : undefined;
}

/**
 * 给的档位 = 管理员选的 ∩ 客户端要的（客户端要了四档里任何一个时；什么都没要就按管理员选的），「查看」总在。
 * 客户端只要了 read，管理员手一滑选了「日常」，也不会多给
 */
export function grantScopes(requestedScope: string, chosen: readonly AgentScope[]): AgentScope[] {
  const words = requestedScope.split(/\s+/);
  const requested = AGENT_SCOPES.filter((s) => words.includes(s));
  const base = requested.length > 0 ? chosen.filter((s) => requested.includes(s)) : chosen;
  return AGENT_SCOPES.filter((s) => s === "read" || base.includes(s));
}

/** 待批准列表里的一条：不带配对码（见 OAuthPendingRequest） */
export function pendingRequestInfo(r: OAuthRequestRecord): OAuthPendingRequest {
  return {
    id: r.id,
    clientId: r.clientId,
    clientName: r.clientName,
    clientKind: r.clientKind,
    clientHost: clientHostOf(r.clientKind, r.clientId),
    redirectHost: hostOf(r.redirectUri),
    redirectInsecure: isInsecureUri(r.redirectUri),
    redirectLoopback: isLoopbackUri(r.redirectUri),
    requestedScopes: AGENT_SCOPES.filter((s) => r.requestedScope.split(/\s+/).includes(s)),
    ip: r.ip,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  };
}

export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope?: string;
  resource?: string;
}

export type AuthorizeStart =
  /** 出授权页：显示配对码，等人批准 */
  | { kind: "page"; request: OAuthRequestRecord; pollSecret: string }
  /** 出错误页。backUrl：回调地址核对过了，页上给个「回到客户端」的链接（带着 error） */
  | { kind: "error"; message: string; backUrl?: string }
  /** 带着 error 直接跳回客户端：只对本机回环地址这么做（命令行客户端在那儿等着，也谈不上把人送去哪个网站） */
  | { kind: "redirect"; url: string };

/**
 * 回调地址核对过之后的出错：回环地址直接跳回去，别的出错误页、给个链接让人自己点——
 * 动态注册谁都能登记任意回调地址，自动跳等于把授权服务器当成任意跳转器（RFC 9700 §4.11.2）
 */
function failBack(cfg: OAuthConfig, redirectUri: string, state: string | undefined, error: string, en: string, zh: string): AuthorizeStart {
  const url = withParams(redirectUri, { error, error_description: en, state, iss: cfg.issuer });
  return isLoopbackUri(redirectUri) ? { kind: "redirect", url } : { kind: "error", message: zh, backUrl: url };
}

/** 这个来源（ipKey）现在还能不能发起：每小时的数量、同时在等的数量、全局在等的数量 */
function rateProblem(key: string, now: number): { en: string; zh: string } | null {
  if (countOAuthRequestsSince(key, now - 3600) >= REQUESTS_PER_IP_PER_HOUR) {
    return { en: "too many authorization requests from this address", zh: "这个地址一小时内发起的授权请求太多了，过一会儿再试" };
  }
  if (countPendingOAuthRequests(now, key) >= PENDING_PER_IP) {
    return { en: "too many pending authorization requests from this address", zh: "这个地址已经有好几个授权请求在等批准了，先处理掉再试" };
  }
  if (countPendingOAuthRequests(now) >= MAX_PENDING_REQUESTS) {
    return { en: "too many pending authorization requests", zh: "等批准的授权请求太多了，先到 OpenStrm 里处理掉一些（可以全部拒绝）再试" };
  }
  return null;
}

export async function startAuthorization(params: AuthorizeParams, ip: string, cfg: OAuthConfig): Promise<AuthorizeStart> {
  const clientId = params.client_id?.trim();
  if (!clientId) return { kind: "error", message: "请求里没有 client_id，不知道是哪个客户端" };
  const key = ipKey(ip);
  const now = nowS();
  // CIMD 要替人去请求一个地址：先按来源限了再去取，别让人拿授权页当免费的请求转发器
  const cimdClient = isUrlClientId(clientId);
  if (cimdClient) {
    const limited = rateProblem(key, now);
    if (limited) return { kind: "error", message: limited.zh };
  }
  let client: OAuthClientRecord;
  try {
    client = await resolveClient(clientId, cfg.cimd);
  } catch (err) {
    return { kind: "error", message: err instanceof OAuthError ? err.forHuman : "认不出这个客户端" };
  }

  // 回调地址：没带的话，只登记了一个就用它；对不上就停在这里，不跳（CIMD 的缓存可能旧了，重取一次再比）
  let redirectUri = params.redirect_uri?.trim();
  if (!redirectUri) {
    if (client.redirectUris.length !== 1) return { kind: "error", message: "请求里没有回调地址（redirect_uri）" };
    redirectUri = client.redirectUris[0];
  } else if (!redirectUriMatches(client.redirectUris, redirectUri)) {
    if (client.kind === "cimd" && client.fetchedAt !== null && now - client.fetchedAt > 300) {
      try {
        client = await resolveClient(clientId, cfg.cimd, true);
      } catch (err) {
        return { kind: "error", message: err instanceof OAuthError ? err.forHuman : "认不出这个客户端" };
      }
    }
    if (!redirectUriMatches(client.redirectUris, redirectUri)) {
      return { kind: "error", message: "回调地址和这个客户端登记的对不上，可能是冒充的客户端" };
    }
  }

  const state = params.state;
  if (!params.response_type) return failBack(cfg, redirectUri, state, "invalid_request", "response_type is required", "请求里没有 response_type");
  if (params.response_type !== "code") {
    return failBack(cfg, redirectUri, state, "unsupported_response_type", "only response_type=code is supported", "只支持 response_type=code");
  }
  if (!params.code_challenge || params.code_challenge_method !== "S256") {
    return failBack(cfg, redirectUri, state, "invalid_request", "PKCE with code_challenge_method=S256 is required", "必须用 PKCE，code_challenge_method 只收 S256");
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(params.code_challenge)) {
    return failBack(cfg, redirectUri, state, "invalid_request", "malformed code_challenge", "code_challenge 格式不对");
  }
  if (params.resource && !sameResource(params.resource, cfg.resource)) {
    return failBack(cfg, redirectUri, state, "invalid_target", `resource must be ${cfg.resource}`, `resource 要是 ${cfg.resource}`);
  }
  if (!cimdClient) {
    const limited = rateProblem(key, now);
    if (limited) return failBack(cfg, redirectUri, state, "temporarily_unavailable", limited.en, limited.zh);
  }

  const { record, pollSecret } = createOAuthRequest(
    {
      clientId: client.id,
      clientName: client.name,
      clientKind: client.kind,
      redirectUri,
      state: state ?? null,
      codeChallenge: params.code_challenge,
      requestedScope: (params.scope ?? "").trim().slice(0, 300),
      resource: cfg.resource,
      ip,
      ipKey: key,
      ttlSeconds: REQUEST_TTL_S,
    },
    now,
  );
  // 发起授权也算用到了这个客户端：久没用的注册会被清掉，正在走流程的不能清
  touchOAuthClient(client.id, now);
  void notifyOAuthRequest(pendingRequestInfo(record)).catch((err: unknown) => log.warn({ err }, "发 OAuth 批准通知失败"));
  log.info({ requestId: record.id, client: record.clientName, ip }, "新的授权请求，等批准");
  return { kind: "page", request: record, pollSecret };
}

export type ApproveResult = "ok" | "wrong_code" | "gone";

/**
 * 批准：配对码得是这一条授权页上的那个（见文件头）；给的档位按客户端要的收窄；工具集至少一组。
 * 返回 wrong_code 时什么都没改
 */
export function approveOAuthRequest(
  id: string,
  pairingCode: string,
  choice: { scopes: readonly AgentScope[]; toolsets: readonly AgentToolset[] },
  via: string,
): ApproveResult {
  const record = getOAuthRequest(id);
  if (!record || record.status !== "pending" || record.expiresAt <= nowS()) return "gone";
  if (normalizePairingCode(pairingCode) !== record.pairingCode) return "wrong_code";
  const toolsets = AGENT_TOOLSETS.filter((t) => choice.toolsets.includes(t));
  if (toolsets.length === 0) throw new OAuthError("invalid_request", "at least one toolset is required", 400, "至少选一组工具");
  const ok = decideOAuthRequest(id, { approved: true, scopes: grantScopes(record.requestedScope, choice.scopes), toolsets, via }, nowS(), CODE_TTL_S);
  if (ok) log.info({ requestId: id, client: record.clientName, via }, "授权请求已批准");
  return ok ? "ok" : "gone";
}

export function denyOAuthRequest(id: string, via: string): boolean {
  const ok = decideOAuthRequest(id, { approved: false, via });
  if (ok) log.info({ requestId: id, via }, "授权请求已拒绝");
  return ok;
}

export function denyAllOAuthRequests(via: string): number {
  const n = denyAllPendingOAuthRequests(via);
  if (n > 0) log.info({ count: n, via }, "待批准的授权请求全部拒绝了");
  return n;
}

export type PollResult =
  | { status: "pending"; expiresAt: number }
  | { status: "redirect"; url: string }
  /** 拒绝了：照样跳回客户端（带 error=access_denied），但授权页上得说「拒绝」而不是「批准」 */
  | { status: "denied"; url: string }
  /** 等太久过期了：url 带 error 回客户端；auto 是回环地址，页面直接跳，别的给链接 */
  | { status: "expired"; url?: string; auto?: boolean }
  /** 授权码已经换过令牌了：这边没什么可做的了 */
  | { status: "done" }
  | { status: "missing" };

/**
 * 授权页每两秒问一次。批准后问到时生成授权码，带着它跳回客户端；
 * 发过了还没换令牌的再问就换一个新的（上一次的回应可能丢了），换过令牌的才算完
 */
export function pollAuthorization(id: string, pollSecret: string, cfg: OAuthConfig): PollResult {
  const record = getOAuthRequestForPoll(id, pollSecret);
  if (!record) return { status: "missing" };
  const now = nowS();
  const expired = (): PollResult => {
    const url = withParams(record.redirectUri, { error: "access_denied", error_description: "authorization request expired", state: record.state, iss: cfg.issuer });
    return { status: "expired", url, auto: isLoopbackUri(record.redirectUri) };
  };
  switch (record.status) {
    case "pending":
      return record.expiresAt > now ? { status: "pending", expiresAt: record.expiresAt } : expired();
    case "approved":
    case "issued": {
      const code = issueOAuthCode(record.id, now, CODE_TTL_S);
      if (!code) return expired();
      return { status: "redirect", url: withParams(record.redirectUri, { code, state: record.state, iss: cfg.issuer }) };
    }
    case "denied":
      return {
        status: "denied",
        url: withParams(record.redirectUri, { error: "access_denied", error_description: "the OpenStrm administrator denied this request", state: record.state, iss: cfg.issuer }),
      };
    default:
      return { status: "done" };
  }
}

/**
 * 授权页上的密码批准单独一套失败退避：公网上来的尝试不能把局域网里的登录也锁住。
 * 再加一道总量：一小时里失败太多（换着地址试），整个功能先停一小时，只能回管理界面批
 */
const passwordThrottle = createLoginThrottle();
const GLOBAL_FAILURES_PER_HOUR = 30;
let globalFailures: { since: number; count: number } = { since: 0, count: 0 };

function passwordApprovalSuspended(now: number): boolean {
  if (now - globalFailures.since >= 3600) globalFailures = { since: now, count: 0 };
  return globalFailures.count >= GLOBAL_FAILURES_PER_HOUR;
}

/** 测试用 */
export function __test_resetPasswordApproval(): void {
  passwordThrottle.reset();
  globalFailures = { since: 0, count: 0 };
}

/** 授权页上用管理员密码直接批准（设置里开了才有）：密码在这个页面上输，本身就证明批的是这一条 */
export async function approveWithPassword(
  input: { id: string; pollSecret: string; password: string; preset: string },
  ip: string,
  cfg: OAuthConfig,
): Promise<PollResult> {
  if (!cfg.allowPasswordApproval) throw new OAuthError("access_denied", "password approval is disabled", 403, "没有开启授权页密码批准");
  const now = nowS();
  if (passwordApprovalSuspended(now)) {
    throw new OAuthError("temporarily_unavailable", "password approval is suspended", 429, "最近失败太多，密码批准先停一小时了：到 OpenStrm 管理界面里批准");
  }
  const record = getOAuthRequestForPoll(input.id, input.pollSecret);
  // 批过、拒过、过期了的请求不许再拿来试密码
  if (!record || record.status !== "pending" || record.expiresAt <= now) {
    throw new OAuthError("invalid_request", "authorization request not found or no longer pending", 404, "授权请求不存在或已失效");
  }
  const scopes = presetScopes(input.preset);
  if (!scopes) throw new OAuthError("invalid_request", "preset must be read or daily", 400, "档位只能选只读或日常");
  const key = ipKey(ip);
  const wait = passwordThrottle.begin(key);
  if (wait > 0) throw new OAuthError("slow_down", "too many attempts", 429, `尝试过于频繁，请 ${wait} 秒后再试`);
  let ok: boolean | undefined;
  try {
    const stored = readAuthConfig().password;
    ok = await verifyPassword(input.password, typeof stored === "string" ? stored : "");
  } finally {
    passwordThrottle.end(key, ok);
  }
  if (!ok) {
    globalFailures.count += 1;
    throw new OAuthError("access_denied", "wrong password", 403, "密码不对");
  }
  const decided = decideOAuthRequest(
    record.id,
    { approved: true, scopes: grantScopes(record.requestedScope, scopes), toolsets: [...AGENT_TOOLSETS], via: "password" },
    nowS(),
    CODE_TTL_S,
  );
  if (decided) log.info({ requestId: record.id, client: record.clientName }, "授权请求已在授权页上用密码批准");
  return pollAuthorization(input.id, input.pollSecret, cfg);
}
