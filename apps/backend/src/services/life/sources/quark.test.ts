/**
 * 快照对比的纯函数用例：改这里的规则先过这份测试。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { diffSnapshot, type SnapEntry } from "./quark.js";

const f = (path: string, id: string, extra: Partial<SnapEntry> = {}): SnapEntry => ({ path, id, isDir: false, size: 1, modifiedAt: 100, ...extra });
const d = (path: string, id: string): SnapEntry => ({ path, id, isDir: true });

const brief = (r: ReturnType<typeof diffSnapshot>) => r.changes.map((c) => `${c.kind} ${c.oldPath ? `${c.oldPath} -> ` : ""}${c.path}`);

test("空对空没有变化；全新快照里每个顶层条目一条 create，新目录下的不再单列", () => {
  assert.deepEqual(diffSnapshot([], []).changes, []);
  const r = diffSnapshot([], [d("S1", "d1"), f("S1/e1.mkv", "f1"), f("S1/e2.mkv", "f2"), f("top.mkv", "f3")]);
  assert.deepEqual(brief(r), ["create S1", "create top.mkv"]);
  assert.equal(r.changes[0]!.isDir, true);
});

test("同 id 换路径：父目录不变是 rename，变了是 move；目录整体搬走时子项不单报", () => {
  const prev = [d("S1", "d1"), f("S1/e1.mkv", "f1"), f("S1/e2.mkv", "f2"), f("x.mkv", "f3")];
  const curr = [d("Season 1", "d1"), f("Season 1/e1.mkv", "f1"), f("Season 1/e2.mkv", "f2"), d("misc", "d2"), f("misc/x.mkv", "f3")];
  const r = diffSnapshot(prev, curr);
  assert.deepEqual(brief(r), ["rename S1 -> Season 1", "move x.mkv -> misc/x.mkv", "create misc"]);
  // misc 是新目录：里面搬进来的 x.mkv 仍要报 move（本地要挪而不是重新生成），而且搬动排在 misc 的 create 前面
  assert.equal(r.removed, 0);
});

test("目录里的文件单独改名 / 挪到别的目录", () => {
  const prev = [d("S1", "d1"), f("S1/e1.mkv", "f1"), d("S2", "d2")];
  const curr = [d("S1", "d1"), f("S1/e1 v2.mkv", "f1"), d("S2", "d2")];
  assert.deepEqual(brief(diffSnapshot(prev, curr)), ["rename S1/e1.mkv -> S1/e1 v2.mkv"]);
  const curr2 = [d("S1", "d1"), d("S2", "d2"), f("S2/e1.mkv", "f1")];
  assert.deepEqual(brief(diffSnapshot(prev, curr2)), ["move S1/e1.mkv -> S2/e1.mkv"]);
});

test("id 消失就是 remove：整个目录没了只报目录那条，removed 计数含子项", () => {
  const prev = [d("S1", "d1"), f("S1/e1.mkv", "f1"), f("S1/e2.mkv", "f2"), f("top.mkv", "f3")];
  const r = diffSnapshot(prev, [f("top.mkv", "f3")]);
  assert.deepEqual(brief(r), ["remove S1"]);
  assert.equal(r.removed, 3);
});

test("同路径同 id 但大小或时间变了：文件按 create 再报一次（换了内容）；目录不看这个", () => {
  const prev = [d("S1", "d1"), f("S1/e1.mkv", "f1", { size: 10, modifiedAt: 1 }), f("S1/e2.nfo", "f2", { size: 5, modifiedAt: 1 })];
  const curr = [d("S1", "d1"), f("S1/e1.mkv", "f1", { size: 10, modifiedAt: 1 }), f("S1/e2.nfo", "f2", { size: 6, modifiedAt: 2 })];
  assert.deepEqual(brief(diffSnapshot(prev, curr)), ["create S1/e2.nfo"]);
});

test("同名替换：删了再传同名文件 → 新 id，先报旧 id 的 remove 再报新 id 的 create（反过来会把刚生成的删掉）", () => {
  const prev = [f("a.mkv", "f1")];
  const curr = [f("a.mkv", "f9")];
  assert.deepEqual(brief(diffSnapshot(prev, curr)), ["remove a.mkv", "create a.mkv"]);
  const dirs = diffSnapshot([d("S", "d1"), f("S/e1.mkv", "f1")], [d("S", "d9"), f("S/e1.mkv", "f8")]);
  assert.deepEqual(brief(dirs), ["remove S", "create S"]);
});

test("输出顺序：删除在前、搬动其次、新增最后（搬进新建目录要先搬再展开）；同组内浅的在前", () => {
  const prev = [d("A", "d1"), f("A/x.mkv", "f1"), f("old.mkv", "f2")];
  const curr = [d("B", "d1"), f("B/x.mkv", "f1"), d("N", "d3"), f("N/deep.mkv", "f4"), f("n.mkv", "f5")];
  assert.deepEqual(brief(diffSnapshot(prev, curr)), ["remove old.mkv", "rename A -> B", "create N", "create n.mkv"]);
});

test("同名替换的删除标 replaced，不计入消失数；真正消失的计入", () => {
  const r = diffSnapshot([d("S", "d1"), f("S/e1.mkv", "f1"), f("gone.mkv", "f2")], [d("S", "d9"), f("S/e1.mkv", "f8")]);
  assert.deepEqual(brief(r), ["remove gone.mkv", "remove S", "create S"]);
  assert.equal(r.changes[0]!.replaced, undefined);
  assert.equal(r.changes[1]!.replaced, true);
  assert.equal(r.removed, 1, "S 和它下面的 e1 都被新 id 顶替了，只有 gone.mkv 算消失");
});

test("目录搬走时子项只有相对位置没变才算跟着走；位置变了的成环退化成先删后建", () => {
  const prev = [d("D", "d1"), d("D/sub", "d2"), f("D/a.mkv", "f1")];
  const curr = [d("E", "d1"), d("E/sub", "d2"), f("E/sub/a.mkv", "f1")];
  // a.mkv 既要在 D 搬走前离开 D，又要等 E 到位才能进 E/sub：成环 → 删旧建新
  assert.deepEqual(brief(diffSnapshot(prev, curr)), ["remove D/a.mkv", "rename D -> E", "create E/sub/a.mkv"]);
});

test("改名链按依赖排序：B→C 先于 A→B；互换成环退化成先删后建", () => {
  const chain = diffSnapshot([d("A", "d1"), d("B", "d2")], [d("B", "d1"), d("C", "d2")]);
  assert.deepEqual(brief(chain), ["rename B -> C", "rename A -> B"]);
  // 互换：退化其中一个解环（删旧位置、新位置重建），另一个照常改名；先删、再改名、最后建
  const swap = diffSnapshot([f("a.mkv", "f1"), f("b.mkv", "f2")], [f("b.mkv", "f1"), f("a.mkv", "f2")]);
  assert.deepEqual(brief(swap), ["remove b.mkv", "rename a.mkv -> b.mkv", "create a.mkv"]);
  assert.equal(swap.changes[0]!.replaced, true, "退化掉的那个删除，路径被占着，不算消失");
  assert.equal(swap.removed, 0);
});

test("搬进刚搬过去的目录：目录先到位，文件再进去", () => {
  const prev = [d("D", "d1"), f("x.mkv", "f1")];
  const curr = [d("E", "d1"), f("E/x.mkv", "f1")];
  assert.deepEqual(brief(diffSnapshot(prev, curr)), ["rename D -> E", "move x.mkv -> E/x.mkv"]);
});
