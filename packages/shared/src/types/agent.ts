/**
 * 智能体（AI agent）接入：令牌、权限档、工具集、调用记录。
 * 设计见 .claude/plans/agent-access.md。
 */

/**
 * 权限档，由低到高：
 *   read    查看：任务、执行记录、网盘目录、分享内容、云下载列表
 *   run     运行：开始 / 取消同步。不改网盘内容，但会打网盘接口
 *   write   改网盘：转存分享、加云下载
 *   danger  删除与花费：删 strm、HDHive 解锁这类。默认不给
 * 档位之间不互相包含：令牌上勾了哪几档就是哪几档。
 */
export type AgentScope = "read" | "run" | "write" | "danger";

/**
 * 工具集：令牌可以只开其中几组，工具少了本地小模型选得准、上下文也省。
 * 总览、任务列表、作业进度这几个基础工具不属于任何一组，总是在。
 */
export type AgentToolset = "sync" | "transfer";

/** 设置里的「智能体接入」一节 */
export type AgentSettings = {
  /** 总开关，默认关：关着时 /mcp 回 404，令牌也调不了 REST */
  enabled?: boolean;
  /** 管理界面地址（局域网的，比如 http://nas:3000），工具结果里生成「在 OpenStrm 里打开」的链接用；不填就不给链接 */
  uiBaseUrl?: string;
};

/** 令牌的公开信息：明文和哈希都不在里面 */
export interface AgentToken {
  id: string;
  name: string;
  /** 明文的前几位，列表里认令牌用 */
  prefix: string;
  scopes: AgentScope[];
  /** 能用哪几组工具（基础工具总在）。选「全部」存的是当时的全部组，以后加的组不会自动给 */
  toolsets: AgentToolset[];
  /** 秒 */
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  lastUsedIp: string | null;
}

/** 新建令牌的响应：明文只在这一次给出 */
export interface AgentTokenCreated {
  token: string;
  info: AgentToken;
}

/** 一次工具调用（或令牌调 REST）的记录 */
export interface AgentCall {
  id: number;
  tokenId: string;
  tokenName: string;
  /** 调用方 IP */
  ip: string;
  /** 工具名；令牌直接调 REST 时是 `METHOD /path` */
  tool: string;
  /** 参数摘要：截断过，链接里的提取码抹掉了 */
  args: string;
  ok: boolean;
  error: string;
  durationMs: number;
  /** 秒 */
  at: number;
}

/** 设置页展示用：每个工具属于哪一档、哪一组 */
export interface AgentToolInfo {
  name: string;
  title: string;
  scope: AgentScope;
  /** null 表示基础工具，不属于任何一组 */
  toolset: AgentToolset | null;
  readOnly: boolean;
  destructive: boolean;
}

export interface AgentInfo {
  enabled: boolean;
  /** MCP 端点的路径，前端拼上当前地址给配置片段用 */
  mcpPath: string;
  tools: AgentToolInfo[];
}
