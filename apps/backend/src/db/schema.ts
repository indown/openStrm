import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

export const accounts = sqliteTable("accounts", {
  name: text("name").primaryKey(),
  accountType: text("account_type").notNull(),
  data: text("data").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    accountName: text("account_name").notNull(),
    data: text("data").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    accountIdx: index("tasks_account_name_idx").on(t.accountName),
  }),
);

export const taskHistory = sqliteTable(
  "task_history",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    // 毫秒（Date.now()）。其它表的时间戳都是秒（unixepoch），这张表是历史遗留
    startTime: integer("start_time").notNull(),
    endTime: integer("end_time"),
    status: text("status").notNull(),
    logs: text("logs").notNull().default("[]"),
    summary: text("summary").notNull().default("{}"),
    taskInfo: text("task_info").notNull().default("{}"),
  },
  (t) => ({
    taskIdIdx: index("task_history_task_id_idx").on(t.taskId),
    startTimeIdx: index("task_history_start_time_idx").on(t.startTime),
  }),
);

export const mediaLibrary = sqliteTable(
  "media_library",
  {
    id: text("id").primaryKey(),
    shareUrl: text("share_url").notNull(),
    shareCode: text("share_code").notNull(),
    receiveCode: text("receive_code").notNull().default(""),
    sharePath: text("share_path").notNull().default(""),
    shareRootCid: text("share_root_cid").notNull().default(""),
    rawName: text("raw_name").notNull().default(""),
    title: text("title").notNull().default(""),
    fileCount: integer("file_count").notNull().default(0),
    coverUrl: text("cover_url").notNull().default(""),
    tags: text("tags").notNull().default("[]"),
    notes: text("notes").notNull().default(""),
    mediaType: text("media_type").notNull().default("unknown"),
    tmdbId: integer("tmdb_id"),
    year: text("year").notNull().default(""),
    overview: text("overview").notNull().default(""),
    scrapeStatus: text("scrape_status").notNull().default("done"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    shareCodeIdx: index("media_library_share_code_idx").on(t.shareCode),
    shareCodePathUniq: uniqueIndex("media_library_share_code_path_uniq").on(t.shareCode, t.sharePath),
    updatedAtIdx: index("media_library_updated_at_idx").on(t.updatedAt),
    scrapeStatusIdx: index("media_library_scrape_status_idx").on(t.scrapeStatus),
  }),
);

/**
 * 115 文件/目录 id → 绝对网盘路径 的缓存。
 * 生活事件只带 parent_id，必须靠这张表把 cid 还原成路径，
 * 同时也是 move / rename 事件定位「旧路径」的唯一依据。
 * id 一律用 text 存：115 的 file_id 超过 JS 安全整数范围。
 */
export const pathCache = sqliteTable(
  "path_cache",
  {
    fileId: text("file_id").primaryKey(),
    parentId: text("parent_id").notNull().default("0"),
    name: text("name").notNull().default(""),
    path: text("path").notNull(),
    isDir: integer("is_dir").notNull().default(1),
    accountName: text("account_name").notNull().default(""),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pathIdx: index("path_cache_path_idx").on(t.path),
    parentIdx: index("path_cache_parent_id_idx").on(t.parentId),
  }),
);

/**
 * 网盘变更事件，主键就是事件 id，重复拉取时幂等覆盖。
 * 115 的生活事件原样记在 type / file_id / parent_id / pick_code 里；kind / path / old_path 是各家统一的形状（0010 加的），
 * 夸克的快照对比事件只有这三列有意义。
 */
