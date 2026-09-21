/**
 * MCP 端点：给智能体客户端（Claude Code、Codex、Open WebUI……）用。设计见 .claude/plans/agent-access.md。
 *
 * 门口的检查全在 onRequest 里做完，body 解析之前：
 *   1. 开关关着 → 404
 *   2. 带着别的网站的 Origin → 403。只放行本机（官方调试工具跑在这里）和两家网页客户端的域名。
 *      不放行「和 Host 同名」的来源：本实例自己的页面不调 /mcp，而 DNS 重绑定时 Origin 和 Host
 *      正好都是攻击者的域名。命令行客户端和服务器对服务器的请求不带 Origin，不受影响
 *   3. 令牌不对 → 401 + WWW-Authenticate。必须在 SDK 之前：Open WebUI 探测鉴权方式时发的
 *      POST 不带 Accept、params 为空，交给 SDK 可能先报别的错，它就认不出这里要鉴权。
 *      认两种令牌：手建的 ostk_、网页客户端走 OAuth 拿到的 osat_。开了 OAuth、而且是从公网域名进来的，
 *      401 带 resource_metadata，claude.ai、ChatGPT 据此找到授权服务器；局域网地址上照旧只说要令牌——
 *      那边的客户端要是跟着元数据走，会因为资源地址（公网的 /mcp）对不上而失败，还不如直接说缺令牌。
 *      回 401 的按来源限流：没登录的请求谁都能发
 *   4. 还在用默认密码 → 403，和 REST 一样：默认口令是公开的，这时拿着令牌也不代表有权限
 *   5. 超出限流 → 429（不记调用记录：被刷的时候不能每个请求都写一行库）
 * body 解析之后：老版协议能一次批好多条消息，按条数补扣配额；令牌看不到的工具调用先记一笔，再交给 SDK。
 * GET / DELETE 一律 405（新旧两版规范都允许；我们无状态，没有会话可开可关），不鉴权——
 * 回 401 会让客户端以为要走 OAuth。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isUsingDefaultPassword } from "../../db/repositories/auth.js";
import { TOKEN_PREFIX } from "../../db/repositories/api-tokens.js";
import { ACCESS_TOKEN_PREFIX } from "../../db/repositories/oauth.js";
import { PASSWORD_CHANGE_REQUIRED, type Principal } from "../../plugins/auth.js";
import { AGENT_CALLER_KEY, MCP_PATH, agentEnabled, verifyAgentToken } from "../../services/agent/access.js";
import { recordToolCall, type AgentCaller } from "../../services/agent/calls.js";
import { anonymousIpBucket, takeAgentQuota } from "../../services/agent/rate-limit.js";
import { ipKey } from "../../lib/ip.js";
import { isPublicHostRequest } from "../../plugins/public-host.js";
import { isAgentTool, toolsFor } from "../../services/agent/tools/index.js";
import { CHALLENGE_SCOPE, oauthConfig } from "../../services/oauth/config.js";
import { verifyOAuthAccessToken } from "../../services/oauth/tokens.js";

/** 带 Origin 的请求只认这些：本机、两家网页客户端的服务器（以防它们带上 Origin） */
const ALLOWED_ORIGIN_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "claude.ai", "chatgpt.com"]);

/** 一个请求最多批几条消息：新版协议不批，老版客户端实际也很少批。比限流的桶小，补扣总扣得下 */
const MAX_BATCH = 10;

type NodeHandler = ReturnType<typeof import("@modelcontextprotocol/node").toNodeHandler>;

