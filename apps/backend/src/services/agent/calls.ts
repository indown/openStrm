/**
 * 一次工具调用：校验参数 → 跑工具 → 出错换成给模型看的失败结果 → 记调用记录。和 MCP SDK 无关，
 * server.ts 只管把它接到 SDK 上；/mcp 路由挡在工具前面的调用（令牌没有的工具）也从这里记。
 *
 * 参数自己校验，不交给 SDK：SDK 校验失败回的是一句英文纯文本、也不经过这里，调用记录里就少了这一笔。
 */
import type { z } from "zod";
import type { AgentToken } from "@openstrm/shared";
import { recordAgentCall } from "../../db/repositories/agent-audit.js";
import { moduleLogger } from "../../lib/logger.js";
import { NeedsConfirmation, type ToolContext, type ToolDef } from "./define.js";
import { summarizeArgs, toFailure, type ToolFailure } from "./format.js";

const log = moduleLogger("agent");

/** 路由交给 SDK、SDK 再交回工具层的调用方：校验过的令牌，外加来源 IP（进调用记录） */
export interface AgentCaller {
  token: AgentToken;
  ip: string;
}

/**
 * 一次调用的结果。confirm 是工具要先请人当面确认（给人看的那段话）：server.ts 换成确认框，
 * 调用记录里记成 CONFIRM_REQUESTED——客户端带着确认结果再调一次时再记真正的结果
 */
export type ToolOutcome = { ok: true; data: unknown } | { ok: false; failure: ToolFailure; confirm?: string };

/** 调用记录里「弹了确认框、等人点」的那一笔 */
export const CONFIRM_REQUESTED = "CONFIRM_REQUESTED";

/**
 * 有的模型把没填的可选参数写成 null（OpenAI 严格模式的习惯）：当成没给。
 * 嵌套的也一样：organize_adjust 的 changes 是对象数组，里面没填的字段照样会写成 null
 */
function dropNulls(args: unknown): unknown {
  if (Array.isArray(args)) return args.map(dropNulls);
  if (!args || typeof args !== "object") return args;
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null).map(([k, v]) => [k, dropNulls(v)]));
}

function validationFailure(error: z.ZodError): ToolFailure {
  const issues = error.issues.slice(0, 5).map((i) => `${i.path.length ? i.path.join(".") : "参数"}: ${i.message}`);
  return {
    error: `参数不对：${issues.join("；")}`,
    code: "VALIDATION",
    hint: "按工具说明里的参数名和取值范围重新调用；说明里没有的参数名会被拒绝。",
  };
}

export async function callTool(tool: ToolDef, args: unknown, caller: AgentCaller, ctx: Omit<ToolContext, "token">): Promise<ToolOutcome> {
  const started = Date.now();
  let outcome: ToolOutcome;
  const parsed = tool.input.safeParse(dropNulls(args ?? {}));
  if (!parsed.success) {
    outcome = { ok: false, failure: validationFailure(parsed.error) };
  } else {
    try {
      outcome = { ok: true, data: await tool.run(parsed.data, { ...ctx, token: caller.token }) };
    } catch (err) {
      if (err instanceof NeedsConfirmation) {
        outcome = { ok: false, failure: { error: "等用户在客户端里确认", code: CONFIRM_REQUESTED }, confirm: err.message };
      } else {
        const failure = toFailure(err);
        if (/^HTTP_5/.test(failure.code)) log.warn({ err, tool: tool.name }, "智能体工具出错");
        outcome = { ok: false, failure };
      }
    }
  }
  recordToolCall(caller, tool.name, args, outcome.ok ? null : outcome.failure, Date.now() - started);
  return outcome;
}

/** 记一笔调用；写库失败只打日志，不影响调用本身 */
export function recordToolCall(caller: AgentCaller, tool: string, args: unknown, failure: Pick<ToolFailure, "code" | "error"> | null, durationMs: number): void {
  try {
    recordAgentCall({
      tokenId: caller.token.id,
      tokenName: caller.token.name,
      tool,
      args: summarizeArgs(args),
      ok: failure === null,
      error: failure ? `${failure.code}: ${failure.error}` : "",
      durationMs,
      ip: caller.ip,
    });
  } catch (err) {
    log.warn({ err }, "记录智能体调用失败");
  }
}
