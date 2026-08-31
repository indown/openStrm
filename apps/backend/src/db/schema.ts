import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

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

/** 已拉取到的 115 生活事件，主键就是事件 id，重复拉取时幂等覆盖 */
export const lifeEvents = sqliteTable(
  "life_events",
  {
    id: text("id").primaryKey(),
    accountName: text("account_name").notNull().default(""),
    type: integer("type").notNull(),
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
