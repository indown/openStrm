/**
 * MCP SDK 适配：SDK 只在这一处出现。路由等请求过了门口才 import 这个模块，没开智能体接入的实例不加载 SDK。
 *
 * createMcpHandler 每个请求调一次 factory：从 authInfo 里拿到路由校验过的令牌，
 * 只注册它档位和工具集里有的工具——只读令牌根本看不到写工具。
 * 默认的 legacy: "stateless" 同时接 2025 年那几版协议的客户端（Open WebUI、Codex 还在用），不能改成 reject。
 *
 * 结果一律是 text 块里的 JSON：Open WebUI 这类客户端只读 text；不声明 outputSchema——
 * 它用的 Python SDK 客户端看到 outputSchema 就要求每个结果都带合规的 structuredContent，错误结果也会被判失败。
 *
 * 当面确认（工具抛 NeedsConfirmation）：回 inputRequired，里面一个 elicitation 表单；客户端弹给人看，
 * 带着结果把同一个 tools/call 原样再发一次（2026-07-28 版的多轮往返）。只对声明了 elicitation 的新协议请求这么做：
 * 老协议按请求无状态服务，拿不到客户端能力，SDK 的 legacy shim 发不出确认框、会直接回错，所以 canConfirm 是 false，
 * 工具退回对话里确认。
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  acceptedContent,
  createMcpHandler,
  inputRequired,
  type McpHttpHandler,
  type ServerContext,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { moduleLogger } from "../../lib/logger.js";
import { APP_VERSION } from "../../lib/version.js";
import { AGENT_CALLER_KEY } from "./access.js";
import { callTool, type AgentCaller } from "./calls.js";
import type { ToolDef } from "./define.js";
import { AGENT_INSTRUCTIONS } from "./instructions.js";
import { promptsFor } from "./prompts.js";
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

/** 确认表单在 inputRequests / inputResponses 里的键 */
const CONFIRM_KEY = "confirm";

/**
 * 客户端能不能弹确认框：只有 2026-07-28 版协议的请求在 _meta 信封里带着客户端能力。
 * elicitation 是空对象（2025-06-18 的写法）或者带 form 才算支持表单；只支持 url 模式的不算
 */
function canElicitForm(ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const caps = envelope?.[CLIENT_CAPABILITIES_META_KEY] as { elicitation?: unknown } | undefined;
  const e = caps?.elicitation;
  if (!e || typeof e !== "object") return false;
  return Object.keys(e).length === 0 || "form" in e;
}

/** 这次请求带回来的确认结果：点了确认（没把勾去掉）是 accepted；拒绝、关掉、去掉勾都是 declined；没带是还没问 */
function confirmationOf(ctx: ServerContext): "accepted" | "declined" | undefined {
  const responses = ctx.mcpReq.inputResponses;
  if (!responses || !(CONFIRM_KEY in responses)) return undefined;
  const content = acceptedContent<{ confirm?: unknown }>(responses, CONFIRM_KEY);
  return content && content.confirm !== false ? "accepted" : "declined";
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
  const outcome = await callTool(tool, args, caller, {
    signal: ctx.mcpReq.signal,
    progress,
    canConfirm: canElicitForm(ctx),
    // 不看这次声明没声明 elicitation：确认框是上一轮弹的，这一轮带回来的拒绝不能因为少声明了一项就作废
    confirmation: confirmationOf(ctx),
  });
  if (outcome.ok) return { content: [{ type: "text" as const, text: JSON.stringify(outcome.data) }] };
  if (outcome.confirm !== undefined) {
    return inputRequired({
      inputRequests: {
        [CONFIRM_KEY]: inputRequired.elicit({
          message: outcome.confirm,
          requestedSchema: {
            type: "object",
            properties: { confirm: { type: "boolean", title: "确认执行", description: "去掉勾或者点拒绝就不执行", default: true } },
            required: ["confirm"],
          },
        }),
      },
    });
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(outcome.failure) }], isError: true };
}

export function buildAgentServer(caller: AgentCaller): McpServer {
  const server = new McpServer({ name: "openstrm", title: "OpenStrm", version: APP_VERSION }, { instructions: AGENT_INSTRUCTIONS });
  const tools = toolsFor(caller.token);
  for (const tool of tools) {
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
  // prompt 展开只是拼一段文字，不调工具；注册了才声明 prompts 能力，用不上的令牌连这一项都看不到
  const names = new Set(tools.map((t) => t.name));
  for (const prompt of promptsFor(names)) {
    server.registerPrompt(prompt.name, { title: prompt.title, description: prompt.description, argsSchema: prompt.args }, (args) => ({
      messages: [{ role: "user", content: { type: "text", text: prompt.render(args, names) } }],
    }));
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
