import assert from "node:assert/strict";
import { test } from "node:test";
import type { ShareFollowEntry } from "@openstrm/shared";
import { diffShareListing, groupByParent, mergeKnown, scopeFromSelection, type ListedEntry } from "./diff.js";

const file = (path: string, sha1: string, id = path): ListedEntry => ({ path, isDir: false, sha1, size: 1, id });
const dir = (path: string, id = path): ListedEntry => ({ path, isDir: true, id });
const paths = (list: ListedEntry[]) => list.map((e) => e.path);

const known: ShareFollowEntry[] = [
  { path: "E01.mkv", isDir: false, sha1: "a" },
  { path: "E02.mkv", isDir: false, sha1: "b" },
  { path: "Extras", isDir: true },
  { path: "Extras/making.mkv", isDir: false, sha1: "x" },
];

test("新文件转存，已知的不动，不看顺序", () => {
  const d = diffShareListing(known, [file("E03.mkv", "c"), file("E01.mkv", "a"), file("E02.mkv", "b")]);
  assert.deepEqual(paths(d.added), ["E03.mkv"]);
  assert.deepEqual(d.replaced, []);
  assert.deepEqual(d.moved, []);
});

test("同一路径 sha1 变了：被替换，只记不转", () => {
  const d = diffShareListing(known, [file("E01.mkv", "a2"), file("E02.mkv", "b")]);
  assert.deepEqual(d.added, []);
  assert.deepEqual(paths(d.replaced), ["E01.mkv"]);
});

test("没有 sha1 的条目只按路径比：不会被误判成替换", () => {
  const d = diffShareListing(known, [{ path: "E01.mkv", isDir: false, id: "1" }]);
  assert.deepEqual(d.replaced, []);
  assert.deepEqual(d.added, []);
});

test("改名：路径新、sha1 已知 → 搬家，不再转一份", () => {
  const d = diffShareListing(known, [file("E01.v2.mkv", "a"), file("E02.mkv", "b")]);
  assert.deepEqual(d.added, []);
  assert.deepEqual(paths(d.moved), ["E01.v2.mkv"]);
});

test("新目录整项转存，里面的东西不再单列（不管列出来的顺序）", () => {
  const d = diffShareListing(known, [file("Season 2/E01.mkv", "s2e1"), dir("Season 2"), file("Season 2/E02.mkv", "s2e2")]);
  assert.deepEqual(paths(d.added), ["Season 2"]);
  assert.equal(d.added[0].isDir, true);
});

test("空的新目录也整项转存", () => {
  const d = diffShareListing(known, [dir("Season 2")]);
  assert.deepEqual(paths(d.added), ["Season 2"]);
});

test("新目录里全是已知 sha1：分享者在整理旧文件，整个目录算搬家", () => {
  const d = diffShareListing(known, [dir("Season 1"), file("Season 1/E01.mkv", "a"), file("Season 1/E02.mkv", "b")]);
  assert.deepEqual(d.added, []);
  assert.deepEqual(paths(d.moved), ["Season 1"]);
});

test("新目录里混着新文件：整个目录当新的转", () => {
  const d = diffShareListing(known, [dir("Season 1"), file("Season 1/E01.mkv", "a"), file("Season 1/E03.mkv", "c")]);
  assert.deepEqual(paths(d.added), ["Season 1"]);
  assert.deepEqual(d.moved, []);
});

test("已知目录里的新文件单个转存，路径带父目录", () => {
  const d = diffShareListing(known, [dir("Extras"), file("Extras/making.mkv", "x"), file("Extras/bloopers.mkv", "y")]);
  assert.deepEqual(paths(d.added), ["Extras/bloopers.mkv"]);
});

test("mergeKnown：失败的不进快照（目录失败连子孙一起），分享里删掉的仍保留，替换的记新 sha1", () => {
  const current = [
    file("E01.mkv", "a2"),
    dir("Season 2"),
    file("Season 2/E01.mkv", "s2e1"),
    file("E03.mkv", "c"),
  ];
  const next = mergeKnown(known, current, ["Season 2", "E03.mkv"]);
  const byPath = new Map(next.map((e) => [e.path, e]));
  assert.equal(byPath.get("E01.mkv")?.sha1, "a2", "替换的按现在的记");
  assert.ok(byPath.has("E02.mkv"), "分享里已经没有的还留着");
  assert.ok(!byPath.has("Season 2") && !byPath.has("Season 2/E01.mkv"), "整目录失败的下次再试");
  assert.ok(!byPath.has("E03.mkv"));
  assert.ok(byPath.has("Extras/making.mkv"));
});

test("mergeKnown 之后再 diff：替换和搬家不会每轮都报", () => {
  const current = [file("E01.mkv", "a2"), file("E02.renamed.mkv", "b")];
  const first = diffShareListing(known, current);
  assert.equal(first.replaced.length + first.moved.length, 2);
  const next = mergeKnown(known, current);
  const second = diffShareListing(next, current);
  assert.deepEqual(second, { added: [], replaced: [], moved: [] });
});

test("groupByParent：按落点分组，被盯目录本身排最前", () => {
  const groups = groupByParent([file("Season 2/E05.mkv", "1"), file("E09.mkv", "2"), dir("Season 3"), file("Season 2/E06.mkv", "3")]);
  assert.deepEqual(
    groups.map((g) => [g.parent, g.items.map((i) => i.path)]),
    [
      ["", ["E09.mkv", "Season 3"]],
      ["Season 2", ["Season 2/E05.mkv", "Season 2/E06.mkv"]],
    ],
  );
});

test("scopeFromSelection：勾了文件追整个目录，只勾目录追这些目录，去重去空", () => {
  assert.deepEqual(scopeFromSelection([{ name: "E01.mkv", isDir: false }, { name: "S1", isDir: true }]), [""]);
  assert.deepEqual(scopeFromSelection([{ name: "S1", isDir: true }, { name: " S1 ", isDir: true }, { name: "S2", isDir: true }]), ["S1", "S2"]);
  assert.deepEqual(scopeFromSelection([]), [""]);
});
