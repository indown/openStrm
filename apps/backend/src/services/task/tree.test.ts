/**
 * 路径 → 节点表 → 树 的往返，以及建表必须是线性的（以前是每段全表 find）。
 *
 *   pnpm test:file src/services/task/tree.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { flattenTree } from "./plan.js";
import { TreeBuilder, buildTree, collectFilesAndTopEmptyDirs, findExportedDir, type TreeNode } from "./tree.js";

const split = (p: string) => p.split("/").filter(Boolean);
const build = (paths: string[]): TreeNode[] => {
  const t = new TreeBuilder();
  for (const p of paths) t.add(split(p));
  return buildTree(t.nodes);
};

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
  assert.deepEqual(flattenTree(nested, "tv"), ["Show/S1/ep1.mkv", "Show/S1/ep1.nfo", "Empty", "movie.mp4"]);
  assert.deepEqual(collectFilesAndTopEmptyDirs(nested[1].children!), ["Show/S1/ep1.mkv", "Show/S1/ep1.nfo", "Empty", "movie.mp4"]);
});

test("findExportedDir：115 导出从上一级开始，tv/Show 的树顶层是 tv，往下一层才是 Show", () => {
  const dir = findExportedDir(build(["tv/Show/Season 1/ep1.mkv", "tv/Show/poster.jpg"]), "tv/Show");
  assert.equal(dir?.name, "Show");
  assert.deepEqual(collectFilesAndTopEmptyDirs(dir!.children!), ["Season 1/ep1.mkv", "poster.jpg"], "相对 Show，不带 Show/ 前缀");
});

test("findExportedDir：更深的目录只带最后两级（tv/Show/Season 1 → Show/Season 1）", () => {
  const dir = findExportedDir(build(["Show/Season 1/ep1.mkv"]), "tv/Show/Season 1");
  assert.equal(dir?.name, "Season 1");
  assert.deepEqual(dir!.children!.map((n) => n.name), ["ep1.mkv"]);
});

test("findExportedDir：顶层目录导出首行是根目录，树顶层就是它自己", () => {
  assert.equal(findExportedDir(build(["tv/Show/ep1.mkv"]), "tv")?.name, "tv");
});

test("findExportedDir：同名嵌套取最长后缀——tv/Show/Show 落到里层，tv/Show 下的同名子目录不抢", () => {
  const inner = findExportedDir(build(["Show/Show/ep1.mkv"]), "tv/Show/Show");
  assert.equal(inner?.depth, 2);
  assert.deepEqual(inner!.children!.map((n) => n.name), ["ep1.mkv"]);
  const outer = findExportedDir(build(["tv/Show/Show/ep1.mkv", "tv/Show/ep0.mkv"]), "tv/Show");
  assert.equal(outer?.depth, 2);
  assert.deepEqual(outer!.children!.map((n) => n.name), ["Show", "ep0.mkv"]);
});

test("findExportedDir：OpenList 树顶层是 originPath 最后一段，前导 / 和段两边空白不影响", () => {
  const tree = build(["Show/S1/ep1.mkv"]);
  assert.equal(findExportedDir(tree, "/media/Show")?.name, "Show");
  assert.equal(findExportedDir(tree, " /media/ Show / ")?.name, "Show");
});

test("findExportedDir：目标是空目录也能找到", () => {
  const dir = findExportedDir(build(["tv/Show"]), "tv/Show");
  assert.equal(dir?.name, "Show");
  assert.deepEqual(dir!.children, []);
});

test("findExportedDir：名字对不上、树为空、路径为空都返回 null", () => {
  assert.equal(findExportedDir(build(["tv/Other/ep1.mkv"]), "tv/Show"), null);
  assert.equal(findExportedDir(buildTree(new TreeBuilder().nodes), "tv"), null);
  assert.equal(findExportedDir(build(["tv/x.mkv"]), "/"), null);
  assert.equal(findExportedDir(build(["tv/x.mkv"]), ""), null);
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