export const lifeEvents = sqliteTable(
  "life_events",
  {
    id: text("id").primaryKey(),
    accountName: text("account_name").notNull().default(""),
    type: integer("type").notNull(),
    kind: text("kind").notNull().default(""),
    path: text("path").notNull().default(""),
    oldPath: text("old_path").notNull().default(""),
    fileId: text("file_id").notNull(),
    parentId: text("parent_id").notNull().default("0"),
    fileName: text("file_name").notNull().default(""),
    fileCategory: integer("file_category").notNull().default(0),
    fileSize: integer("file_size").notNull().default(0),
    sha1: text("sha1").notNull().default(""),
    pickCode: text("pick_code").notNull().default(""),
    updateTime: integer("update_time").notNull().default(0),
    createTime: integer("create_time").notNull().default(0),
    status: text("status").notNull().default("pending"),
    detail: text("detail").notNull().default(""),
    handledAt: integer("handled_at"),
  },
  // 只按 update_time 查（listRecent / 留存清理）。file_id 和 type 上的索引没有任何查询用到，
  // 这张表又是写得最多的一张，白白放大写入量，0008 迁移里删掉了
  (t) => ({
    updateTimeIdx: index("life_events_update_time_idx").on(t.updateTime),
  }),
);

export type PathCacheRow = typeof pathCache.$inferSelect;
export type LifeEventRow = typeof lifeEvents.$inferSelect;

/**
 * 没有事件流的网盘（夸克）的监控快照：每个账号的每个任务根目录一份，entries 是整棵子树的 JSON。
 * 下一轮扫描和它对比得出新增 / 删除 / 改名 / 移动。
 */
export const driveSnapshots = sqliteTable(
  "drive_snapshots",
  {
    accountName: text("account_name").notNull(),
    rootPath: text("root_path").notNull(),
    entries: text("entries").notNull().default("[]"),
    scannedAt: integer("scanned_at").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.accountName, t.rootPath] }),
  }),
);

/**
 * 分享追更订阅：一条 = 分享里的某个目录 → 某个同步任务的子目录。
 * 快照 known 是 JSON：一部剧几百条，放行里比再开一张表省事，列表接口不带它。
 * 时间戳里 last_checked_at / last_change_at / next_check_at 是毫秒（直接和 Date.now() 比），
 * created_at / updated_at 和其它表一样是秒。
 */
export const shareFollows = sqliteTable(
  "share_follows",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().default(""),
    libraryId: text("library_id"),
    shareUrl: text("share_url").notNull().default(""),
    shareCode: text("share_code").notNull(),
    receiveCode: text("receive_code").notNull().default(""),
    watchCid: text("watch_cid").notNull().default("0"),
    watchPath: text("watch_path").notNull().default(""),
    scope: text("scope").notNull().default('[""]'),
    taskId: text("task_id").notNull(),
    subPath: text("sub_path").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    intervalMinutes: integer("interval_minutes").notNull().default(360),
    status: text("status").notNull().default("idle"),
    lastError: text("last_error").notNull().default(""),
    errorStreak: integer("error_streak").notNull().default(0),
    lastCheckedAt: integer("last_checked_at"),
    lastChangeAt: integer("last_change_at"),
    nextCheckAt: integer("next_check_at").notNull().default(0),
    known: text("known").notNull().default("[]"),
    recent: text("recent").notNull().default("[]"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    // 同一个分享目录只允许一条订阅：两条盯同一处会各转存一份
    shareWatchUniq: uniqueIndex("share_follows_share_watch_uniq").on(t.shareCode, t.watchCid),
    dueIdx: index("share_follows_due_idx").on(t.enabled, t.nextCheckAt),
    taskIdx: index("share_follows_task_id_idx").on(t.taskId),
  }),
);

/* ------------------------------- 整理与规范化命名 ------------------------------- */

/**
 * 一次整理：范围、状态、统计、最近的日志行。items 是计划也是执行流水账（撤销按它逆序退回）。
 * 时间戳秒；id 字符串。
 */
