import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import { db } from "./client.js";
import { seedIfEmpty } from "./seed.js";

// fileURLToPath 而不是 URL.pathname：仓库放在带空格或中文的目录下，pathname 是百分号编码的，迁移目录会 ENOENT
const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

export async function initDb(): Promise<void> {
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await seedIfEmpty();
}
