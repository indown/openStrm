/**
 * 智能体工具的定义形状。和 MCP SDK 无关：SDK 只在 server.ts 一处出现，规范、SDK 再变也只动那里。
 *
 * 工具返回普通对象（会序列化成 JSON 文本给模型），出错抛 ToolError / HttpError，
 * server.ts 统一换成 `isError: true` 的工具结果（带 code 和 hint），不回协议错误。
 */
import type { z } from "zod";
import type { AgentScope, AgentToken, AgentToolset } from "@openstrm/shared";

export interface ToolContext {
  token: AgentToken;
  /** 客户端断开（新版协议里就是取消这次请求）时触发：只取消这次等待，后台的同步和作业照跑 */
  signal: AbortSignal;
  /** 推一条进度通知；客户端没要进度（没给 progressToken）时是空操作 */
  progress(progress: number, total?: number, message?: string): void;
}

/**
 * 四个注解都显式写：规范里的默认值是 readOnly=false、destructive=true、idempotent=false、openWorld=true，
 * 偏保守，不写的话只读工具也会被客户端当成危险操作（ChatGPT 每次都要人点确认）。
 */
export interface ToolAnnotationsSpec {
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  /** 会访问外部：网盘、TMDB、HDHive */
  openWorld: boolean;
}

export interface AgentTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  /** 中文，用词和界面一致；写工具的描述里写明「先征得用户同意」（有的客户端不读服务端说明） */
  description: string;
  scope: AgentScope;
  /** null = 基础工具，不属于任何一组，总是在 */
  toolset: AgentToolset | null;
  annotations: ToolAnnotationsSpec;
  /** 扁平对象；不写 .default()，默认值在 run 里补、写进描述（有的客户端会把 default 丢掉） */
  input: S;
  run(args: z.output<S>, ctx: ToolContext): Promise<unknown>;
}

/**
 * 注册表里的工具：参数类型抹掉了。写工具时用带泛型的 AgentTool 拿到类型推导；
 * 调用前 callTool 已经按 input 校验过参数，所以这里抹掉是安全的。
 */
export type ToolDef = Omit<AgentTool, "run"> & { run(args: unknown, ctx: ToolContext): Promise<unknown> };

/**
 * 入参一律严格：说明里没有的参数名直接报错。不然模型把 itemIds 写成 item_ids 会被悄悄丢掉，
 * share_save 就成了「整层都转存」
 */
export function defineTool<S extends z.ZodObject>(tool: AgentTool<S>): ToolDef {
  return { ...tool, input: tool.input.strict() } as unknown as ToolDef;
}

/** 工具自己的业务错误：code 给程序看，hint 告诉模型下一步能做什么 */
export class ToolError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly extra: Record<string, unknown>;

  constructor(code: string, message: string, hint?: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.hint = hint;
    this.extra = extra;
  }
}

/** 只读、不访问外部 */
export const LOCAL_READ: ToolAnnotationsSpec = { readOnly: true, destructive: false, idempotent: true, openWorld: false };
/** 只读、要访问网盘 */
export const REMOTE_READ: ToolAnnotationsSpec = { readOnly: true, destructive: false, idempotent: true, openWorld: true };
