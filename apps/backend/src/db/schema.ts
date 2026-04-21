import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

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

export type SettingsRow = typeof settings.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskHistoryRow = typeof taskHistory.$inferSelect;
