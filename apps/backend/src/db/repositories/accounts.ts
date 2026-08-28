import { eq, notInArray, sql } from "drizzle-orm";
import type { AccountInfo } from "@openstrm/shared";
import { db } from "../client.js";
import { accounts } from "../schema.js";

type Row = typeof accounts.$inferSelect;

function deserialize(row: Row): AccountInfo {
  try {
    const obj = JSON.parse(row.data) as Record<string, unknown>;
    return { ...obj, name: row.name, accountType: row.accountType } as AccountInfo;
  } catch {
    return { name: row.name, accountType: row.accountType } as AccountInfo;
  }
}

function columns(a: AccountInfo) {
  return { accountType: a.accountType, data: JSON.stringify(a) };
}

export function listAccounts(): AccountInfo[] {
  return db.select().from(accounts).all().map(deserialize);
}

export function getAccount(name: string): AccountInfo | null {
  const row = db.select().from(accounts).where(eq(accounts.name, name)).get();
  return row ? deserialize(row) : null;
}

/** 同名账号已存在会抛主键冲突，调用方先用 getAccount 查重 */
export function insertAccount(account: AccountInfo): void {
  db.insert(accounts).values({ name: account.name, ...columns(account) }).run();
}

/** 合并给出的字段；name 是主键不可改。账号不存在时返回 null */
export function updateAccount(name: string, patch: Record<string, unknown>): AccountInfo | null {
  // 读改写放进一个事务：界面保存和 runner 写回 openlist token 同时发生也不会互相抹掉
  return db.transaction((tx) => {
    const current = getAccount(name);
    if (!current) return null;
    const merged = { ...current, ...patch, name } as AccountInfo;
    tx.update(accounts)
      .set({ ...columns(merged), updatedAt: sql`(unixepoch())` })
      .where(eq(accounts.name, name))
      .run();
    return merged;
  });
}

export function deleteAccount(name: string): boolean {
  return db.delete(accounts).where(eq(accounts.name, name)).run().changes > 0;
}

/** 整体替换：不在列表里的删掉，其余按 name upsert（保留 created_at）。只该用于测试。 */
export function replaceAccounts(list: AccountInfo[]): void {
  db.transaction((tx) => {
    const names = list.map((a) => a.name);
    if (names.length === 0) tx.delete(accounts).run();
    else tx.delete(accounts).where(notInArray(accounts.name, names)).run();
    for (const a of list) {
      tx.insert(accounts)
        .values({ name: a.name, ...columns(a) })
        .onConflictDoUpdate({
          target: accounts.name,
          set: { ...columns(a), updatedAt: sql`(unixepoch())` },
        })
        .run();
    }
  });
}
