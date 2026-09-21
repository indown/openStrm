/**
 * MCP SDK 适配：SDK 只在这一处出现。路由等请求过了门口才 import 这个模块，没开智能体接入的实例不加载 SDK。
 *
 * createMcpHandler 每个请求调一次 factory：从 authInfo 里拿到路由校验过的令牌，
 * 只注册它档位和工具集里有的工具——只读令牌根本看不到写工具。
 * 默认的 legacy: "stateless" 同时接 2025 年那几版协议的客户端（Open WebUI、Codex 还在用），不能改成 reject。
 *
 * 结果一律是 text 块里的 JSON：Open WebUI 这类客户端只读 text；不声明 outputSchema——
 * 它用的 Python SDK 客户端看到 outputSchema 就要求每个结果都带合规的 structuredContent，错误结果也会被判失败。
 */
import { McpServer, createMcpHandler, type McpHttpHandler, type ServerContext, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { moduleLogger } from "../../lib/logger.js";
import { APP_VERSION } from "../../lib/version.js";
import { AGENT_CALLER_KEY } from "./access.js";
import { callTool, type AgentCaller } from "./calls.js";
import type { ToolDef } from "./define.js";
import { AGENT_INSTRUCTIONS } from "./instructions.js";
import { toolsFor } from "./tools/index.js";

const log = moduleLogger("agent");

type SdkSchema = StandardSchemaWithJSON<Record<string, unknown>, Record<string, unknown>>;

const sdkSchemas = new Map<string, SdkSchema>();

/**
 * 交给 SDK 的入参 schema：JSON Schema 只在第一次用到时算一次（SDK 每注册一次、每回一次 tools/list 都要转一遍，
 * 而工厂每个请求都要重建），校验原样放行——参数由 callTool 自己用 zod 校验。
 */
function sdkSchemaFor(tool: ToolDef): SdkSchema {
  const hit = sdkSchemas.get(tool.name);
  if (hit) return hit;
  // 和 SDK 自己转 zod 走同一条路（~standard.jsonSchema、同一个 target），发出去的 schema 跟以前一字不差
  const json = (tool.input as unknown as SdkSchema)["~standard"].jsonSchema.input({ target: "draft-2020-12" });
  const schema: SdkSchema = {
    "~standard": {
      version: 1,
      vendor: "openstrm",
      validate: (value) => ({ value: value as Record<string, unknown> }),
      jsonSchema: { input: () => json, output: () => json },
    },
  };
  sdkSchemas.set(tool.name, schema);
  return schema;
}

async function runTool(tool: ToolDef, caller: AgentCaller, args: unknown, ctx: ServerContext) {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  const progress = (value: number, total?: number, message?: string) => {
    if (progressToken === undefined) return;
    ctx.mcpReq
      .notify({
        method: "notifications/progress",
        params: { progressToken, progress: value, ...(total !== undefined ? { total } : {}), ...(message ? { message } : {}) },
      })
      .catch(() => {});
  };
  const outcome = await callTool(tool, args, caller, { signal: ctx.mcpReq.signal, progress });
  if (outcome.ok) return { content: [{ type: "text" as const, text: JSON.stringify(outcome.data) }] };
  return { content: [{ type: "text" as const, text: JSON.stringify(outcome.failure) }], isError: true };
}

export function buildAgentServer(caller: AgentCaller): McpServer {
  const server = new McpServer({ name: "openstrm", title: "OpenStrm", version: APP_VERSION }, { instructions: AGENT_INSTRUCTIONS });
  for (const tool of toolsFor(caller.token)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: sdkSchemaFor(tool),
        annotations: {
          title: tool.title,
          readOnlyHint: tool.annotations.readOnly,
          destructiveHint: tool.annotations.destructive,
          idempotentHint: tool.annotations.idempotent,
          openWorldHint: tool.annotations.openWorld,
        },
      },
      (args, ctx) => runTool(tool, caller, args, ctx),
    );
  }
  return server;
}

export function createAgentHandler(): McpHttpHandler {
  return createMcpHandler(
    ({ authInfo }) => {
      const caller = authInfo?.extra?.[AGENT_CALLER_KEY] as AgentCaller | undefined;
      // 路由先鉴权再进这里，没有令牌是接线错了
      if (!caller) throw new Error("MCP 请求没有带上校验过的令牌");
      return buildAgentServer(caller);
    },
    { onerror: (err) => log.warn({ err }, "MCP 请求处理出错") },
  );
}
