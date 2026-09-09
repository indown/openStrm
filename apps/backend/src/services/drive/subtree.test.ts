import assert from "node:assert/strict";
import { test } from "node:test";
import { syncViewFromPaths } from "./subtree.js";

/**
 * 口径和 115 导出树一致：叶子按「有没有扩展名」认文件；一个目录下面只有空目录（没有任何文件）时列这个目录本身，
 * 更外层不再重复列；根级的空目录和有文件的目录下面的空目录都不单列（导出树里认不出它们是目录）。
 */
test("同步视图：文件全部列出，只装着空目录的目录列它自己", () => {
  const view = syncViewFromPaths([
    ["S1", "e1.mkv"],
    ["S1", "e2.mkv"],
    ["S2"],
    ["S3", "Extras"],
    ["S3", "x.nfo"],
    ["S4", "Sub"],
    ["S5", "Deep", "Deeper"],
    [],
  ]);
  assert.deepEqual(view.sort(), ["S1/e1.mkv", "S1/e2.mkv", "S3/x.nfo", "S4", "S5/Deep"].sort());
});
