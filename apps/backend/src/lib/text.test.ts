/**
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/lib/text.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { stripInvisible } from "./text.js";

test("stripInvisible：零宽空格 / BOM / 软连字符 / 方向控制符去掉，看得见的字不动", () => {
  assert.equal(stripInvisible("回家的诱惑.2011.S01E\u200B36\u200B"), "回家的诱惑.2011.S01E36");
  assert.equal(stripInvisible("\uFEFFA\u00ADB\u200C\u200D\u2060C\u202E"), "ABC");
  assert.equal(stripInvisible("沙丘：第二部 (2024) - 2160p"), "沙丘：第二部 (2024) - 2160p");
});
