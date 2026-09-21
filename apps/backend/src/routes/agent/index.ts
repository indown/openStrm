/**
 * 智能体接入的管理：令牌增删改、工具目录、调用记录；网页客户端（OAuth）的待批准、已连接、预注册客户端、连接自检。
 * 只认管理界面的会话——这些路由都不声明 agentScope，令牌调一律 403：令牌不能再签令牌、也不能批准授权。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentInfo, AgentOAuthState, AgentScope, AgentTokenCreated, AgentToolset, OAuthClientCreated } from "@openstrm/shared";
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
import {
  createManualClient,
  deleteAllOAuthGrants,
  deleteOAuthClient,
  deleteOAuthGrant,
  getOAuthClient,
  getOAuthRequest,
  listManualClients,
  listOAuthGrants,
  listPendingOAuthRequests,
  normalizePairingCode,
  toClientInfo,
} from "../../db/repositories/oauth.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { MCP_PATH, agentEnabled } from "../../services/agent/access.js";
import { toolCatalog } from "../../services/agent/tools/index.js";
import { assertCurrentPassword } from "../../services/current-password.js";
import { approveOAuthRequest, denyAllOAuthRequests, denyOAuthRequest, pendingRequestInfo } from "../../services/oauth/authorize.js";
import { oauthConfig, publicBaseUrl } from "../../services/oauth/config.js";
import { redirectUriProblem } from "../../services/oauth/redirect.js";
import { runSelfCheck } from "../../services/oauth/selfcheck.js";

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

const approveSchema = z.object({
  /** 授权页上显示的配对码：证明批的就是自己眼前这一条（见 services/oauth/authorize.ts 文件头） */
  pairingCode: z.string().trim().min(1, "输入授权页上的配对码").max(20),
  scopes: z.array(scopeSchema).min(1, "至少选一个权限档"),
  toolsets: toolsetsSchema,
  /** 批准等于发一把不随改密码失效的钥匙（刷新令牌一直能续），和建令牌一样光有会话不够 */
  currentPassword: z.string().default(""),
});

const manualClientSchema = z.object({
  name: nameSchema,
  redirectUris: z.array(z.string().trim().min(1).max(2000)).min(1, "至少填一个回调地址").max(10, "回调地址最多 10 个"),
});
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
    // 会话被偷了也签不出令牌：令牌不随改密码失效，拿着偷来的会话签一把就能一直用下去
    await assertCurrentPassword(request, reply, body.currentPassword);
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

  /* ------------------------------- 网页客户端（OAuth） ------------------------------- */

  fastify.get("/api/agent/oauth", auth, async (): Promise<AgentOAuthState> => {
    const base = publicBaseUrl();
    return {
      publicBaseUrl: base,
      active: oauthConfig() !== null,
      pending: listPendingOAuthRequests().map(pendingRequestInfo),
      // 令牌绑的资源不是现在的 <公网地址>/mcp（公网地址改过了）的，标成失效
      grants: listOAuthGrants(base ? `${base}${MCP_PATH}` : null),
      clients: listManualClients(),
    };
  });

  /**
   * 批准：输入授权页上的配对码（对不上什么都不改）、当前密码，选档位和工具集；给的档位会按客户端要的收窄。
   * 配对码先比：输错了不白占一次密码尝试
   */
  fastify.post("/api/agent/oauth/requests/:id/approve", auth, async (request, reply) => {
    const { id } = parse(idParams, request.params, "params");
    const body = parse(approveSchema, request.body);
    const record = getOAuthRequest(id);
    if (!record || record.status !== "pending" || record.expiresAt <= Math.floor(Date.now() / 1000)) {
      throw new HttpError(404, "这个授权请求已经处理过或过期了");
    }
    if (normalizePairingCode(body.pairingCode) !== record.pairingCode) {
      throw new HttpError(400, "配对码对不上：输入的得是这一条授权页上显示的那个。对不上说明这一条不是你眼前的授权页发起的，别批", {
        code: "WRONG_PAIRING_CODE",
      });
    }
    await assertCurrentPassword(request, reply, body.currentPassword);
    const result = approveOAuthRequest(id, body.pairingCode, { scopes: normalizeScopes(body.scopes), toolsets: resolveToolsets(body.toolsets) }, "ui");
    if (result !== "ok") throw new HttpError(404, "这个授权请求已经处理过或过期了");
    return { success: true };
  });

  /** 全部拒绝：有人在刷授权请求、待批准被占满时一键清掉 */
  fastify.post("/api/agent/oauth/requests/deny-all", auth, async () => ({ denied: denyAllOAuthRequests("ui") }));

  fastify.post("/api/agent/oauth/requests/:id/deny", auth, async (request) => {
    const { id } = parse(idParams, request.params, "params");
    if (!denyOAuthRequest(id, "ui")) throw new HttpError(404, "这个授权请求已经处理过或过期了");
    return { success: true };
  });

  /** 断开一个已连接的客户端：访问令牌、刷新令牌一起作废，它要再连得重新授权 */
  fastify.delete("/api/agent/oauth/grants/:id", auth, async (request) => {
    const { id } = parse(idParams, request.params, "params");
    if (!deleteOAuthGrant(id)) throw new HttpError(404, "这个客户端已经断开了");
    return { success: true };
  });

  fastify.delete("/api/agent/oauth/grants", auth, async () => ({ deleted: deleteAllOAuthGrants() }));

  /** 预注册客户端：给不会动态注册、又不能配请求头的客户端用；secret 只在这里给一次 */
  fastify.post("/api/agent/oauth/clients", auth, async (request, reply) => {
    const body = parse(manualClientSchema, request.body);
    for (const uri of body.redirectUris) {
      const problem = redirectUriProblem(uri);
      if (problem) throw new HttpError(400, problem.zh);
    }
    const { record, secret } = createManualClient({ name: body.name, redirectUris: body.redirectUris });
    const created: OAuthClientCreated = { clientId: record.id, clientSecret: secret, info: toClientInfo(record) };
    return reply.code(201).send(created);
  });

  /** 删预注册客户端连带断开用它连上的客户端 */
  fastify.delete("/api/agent/oauth/clients/:id", auth, async (request) => {
    const { id } = parse(idParams, request.params, "params");
    if (getOAuthClient(id)?.kind !== "manual") throw new HttpError(404, "没有这个预注册客户端");
    deleteOAuthClient(id);
    return { success: true };
  });

  /** 连接自检：从服务器这边请求公网地址，看网页客户端要走的路通不通 */
  fastify.post("/api/agent/selfcheck", auth, async () => ({ items: await runSelfCheck() }));

  fastify.get("/api/agent/calls", auth, async (request) => {
    const q = parse(callsQuery, request.query, "query");
    return { calls: listAgentCalls({ tokenId: q.tokenId || undefined, limit: q.limit ?? 50 }) };
  });
}
