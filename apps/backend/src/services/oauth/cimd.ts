/**
 * CIMD（客户端 ID 元数据文档）：client_id 本身是一个 https 地址，客户端的名字、回调地址写在那份 JSON 里。
 * claude.ai、ChatGPT 都支持（ChatGPT 的是 https://chatgpt.com/oauth/client.json）。设置里开了才认，默认关：
 * 要本机能直接访问对方的地址，国内网络一般不行，关着客户端就用动态注册。
 *
 * 这是我们替别人去请求一个任意地址，要防 SSRF：
 *   - 只取 https、默认端口、写域名的地址（写 IP、带端口、单段主机名的一律不取），不跟跳转；
 *   - 解析出来的每个地址都不能是内网、回环、链路本地、组播、保留、内嵌 IPv4 的过渡地址；连接时就连检查过的那个（防 DNS 重绑定）；
 *   - 总共 5 秒、64 KB 上限；出错只回一句笼统的话（细节进日志），不给人拿它探内网端口。
 */
import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import type { LookupFunction } from "node:net";
import { moduleLogger } from "../../lib/logger.js";
import { OAuthError } from "./errors.js";
import { redirectUriProblem } from "./redirect.js";

const log = moduleLogger("oauth");

const TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024;
/** 对方没说缓存多久就缓存一天；说了按它的，但最长一天、最短五分钟 */
export const CIMD_CACHE_MAX_S = 24 * 60 * 60;
const CIMD_CACHE_MIN_S = 5 * 60;
const MAX_REDIRECT_URIS = 10;

const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(addr, prefix, "ipv4");
}
for (const [addr, prefix] of [
  // 未指定、回环、IPv4 兼容地址（::a.b.c.d）
  ["::", 96],
  // NAT64（知名前缀和本地前缀）、丢弃、Teredo、文档、6to4：都能把内网 IPv4 包在里面
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  // 唯一本地、链路本地、站点本地（已废弃）、组播
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(addr, prefix, "ipv6");
}

/** 内网、回环、链路本地、组播、保留这些地址：不替客户端去请求 */
export function isBlockedAddress(address: string, family: number): boolean {
  if (family === 6) {
    // ::ffff:10.0.0.1 这种 IPv4 映射地址按里面那个 IPv4 算
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return BLOCKED.check(mapped[1], "ipv4");
    return BLOCKED.check(address, "ipv6");
  }
  return BLOCKED.check(address, "ipv4");
}

/** 先解析、检查完再连：连的就是检查过的地址，中间换不了 */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isBlockedAddress(a.address, a.family));
    if (list.length === 0 || bad) {
      return callback(new Error(`CIMD host ${hostname} resolves to a blocked address (${bad?.address ?? "none"})`), "", 0);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    return callback(null, list[0].address, list[0].family);
  });
};

export interface ClientMetadata {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  scope?: string;
}

