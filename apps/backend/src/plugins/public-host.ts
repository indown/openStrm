/**
 * 公网域名只放行智能体用的那几个路径：从设置里的公网地址（比如 https://mcp.example.com）这个域名进来的请求，
 * 不在白名单里的一律 404，管理界面和 /api 不上公网。反代 / Tunnel 按路径放行是第一道，这里是第二道。
 *
 *   - 认主机名时把能看到的都比一遍：原始的 Host 头、X-Forwarded-Host 里的每一个、Fastify 算出来的 hostname，
 *     哪个是公网域名就算公网请求。只能「更严」不能「更松」：客户端自己加一个 X-Forwarded-Host 换不掉原始 Host。
 *   - 主机名先规范化：小写、去端口、去结尾的点（mcp.example.com. 和不带点的是同一个域名，不规范化的话加个点就绕过去了）。
 *   - 路径精确匹配（不解码、不去结尾的 /）：/mcp/、/%6Dcp、/oauth/../api 这些变体一律不认；方法也按路径卡（见 PUBLIC_ROUTES）。
 *   - 不看智能体接入开没开：公网地址填着，这个域名就还指着这台机器，开关关了也不能把管理界面漏出去。
 *   - 设置里打开了「这个域名也用来打开管理界面」（publicServesUi，多数人就一个域名）就整个不拦：
 *     管理界面本来就放在这个域名上，拦了只会把它自己挡在外面。
 * 顺带（每个请求都经过这里）：记下连接自检的探针；有请求经内网里的反代进来、容器却没设 TRUST_PROXY 的，记一笔给设置页提示。
 */
import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { isInternalAddress } from "../lib/ip.js";
import { trustProxyOption } from "../lib/trust-proxy.js";
import { isPublicRoute, normalizeHost, publicHostname, publicServesUi } from "../services/oauth/config.js";
import { noteSelfCheckProbe } from "../services/oauth/selfcheck.js";

/** 每个请求都要看一眼：公网地址和共用开关缓存 5 秒（保存设置时立刻清掉，见 invalidatePublicHost） */
const CACHE_MS = 5000;
let cached: { at: number; host: string | null; servesUi: boolean } | null = null;

function publicHost(now = Date.now()): { host: string | null; servesUi: boolean } {
  if (cached && now - cached.at < CACHE_MS) return cached;
  cached = { at: now, host: publicHostname(), servesUi: publicServesUi() };
  return cached;
}

/** 设置改了马上生效：保存设置之后调（不然自检、守卫在 5 秒里还按旧的设置走） */
export function invalidatePublicHost(): void {
  cached = null;
}

/** 最近一次看到「经内网里的反代进来、却没设 TRUST_PROXY」的请求 */
let untrustedProxy: { peer: string; at: number } | null = null;

/**
 * 带着 X-Forwarded-For、直接连过来的又是本机 / 内网地址（反代、cloudflared、docker 网关），而容器没设 TRUST_PROXY：
 * 公网上所有人都被算成这个反代的地址，登录退避、限流会互相连累。对端是公网地址的不记——那可能是有人直接连端口、
 * 自己写的头，这时候提示去设 TRUST_PROXY 反而会让伪造的来源生效
 */
function noteUntrustedProxy(request: FastifyRequest): void {
  if (request.headers["x-forwarded-for"] === undefined || trustProxyOption(process.env.TRUST_PROXY) !== false) return;
  const peer = request.socket?.remoteAddress;
  if (peer && isInternalAddress(peer)) untrustedProxy = { peer, at: Date.now() };
}

/** 设置页用：有没有「反代后面没设 TRUST_PROXY」的迹象 */
export function untrustedProxySeen(): { peer: string; at: number } | null {
  return untrustedProxy;
}

/** 测试用 */
export function __test_resetUntrustedProxy(): void {
  untrustedProxy = null;
}

/** 这个请求能看到的所有主机名（规范化过的） */
export function requestHosts(request: FastifyRequest): string[] {
  const out = new Set<string>();
  const add = (v: string | undefined) => {
    const h = normalizeHost(v);
    if (h) out.add(h);
  };
  add(request.headers.host);
  const xfh = request.headers["x-forwarded-host"];
  for (const v of Array.isArray(xfh) ? xfh : xfh ? [xfh] : []) for (const part of v.split(",")) add(part);
  add(request.hostname);
  return [...out];
}

/** 是不是从公网域名进来的（共用域名时也算：401 要不要指到元数据按这个认） */
export function isPublicHostRequest(request: FastifyRequest): boolean {
  const { host } = publicHost();
  return host !== null && requestHosts(request).includes(host);
}

export const publicHostPlugin = fp(
  async (fastify) => {
    fastify.addHook("onRequest", async (request, reply) => {
      // 连接自检绕公网回来的探针：记下这次看到的来源（请求头里有它的一次性标记才记）
      noteSelfCheckProbe(request);
      noteUntrustedProxy(request);
      if (publicHost().servesUi || !isPublicHostRequest(request)) return;
      if (isPublicRoute(request.method, request.url.split("?")[0])) return;
      return reply.code(404).send({ message: "Not found", code: "NOT_FOUND" });
    });
  },
  { name: "public-host" },
);
