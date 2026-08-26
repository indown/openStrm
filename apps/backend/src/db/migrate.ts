import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { inArray } from "drizzle-orm";
import path from "node:path";
import { db } from "./client.js";
import { settings } from "./schema.js";
import { seedIfEmpty } from "./seed.js";

const MIGRATIONS_DIR = path.resolve(new URL(".", import.meta.url).pathname, "migrations");

export async function initDb(): Promise<void> {
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await seedIfEmpty();
  dropRetiredSettings();
}

/**
 * 已经没有代码读的设置项。留着的话 GET /api/settings 会一直把它们发给浏览器。
 *
 * - app.internalToken：v1 里 nginx 调 /api/fs/get 用的回环凭据，两者都已移除。
 */
function dropRetiredSettings(): void {
  db.delete(settings).where(inArray(settings.key, ["app.internalToken"])).run();
}
