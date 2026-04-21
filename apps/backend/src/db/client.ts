import Database, { type Database as DatabaseType } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../paths.js";
import * as schema from "./schema.js";

const DB_FILE = path.join(CONFIG_DIR, "openstrm.db");

if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

export const sqlite: DatabaseType = new Database(DB_FILE);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("synchronous = NORMAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");

export const db = drizzle(sqlite, { schema });

export { schema };
export const DB_PATH = DB_FILE;
