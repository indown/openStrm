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
  (t) => ({
    fileIdIdx: index("life_events_file_id_idx").on(t.fileId),
    updateTimeIdx: index("life_events_update_time_idx").on(t.updateTime),
    typeIdx: index("life_events_type_idx").on(t.type),
  }),
);

export type SettingsRow = typeof settings.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskHistoryRow = typeof taskHistory.$inferSelect;
export type MediaLibraryRow = typeof mediaLibrary.$inferSelect;
export type PathCacheRow = typeof pathCache.$inferSelect;
export type LifeEventRow = typeof lifeEvents.$inferSelect;
