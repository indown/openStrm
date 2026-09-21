/**
 * 智能体接入的管理：令牌增删改、工具目录、调用记录。
 * 只认管理界面的会话——这些路由都不声明 agentScope，令牌调一律 403：令牌不能再签令牌。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentInfo, AgentScope, AgentTokenCreated, AgentToolset } from "@openstrm/shared";
import { readAuthConfig } from "../../db/repositories/auth.js";
import {
  AGENT_SCOPES,
  AGENT_TOOLSETS,
  createApiToken,
  deleteAllApiTokens,
  deleteApiToken,
  getApiToken,
  listApiTokens,
  updateApiToken,
} from "../../db/repositories/api-tokens.js";
import { listAgentCalls } from "../../db/repositories/agent-audit.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { MCP_PATH, agentEnabled } from "../../services/agent/access.js";
import { toolCatalog } from "../../services/agent/tools/index.js";
import { verifyPassword } from "../../services/password.js";

// 和库里认的是同一份清单：加档位 / 工具集只改 api-tokens.ts 一处
const scopeSchema = z.enum(AGENT_SCOPES);
const toolsetSchema = z.enum(AGENT_TOOLSETS);
const nameSchema = z.string().trim().min(1, "名称不能为空").max(60, "名称最多 60 个字");
/** 不给或 null = 眼下的全部工具集（存成明确的列表） */
const toolsetsSchema = z.array(toolsetSchema).min(1, "至少选一组工具，或者选「全部」").nullable().optional();

const createSchema = z.object({
  name: nameSchema,
  scopes: z.array(scopeSchema).min(1, "至少选一个权限档"),
  toolsets: toolsetsSchema,
  /** 不给或 null = 不过期 */
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
  /** 管理界面的登录密码：签令牌等于发一把不随改密码失效的钥匙，光有会话不够 */
  currentPassword: z.string().default(""),
});

const patchSchema = z.object({
  name: nameSchema.optional(),
  scopes: z.array(scopeSchema).min(1, "至少选一个权限档").optional(),
  toolsets: toolsetsSchema,
});

function resolveToolsets(toolsets: AgentToolset[] | null | undefined): AgentToolset[] {
  return toolsets ? AGENT_TOOLSETS.filter((t) => toolsets.includes(t)) : [...AGENT_TOOLSETS];
}

const idParams = z.object({ id: z.string().min(1) });
const callsQuery = z.object({
  tokenId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** 「查看」总是带上：总览、任务列表这些基础工具都要它。顺序按档位从低到高 */
function normalizeScopes(scopes: AgentScope[]): AgentScope[] {
  const set = new Set<AgentScope>([...scopes, "read"]);
  return AGENT_SCOPES.filter((s) => set.has(s));
}

function assertUniqueName(name: string, exceptId?: string): void {
  if (listApiTokens().some((t) => t.name === name && t.id !== exceptId)) {
    throw new HttpError(409, `已经有叫「${name}」的令牌了，换个名字好区分`);
  }
}

export default async function (fastify: FastifyInstance) {
  const auth = { preHandler: [fastify.authenticate] };

  fastify.get("/api/agent/info", auth, async (): Promise<AgentInfo> => ({
    enabled: agentEnabled(),
    mcpPath: MCP_PATH,
    tools: toolCatalog(),
  }));

  fastify.get("/api/agent/tokens", auth, async () => listApiTokens());

  fastify.post("/api/agent/tokens", auth, async (request, reply) => {
    const body = parse(createSchema, request.body);
    // 会话被偷了也签不出令牌：令牌不随改密码失效，拿着偷来的会话签一把就能一直用下去。
    // 密码错回 400 不回 401：401 会让前端当成会话失效、把人踢回登录页
    const stored = readAuthConfig().password;
    if (!(await verifyPassword(body.currentPassword, typeof stored === "string" ? stored : ""))) {
      throw new HttpError(400, "当前密码不正确", { code: "WRONG_PASSWORD" });
    }
    assertUniqueName(body.name);
    const expiresAt = body.expiresInDays ? Math.floor(Date.now() / 1000) + body.expiresInDays * 86400 : null;
    const created: AgentTokenCreated = createApiToken({
      name: body.name,
      scopes: normalizeScopes(body.scopes),
      toolsets: resolveToolsets(body.toolsets),
      expiresAt,
    });
    return reply.code(201).send(created);
  });

  fastify.patch("/api/agent/tokens/:id", auth, async (request) => {
    const { id } = parse(idParams, request.params, "params");
    const body = parse(patchSchema, request.body);
    if (!getApiToken(id)) throw new HttpError(404, "令牌不存在");
    if (body.name !== undefined) assertUniqueName(body.name, id);
    return updateApiToken(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.scopes !== undefined ? { scopes: normalizeScopes(body.scopes) } : {}),
      ...(body.toolsets !== undefined ? { toolsets: resolveToolsets(body.toolsets) } : {}),
    });
  });

  fastify.delete("/api/agent/tokens/:id", auth, async (request) => {
    const { id } = parse(idParams, request.params, "params");
    if (!deleteApiToken(id)) throw new HttpError(404, "令牌不存在");
    return { success: true };
  });

  /** 全部撤销：怀疑令牌泄露时一键收回 */
  fastify.delete("/api/agent/tokens", auth, async () => ({ deleted: deleteAllApiTokens() }));

  fastify.get("/api/agent/calls", auth, async (request) => {
    const q = parse(callsQuery, request.query, "query");
    return { calls: listAgentCalls({ tokenId: q.tokenId || undefined, limit: q.limit ?? 50 }) };
  });
}