export const organizeRuns = sqliteTable(
  "organize_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    accountName: text("account_name").notNull().default(""),
    scopePath: text("scope_path").notNull().default(""),
    scopePaths: text("scope_paths").notNull().default("[]"),
    mode: text("mode").notNull().default("manual"),
    trigger: text("trigger").notNull().default("manual"),
    status: text("status").notNull().default("planning"),
    /** apply 执行 / revert 撤销：开始撤销之后只能继续撤销 */
    stage: text("stage").notNull().default("apply"),
    stats: text("stats").notNull().default("{}"),
    error: text("error").notNull().default(""),
    log: text("log").notNull().default("[]"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => ({
    taskIdx: index("organize_runs_task_idx").on(t.taskId, t.createdAt),
    statusIdx: index("organize_runs_status_idx").on(t.status),
  }),
);

/** 一个作品单元：识别结果 + 用户的修改；items 按 unit_key 挂在它下面 */
export const organizeUnits = sqliteTable(
  "organize_units",
  {
    runId: text("run_id").notNull(),
    key: text("key").notNull(),
    rootPath: text("root_path").notNull().default(""),
    rawName: text("raw_name").notNull().default(""),
    parsedTitle: text("parsed_title").notNull().default(""),
    parsedYear: text("parsed_year").notNull().default(""),
    match: text("match"),
    seasonOverride: integer("season_override"),
    episodeOffset: integer("episode_offset").notNull().default(0),
    dstRoot: text("dst_root").notNull().default(""),
    selected: integer("selected", { mode: "boolean" }).notNull().default(true),
    remember: integer("remember", { mode: "boolean" }).notNull().default(false),
    fileCount: integer("file_count").notNull().default(0),
    videoCount: integer("video_count").notNull().default(0),
    referencedBy: integer("referenced_by").notNull().default(0),
    notes: text("notes").notNull().default("[]"),
    /** 用户单独取消勾选的文件（网盘绝对路径的 JSON 数组）：规划时跳过，重规划不丢 */
    excluded: text("excluded").notNull().default("[]"),
    /** 用户给冲突项选的处理（JSON：网盘绝对路径 → rename / duplicate），重规划不丢 */
    resolutions: text("resolutions").notNull().default("{}"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.key] }),
  }),
);

/**
 * 计划项 / 流水账。src_path / dst_path 是网盘绝对路径（带前导 /）：
 * 网盘监控用 (node_id, dst_path) 认出「这是整理自己做的改名 / 移动」，跳过不重复处理。
 */
export const organizeItems = sqliteTable(
  "organize_items",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    unitKey: text("unit_key").notNull().default(""),
    seq: integer("seq").notNull().default(0),
    kind: text("kind").notNull().default("other"),
    action: text("action").notNull().default("skip"),
    srcPath: text("src_path").notNull().default(""),
    dstPath: text("dst_path").notNull().default(""),
    nodeId: text("node_id").notNull().default(""),
    reason: text("reason").notNull().default(""),
    status: text("status").notNull().default("pending"),
    error: text("error").notNull().default(""),
    /** error 的类别（transient / blocked / stale / rejected / mirror），决定重试还是放弃 */
    errorKind: text("error_kind").notNull().default(""),
    /** 被执行 / 撤销了几轮（自动重试不算） */
    attempts: integer("attempts").notNull().default(0),
    /** 用户点了「放弃」 */
    givenUp: integer("given_up", { mode: "boolean" }).notNull().default(false),
    finishedAt: integer("finished_at"),
    /** 文件当前的中间位置：执行时是原地改了名还没挪走，撤销时是挪回来了还没改回原名；做完清空 */
    curPath: text("cur_path").notNull().default(""),
    /** 网盘监控已经按「整理自己做的」跳过了几条事件；一条 rename + 一条 move 最多两条，之后的就是别人动的 */
    hits: integer("hits").notNull().default(0),
  },
  (t) => ({
    runIdx: index("organize_items_run_idx").on(t.runId, t.seq),
    nodeIdx: index("organize_items_node_idx").on(t.nodeId),
  }),
);

/** 用户在预览里改过并勾了「记住」的识别结果：同账号同目录下次直接用 */
export const organizeMatches = sqliteTable(
  "organize_matches",
  {
    accountName: text("account_name").notNull(),
    srcPath: text("src_path").notNull(),
    mediaType: text("media_type").notNull().default("tv"),
    tmdbId: integer("tmdb_id").notNull(),
    title: text("title").notNull().default(""),
    year: text("year").notNull().default(""),
    season: integer("season"),
    episodeOffset: integer("episode_offset").notNull().default(0),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.accountName, t.srcPath] }),
  }),
);

