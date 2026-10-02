/**
 * 迁移 0021：限流设置改名（app.download → app.throttle，三个字段换名，值不动）。
 *
 * 测试库是新建的，迁移跑的时候 settings 表还是空的，这条迁移等于没动过数据。
 * 所以这里把迁移文件里的语句拿出来，对着造好的旧数据再跑一遍。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/db/throttle-migration.itest.ts
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { sqlite } from "./client.js";
import { throttleSettings } from "../services/throttle.js";

const statements = fs
  .readFileSync(fileURLToPath(new URL("./migrations/0021_throttle_settings.sql", import.meta.url)), "utf8")
  .split("--> statement-breakpoint");

const migrate = () => {
  for (const statement of statements) sqlite.exec(statement);
};
const put = (key: string, value: string) => sqlite.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
const stored = (key: string): unknown => {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : undefined;
};

beforeEach(() => {
  sqlite.prepare("DELETE FROM settings WHERE key IN ('app.download', 'app.throttle')").run();
});

test("旧的一组搬到新键下，三个字段换名、值不变，旧键删掉", () => {
  put("app.download", JSON.stringify({ linkMaxPerSecond: 3, linkMaxConcurrent: 4, downloadMaxConcurrent: 6 }));
  migrate();
  assert.deepEqual(stored("app.throttle"), { requestsPerSecond: 3, requestConcurrency: 4, downloadConcurrency: 6 });
  assert.equal(stored("app.download"), undefined);
  assert.deepEqual(throttleSettings(), { requestsPerSecond: 3, requestConcurrency: 4, downloadConcurrency: 6 });
});

test("只填过一部分的：没填的字段不带过去，读的时候补默认", () => {
  put("app.download", JSON.stringify({ linkMaxPerSecond: 1 }));
  migrate();
  assert.deepEqual(stored("app.throttle"), { requestsPerSecond: 1 });
  assert.deepEqual(throttleSettings(), { requestsPerSecond: 1, requestConcurrency: 2, downloadConcurrency: 5 });
});

test("已经有新键的不覆盖；没有旧键的什么都不做", () => {
  put("app.throttle", JSON.stringify({ requestsPerSecond: 0.5, requestConcurrency: 1, downloadConcurrency: 2 }));
  put("app.download", JSON.stringify({ linkMaxPerSecond: 9, linkMaxConcurrent: 9, downloadMaxConcurrent: 9 }));
  migrate();
  assert.deepEqual(stored("app.throttle"), { requestsPerSecond: 0.5, requestConcurrency: 1, downloadConcurrency: 2 });
  assert.equal(stored("app.download"), undefined);

  migrate();
  assert.deepEqual(stored("app.throttle"), { requestsPerSecond: 0.5, requestConcurrency: 1, downloadConcurrency: 2 });
});

test("旧值不是合法 JSON：不搬，旧键照删，之后按默认值走", () => {
  put("app.download", "not json");
  migrate();
  assert.equal(stored("app.throttle"), undefined);
  assert.equal(sqlite.prepare("SELECT 1 FROM settings WHERE key = 'app.download'").get(), undefined);
  assert.deepEqual(throttleSettings(), { requestsPerSecond: 2, requestConcurrency: 2, downloadConcurrency: 5 });
});
