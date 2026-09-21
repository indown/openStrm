/**
 * OAuth 授权服务器的地址和时限。地址都从设置里的公网地址来：没开智能体接入、或者没填公网地址，就是没启用。
 * 设计见 .claude/plans/agent-access.md「OAuth：实例自己当授权服务器」。
 */
import { readAppSetting } from "../../db/repositories/settings.js";
import { MCP_PATH } from "../agent/access.js";

/** 访问令牌 1 小时，刷新令牌 30 天（每次刷新都换新的） */
export const ACCESS_TOKEN_TTL_S = 60 * 60;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;
/** 授权请求等人批准的时间；批准后授权页来取授权码、授权码换令牌，也都是这么久 */
export const REQUEST_TTL_S = 10 * 60;
export const CODE_TTL_S = 10 * 60;
/**
 * 同一个授权码 / 刷新令牌一分钟内再来一次：多半是客户端并发刷新、回应丢了重试，回同一对令牌；
 * 过了一分钟再来才当成被偷了拿去重放、整个授权作废
 */
export const REUSE_GRACE_S = 60;
/**
 * 授权页谁都能打开，别拿它刷通知、占满待批准：同一来源（IPv6 按 /64）每小时最多发起几个、同时最多几个在等，
 * 全局同时最多几个在等
 */
export const REQUESTS_PER_IP_PER_HOUR = 10;
export const PENDING_PER_IP = 3;
export const MAX_PENDING_REQUESTS = 20;

/** 档位之外还认 offline_access（要了才在返回的 scope 里带上；刷新令牌总是发） */
export const OFFLINE_ACCESS = "offline_access";
/** 授权服务器元数据里列的：四个档位加 offline_access */
export const SUPPORTED_SCOPES = ["read", "run", "write", "danger", OFFLINE_ACCESS] as const;
/**
 * 资源这边（受保护资源元数据、401 的 WWW-Authenticate、动态注册的默认值）只列日常用的三档：
 * 规范说资源这边列「基本够用的最小集合」、不要列 offline_access；有的客户端会照单全要，列了 danger 它就要 danger
 */
export const RESOURCE_SCOPES = ["read", "run", "write"] as const;
export const CHALLENGE_SCOPE = RESOURCE_SCOPES.join(" ");

export const WELL_KNOWN_PRM = "/.well-known/oauth-protected-resource";
export const WELL_KNOWN_AS = "/.well-known/oauth-authorization-server";

export const OAUTH_PATHS = {
  authorize: "/oauth/authorize",
  authorizeStatus: "/oauth/authorize/status",
  authorizePassword: "/oauth/authorize/password",
  token: "/oauth/token",
  register: "/oauth/register",
  revoke: "/oauth/revoke",
} as const;

/**
 * 没打开「这个域名也用来打开管理界面」时，公网域名下只放行这些路径（精确匹配）和方法，别的一律 404：管理界面和 /api 不上公网。
 * 方法也要卡：比如 GET /oauth/token 没有这个路由，会落到托管管理界面的静态站上，回的是带着管理界面外壳的 404 页。
 * null 是方法都放（/mcp 自己对 GET、DELETE 回 405）；OPTIONS（跨域预检）都放
 */
const READ = new Set(["GET", "HEAD", "OPTIONS"]);
const SUBMIT = new Set(["POST", "OPTIONS"]);
export const PUBLIC_ROUTES: ReadonlyMap<string, ReadonlySet<string> | null> = new Map<string, ReadonlySet<string> | null>([
  [MCP_PATH, null],
  [WELL_KNOWN_PRM, READ],
  [`${WELL_KNOWN_PRM}${MCP_PATH}`, READ],
  [WELL_KNOWN_AS, READ],
  [OAUTH_PATHS.authorize, READ],
  [OAUTH_PATHS.authorizeStatus, SUBMIT],
  [OAUTH_PATHS.authorizePassword, SUBMIT],
  [OAUTH_PATHS.token, SUBMIT],
  [OAUTH_PATHS.register, SUBMIT],
  [OAUTH_PATHS.revoke, SUBMIT],
]);

