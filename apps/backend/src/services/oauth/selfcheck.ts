/**
 * 连接自检：从服务器自己这边去请求公网地址，逐项看网页客户端要走的路通不通，给配反代 / Tunnel 的人用。
 *   1. 受保护资源元数据；2. 授权服务器元数据；3. 不带令牌的 /mcp 应该回 401 并指到元数据
 *      （被 Cloudflare Access 的登录页、质询页挡住的认得出来，直接说是它）；
 *   4. 来源地址：/mcp 那次请求带一个一次性标记和一个 X-Forwarded-For 哨兵绕公网回来，看 OpenStrm 认出的来源对不对
 *      （常见的配错：反代后面没设 TRUST_PROXY、反代没传客户端地址、CDN → 反代只信了一层、信任过头能伪造来源）；
 *   5、6. 管理界面和 /api 从公网地址应该访问不到（404）——共用域名（这个域名也用来打开管理界面）时换成一条加固建议；
 *   7. 开了 CIMD 的话，本机能不能取到 claude.ai、ChatGPT 的客户端元数据（取不到它们就连不上）。
 *   公网地址带端口的另外提醒：claude.ai 只往 443 端口连。
 * 服务器访问不到自己的公网地址也可能只是网络不支持「回环访问」，不代表外面访问不到，结果里照实说。
 */
import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { AgentSelfCheckItem } from "@openstrm/shared";
import { isInternalAddress, normalizeAddress } from "../../lib/ip.js";
import { trustProxyOption } from "../../lib/trust-proxy.js";
import { readAppSetting } from "../../db/repositories/settings.js";
import { MCP_PATH } from "../agent/access.js";
import { fetchClientMetadata } from "./cimd.js";
import { WELL_KNOWN_AS, WELL_KNOWN_PRM, publicBaseUrl } from "./config.js";
import { OAuthError } from "./errors.js";

/* ------------------------------- 来源地址探针 ------------------------------- */

const PROBE_HEADER = "x-openstrm-selfcheck";
export const SOURCE_PROBE_HEADER = PROBE_HEADER;
/**
 * 探针自己在 X-Forwarded-For 里放的哨兵（192.0.2.1 是文档专用的保留地址，不会是真的客户端）。
 * 反代都是往后追加，它留在最左边；OpenStrm 认出的来源要是它，说明客户端自己在请求头里写的地址也被采信了
 */
export const PROBE_CANARY = "192.0.2.1";

export interface ProbeSeen {
  /** Fastify 认出的来源（TRUST_PROXY 生效后从 X-Forwarded-For 里取） */
  ip: string;
  /** 直接连过来的那一端（反代 / cloudflared 自己的地址） */
  peer: string | null;
  /** 收到的 X-Forwarded-For，从左到右 */
  xff: string[];
  /** 反代带的 X-Real-IP（OpenStrm 不认它，只拿来提示） */
  realIp: string | null;
  /** Cloudflare 给的真实来源（CF-Connecting-IP） */
  cfIp: string | null;
}

/** 自检发出去、还没绕回来的探针：只记这些，别的请求带同名头也不理 */
const pendingProbes = new Map<string, { at: number; seen?: ProbeSeen }>();

function headerValue(request: FastifyRequest, name: string): string | null {
  const v = request.headers[name];
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.join(",").trim();
  return null;
}

