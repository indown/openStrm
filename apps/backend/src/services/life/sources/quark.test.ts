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
