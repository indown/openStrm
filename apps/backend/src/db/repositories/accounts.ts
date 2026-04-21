import { sql } from "drizzle-orm";
import type { AccountInfo } from "@openstrm/shared";
import { db } from "../client.js";
import { accounts } from "../schema.js";

function deserialize(row: { name: string; accountType: string; data: string }): AccountInfo {
  try {
    const obj = JSON.parse(row.data) as Record<string, unknown>;
    return { ...obj, name: row.name, accountType: row.accountType } as AccountInfo;
  } catch {
    return { name: row.name, accountType: row.accountType } as AccountInfo;
  }
}

export function listAccounts(): AccountInfo[] {
  const rows = db.select().from(accounts).all();
  return rows.map(deserialize);
}

export function writeAccounts(list: AccountInfo[]): void {
  db.transaction((tx) => {
    tx.delete(accounts).run();
    if (list.length > 0) {
      tx.insert(accounts)
        .values(
          list.map((a) => ({
            name: a.name,
            accountType: a.accountType,
            data: JSON.stringify(a),
            updatedAt: sql`(unixepoch())`,
          })),
        )
        .run();
    }
  });
}
