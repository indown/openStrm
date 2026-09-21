/**
 * 跨域按路径给：
 *   - 智能体用的几个路径（CORS_PATHS：/mcp、/oauth/token|register|revoke、两份元数据）对任何来源开放：
 *     浏览器里的 MCP 客户端要读 401 的 WWW-Authenticate（找授权服务器）、429 的 Retry-After，得明着放出来。
 *   - /api 和别的不对外站开放：管理界面是同源的（生产由 API 进程托管，开发走 next dev 的 rewrites），用不到跨域；
 *     反射任意来源的话，随便一个网页都能借访客的浏览器来试管理员密码，每个访客一个来源，按来源的退避就白搭了。
 *   - 本机来源（localhost、127.0.0.1、[::1]）照开：给把 NEXT_PUBLIC_API_URL 指到别处的开发方式兜底。
 * 不开 credentials：凭据是请求头里的 Bearer token，没有 cookie。
 */
import type { FastifyCorsOptions } from "@fastify/cors";
import type { FastifyRequest } from "fastify";
import { CORS_PATHS } from "../services/oauth/config.js";

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const EXPOSED = ["WWW-Authenticate", "Retry-After"];

/** 这个路径、这个来源给不给跨域 */
export function corsOptionsFor(path: string, origin: string | undefined): FastifyCorsOptions {
  if (CORS_PATHS.has(path) || (origin !== undefined && LOCAL_ORIGIN.test(origin))) return { origin: true, exposedHeaders: EXPOSED };
  return { origin: false };
}

/** @fastify/cors 的 delegator：每个请求按路径和来源给一份配置 */
export function corsDelegator(request: FastifyRequest, callback: (error: Error | null, options?: FastifyCorsOptions) => void): void {
  callback(null, corsOptionsFor(request.url.split("?")[0], request.headers.origin));
}
