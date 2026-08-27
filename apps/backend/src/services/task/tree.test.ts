/**
 * 路径 → 节点表 → 树 的往返，以及建表必须是线性的（以前是每段全表 find）。
 *
 *   pnpm test:file src/services/task/tree.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { flattenTree } from "./plan.js";
import { TreeBuilder, buildTree, collectFilesAndTopEmptyDirs } from "./tree.js";

const split = (p: string) => p.split("/").filter(Boolean);

test("共享前缀只建一次节点，key 按首次出现顺序分配，根是 key 0 的空名节点", () => {
  const tree = new TreeBuilder();
  for (const p of ["tv/Show/ep1.mkv", "tv/Show/ep2.mkv", "tv/Other/ep1.mkv", "tv/Show/ep1.mkv"]) tree.add(split(p));

  assert.deepEqual(tree.nodes, [
    { depth: 0, key: 0, name: "", parent_key: 0 },
    { depth: 1, key: 1, name: "tv", parent_key: 0 },
    { depth: 2, key: 2, name: "Show", parent_key: 1 },
    { depth: 3, key: 3, name: "ep1.mkv", parent_key: 2 },
    { depth: 3, key: 4, name: "ep2.mkv", parent_key: 2 },
    { depth: 2, key: 5, name: "Other", parent_key: 1 },
    { depth: 3, key: 6, name: "ep1.mkv", parent_key: 5 },
  ]);
});

test("同名但父节点不同的段各自成节点；空段列表不产生节点", () => {
  const tree = new TreeBuilder();
  tree.add([]);
  tree.add(["a", "x.mkv"]);
  tree.add(["b", "x.mkv"]);
  assert.equal(tree.nodes.length, 5);
  const files = tree.nodes.filter((n) => n.name === "x.mkv");
  assert.deepEqual(files.map((n) => n.parent_key), [1, 3]);
});

test("往返：flattenTree(buildTree(...)) 得到去掉顶层目录的相对路径，空目录只报最上层", () => {
  const tree = new TreeBuilder();
  for (const p of ["tv/Show/S1/ep1.mkv", "tv/Show/S1/ep1.nfo", "tv/Empty/Deeper", "tv/movie.mp4"]) tree.add(split(p));
  const nested = buildTree(tree.nodes);
  assert.equal(nested.length, 2, "根占位节点和 tv 两个顶层节点");
  assert.deepEqual(flattenTree(nested), ["Show/S1/ep1.mkv", "Show/S1/ep1.nfo", "Empty", "movie.mp4"]);
  assert.deepEqual(collectFilesAndTopEmptyDirs(nested[1].children!), ["Show/S1/ep1.mkv", "Show/S1/ep1.nfo", "Empty", "movie.mp4"]);
});

test("10 万条路径在一秒量级内建完（全表 find 的写法要跑几分钟）", () => {
  const tree = new TreeBuilder();
  const t0 = performance.now();
  for (let show = 0; show < 1000; show++) {
    for (let ep = 0; ep < 100; ep++) tree.add(["tv", `Show ${show}`, `Season 1`, `ep${ep}.mkv`]);
  }
  const elapsed = performance.now() - t0;
  assert.equal(tree.nodes.length, 1 + 1 + 1000 + 1000 + 100_000);
  assert.ok(elapsed < 3000, `建表用了 ${elapsed.toFixed(0)}ms`);
});
