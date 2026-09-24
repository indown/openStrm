/**
 * 智能体（AI agent）接入：令牌、权限档、工具集、调用记录。
 * 设计见 .claude/plans/agent-access.md。
 */

/**
 * 权限档，由低到高：
 *   read    查看：任务、执行记录、网盘目录、分享内容、云下载列表、整理清单、追更、strm 体检
 *   run     运行：开始 / 取消同步、整理预览和改清单、追更立即检查、strm 网盘校验。不改网盘内容，但会打网盘接口
 *   write   改网盘：转存分享、加云下载、执行 / 撤销整理、改追更、修正 strm
 *   danger  删除与花费：删 strm、按网盘重建 strm、删追更、整理冲突选删掉 / 覆盖。默认不给
 * 档位之间不互相包含：令牌上勾了哪几档就是哪几档。
 */
export type AgentScope = "read" | "run" | "write" | "danger";

/**
 * 工具集：令牌可以只开其中几组，工具少了本地小模型选得准、上下文也省。
 * 总览、任务列表、作业进度这几个基础工具不属于任何一组，总是在。
 *   sync 同步、transfer 搜资源、转存与云下载、organize 整理（含 TMDB 搜索）、follow 追更、strm strm 管理
 */
export type AgentToolset = "sync" | "transfer" | "organize" | "follow" | "strm";

/** 设置里的「智能体接入」一节 */
export type AgentSettings = {
  /** 总开关，默认关：关着时 /mcp 回 404，令牌也调不了 REST */
  enabled?: boolean;
  /** 管理界面地址（比如 http://nas:3000），工具结果里生成「在 OpenStrm 里打开」的链接用；不填时共用域名就用公网地址，否则不给链接 */
  uiBaseUrl?: string;
  /**
   * 公网地址（https 的源，比如 https://nas.example.com）：claude.ai、ChatGPT 这类网页客户端从这里连，
   * OAuth 的地址都从它来；不填就不启用 OAuth。没打开 publicServesUi 时，这个域名下只放行智能体用的几个路径
   */
  publicBaseUrl?: string;
  /**
   * 公网地址这个域名也用来打开管理界面（多数人就一个域名）。关着时这个域名下只放行智能体用的几个路径，
   * 给「智能体单独一个子域名、管理界面不上公网」的人用
   */
  publicServesUi?: boolean;
  /** 授权页上允许用管理员密码直接批准，默认关（授权页在公网上）；设置页打开共用域名时会顺带打开 */
  allowPasswordApproval?: boolean;
  /**
   * 认 CIMD（client_id 是元数据地址，claude.ai、ChatGPT 都优先用），默认关。
   * 开了要本机能直接访问 claude.ai、chatgpt.com 去取元数据（国内网络一般不行）；关着客户端就用动态注册，不用往外访问
   */
  oauthCimd?: boolean;
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

/** OAuth 客户端从哪来：动态注册（DCR）的、client_id 本身是元数据地址（CIMD）的、设置页手建的（预注册） */
export type OAuthClientKind = "dcr" | "cimd" | "manual";

/** OAuth 客户端的公开信息（预注册客户端列表用） */
export interface OAuthClientInfo {
  id: string;
  kind: OAuthClientKind;
  name: string;
  redirectUris: string[];
  /** 秒 */
  createdAt: number;
  lastUsedAt: number | null;
}

/** 新建预注册客户端的结果：secret 只在这里出现一次 */
export interface OAuthClientCreated {
  clientId: string;
  clientSecret: string;
  info: OAuthClientInfo;
}

/**
 * 等人批准的授权请求。配对码故意不在里面：批准时要输入授权页上显示的那个，
 * 证明批的就是自己眼前这一条——列表里要是直接给出配对码，批错了别人冒充发起的请求也拦不住
 */
export interface OAuthPendingRequest {
  id: string;
  clientId: string;
  /** 客户端自报的名字（DCR 的谁都能填，CIMD 的看 clientHost） */
  clientName: string;
  clientKind: OAuthClientKind;
  /** CIMD 客户端的元数据地址的域名：这个才证明是谁（名字是自己写的） */
  clientHost: string | null;
  /** 授权后跳回的地址的域名 */
  redirectHost: string;
  /** 跳回的是公网上的 http 地址（明文） */
  redirectInsecure: boolean;
  /** 跳回的是本机回环地址（命令行、桌面客户端） */
  redirectLoopback: boolean;
  /**
   * 授权页上能不能用管理员密码批准：设置里开着，而且授权码发去的地方别人拿不到
   * （本机、局域网、桌面客户端、claude.ai / ChatGPT 的回调，或者管理员手建的客户端）
   */
  passwordApproval: boolean;
  /** 客户端要的档位（read / run / write / danger 里的；没要就是空的，按管理员选的给） */
  requestedScopes: AgentScope[];
  ip: string;
  /** 秒 */
  createdAt: number;
  expiresAt: number;
}

/** 已连接的客户端：一次 OAuth 授权 */
export interface OAuthGrantInfo {
  id: string;
  clientId: string;
  clientName: string;
  scopes: AgentScope[];
  toolsets: AgentToolset[];
  /** 秒 */
  createdAt: number;
  lastUsedAt: number | null;
  lastUsedIp: string | null;
  /** 刷新令牌到期（秒）：过了不用就得重新授权 */
  refreshExpiresAt: number;
  /** stale：公网地址改过了，令牌绑的还是旧地址，用不了了（断开后在客户端里重新连接） */
  status: "active" | "stale";
  /** 在哪批的：ui / telegram / password；发起授权的地址 */
  approvedVia: string | null;
  approvedAt: number | null;
  requestIp: string | null;
}

/** 连接自检的一项 */
export interface AgentSelfCheckItem {
  name: string;
  ok: boolean;
  /** 不算错，但要人自己留意或再核对（比如公网地址带端口、自检是在内网里绕回来的） */
  warn?: boolean;
  detail: string;
}

/** 设置页「网页客户端」一块要的东西：公网地址、OAuth 生没生效、待批准、已连接的、预注册的 */
export interface AgentOAuthState {
  publicBaseUrl: string | null;
  /** 开关开着、公网地址也填了：OAuth 在工作 */
  active: boolean;
  /**
   * 有请求经过本机 / 内网里的反代进来（带着 X-Forwarded-For），容器却没设 TRUST_PROXY：
   * 公网上所有人都被算成这个反代的地址。peer 是反代的地址，at 是最近一次看到的时间（毫秒）
   */
  untrustedProxy: { peer: string; at: number } | null;
  pending: OAuthPendingRequest[];
  grants: OAuthGrantInfo[];
  clients: OAuthClientInfo[];
}
