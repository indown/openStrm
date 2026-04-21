import { like } from "drizzle-orm";
import { db } from "../client.js";
import { settings } from "../schema.js";

const AUTH_PREFIX = "auth.";

export function readAuthConfig(): Record<string, unknown> {
  const rows = db.select().from(settings).where(like(settings.key, `${AUTH_PREFIX}%`)).all();
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const k = r.key.slice(AUTH_PREFIX.length);
    try {
      out[k] = JSON.parse(r.value);
    } catch {
      out[k] = r.value;
    }
  }
  return out;
}