/** 每个请求都过一下（在公网守卫的钩子里调）：是自检自己的探针才记下它看到的来源 */
export function noteSelfCheckProbe(request: FastifyRequest): void {
  const nonce = request.headers[PROBE_HEADER];
  if (typeof nonce !== "string") return;
  const probe = pendingProbes.get(nonce);
  if (!probe || probe.seen) return;
  probe.seen = {
    ip: request.ip,
    peer: request.socket?.remoteAddress ?? null,
    xff: (headerValue(request, "x-forwarded-for") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    realIp: headerValue(request, "x-real-ip"),
    cfIp: headerValue(request, "cf-connecting-ip"),
  };
}

/** 发一个探针前先登记：返回要放进请求头 PROBE_HEADER 的一次性标记 */
export function startSourceProbe(now = Date.now()): string {
  for (const [k, v] of pendingProbes) if (now - v.at > 60_000) pendingProbes.delete(k);
  const nonce = randomBytes(12).toString("base64url");
  pendingProbes.set(nonce, { at: now });
  return nonce;
}

/** 探针回来后取结果（取完就忘）：没到这台机器上就是 undefined */
export function finishSourceProbe(nonce: string): ProbeSeen | undefined {
  const seen = pendingProbes.get(nonce)?.seen;
  pendingProbes.delete(nonce);
  return seen;
}

export interface SourceVerdict {
  ok: boolean;
  /** 看不全（比如自检是在内网里绕回来的）：不算错，但要人自己再核对 */
  warn?: boolean;
  detail: string;
}

const APPEND_XFF = "反代要往 X-Forwarded-For 里追加客户端地址（nginx 写 proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;，Caddy、Nginx Proxy Manager、cloudflared 默认就是这样）";

/**
 * 看 OpenStrm 给探针认出的来源对不对。Fastify 只认 X-Forwarded-For（从右往左跳过信任的代理）；探针请求自己只带哨兵，
 * 所以哨兵右边第一项（或者 Cloudflare 给的 CF-Connecting-IP）就是第一层代理看到的来源——这台服务器出去时的地址。
 * trustRaw 是 TRUST_PROXY 的原始写法（只用来判断设没设、写进提示里）
 */
export function judgeSource(seen: ProbeSeen, trustRaw: string | undefined): SourceVerdict {
  const trusted = trustProxyOption(trustRaw) !== false;
  const setting = trusted ? `TRUST_PROXY=${trustRaw?.trim()}` : "没设 TRUST_PROXY";
  const ip = normalizeAddress(seen.ip);
  const peer = seen.peer ? normalizeAddress(seen.peer) : ip;
  const chain = seen.xff.map(normalizeAddress);
  const canaryAt = chain.indexOf(PROBE_CANARY);
  // 反代追加上去的：哨兵右边的；反代把整个头换掉了（nginx 写 $remote_addr）就是整条
  const appended = canaryAt === -1 ? chain : chain.slice(canaryAt + 1);
  const cf = seen.cfIp ? normalizeAddress(seen.cfIp) : null;

  // 公网地址只收 https，OpenStrm 自己只跑 http：中间一定有一层终结 TLS 的代理，而它没往 X-Forwarded-For 里加东西
  if (appended.length === 0) {
    const other = seen.realIp ? "（它带的是 X-Real-IP，OpenStrm 只认 X-Forwarded-For）" : cf ? "（它带的是 CF-Connecting-IP，OpenStrm 只认 X-Forwarded-For）" : "";
    if (ip === PROBE_CANARY) {
      return {
        ok: false,
        detail: `反代没往 X-Forwarded-For 里加客户端地址，而是把请求里带的原样转了过来${other}，TRUST_PROXY 又信任了它：外面的人在请求头里写什么地址，OpenStrm 就当它是来源，按来源的登录退避、限流都能绕过去。${APPEND_XFF}`,
      };
    }
    return {
      ok: false,
      detail: `反代没把客户端地址加进 X-Forwarded-For${other}：公网上所有人都会被算成 ${peer}，登录失败退避、公网限流会互相连累，别人试错几次你自己也登不上。${APPEND_XFF}，容器设 TRUST_PROXY=true`,
    };
  }

  // 第一层代理看到的来源，就是这台服务器出去时的地址（经过 Cloudflare 的，它直接写在 CF-Connecting-IP 里）
  const origin = cf ?? appended[0];
  // 内网 DNS、NAT 回环：请求没真的出去，第一层代理看到的是内网地址，TRUST_PROXY=true 会把它也当成代理跳过去
  const hairpin = cf === null && isInternalAddress(origin);
  const hairpinDetail = `自检的请求是在内网里绕回来的（第一层代理看到的来源是内网地址 ${origin}：NAT 回环，或者内网 DNS 把域名解析到了内网），从这里看不出外面来的请求认得对不对，照 README 核对一下 TRUST_PROXY`;

  if (ip === PROBE_CANARY) {
    if (hairpin) return { ok: true, warn: true, detail: hairpinDetail };
    return {
      ok: false,
      detail: `TRUST_PROXY 信任过头（${setting}）：客户端自己在请求头里写的地址也被当成了来源，按来源的登录退避、限流都能绕过去。${hopsAdvice(chain, origin, cf)}`,
    };
  }
  if (ip === origin) {
    if (hairpin) return { ok: true, warn: true, detail: hairpinDetail };
    return { ok: true, detail: `认出的来源是 ${ip}，就是自检请求从这台服务器出去时的公网地址：TRUST_PROXY 配得对` };
  }
  if (ip === peer) {
    const where = isInternalAddress(peer)
      ? "它在本机或内网里，写 TRUST_PROXY=true 就行"
      : "它在公网上（比如 CDN 直接连到 OpenStrm 的端口）：把它所在的网段写进 TRUST_PROXY";
    if (!trusted) {
      return {
        ok: false,
        detail: `请求经过了反代（${peer}），但没设 TRUST_PROXY：公网上所有人都会被算成它，登录失败退避、公网限流会互相连累，别人试错几次你自己也登不上。${where}`,
      };
    }
    return { ok: false, detail: `${setting}，但没信任直接连过来的这一层（${peer}）：${where}` };
  }
  // 认出的是中间某一层代理：比如 CDN → 反代 → OpenStrm，只信了反代
  return {
    ok: false,
    detail: `认出的来源是 ${ip}：这是中间一层代理${cf ? "（Cloudflare 的节点）" : ""}，不是客户端，公网上的人会按代理节点分桶。${hopsAdvice(chain, origin, cf)}`,
  };
}

/** 该信几层：按探针这次经过的代理数给。写层数的前提是 OpenStrm 的端口只能经过这几层访问 */
function hopsAdvice(chain: string[], origin: string, cf: string | null): string {
  const at = chain.lastIndexOf(origin);
  if (at === -1) {
    // Cloudflare 看到的来源不在链上：后面有一层把 X-Forwarded-For 整个换掉了
    return `中间有一层反代把 X-Forwarded-For 换成了上一跳的地址（nginx 写的是 $remote_addr）：${APPEND_XFF}，再按代理层数设 TRUST_PROXY`;
  }
  const hops = chain.length - at;
  if (hops <= 1) return "前面只有一层反代：TRUST_PROXY 写 true（反代在本机或内网里），或者写反代自己的地址";
  return `前面一共 ${hops} 层代理${cf ? "（Cloudflare → 反代）" : ""}：TRUST_PROXY 写 ${hops}。前提是 OpenStrm 的端口只能经过这几层访问（能绕过它们直接连上的话，别人可以自己写 X-Forwarded-For），做不到就把每一层代理的网段写进 TRUST_PROXY${cf ? "（Cloudflare 的网段见 cloudflare.com/ips）" : ""}`;
}

/* ------------------------------- 自检 ------------------------------- */

/** 两家网页客户端的 CIMD 元数据地址（2026-09 核实） */
const KNOWN_CIMD = [
  ["claude.ai", "https://claude.ai/oauth/mcp-oauth-client-metadata"],
  ["ChatGPT", "https://chatgpt.com/oauth/client.json"],
] as const;

const TIMEOUT_MS = 8000;

interface Probe {
  status: number;
  headers: Headers;
  json: unknown;
}

async function probe(url: string, init: RequestInit = {}): Promise<Probe> {
  const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json };
}