/**
 * 对任何来源都开跨域的路径：浏览器里的 MCP 客户端（比如调试器）要直接调的这几个。
 * 授权页和它的轮询、密码批准是浏览器导航过去、同源请求的，不用跨域
 */
export const CORS_PATHS: ReadonlySet<string> = new Set([
  MCP_PATH,
  WELL_KNOWN_PRM,
  `${WELL_KNOWN_PRM}${MCP_PATH}`,
  WELL_KNOWN_AS,
  OAUTH_PATHS.token,
  OAUTH_PATHS.register,
  OAUTH_PATHS.revoke,
]);

/** 公网域名下这个方法、这个路径放不放行 */
export function isPublicRoute(method: string, path: string): boolean {
  if (!PUBLIC_ROUTES.has(path)) return false;
  const methods = PUBLIC_ROUTES.get(path);
  return methods === null || methods === undefined || methods.has(method.toUpperCase());
}

export interface OAuthConfig {
  /** 公网地址，也就是 issuer（规范化过的源：小写、默认端口去掉、国际化域名转成 punycode） */
  issuer: string;
  /** 令牌绑定的资源（RFC 8707）：<公网地址>/mcp */
  resource: string;
  /** 受保护资源元数据的地址（401 的 WWW-Authenticate 里指向它） */
  resourceMetadataUrl: string;
  allowPasswordApproval: boolean;
  /** 认不认 CIMD（client_id 是元数据地址） */
  cimd: boolean;
  /** 公网地址这个域名也用来打开管理界面（一个域名走天下） */
  servesUi: boolean;
}

/** https 的源规范成一种写法：大小写、默认端口、国际化域名都统一；不是合法地址返回 null */
export function normalizeOrigin(v: string): string | null {
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * 比两个资源地址是不是同一个：规范成源 + 去掉结尾 / 的路径再比。
 * 客户端发来的 resource 可能是大写域名、带默认端口、带结尾的 /，都算同一个
 */
export function sameResource(a: string, b: string): boolean {
  const norm = (x: string) => {
    try {
      const u = new URL(x);
      return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
    } catch {
      return x;
    }
  };
  return norm(a) === norm(b);
}

/** Host 头 / X-Forwarded-Host 里的主机名规范成一种写法：小写、去端口、去结尾的点（mcp.example.com. 和不带点的是同一个域名） */
export function normalizeHost(v: string | undefined | null): string | null {
  if (!v) return null;
  let h = v.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    h = end > 0 ? h.slice(0, end + 1) : h;
  } else if (h.indexOf(":") === h.lastIndexOf(":")) {
    h = h.replace(/:\d*$/, "");
  }
  h = h.replace(/\.+$/, "");
  return h || null;
}

export function publicBaseUrl(): string | null {
  const raw = readAppSetting("agent")?.publicBaseUrl;
  return raw ? normalizeOrigin(raw) : null;
}

/** 公网地址的主机名（规范化过的）：公网守卫、401 要不要指到元数据都按它认 */
export function publicHostname(): string | null {
  const base = publicBaseUrl();
  return base ? normalizeHost(new URL(base).host) : null;
}

/** 公网地址这个域名是不是也用来打开管理界面：是的话公网守卫对它不生效 */
export function publicServesUi(): boolean {
  return readAppSetting("agent")?.publicServesUi === true;
}

export function oauthConfig(): OAuthConfig | null {
  const agent = readAppSetting("agent");
  if (agent?.enabled !== true) return null;
  const issuer = agent.publicBaseUrl ? normalizeOrigin(agent.publicBaseUrl) : null;
  if (!issuer) return null;
  return {
    issuer,
    resource: `${issuer}${MCP_PATH}`,
    resourceMetadataUrl: `${issuer}${WELL_KNOWN_PRM}${MCP_PATH}`,
    allowPasswordApproval: agent.allowPasswordApproval === true,
    cimd: agent.oauthCimd === true,
    servesUi: agent.publicServesUi === true,
  };
}

export const endpoint = (cfg: OAuthConfig, path: string) => `${cfg.issuer}${path}`;
