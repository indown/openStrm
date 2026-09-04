/**
 *   pnpm test:file src/services/cloud-115/share.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { uniqueFileIds } from "./share.js";

test("同一个 id 只留一次、顺序不变、空的丢掉：弹框重复勾选或 API 重复传 id 都不该让 115 复制两份", () => {
  assert.deepEqual(uniqueFileIds(["3", 3, "1", "", " 3 ", "2", "1"]), ["3", "1", "2"]);
  assert.deepEqual(uniqueFileIds(42), [42]);
  assert.deepEqual(uniqueFileIds([]), []);
});
