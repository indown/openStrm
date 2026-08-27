import { eq } from "drizzle-orm";
import { db } from "./client.js";
import { settings } from "./schema.js";
import { DEFAULT_AUTH, buildDefaultAppSettings } from "./defaults.js";
import { hashPassword } from "../services/password.js";
import { KEY } from "./keys.js";
import { moduleLogger } from "../lib/logger.js";

const log = moduleLogger("seed");

const SEEDED_MARKER_KEY = KEY.seededMarker;

export async function seedIfEmpty(): Promise<void> {
  const marker = db
    .select()
    .from(settings)
    .where(eq(settings.key, SEEDED_MARKER_KEY))
    .all();
  if (marker.length > 0) {
    log.info("[seed] already seeded, skip");
    return;
  }

  // 默认口令一样要哈希入库：明文只在这一刻存在于内存里
  const passwordHash = await hashPassword(DEFAULT_AUTH.password);

  db.transaction((tx) => {
    const auth: Record<string, unknown> = {
      username: DEFAULT_AUTH.username,
      password: passwordHash,
      // 新库当然还在用默认口令，authenticate 靠这个标记判断，不必现算
      mustChangePassword: true,
    };
    for (const [k, v] of Object.entries(auth)) {
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

  log.info("[seed] inserted defaults");
}
