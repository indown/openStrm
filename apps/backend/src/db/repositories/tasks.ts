import { sql } from "drizzle-orm";
import type { TaskDefinition } from "@openstrm/shared";
import { db } from "../client.js";
import { tasks } from "../schema.js";

function deserialize(row: { id: string; accountName: string; data: string }): TaskDefinition {
  try {
    const obj = JSON.parse(row.data) as Record<string, unknown>;
    return { ...obj, id: row.id, account: row.accountName } as TaskDefinition;
  } catch {
    return { id: row.id, account: row.accountName } as TaskDefinition;
  }
}

export function listTasks(): TaskDefinition[] {
  const rows = db.select().from(tasks).all();
  return rows.map(deserialize);
}

export function writeTasks(list: TaskDefinition[]): void {
  db.transaction((tx) => {
    tx.delete(tasks).run();
    if (list.length > 0) {
      tx.insert(tasks)
        .values(
          list.map((t) => ({
            id: t.id,
            accountName: t.account,
            data: JSON.stringify(t),
            updatedAt: sql`(unixepoch())`,
          })),
        )
        .run();
    }
  });
}
