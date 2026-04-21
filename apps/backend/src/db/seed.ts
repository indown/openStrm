import { eq } from "drizzle-orm";
import { db } from "./client.js";
import { settings } from "./schema.js";
import { DEFAULT_AUTH, buildDefaultAppSettings } from "./defaults.js";

const SEEDED_MARKER_KEY = "__migrated_from_json__";

export function seedIfEmpty(): void {
  const marker = db
    .select()
    .from(settings)
    .where(eq(settings.key, SEEDED_MARKER_KEY))
    .all();
  if (marker.length > 0) {
    console.log("[seed] already seeded, skip");
    return;
  }

  db.transaction((tx) => {
    for (const [k, v] of Object.entries(DEFAULT_AUTH)) {
      tx.insert(settings)
        .values({ key: `auth.${k}`, value: JSON.stringify(v) })
        .run();
    }
    for (const [k, v] of Object.entries(buildDefaultAppSettings())) {
      tx.insert(settings)
        .values({ key: `app.${k}`, value: JSON.stringify(v) })
        .run();
    }
    tx.insert(settings)
      .values({ key: SEEDED_MARKER_KEY, value: JSON.stringify(Date.now()) })
      .run();
  });

  console.log("[seed] inserted defaults");
}
