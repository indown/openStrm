/**
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/housekeeping.itest.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { lifeEvents, pathCache } from "../db/schema.js";
import { rememberPath, } from "./cloud-115/path-resolver.js";
import { upsertLifeEvents, getPathCacheRow } from "../db/repositories/life.js";
import { LIFE_EVENT_RETENTION_S, PATH_CACHE_RETENTION_S, runHousekeeping } from "./housekeeping.js";

const now = Math.floor(Date.now() / 1000);
const ev = (id: string, updateTime: number) => ({
  id, accountName: "hk", type: 2, fileId: id, parentId: "0", fileName: `${id}.mkv`,
  fileCategory: 1, fileSize: 1, sha1: "", pickCode: "", updateTime, createTime: updateTime,
});

test("过期的生活事件被清掉，新的留下", () => {
  upsertLifeEvents([ev("hk-old", now - LIFE_EVENT_RETENTION_S - 60), ev("hk-new", now - 60)]);
  const { lifeEvents: removed } = runHousekeeping(now);
  assert.ok(removed >= 1, "至少删掉那条过期的");
  const ids = db.select({ id: lifeEvents.id }).from(lifeEvents).all().map((r) => r.id);
  assert.ok(!ids.includes("hk-old"));
  assert.ok(ids.includes("hk-new"));
});

test("长期没刷新的路径缓存被清掉，最近刷新过的留下", () => {
  rememberPath({ fileId: "hk-stale", parentId: "0", name: "stale", path: "/hk/stale", isDir: true, accountName: "hk" });
  rememberPath({ fileId: "hk-fresh", parentId: "0", name: "fresh", path: "/hk/fresh", isDir: true, accountName: "hk" });
  // 把一条的 updated_at 拨回留存期之前
  db.update(pathCache)
    .set({ updatedAt: now - PATH_CACHE_RETENTION_S - 60 })
    .where(sql`${pathCache.fileId} = 'hk-stale'`)
    .run();
  const { pathCache: removed } = runHousekeeping(now);
  assert.ok(removed >= 1);
  assert.equal(getPathCacheRow("hk-stale"), undefined);
  assert.ok(getPathCacheRow("hk-fresh"));
});
