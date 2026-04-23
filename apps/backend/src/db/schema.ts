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

export type SettingsRow = typeof settings.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskHistoryRow = typeof taskHistory.$inferSelect;
export type MediaLibraryRow = typeof mediaLibrary.$inferSelect;
