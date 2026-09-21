import fp from "fastify-plugin";
import { SignJWT, jwtVerify } from "jose";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { AgentScope, AgentToken, AgentToolset } from "@openstrm/shared";

import { isUsingDefaultPassword, passwordVersion, resolveJwtSecret } from "../db/repositories/auth.js";
import { TOKEN_PREFIX } from "../db/repositories/api-tokens.js";
import { recordAgentCall } from "../db/repositories/agent-audit.js";
import { HttpError } from "../lib/http-error.js";
import { moduleLogger } from "../lib/logger.js";
import { agentEnabled, requireAgentScope, requireAgentToolset, verifyAgentToken } from "../services/agent/access.js";
import { summarizeArgs } from "../services/agent/format.js";
import { takeAgentQuota } from "../services/agent/rate-limit.js";

/** 前端据此把用户引导到改密码页，不要改动字面量。 */
export const PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED";

const log = moduleLogger("auth");

export const authPlugin = fp(async (fastify) => {
  // 必须在插件体内取密钥：ESM 的 import 求值早于 index.ts 里的 initDb()，
  // 放在模块顶层读库会撞上还没建好的表。
  const JWT_SECRET = new TextEncoder().encode(resolveJwtSecret());

  if (isUsingDefaultPassword()) {
    fastify.log.warn("[auth] 仍在使用默认密码，除修改密码外的接口一律拒绝");
  }

  // JWT sign helper。pv 是当前口令的指纹：改密码后老 token 失效，泄露的 token 才真的能被轮换掉
  fastify.decorate("signJwt", async (payload: Record<string, unknown>) => {
    return new SignJWT({ ...payload, pv: passwordVersion() })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("24h")
      .sign(JWT_SECRET);
  });

  // JWT verify helper
  fastify.decorate("verifyJwt", async (token: string) => {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload;
  });

  // Auth preHandler hook
  fastify.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      throw new HttpError(401, "Unauthorized", { code: "UNAUTHORIZED" });
    }
    const bearer = authHeader.slice(7).trim();

    if (bearer.startsWith(TOKEN_PREFIX)) {
      authenticateAgentToken(request, reply, bearer);
    } else {
      try {
        request.user = await fastify.verifyJwt(bearer);
      } catch {
        throw new HttpError(401, "Invalid or expired token", { code: "UNAUTHORIZED" });
      }
      // 密码改过之后签发的 token 才算数：没有这一步，24 小时内泄露的 token 改密码也收不回来
      if (request.user.pv !== passwordVersion()) {
        throw new HttpError(401, "密码已更改，请重新登录", { code: "UNAUTHORIZED" });
      }
      request.principal = { kind: "session" };
    }

    // 默认口令是公开的，此时拿到 token 不代表这个人有权限。除改密码本身外
    // 一律挡下——判断放在这里，是因为所有受保护路由共用这一个 preHandler，
    // 逐个路由加守卫早晚会漏掉一个。
    if (!request.routeOptions.config?.allowDefaultPassword && isUsingDefaultPassword()) {
      throw new HttpError(403, "请先修改默认密码", { code: PASSWORD_CHANGE_REQUIRED });
    }
  });

  // 令牌直接调 REST 的也记一笔：和 MCP 工具调用进同一张表，设置页「最近调用」能看到
  fastify.addHook("onResponse", async (request, reply) => {
    const p = request.principal;
    if (p?.kind !== "token" || request.routeOptions.config?.agentAudit === false) return;
    try {
      recordAgentCall({
        tokenId: p.token.id,
        tokenName: p.token.name,
        ip: request.ip,
        tool: `${request.method} ${request.routeOptions.url ?? request.url.split("?")[0]}`,
        // 同一个接口按参数干不同的事（/api/share 的 action）：不记参数就分不清查看和转存
        args: summarizeArgs(restArgs(request)),
        ok: reply.statusCode < 400,
        error: reply.statusCode < 400 ? "" : String(reply.statusCode),
        durationMs: Math.round(reply.elapsedTime),
      });
    } catch (err) {
      log.warn({ err }, "记录令牌调用失败");
    }
  });
}, { name: "auth" });

/** 令牌调 REST 时记进调用记录的参数：路径参数、查询串、body 摊平成一个对象 */
function restArgs(request: FastifyRequest): Record<string, unknown> {
  const pick = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  return { ...pick(request.params), ...pick(request.query), ...pick(request.body) };
}

/**
 * 令牌只能调声明了档位的路由（`config.agentScope`），没声明的一律 403：
 * 以后新加的路由默认不对令牌开放，不会有哪个忘了加守卫。
 * 账号、设置、令牌管理、备份这些永远不声明。路由属于某组工具的（`config.agentToolset`），令牌还得勾了那一组。
 */
function authenticateAgentToken(request: FastifyRequest, reply: FastifyReply, bearer: string): void {
  if (!agentEnabled()) {
    throw new HttpError(403, "智能体接入没有开启", { code: "AGENT_DISABLED" });
  }
  const token = verifyAgentToken(bearer, request.ip);
  if (!token) throw new HttpError(401, "令牌无效或已过期", { code: "UNAUTHORIZED" });
  // 和 /mcp 共用一个桶：绕开 MCP 直接调 REST 也躲不过限流。限流挡下的不记调用记录（被刷时不能每个请求写一行库）
  const quota = takeAgentQuota(token.id);
  if (!quota.ok) {
    reply.header("retry-after", String(quota.retryAfterSeconds));
    throw new HttpError(429, `请求太频繁，${quota.retryAfterSeconds} 秒后再试`, { code: "RATE_LIMITED", retryAfterSeconds: quota.retryAfterSeconds });
  }
  // 先认下身份再查档位：被挡下的越权尝试也要进调用记录，那正是最该留痕的
  request.principal = { kind: "token", token };
  const config = request.routeOptions.config;
  if (!config?.agentScope) throw new HttpError(403, "这个接口不对令牌开放", { code: "TOKEN_NOT_ALLOWED" });
  requireAgentScope(request, config.agentScope);
  if (config.agentToolset) requireAgentToolset(request, config.agentToolset);
}

/** 谁在调：管理界面登录的会话，或者智能体的令牌 */
export type Principal = { kind: "session" } | { kind: "token"; token: AgentToken };

declare module "fastify" {
  interface FastifyContextConfig {
    /** 置为 true 的路由在强制改密码期间依然可以访问 */
    allowDefaultPassword?: boolean;
    /** 令牌调这个路由要有的档位；不声明就不对令牌开放 */
    agentScope?: AgentScope;
    /** 这个路由属于哪组工具：令牌只勾了别的组就调不了。基础的（任务列表）不声明 */
    agentToolset?: AgentToolset;
    /** false：这个路由自己记调用（/mcp 在工具层逐个记），不再按 HTTP 请求记一笔 */
    agentAudit?: boolean;
  }
  interface FastifyInstance {
    signJwt: (payload: Record<string, unknown>) => Promise<string>;
    verifyJwt: (token: string) => Promise<Record<string, unknown>>;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user?: Record<string, unknown>;
    principal?: Principal;
  }
}
