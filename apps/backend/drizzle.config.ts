import type { Config } from "drizzle-kit";
import path from "node:path";

const CONFIG_DIR = process.env.CONFIG_DIR || path.resolve(process.cwd(), "../../config");

export default {
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url: path.join(CONFIG_DIR, "openstrm.db"),
  },
} satisfies Config;