/** TMDB 详情 / 搜索结果缓存：key 是 `kind:参数`，value 是 JSON */
export const tmdbCache = sqliteTable("tmdb_cache", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default("{}"),
  fetchedAt: integer("fetched_at").notNull().default(0),
});

/**
 * 智能体（MCP / REST）用的访问令牌。明文只在创建时给一次，这里只存 SHA-256：
 * 令牌是 256 位随机数，没有字典可撞，每个请求都要校验，犯不上跑 KDF。
 * 撤销就是删行；调用记录里留着令牌名，删了也查得到是谁干的。
 */
export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** manual = 设置页手建；以后 OAuth 发的令牌也放这张表 */
    kind: text("kind").notNull().default("manual"),
    tokenHash: text("token_hash").notNull(),
    /** 明文的前几位，列表里认令牌用 */
    prefix: text("prefix").notNull(),
    scopes: text("scopes").notNull().default("[]"),
    /** 工具集的 JSON 数组。选「全部」存的是当时的全部组：以后版本加的组不会自动给老令牌，要用户自己勾 */
    toolsets: text("toolsets").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    expiresAt: integer("expires_at"),
    lastUsedAt: integer("last_used_at"),
    lastUsedIp: text("last_used_ip"),
  },
  (t) => ({
    hashUniq: uniqueIndex("api_tokens_hash_uniq").on(t.tokenHash),
  }),
);

/** 智能体的每次工具调用（和令牌直接调 REST）：设置页「最近调用」、事后查是谁干的 */
export const agentAudit = sqliteTable(
  "agent_audit",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tokenId: text("token_id").notNull(),
    tokenName: text("token_name").notNull().default(""),
    /** 调用方的 IP：同一个令牌出现陌生 IP 就是泄露的信号 */
    ip: text("ip").notNull().default(""),
    tool: text("tool").notNull(),
    /** 参数摘要：截断过，提取码抹掉了 */
    args: text("args").notNull().default(""),
    ok: integer("ok", { mode: "boolean" }).notNull().default(true),
    error: text("error").notNull().default(""),
    durationMs: integer("duration_ms").notNull().default(0),
    at: integer("at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    tokenIdx: index("agent_audit_token_idx").on(t.tokenId, t.at),
    atIdx: index("agent_audit_at_idx").on(t.at),
  }),
);

/**
 * OAuth 客户端（网页客户端走授权流程时）：
 *   dcr    动态注册（RFC 7591）来的，client_id 是我们发的；
 *   cimd   client_id 本身是一个 https 地址，元数据从那里取来缓存在这里（设置里开了 CIMD 才有）；
 *   manual 设置页手建的预注册客户端，有 secret（只存哈希）。
 * 只存用得上的几样（名字、回调地址、scope），不存客户端交上来的整份元数据：注册谁都能发，存整份等于让人随便往库里塞东西
 */
export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    name: text("name").notNull().default(""),
    /** 登记的回调地址（JSON 数组） */
    redirectUris: text("redirect_uris").notNull().default("[]"),
    secretHash: text("secret_hash"),
    /** 注册时要的 scope：DCR 的注册回应里要原样带回 */
    scope: text("scope").notNull().default(""),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    /** CIMD 元数据上次取的时间（秒） */
    fetchedAt: integer("fetched_at"),
    /** CIMD 元数据缓存到什么时候（秒）：按对方的 Cache-Control，最长一天 */
    cacheUntil: integer("cache_until"),
    lastUsedAt: integer("last_used_at"),
  },
  (t) => ({
    kindIdx: index("oauth_clients_kind_idx").on(t.kind),
  }),
);

/**
 * 授权请求：授权页发起，等人在管理界面（或 Telegram）里输入授权页上的配对码后批准。
 * 批准后授权页轮询时才生成授权码（只存哈希），一次性、10 分钟内有效。
 */
