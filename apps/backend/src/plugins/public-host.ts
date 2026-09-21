/**
 * 公网域名只放行智能体用的那几个路径：从设置里的公网地址（比如 https://mcp.example.com）这个域名进来的请求，
 * 不在白名单里的一律 404，管理界面和 /api 不上公网。反代 / Tunnel 按路径放行是第一道，这里是第二道。
 *
 *   - 认主机名时把能看到的都比一遍：原始的 Host 头、X-Forwarded-Host 里的每一个、Fastify 算出来的 hostname，
 *     哪个是公网域名就算公网请求。只能「更严」不能「更松」：客户端自己加一个 X-Forwarded-Host 换不掉原始 Host。
 *   - 主机名先规范化：小写、去端口、去结尾的点（mcp.example.com. 和不带点的是同一个域名，不规范化的话加个点就绕过去了）。
 *   - 路径精确匹配（不解码、不去结尾的 /）：/mcp/、/%6Dcp、/oauth/../api 这些变体一律不认；方法也按路径卡（见 PUBLIC_ROUTES）。
 *   - 不看智能体接入开没开：公网地址填着，这个域名就还指着这台机器，开关关了也不能把管理界面漏出去。
 */
import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { isPublicRoute, normalizeHost, publicHostname } from "../services/oauth/config.js";

/** 每个请求都要看一眼：公网地址缓存 5 秒，改完设置最多 5 秒后生效 */
const CACHE_MS = 5000;
let cached: { at: number; host: string | null } | null = null;

function publicHost(now = Date.now()): string | null {
  if (cached && now - cached.at < CACHE_MS) return cached.host;
  cached = { at: now, host: publicHostname() };
  return cached.host;
}

/** 测试用：设置改了马上生效 */
export function __test_resetPublicHost(): void {
  cached = null;
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

/** 是不是从公网域名进来的 */
export function isPublicHostRequest(request: FastifyRequest): boolean {
  const host = publicHost();
  return host !== null && requestHosts(request).includes(host);
}

export const publicHostPlugin = fp(
  async (fastify) => {
    fastify.addHook("onRequest", async (request, reply) => {
      if (!isPublicHostRequest(request)) return;
      if (isPublicRoute(request.method, request.url.split("?")[0])) return;
      return reply.code(404).send({ message: "Not found", code: "NOT_FOUND" });
    });
  },
  { name: "public-host" },
);
