import { eq, like, sql } from "drizzle-orm";
import type { AppSettings } from "@openstrm/shared";
import { db } from "../client.js";
import { settings } from "../schema.js";
import { KEY } from "../keys.js";

const PREFIX = KEY.appPrefix;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function parse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function readAppSettings(): AppSettings {
  const rows = db.select().from(settings).where(like(settings.key, `${PREFIX}%`)).all();
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key.slice(PREFIX.length)] = parse(r.value);
  return out as AppSettings;
}

export function readAppSetting<K extends keyof AppSettings>(key: K): AppSettings[K] | undefined {
  const row = db.select().from(settings).where(eq(settings.key, `${PREFIX}${String(key)}`)).get();
  return row ? (parse(row.value) as AppSettings[K]) : undefined;
}

function upsertEntries(tx: Tx, entries: Array<[string, unknown]>): void {
  for (const [k, v] of entries) {
    const key = `${PREFIX}${k}`;
    if (v === undefined) {
      tx.delete(settings).where(eq(settings.key, key)).run();
      continue;
    }
    const encoded = JSON.stringify(v);
    tx.insert(settings)
      .values({ key, value: encoded })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: encoded, updatedAt: sql`(unixepoch())` },
      })
      .run();
  }
}

/**
 * 只写给出的顶层键，其余键原样保留；值为 undefined 的键会被删除。
 *
 * 这是写设置的常规入口。以前是"删光再整体插入"，任何一处拿着过期快照的写入
 * 都会把别的页面刚写的键抹掉——设置页一保存，Telegram 配置就回滚。
 */
export function patchAppSettings(patch: Partial<AppSettings>): void {
  const entries = Object.entries(patch ?? {});
  if (entries.length === 0) return;
  db.transaction((tx) => upsertEntries(tx, entries));
}

export function writeAppSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K] | undefined,
): void {
  patchAppSettings({ [key]: value } as Partial<AppSettings>);
}

/**
 * 读-改-写一个顶层键，整个放在一个事务里。
 * 以前各路由自己 `write(key, { ...read(key), x })`：两个请求同时改 telegram 组的不同字段，后写的把先写的抹掉。
 */
export function updateAppSetting<K extends keyof AppSettings>(
  key: K,
  updater: (current: AppSettings[K] | undefined) => AppSettings[K],
): AppSettings[K] {
  return db.transaction((tx) => {
    const next = updater(readAppSetting(key));
    upsertEntries(tx, [[String(key), next]]);
    return next;
  });
}

export function deleteAppSetting(key: keyof AppSettings): void {
  db.delete(settings).where(eq(settings.key, `${PREFIX}${String(key)}`)).run();
}

/** 整体替换：没出现在 data 里的键会被删掉。只该用于测试恢复快照。 */
export function replaceAppSettings(data: AppSettings): void {
  db.transaction((tx) => {
    tx.delete(settings).where(like(settings.key, `${PREFIX}%`)).run();
    upsertEntries(tx, Object.entries(data ?? {}));
  });
}