/** 路径里有没有 . / .. 这种段（含百分号编码的）：URL 解析会把它们吃掉，得看原串 */
function hasDotSegment(raw: string): boolean {
  const path = raw.replace(/^[a-z]+:\/\/[^/?#]*/i, "").split(/[?#]/)[0];
  return path.split("/").some((seg) => {
    const s = seg.replace(/%2e/gi, ".");
    return s === "." || s === "..";
  });
}

/** client_id 能不能当 CIMD 地址用：见文件头。能就是 null */
export function cimdUrlProblem(clientId: string): { en: string; zh: string } | null {
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    return { en: "client_id is not a valid URL", zh: "client_id 不是合法的地址" };
  }
  if (u.protocol !== "https:") return { en: "a URL client_id must use https", zh: "client_id 是地址时必须是 https" };
  if (u.username || u.password || u.hash) return { en: "a URL client_id must not contain credentials or a fragment", zh: "client_id 地址不能带账号密码或 #" };
  if (u.pathname === "/" || u.pathname === "") return { en: "a URL client_id must have a path", zh: "client_id 地址得有路径" };
  if (hasDotSegment(clientId)) return { en: "a URL client_id must not contain dot segments", zh: "client_id 地址里不能有 . 或 .. 这样的路径段" };
  if (u.port) return { en: "a URL client_id must use the default https port", zh: "client_id 地址不能带端口" };
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  if (net.isIP(host) !== 0) return { en: "a URL client_id must use a domain name, not an IP address", zh: "client_id 地址得写域名，不能直接写 IP" };
  if (!host.includes(".") || host.endsWith(".localhost")) return { en: "a URL client_id must use a public domain name", zh: "client_id 地址得是公网域名" };
  return null;
}

/** Cache-Control 里的 max-age / no-store：按它缓存，限在五分钟到一天之间 */
export function cacheSecondsFrom(cacheControl: string | undefined): number {
  if (!cacheControl) return CIMD_CACHE_MAX_S;
  const cc = cacheControl.toLowerCase();
  if (/\bno-store\b|\bno-cache\b/.test(cc)) return CIMD_CACHE_MIN_S;
  const m = /\bmax-age\s*=\s*(\d+)/.exec(cc);
  if (!m) return CIMD_CACHE_MAX_S;
  return Math.min(CIMD_CACHE_MAX_S, Math.max(CIMD_CACHE_MIN_S, Number(m[1])));
}

function download(url: URL): Promise<{ text: string; cacheSeconds: number }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: "GET", headers: { accept: "application/json", "user-agent": "OpenStrm-OAuth" }, timeout: TIMEOUT_MS, lookup: safeLookup },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(res.statusCode && res.statusCode >= 300 && res.statusCode < 400 ? "redirect not followed" : `HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy(new Error("document larger than 64 KB"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8"), cacheSeconds: cacheSecondsFrom(res.headers["cache-control"]) }));
        res.on("error", reject);
      },
    );
    // timeout 只管「多久没动静」：一秒挤一个字节的能拖很久，再加一道总时限
    const deadline = setTimeout(() => req.destroy(new Error("timed out")), TIMEOUT_MS);
    req.on("close", () => clearTimeout(deadline));
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

const SHARED_SECRET_METHODS = new Set(["client_secret_post", "client_secret_basic", "client_secret_jwt"]);

/**
 * 取来的文档要能用：client_id 就是它自己的地址，回调地址都合规（最多 10 个），不是靠共享密钥认证的客户端。
 * private_key_jwt（ChatGPT 的文档就这么写）也收：我们不支持它，元数据里没列，客户端就按公开客户端（none）来，
 * 靠 PKCE。只留用得上的几样
 */
export function validateClientMetadata(clientId: string, doc: unknown): ClientMetadata {
  const reject = (en: string, zh: string) => new OAuthError("invalid_client", `client metadata: ${en}`, 400, `客户端元数据${zh}`);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw reject("not a JSON object", "不是 JSON 对象");
  const m = doc as Record<string, unknown>;
  if (m.client_id !== clientId) throw reject("client_id does not match the document URL", "里的 client_id 和它的地址对不上");
  const uris = m.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.some((u) => typeof u !== "string")) {
    throw reject("redirect_uris missing", "里没有回调地址（redirect_uris）");
  }
  if (uris.length > MAX_REDIRECT_URIS) throw reject(`more than ${MAX_REDIRECT_URIS} redirect_uris`, `里的回调地址超过 ${MAX_REDIRECT_URIS} 个`);
  for (const u of uris as string[]) {
    const problem = redirectUriProblem(u);
    if (problem) throw reject(problem.en, `里的${problem.zh}`);
  }
  const method = m.token_endpoint_auth_method;
  if ((typeof method === "string" && SHARED_SECRET_METHODS.has(method)) || m.client_secret !== undefined || m.client_secret_expires_at !== undefined) {
    throw reject("shared-secret client authentication is not allowed", "要求共享密钥认证（client_secret_*），CIMD 客户端不能这样");
  }
  return {
    client_id: clientId,
    client_name: typeof m.client_name === "string" ? m.client_name : undefined,
    redirect_uris: uris as string[],
    scope: typeof m.scope === "string" ? m.scope.slice(0, 300) : undefined,
  };
}

type Fetcher = (url: string) => Promise<{ doc: unknown; cacheSeconds: number }>;

const realFetcher: Fetcher = async (url) => {
  const { text, cacheSeconds } = await download(new URL(url));
  try {
    return { doc: JSON.parse(text) as unknown, cacheSeconds };
  } catch {
    throw new Error("not JSON");
  }
};

let fetcher: Fetcher = realFetcher;

/** 仅供测试：换掉真正去请求的那一步（测试里没有公网 https）；传 null 恢复 */
export function setCimdFetcher(fn: Fetcher | null): void {
  fetcher = fn ?? realFetcher;
}

export async function fetchClientMetadata(clientId: string): Promise<{ metadata: ClientMetadata; cacheSeconds: number }> {
  const problem = cimdUrlProblem(clientId);
  if (problem) throw new OAuthError("invalid_client", problem.en, 400, problem.zh);
  let fetched: { doc: unknown; cacheSeconds: number };
  try {
    fetched = await fetcher(clientId);
  } catch (err) {
    log.warn({ clientId, err: err instanceof Error ? err.message : String(err) }, "取 CIMD 客户端元数据失败");
    throw new OAuthError(
      "invalid_client",
      "could not fetch the client metadata document",
      400,
      "取不到客户端元数据（地址不通、超时，或者内容不对）。国内网络一般访问不了 claude.ai、chatgpt.com：到 OpenStrm 的设置里关掉 CIMD，客户端会改用动态注册",
    );
  }
  return { metadata: validateClientMetadata(clientId, fetched.doc), cacheSeconds: fetched.cacheSeconds };
}
