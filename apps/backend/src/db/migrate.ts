import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { db } from "./client.js";
import { seedIfEmpty } from "./seed.js";

const MIGRATIONS_DIR = path.resolve(new URL(".", import.meta.url).pathname, "migrations");

export async function initDb(): Promise<void> {
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  seedIfEmpty();
}
