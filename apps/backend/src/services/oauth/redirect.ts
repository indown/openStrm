/**
 * 回调地址的规矩：
 *   - https 都收；http 也收（局域网里的 Open WebUI 多半是 http），批准时标出来让人核对；
 *   - 桌面客户端的私有 scheme（cursor://、vscode:// 这类）也收，能执行脚本或读本地的 scheme 不收；
 *   - 比对按完全一致；登记的是本机回环地址时端口可以不同（RFC 8252 §7.3：命令行客户端每次随机开端口）；
 *   - 授权页上的密码批准只给「授权码发过去别人拿不到」的回调（见 passwordApprovalAllowed）。
 */
import net from "node:net";
import type { OAuthClientKind } from "@openstrm/shared";
import { isInternalAddress } from "../../lib/ip.js";

const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "filesystem:"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** 回调地址的毛病：en 回给客户端（协议里的说明只许 ASCII），zh 给人看 */
export interface RedirectProblem {
  en: string;
  zh: string;
}

/** 能不能登记成回调地址：能就是 null，不能说原因 */
export function redirectUriProblem(uri: string): RedirectProblem | null {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > 2000) return { en: "redirect_uri is empty or too long", zh: "回调地址为空或太长" };
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return { en: "redirect_uri is not a valid URL", zh: `回调地址不是合法的 URL：${uri.slice(0, 200)}` };
  }
  if (BLOCKED_SCHEMES.has(u.protocol)) return { en: `redirect_uri scheme ${u.protocol} is not allowed`, zh: `回调地址不能用 ${u.protocol} 开头` };
  if (u.hash) return { en: "redirect_uri must not contain a fragment", zh: "回调地址不能带 #" };
  if ((u.protocol === "http:" || u.protocol === "https:") && !u.hostname) return { en: "redirect_uri has no host", zh: "回调地址没有主机名" };
  if (u.username || u.password) return { en: "redirect_uri must not contain credentials", zh: "回调地址不能带账号密码" };
  return null;
}

/** URL 的 hostname 对 IPv6 带着方括号，和上面的写法一致 */
function isLoopback(u: URL): boolean {
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname.toLowerCase());
}

/** 跳回本机回环地址（命令行、桌面客户端） */
export function isLoopbackUri(uri: string): boolean {
  try {
    return isLoopback(new URL(uri));
  } catch {
    return false;
  }
}

/** 跳回公网上的 http 地址：授权码明文走网络，批准前要提醒 */
export function isInsecureUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === "http:" && !isLoopback(u);
  } catch {
    return false;
  }
}

/** claude.ai、ChatGPT 的回调所在的域名（2026-09 核实：claude.ai/api/mcp/auth_callback、chatgpt.com/connector_platform_oauth_redirect） */
const KNOWN_WEB_CLIENT_HOSTS = new Set(["claude.ai", "chatgpt.com"]);
/** 只在局域网里解析得到的主机名后缀 */
const LAN_SUFFIXES = [".local", ".lan", ".home", ".internal", ".localdomain", ".home.arpa"];

/**
 * 授权码发到这个回调，外面的人拿不到：本机、局域网地址、桌面客户端的私有 scheme、claude.ai / ChatGPT 的回调。
 * 反过来的例子：动态注册谁都能做、回调随便填，发到别的公网域名的，谁拿着授权页批了，授权码就直接进了注册它的人手里
 */
export function isTrustedRedirect(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return true;
  const host = u.hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (net.isIP(host)) return isInternalAddress(host);
  if (!host.includes(".") || LAN_SUFFIXES.some((s) => host.endsWith(s))) return true;
  return u.protocol === "https:" && KNOWN_WEB_CLIENT_HOSTS.has(host);
}

/**
 * 授权页上能不能用管理员密码批准：管理员自己手建的客户端（回调是他登记的，换令牌还要密钥），或者回调别人拿不到。
 * 别的走配对码——在管理界面里批，看得到「名字是它自己报的」和回调域名
 */
export function passwordApprovalAllowed(kind: OAuthClientKind, redirectUri: string): boolean {
  return kind === "manual" || isTrustedRedirect(redirectUri);
}

/** 这次带来的回调地址对不对得上登记过的 */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let r: URL;
  try {
    r = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopback(r)) return false;
  return registered.some((uri) => {
    try {
      const g = new URL(uri);
      return isLoopback(g) && g.hostname === r.hostname && g.pathname === r.pathname && g.search === r.search;
    } catch {
      return false;
    }
  });
}

/**
 * 往回调地址后面接参数（code、state、iss、error…）。登记的地址里本来就有的查询串原样保留（RFC 6749 §3.1.2），
 * 不能拿 URL 对象改：它会把 %20 改写成 +、给没有值的参数补上 =，客户端比对回调地址时就对不上了
 */
export function withParams(uri: string, params: Record<string, string | null | undefined>): string {
  const q = Object.entries(params)
    .filter((e): e is [string, string] => e[1] != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  if (!q) return uri;
  if (!uri.includes("?")) return `${uri}?${q}`;
  return uri.endsWith("?") || uri.endsWith("&") ? `${uri}${q}` : `${uri}&${q}`;
}