const unreachable = (url: string, err: unknown) =>
  `访问不到 ${url}：${err instanceof Error ? err.message : String(err)}。也可能只是服务器访问不了自己的公网地址（网络不支持回环访问），用手机流量打开这个地址试试`;

/**
 * 回应是不是被挡在了半路：Cloudflare Access 的登录页、Cloudflare 的质询页（Bot Fight Mode / WAF）。
 * 认得出就直接说，不然只能笼统地说「要放行」
 */
function blockedBy(r: Probe): string | null {
  const location = r.headers.get("location") ?? "";
  if (r.status >= 300 && r.status < 400 && /cloudflareaccess\.com|\/cdn-cgi\/access\//i.test(location)) {
    return "被 Cloudflare Access 挡住了（跳去了它的登录页）：给智能体用的几个路径建 Bypass 应用，见 README";
  }
  if (r.headers.get("cf-mitigated") === "challenge") {
    return "被 Cloudflare 的质询挡住了（Bot Fight Mode / WAF）：给智能体用的几个路径加跳过规则";
  }
  return null;
}

export async function runSelfCheck(): Promise<AgentSelfCheckItem[]> {
  const base = publicBaseUrl();
  if (!base) return [{ name: "公网地址", ok: false, detail: "还没填公网地址：网页客户端（claude.ai、ChatGPT）要从公网连过来" }];
  const agent = readAppSetting("agent");
  const items: AgentSelfCheckItem[] = [];
  if (agent?.enabled !== true) {
    items.push({ name: "智能体接入", ok: false, detail: "还没开启：外面连进来都是 404" });
  }
  const url = new URL(base);
  if (url.port) {
    items.push({
      name: "公网地址的端口",
      ok: true,
      warn: true,
      detail: `公网地址带了端口 :${url.port}：claude.ai 的服务器只往 443 端口连（带别的端口的地址连不上，社区多次报告过），ChatGPT 也按 443 准备。443 被封的可以用 Cloudflare Tunnel`,
    });
  }

  const prmUrl = `${base}${WELL_KNOWN_PRM}${MCP_PATH}`;
  try {
    const r = await probe(prmUrl);
    const resource = (r.json as { resource?: unknown } | null)?.resource;
    const ok = r.status === 200 && resource === `${base}${MCP_PATH}`;
    items.push({
      name: "受保护资源元数据",
      ok,
      detail: ok
        ? prmUrl
        : `回了 ${r.status}${resource ? `，resource 是 ${String(resource)}` : ""}：${blockedBy(r) ?? "反代 / Tunnel 要放行 /.well-known/oauth-protected-resource 这几个路径"}`,
    });
  } catch (err) {
    items.push({ name: "受保护资源元数据", ok: false, detail: unreachable(prmUrl, err) });
  }

  const asUrl = `${base}${WELL_KNOWN_AS}`;
  try {
    const r = await probe(asUrl);
    const issuer = (r.json as { issuer?: unknown } | null)?.issuer;
    const ok = r.status === 200 && issuer === base;
    items.push({ name: "授权服务器元数据", ok, detail: ok ? asUrl : `回了 ${r.status}：${blockedBy(r) ?? "反代 / Tunnel 要放行 /.well-known/oauth-authorization-server"}` });
  } catch (err) {
    items.push({ name: "授权服务器元数据", ok: false, detail: unreachable(asUrl, err) });
  }

  const mcpUrl = `${base}${MCP_PATH}`;
  // /mcp 这次顺带当来源地址的探针：POST 不会被 CDN 缓存，一定真的打到这里
  const nonce = startSourceProbe();
  let mcpOk = false;
  try {
    const r = await probe(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        [PROBE_HEADER]: nonce,
        "x-forwarded-for": PROBE_CANARY,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const challenge = r.headers.get("www-authenticate") ?? "";
    mcpOk = r.status === 401 && challenge.includes("resource_metadata=");
    items.push({
      name: "MCP 地址",
      ok: mcpOk,
      detail: mcpOk ? `${mcpUrl}（不带令牌回 401，指到了元数据）` : `回了 ${r.status}：${blockedBy(r) ?? "反代 / Tunnel 要放行 POST /mcp，并且别缓冲流式响应"}`,
    });
  } catch (err) {
    items.push({ name: "MCP 地址", ok: false, detail: unreachable(mcpUrl, err) });
  }

  const seen = finishSourceProbe(nonce);
  if (seen) {
    items.push({ name: "来源地址（TRUST_PROXY）", ...judgeSource(seen, process.env.TRUST_PROXY) });
  } else if (mcpOk) {
    // /mcp 那一项没过的，上面已经说了原因；过了却没见到探针：回应不是这台 OpenStrm 给的
    items.push({
      name: "来源地址（TRUST_PROXY）",
      ok: false,
      detail: "公网地址回了 401，但请求没到这台 OpenStrm：公网地址是不是指到了别的机器，或者中间有一层把自检加的请求头去掉了",
    });
  }

  if (agent?.publicServesUi === true) {
    items.push({
      name: "管理界面在公网上（共用域名）",
      ok: true,
      detail: `${url.host} 也能打开管理界面：管理员密码要够长、别和别处重复，放在反代 / Tunnel 后面要设对 TRUST_PROXY（看上一项）。想再加一层，可以给管理界面套 Cloudflare Access 之类的身份代理，放行 /mcp、/oauth/token、/oauth/register、/oauth/revoke 和 /.well-known 下的两个元数据`,
    });
  } else {
    for (const [name, path] of [
      ["管理界面不在公网上", "/"],
      ["管理接口不在公网上", "/api/task"],
    ] as const) {
      const target = `${base}${path}`;
      try {
        const r = await probe(target);
        const ok = r.status === 404;
        items.push({
          name,
          ok,
          detail: ok
            ? `${target} 回 404（平时从外网就用 ${url.host} 打开管理界面的话，打开「这个域名也用来打开管理界面」）`
            : `${target} 回了 ${r.status}：这个域名下应该只放行智能体用的几个路径（要在这个域名上用管理界面，打开「这个域名也用来打开管理界面」）`,
        });
      } catch (err) {
        items.push({ name, ok: false, detail: unreachable(target, err) });
      }
    }
  }

  if (agent?.oauthCimd === true) {
    for (const [client, cimdUrl] of KNOWN_CIMD) {
      try {
        await fetchClientMetadata(cimdUrl);
        items.push({ name: `取 ${client} 的客户端元数据（CIMD）`, ok: true, detail: cimdUrl });
      } catch (err) {
        items.push({
          name: `取 ${client} 的客户端元数据（CIMD）`,
          ok: false,
          detail: `${err instanceof OAuthError ? err.forHuman : String(err)}（${cimdUrl}）`,
        });
      }
    }
  }
  return items;
}