export const oauthRequests = sqliteTable(
  "oauth_requests",
  {
    id: text("id").primaryKey(),
    /** 授权页轮询用的密钥（哈希）：光知道请求 id 拿不到授权码 */
    pollHash: text("poll_hash").notNull(),
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull().default(""),
    clientKind: text("client_kind").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    state: text("state"),
    codeChallenge: text("code_challenge").notNull(),
    /** 客户端要的 scope，原样（空格分隔） */
    requestedScope: text("requested_scope").notNull().default(""),
    /** 令牌要绑定的资源（RFC 8707）：本实例的 <公网地址>/mcp */
    resource: text("resource").notNull(),
    pairingCode: text("pairing_code").notNull(),
    /** pending → approved（批了，等授权页来取授权码）→ issued（授权码已发）→ used（换过令牌）；或 denied */
    status: text("status").notNull().default("pending"),
    grantedScopes: text("granted_scopes"),
    grantedToolsets: text("granted_toolsets"),
    /** 在哪批的：ui / telegram / password */
    approvedVia: text("approved_via"),
    codeHash: text("code_hash"),
    codeExpiresAt: integer("code_expires_at"),
    /** 授权码换令牌的时间：同一个授权码短时间内再来一次（回应丢了重试）要认得出 */
    usedAt: integer("used_at"),
    /** 用这个授权码换出来的授权：授权码被再用一次时整个撤掉 */
    grantId: text("grant_id"),
    ip: text("ip").notNull().default(""),
    /** 按来源计数用的键：IPv6 按 /64（lib/ip.ts） */
    ipKey: text("ip_key").notNull().default(""),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    expiresAt: integer("expires_at").notNull(),
    decidedAt: integer("decided_at"),
  },
  (t) => ({
    codeUniq: uniqueIndex("oauth_requests_code_uniq").on(t.codeHash),
    statusIdx: index("oauth_requests_status_idx").on(t.status, t.createdAt),
    ipKeyIdx: index("oauth_requests_ip_key_idx").on(t.ipKey, t.createdAt),
  }),
);

/**
 * 一次授权 = 设置页「已连接的客户端」的一行：当前的访问令牌、刷新令牌（都只存哈希，每次刷新都换），
 * 批给它的档位和工具集，令牌绑定的资源，怎么批的
 */
export const oauthGrants = sqliteTable(
  "oauth_grants",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull().default(""),
    scopes: text("scopes").notNull().default("[]"),
    toolsets: text("toolsets").notNull(),
    /** 客户端要没要 offline_access：返回的 scope 里带不带它 */
    offline: integer("offline", { mode: "boolean" }).notNull().default(false),
    resource: text("resource").notNull(),
    accessHash: text("access_hash").notNull(),
    accessExpiresAt: integer("access_expires_at").notNull(),
    /** 刷新前的那个访问令牌：到它自己过期前照样认，刷新时正在路上的请求不会平白 401 */
    prevAccessHash: text("prev_access_hash"),
    prevAccessExpiresAt: integer("prev_access_expires_at"),
    refreshHash: text("refresh_hash").notNull(),
    refreshExpiresAt: integer("refresh_expires_at").notNull(),
    /** 在哪批的（ui / telegram / password）、什么时候、发起授权的地址：出了事能查 */
    approvedVia: text("approved_via"),
    approvedAt: integer("approved_at"),
    requestIp: text("request_ip"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    lastUsedAt: integer("last_used_at"),
    lastUsedIp: text("last_used_ip"),
  },
  (t) => ({
    accessUniq: uniqueIndex("oauth_grants_access_uniq").on(t.accessHash),
    prevAccessUniq: uniqueIndex("oauth_grants_prev_access_uniq").on(t.prevAccessHash),
    refreshUniq: uniqueIndex("oauth_grants_refresh_uniq").on(t.refreshHash),
    clientIdx: index("oauth_grants_client_idx").on(t.clientId),
  }),
);

/**
 * 换过的刷新令牌：宽限期（一分钟）内再出现是客户端并发刷新 / 重试，回同一对令牌；
 * 过了宽限期再出现就是被偷了拿去重放，整个授权作废（刷新令牌过期后就清掉）
 */
export const oauthUsedRefresh = sqliteTable(
  "oauth_used_refresh",
  {
    hash: text("hash").primaryKey(),
    grantId: text("grant_id").notNull(),
    usedAt: integer("used_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    usedAtIdx: index("oauth_used_refresh_used_at_idx").on(t.usedAt),
  }),
);
