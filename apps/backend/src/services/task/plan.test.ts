/**
 * 对照计划的边界情况。每条都对应一种"看起来同步成功、其实反复删建或永远同步不完"的故障。
 *
 *   pnpm test:file src/services/task/plan.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { extSet } from "../strm/naming.js";
import { flattenTree, planSync } from "./plan.js";
import type { TreeNode } from "./tree.js";

const strm = extSet([".mp4", ".mkv", ".avi", ".iso", ".flac"]);
const dl = extSet([".nfo", ".jpg", ".srt"]);

test("本地已有对应 .strm 的 strm 类文件既不缺也不多——不限于 mp4/mp3/mkv", () => {
  const plan = planSync(["a.avi", "b.iso", "c.flac", "d.mkv"], ["a.strm", "b.strm", "c.strm", "d.strm"], strm, dl);
  assert.deepEqual(plan, { missing: [], extra: [] });
});

test("远端有、本地没有的 strm 类文件算缺失", () => {
  const plan = planSync(["Show/ep1.mkv", "Show/ep2.mkv"], ["Show/ep1.strm"], strm, dl);
  assert.deepEqual(plan.missing, ["Show/ep2.mkv"]);
  assert.deepEqual(plan.extra, []);
});

test("下载类文件按原名对照", () => {
  const plan = planSync(["m.mkv", "m.nfo", "poster.jpg"], ["m.strm", "poster.jpg"], strm, dl);
  assert.deepEqual(plan.missing, ["m.nfo"]);
  assert.deepEqual(plan.extra, []);
});

test("白名单之外的远端文件不算缺失，本地有同名文件也不算多余", () => {
  const plan = planSync(["readme.txt", "m.mkv"], ["readme.txt", "m.strm"], strm, dl);
  assert.deepEqual(plan, { missing: [], extra: [] });
});

test("本地多出来的 strm / 文件算多余", () => {
  const plan = planSync(["keep.mkv"], ["keep.strm", "gone.strm", "stray.nfo"], strm, dl);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.extra, ["gone.strm", "stray.nfo"]);
});

test("扩展名大小写不敏感", () => {
  const plan = planSync(["A.MKV", "B.Nfo"], ["A.strm"], strm, dl);
  assert.deepEqual(plan.missing, ["B.Nfo"]);
  assert.deepEqual(plan.extra, []);
});

test("顶层空目录：两边都有不算多余，只有本地有才算", () => {
  const plan = planSync(["Empty", "m.mkv"], ["Empty", "Orphan", "m.strm"], strm, dl);
  assert.deepEqual(plan.missing, [], "空目录不生成任何文件，不能算缺失");
  assert.deepEqual(plan.extra, ["Orphan"]);
});

test("远端为空时本地全是多余，本地为空时白名单内全是缺失", () => {
  assert.deepEqual(planSync([], ["x.strm"], strm, dl).extra, ["x.strm"]);
  assert.deepEqual(planSync(["x.mkv", "x.txt"], [], strm, dl).missing, ["x.mkv"]);
});

test("flattenTree：顶层节点是被导出的目录本身，条目相对它；只有整棵无文件的子树才记成目录", () => {
  const dir = (key: number, name: string, parent: number, children: TreeNode[] = []): TreeNode =>
    ({ key, name, parent_key: parent, depth: 0, children });
  const file = (key: number, name: string, parent: number): TreeNode =>
    ({ key, name, parent_key: parent, depth: 0, children: [] });
  const entries = flattenTree([
    // exportDirParse 的占位根，永远是空名字、没有孩子
    dir(0, "", 0),
    dir(1, "tv", 0, [
      file(2, "root.mkv", 1),
      dir(3, "Show", 1, [file(4, "ep1.mkv", 3), dir(5, "Extras", 3)]),
      dir(6, "Season1", 1, [dir(7, "Sub", 6)]),
    ]),
  ]);
  assert.deepEqual(entries.sort(), ["Season1", "Show/ep1.mkv", "root.mkv"], [
    "路径不带 tv 前缀（和本地 saveDir 下的相对路径对齐）",
    "Show 里有文件，它的空子目录 Extras 不单独记",
    "Season1 整棵没有文件，记成一个目录条目",
  ].join("；"));
});
