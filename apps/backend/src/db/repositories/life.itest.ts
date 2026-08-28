/**
 * path_cache 的子树操作：改成范围查询后，前缀匹配的边界不能出错——
 * `tv/Show` 的子树不能吞掉 `tv/Show2`，也不能漏掉 `tv/Show/S1/ep.mkv`。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/db/repositories/life.itest.ts
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { deletePathCache, dropSubtree, getPathCacheRow, repathSubtree, upsertPathCache } from "./life.js";

const ids = ["st-1", "st-2", "st-3", "st-4", "st-5"];
const row = (fileId: string, path: string, isDir = false) => ({
  fileId,
  parentId: "0",
  name: path.split("/").pop()!,
  path,
  isDir,
  accountName: "itest",
});

after(() => deletePathCache(ids));

test("repathSubtree 只改自身和 `dir/` 下的后代，同前缀的兄弟目录不动", () => {
  upsertPathCache([
    row("st-1", "tv/Show", true),
    row("st-2", "tv/Show/S1/ep1.mkv"),
    row("st-3", "tv/Show2", true),
    row("st-4", "tv/Show2/ep1.mkv"),
    row("st-5", "tv/Show0/x.mkv"),
  ]);
  const changed = repathSubtree("tv/Show", "tv/Renamed");
  assert.equal(changed, 2);
  assert.equal(getPathCacheRow("st-1")?.path, "tv/Renamed");
  assert.equal(getPathCacheRow("st-2")?.path, "tv/Renamed/S1/ep1.mkv");
  assert.equal(getPathCacheRow("st-3")?.path, "tv/Show2", "兄弟目录不能被当成后代");
  assert.equal(getPathCacheRow("st-4")?.path, "tv/Show2/ep1.mkv");
  assert.equal(getPathCacheRow("st-5")?.path, "tv/Show0/x.mkv", "'0' 是范围上界，正好以它开头的路径要排除");
});

test("dropSubtree 同样的边界", () => {
  dropSubtree("tv/Renamed");
  assert.equal(getPathCacheRow("st-1"), undefined);
  assert.equal(getPathCacheRow("st-2"), undefined);
  assert.ok(getPathCacheRow("st-3"));
  assert.ok(getPathCacheRow("st-4"));
  assert.ok(getPathCacheRow("st-5"));
});