function originAllowed(origin: string): boolean {
  try {
    return ALLOWED_ORIGIN_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function tooManyRequests(reply: FastifyReply, retryAfterSeconds: number) {
  return reply
    .code(429)
    .header("retry-after", String(retryAfterSeconds))
    .send({ message: `请求太频繁，${retryAfterSeconds} 秒后再试`, code: "RATE_LIMITED", retryAfterSeconds });
}

async function guard(request: FastifyRequest, reply: FastifyReply) {
  if (!agentEnabled()) {
    return reply.code(404).send({ message: "智能体接入没有开启", code: "AGENT_DISABLED" });
  }
  const origin = request.headers.origin;
  if (origin && !originAllowed(origin)) {
    return reply.code(403).send({ message: "不接受这个来源的请求", code: "ORIGIN_NOT_ALLOWED" });
  }
  // 认证方案名不分大小写（RFC 9110 §11.1）
  const bearer = /^bearer\s+(.+)$/i.exec(request.headers.authorization ?? "")?.[1].trim() ?? "";
  const oauth = oauthConfig();
  const token = bearer.startsWith(TOKEN_PREFIX)
    ? verifyAgentToken(bearer, request.ip)
    : bearer.startsWith(ACCESS_TOKEN_PREFIX) && oauth
      ? verifyOAuthAccessToken(bearer, request.ip, oauth)
      : null;
  if (!token) {
    const quota = anonymousIpBucket.take(`ip:${ipKey(request.ip)}`);
    if (!quota.ok) return tooManyRequests(reply, quota.retryAfterSeconds);
    // 开了 OAuth、从公网域名进来的：按 RFC 9728 指到受保护资源元数据，网页客户端从这里走授权流程；带了令牌但不认的标 invalid_token
    const invalid = bearer ? ', error="invalid_token"' : "";
    const challenge =
      oauth && isPublicHostRequest(request)
        ? `Bearer resource_metadata="${oauth.resourceMetadataUrl}", scope="${CHALLENGE_SCOPE}"${invalid}`
        : `Bearer realm="OpenStrm"${invalid}`;
    return reply
      .code(401)
      .header("www-authenticate", challenge)
      .send({ message: bearer ? "令牌无效或已过期" : "缺少令牌：请求头带上 Authorization: Bearer ostk_…", code: "UNAUTHORIZED" });
  }
  if (isUsingDefaultPassword()) {
    return reply.code(403).send({ message: "请先修改默认密码", code: PASSWORD_CHANGE_REQUIRED });
  }
  const quota = takeAgentQuota(token.id);
  if (!quota.ok) return tooManyRequests(reply, quota.retryAfterSeconds);
  request.principal = { kind: "token", token };
}

/** tools/call 了令牌看不到的工具：SDK 只回一句「Tool X not found」、不经过工具层，这里先记一笔——越权尝试最该留痕 */
function auditUnavailableTools(caller: AgentCaller, messages: unknown[]): void {
  const allowed = new Set(toolsFor(caller.token).map((t) => t.name));
  for (const m of messages) {
    if (!m || typeof m !== "object" || (m as { method?: unknown }).method !== "tools/call") continue;
    const params = (m as { params?: { name?: unknown; arguments?: unknown } }).params;
    const name = typeof params?.name === "string" ? params.name : "";
    if (allowed.has(name)) continue;
    const failure = isAgentTool(name)
      ? { code: "TOOL_NOT_ALLOWED", error: "令牌的档位或工具集里没有这个工具" }
      : { code: "UNKNOWN_TOOL", error: "没有这个工具" };
    recordToolCall(caller, name.slice(0, 64) || "（没给工具名）", params?.arguments, failure, 0);
  }
}

export default async function (fastify: FastifyInstance) {
  // SDK 按需加载：没开智能体接入的实例一次都走不到这里，启动时不用背上它
  let handler: Promise<NodeHandler> | undefined;
  const loadHandler = (): Promise<NodeHandler> => {
    handler ??= (async () => {
      const [{ toNodeHandler }, { createAgentHandler }] = await Promise.all([
        import("@modelcontextprotocol/node"),
        import("../../services/agent/server.js"),
      ]);
      return toNodeHandler(createAgentHandler(), { onerror: (err) => fastify.log.warn({ err }, "MCP 适配层出错") });
    })().catch((err: unknown) => {
      handler = undefined;
      throw err;
    });
    return handler;
  };

  const methodNotAllowed = async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!agentEnabled()) return reply.code(404).send({ message: "智能体接入没有开启", code: "AGENT_DISABLED" });
    return reply.code(405).header("allow", "POST").send({ message: "Method not allowed", code: "METHOD_NOT_ALLOWED" });
  };
  fastify.get(MCP_PATH, methodNotAllowed);
  fastify.delete(MCP_PATH, methodNotAllowed);

  // 调用记录在工具层逐个记（calls.ts），这里不再按 HTTP 请求重复记
  fastify.post(MCP_PATH, { onRequest: guard, config: { agentAudit: false } }, async (request, reply) => {
    // guard 放行时一定认下了令牌
    const { token } = request.principal as Extract<Principal, { kind: "token" }>;
    const caller: AgentCaller = { token, ip: request.ip };
    const messages: unknown[] = Array.isArray(request.body) ? request.body : [request.body];
    if (messages.length > MAX_BATCH) {
      return reply.code(400).send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `一次最多批 ${MAX_BATCH} 条消息` } });
    }
    // 门口扣了一个，批了几条就补扣几个：不然一个请求就能让网盘接口跑上几千次
    if (messages.length > 1) {
      const quota = takeAgentQuota(token.id, messages.length - 1);
      if (!quota.ok) return tooManyRequests(reply, quota.retryAfterSeconds);
    }
    auditUnavailableTools(caller, messages);

    const handle = await loadHandler();
    // 接管响应：SDK 自己往 raw 上写（可能是 SSE 流），Fastify 不该再发一次，compress 也不该插手。
    // Fastify 已经记下的响应头（CORS 插件在 onRequest 里设的那些）接管后不会再帮着发，先挪到 raw 上
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }
    reply.hijack();
    // nginx 默认会攒着代理响应，流式的进度通知就成了一坨
    reply.raw.setHeader("x-accel-buffering", "no");
    const auth = { token: token.prefix, clientId: token.id, scopes: token.scopes, extra: { [AGENT_CALLER_KEY]: caller } };
    await handle(Object.assign(request.raw, { auth }), reply.raw, request.body);
  });
}
