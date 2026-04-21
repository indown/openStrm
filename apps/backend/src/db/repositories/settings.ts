import { like, eq, and, not } from "drizzle-orm";
import type { AppSettings } from "@openstrm/shared";
import { db } from "../client.js";
import { settings } from "../schema.js";

const APP_PREFIX = "app.";
const MARKER_KEY = "__migrated_from_json__";

export function readAppSettings(): AppSettings {
  const rows = db
    .select()
    .from(settings)
    .where(and(like(settings.key, `${APP_PREFIX}%`), not(eq(settings.key, MARKER_KEY))))
    .all();
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const k = r.key.slice(APP_PREFIX.length);
    try {
      out[k] = JSON.parse(r.value);
    } catch {
      out[k] = r.value;
    }
  }
  return out as AppSettings;
}

export function writeAppSettings(data: AppSettings): void {
  const entries = Object.entries(data ?? {});
  db.transaction((tx) => {
    tx.delete(settings).where(like(settings.key, `${APP_PREFIX}%`)).run();
    if (entries.length > 0) {
      tx.insert(settings)
        .values(
          entries.map(([k, v]) => ({
            key: `${APP_PREFIX}${k}`,
            value: JSON.stringify(v),
          })),
        )
        .run();
    }
  });
}
