import { eq, notInArray, sql } from "drizzle-orm";
import type { TaskDefinition } from "@openstrm/shared";
import { db } from "../client.js";
import { tasks } from "../schema.js";

type Row = typeof tasks.$inferSelect;

function deserialize(row: Row): TaskDefinition {
  try {
    const obj = JSON.parse(row.data) as Record<string, unknown>;
    return { ...obj, id: row.id, account: row.accountName } as TaskDefinition;
  } catch {
    return { id: row.id, account: row.accountName } as TaskDefinition;
  }
}

function columns(t: TaskDefinition) {
  return { accountName: t.account, data: JSON.stringify(t) };
}

export function listTasks(): TaskDefinition[] {
  return db.select().from(tasks).all().map(deserialize);
}

export function getTask(id: string): TaskDefinition | null {
  const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
  return row ? deserialize(row) : null;
}

/** id 重复会抛主键冲突，调用方负责生成唯一 id */
export function insertTask(task: TaskDefinition): void {
  db.insert(tasks).values({ id: task.id, ...columns(task) }).run();
}

/** 合并给出的字段；id 不可改。任务不存在时返回 null */
export function updateTask(id: string, patch: Partial<TaskDefinition>): TaskDefinition | null {
  const current = getTask(id);
  if (!current) return null;
  const merged: TaskDefinition = { ...current, ...patch, id };
  db.update(tasks)
    .set({ ...columns(merged), updatedAt: sql`(unixepoch())` })
    .where(eq(tasks.id, id))
    .run();
  return merged;
}

export function deleteTask(id: string): boolean {
  return db.delete(tasks).where(eq(tasks.id, id)).run().changes > 0;
}

/** 整体替换：不在列表里的删掉，其余按 id upsert（保留 created_at）。只该用于测试。 */
export function replaceTasks(list: TaskDefinition[]): void {
  db.transaction((tx) => {
    const ids = list.map((t) => t.id);
    if (ids.length === 0) tx.delete(tasks).run();
    else tx.delete(tasks).where(notInArray(tasks.id, ids)).run();
    for (const t of list) {
      tx.insert(tasks)
        .values({ id: t.id, ...columns(t) })
        .onConflictDoUpdate({
          target: tasks.id,
          set: { ...columns(t), updatedAt: sql`(unixepoch())` },
        })
        .run();
    }
  });
}
