/**
 * 令牌校验和档位检查：REST（plugins/auth.ts）和 /mcp（routes/mcp）共用这一套。
 * 这里不碰 MCP SDK：SDK 只在请求真的进了 /mcp 时才加载。
 */
import type { FastifyRequest } from "fastify";
import type { AgentScope, AgentToken, AgentToolset } from "@openstrm/shared";
import { findApiToken, touchApiToken } from "../../db/repositories/api-tokens.js";
import { readAppSetting } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";

/** MCP 端点的路径；设置页拼给客户端的地址也用它 */
export const MCP_PATH = "/mcp";
/** /mcp 把调用方（校验过的令牌 + IP）放在 SDK 的 authInfo.extra 的这个键下，server.ts 从这里拿 */
export const AGENT_CALLER_KEY = "agentCaller";

export const SCOPE_LABEL: Record<AgentScope, string> = {
  read: "查看",
  run: "运行",
  write: "改网盘",
  danger: "删除与花费",
};

/** 设置里的总开关，默认关 */
export function agentEnabled(): boolean {
  return readAppSetting("agent")?.enabled === true;
}

/** 明文 → 有效的令牌（顺手记最近使用）；无效或过期回 null */
export function verifyAgentToken(raw: string, ip: string | null): AgentToken | null {
  const token = findApiToken(raw);
  if (!token) return null;
  touchApiToken(token.id, ip);
  return token;
}

export function hasScope(token: Pick<AgentToken, "scopes">, scope: AgentScope): boolean {
  return token.scopes.includes(scope);
}

/** 工具集：不属于任何一组的工具 / 接口是基础的，谁都能用 */
export function hasToolset(token: Pick<AgentToken, "toolsets">, toolset: AgentToolset | null | undefined): boolean {
  return !toolset || token.toolsets.includes(toolset);
}

/**
 * 路由里的二次检查：一个接口按参数分风险（比如 /api/share 的 receive 要改网盘）时用。
 * 会话调用不受限。
 */
export function requireAgentScope(request: FastifyRequest, scope: AgentScope): void {
  const p = request.principal;
  if (p?.kind !== "token" || hasScope(p.token, scope)) return;
  throw new HttpError(403, `令牌没有「${SCOPE_LABEL[scope]}」权限`, { code: "INSUFFICIENT_SCOPE", required: scope });
}

export const TOOLSET_LABEL: Record<AgentToolset, string> = {
  sync: "同步",
  transfer: "搜资源、转存与云下载",
  organize: "整理",
  follow: "追更",
  strm: "strm 管理",
};

/** 同上，查工具集：令牌只勾了「同步」就调不了转存那一组的接口 */
export function requireAgentToolset(request: FastifyRequest, toolset: AgentToolset): void {
  const p = request.principal;
  if (p?.kind !== "token" || hasToolset(p.token, toolset)) return;
  throw new HttpError(403, `令牌没有勾选「${TOOLSET_LABEL[toolset]}」这组工具`, { code: "TOOLSET_NOT_ALLOWED", required: toolset });
}
