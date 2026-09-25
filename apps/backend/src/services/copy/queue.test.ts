/**
 * 复制队列的存取：裁剪、去重、按 id 合并、整理挪目录后改路径。不碰网络。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/copy/queue.test.ts
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { dstDirFor } from "./paths.js";
import { clearCopies, commitCopies, isDuplicate, listCopies, releaseCopyHolds, rewriteCopyPaths, saveCopies, type CopyRecord } from "./queue.js";

const NOW = 1_800_000_000_000;

const rec = (over: Partial<CopyRecord>): CopyRecord => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  account: "acc",
  srcDir: "/tv/某剧/S01",
  name: "E01.mkv",
  dstDir: "/local/media/某剧/S01",
  dstBase: "/local/media",
  rootPath: "/tv",
  taskId: "t1",
  trigger: "monitor",
  addedAt: NOW,
  status: "pending",
  stage: "waiting",
  detail: "",
  attempts: 0,
  waits: 0,
  misses: 0,
  ...over,
});

const layout = (base: string, rootPath: string | undefined, srcPath: string) => dstDirFor(base, rootPath, srcPath).dstDir;

beforeEach(() => clearCopies());

test("裁剪：pending 一条都不能丢，办完 / 失败的才按时间和条数收", () => {
  const rows: CopyRecord[] = [];
  for (let i = 0; i < 600; i++) rows.push(rec({ id: `p${i}`, status: "pending", addedAt: NOW + i }));
  for (let i = 0; i < 600; i++) rows.push(rec({ id: `d${i}`, status: "done", doneAt: NOW, addedAt: NOW + i }));
  saveCopies(rows, NOW);
  const kept = listCopies();
  assert.equal(kept.filter((c) => c.status === "pending").length, 600, "还在跑的一条都不能挤掉");
  assert.equal(kept.filter((c) => c.status === "done").length, 500);
});

test("裁剪：一批成功挤不掉能动手的失败记录", () => {
  const failed = rec({ id: "f1", status: "failed", doneAt: NOW - 3600_000, addedAt: NOW - 3600_000 });
  const dones = Array.from({ length: 600 }, (_, i) => rec({ id: `d${i}`, status: "done", doneAt: NOW, addedAt: NOW + i }));
  saveCopies([failed, ...dones], NOW);
  assert.ok(
    listCopies().some((c) => c.id === "f1"),
    "失败的留 7 天，不该被一批成功冲掉",
  );
});

test("裁剪：过了保留期的清掉，失败的留得久一些", () => {
  saveCopies(
    [
      rec({ id: "old-done", status: "done", doneAt: NOW - 3 * 24 * 3600_000 }),
      rec({ id: "old-failed", status: "failed", doneAt: NOW - 3 * 24 * 3600_000 }),
    ],
    NOW,
  );
  assert.deepEqual(listCopies().map((c) => c.id), ["old-failed"]);
});

test("按 id 合并：别人期间新加的留着，删掉的不复活", () => {
  const a = rec({ id: "a" });
  saveCopies([a], NOW);
  // 取一份快照（相当于循环开头读到的），期间别人加了一条、又把 a 删了之外的事
  const snapshot = { ...a, detail: "循环改过的" };
  saveCopies([listCopies()[0], rec({ id: "b" })], NOW);
  commitCopies([snapshot], NOW);
  const rows = listCopies();
  assert.equal(rows.length, 2, "期间新加的 b 不能被抹掉");
  assert.equal(rows.find((c) => c.id === "a")?.detail, "循环改过的");
});

test("按 id 合并：期间被删掉的记录不会被写回来", () => {
  const a = rec({ id: "a" });
  saveCopies([a], NOW);
  const snapshot = { ...a, detail: "循环改过的" };
  clearCopies();
  commitCopies([snapshot], NOW);
  assert.equal(listCopies().length, 0);
});

test("去重：一样的来源 + 目标不重复排；刚办完的 24 小时内也不排", () => {
  const rows = [rec({ id: "a" })];
  assert.equal(isDuplicate(rows, rec({ id: "b" }), NOW), true);
  assert.equal(isDuplicate(rows, rec({ id: "b", dstDir: "/local/backup" }), NOW), false, "换了目标就是另一件事");

  const done = [rec({ id: "a", status: "done", doneAt: NOW - 3600_000 })];
  assert.equal(isDuplicate(done, rec({ id: "b" }), NOW), true);
  assert.equal(isDuplicate(done, rec({ id: "b" }), NOW + 25 * 3600_000), false, "隔了一天以上就可以再排");
});

test("整理挪了目录：还没提交的跟着改，目标目录按新层级重算", () => {
  saveCopies([rec({ id: "a" })], NOW);
  const hit = rewriteCopyPaths("t1", "/tv", [{ from: "某剧", to: "某剧 (2020) [tmdbid=1]" }], false, layout);
  assert.deepEqual(hit, ["某剧/S01/E01.mkv"]);
  const [c] = listCopies();
  assert.equal(c.srcDir, "/tv/某剧 (2020) [tmdbid=1]/S01");
  assert.equal(c.dstDir, "/local/media/某剧 (2020) [tmdbid=1]/S01", "目标跟着新层级走，不停在改名前");
});

test("整理把文件改了名：连名字一起改，不然永远等不到它出现", () => {
  saveCopies([rec({ id: "a" })], NOW);
  rewriteCopyPaths("t1", "/tv", [{ from: "某剧/S01/E01.mkv", to: "某剧/Season 01/某剧 - S01E01.mkv" }], false, layout);
  const [c] = listCopies();
  assert.equal(c.name, "某剧 - S01E01.mkv");
  assert.equal(c.srcDir, "/tv/某剧/Season 01");
  assert.equal(c.dstDir, "/local/media/某剧/Season 01");
});

test("整理挪了目录：顶层条目（就在任务目录下）也认得出来", () => {
  saveCopies([rec({ id: "a", srcDir: "/tv", name: "某剧", isDir: true, dstDir: "/local/media" })], NOW);
  const hit = rewriteCopyPaths("t1", "/tv", [{ from: "某剧", to: "某剧 (2020)" }], false, layout);
  assert.deepEqual(hit, ["某剧"]);
  assert.equal(listCopies()[0].name, "某剧 (2020)");
});

test("整理挪了目录：已经提交给 OpenList 的不动", () => {
  saveCopies([rec({ id: "a", stage: "copying", copyTaskId: "t9" })], NOW);
  rewriteCopyPaths("t1", "/tv", [{ from: "某剧", to: "别的名字" }], false, layout);
  assert.equal(listCopies()[0].srcDir, "/tv/某剧/S01", "交出去了就追不回来，别改");
});

test("整理挪了目录：别的任务、对不上的映射都不碰；dryRun 只看不改", () => {
  saveCopies([rec({ id: "a" })], NOW);
  rewriteCopyPaths("别的任务", "/tv", [{ from: "某剧", to: "x" }], false, layout);
  rewriteCopyPaths("t1", "/tv", [{ from: "对不上的", to: "x" }], false, layout);
  assert.equal(listCopies()[0].srcDir, "/tv/某剧/S01");

  const hit = rewriteCopyPaths("t1", "/tv", [], true, layout);
  assert.deepEqual(hit, ["某剧/S01/E01.mkv"]);
  assert.equal(listCopies()[0].srcDir, "/tv/某剧/S01", "dryRun 不改");
});

test("整理把一集挪进作品目录并改名（所在目录没腾空）：按文件的挪动改，目录级映射里没有它也得跟上", () => {
  saveCopies([rec({ id: "a", srcDir: "/tv/Show.S01.1080p", name: "Show.S01E06.mkv", dstDir: "/local/media/Show.S01.1080p" })], NOW);
  const hit = rewriteCopyPaths(
    "t1",
    "/tv",
    [], // 发布目录里还剩别的集，没腾空，没有目录级映射
    false,
    layout,
    [{ from: "Show.S01.1080p/Show.S01E06.mkv", to: "某剧 (2022) [tmdbid=1]/Season 01/某剧 - S01E06.mkv" }],
    new Set(),
    NOW,
  );
  assert.deepEqual(hit, ["Show.S01.1080p/Show.S01E06.mkv"]);
  const [c] = listCopies();
  assert.equal(c.srcDir, "/tv/某剧 (2022) [tmdbid=1]/Season 01");
  assert.equal(c.name, "某剧 - S01E06.mkv");
  assert.equal(c.dstDir, "/local/media/某剧 (2022) [tmdbid=1]/Season 01");
});

test("整理把目录里的文件挪走、目录腾空删掉：目录待办记成跳过，挪走的每个文件另起一条跟过去", () => {
  saveCopies([rec({ id: "dir", srcDir: "/tv", name: "Show.S01.1080p", isDir: true, dstDir: "/local/media", deleteSource: true, holdUntil: NOW + 60_000 })], NOW);
  rewriteCopyPaths(
    "t1",
    "/tv",
    [{ from: "Show.S01.1080p", to: "某剧 (2022) [tmdbid=1]/Season 01" }],
    false,
    layout,
    [
      { from: "Show.S01.1080p/E01.mkv", to: "某剧 (2022) [tmdbid=1]/Season 01/某剧 - S01E01.mkv" },
      { from: "Show.S01.1080p/E02.mkv", to: "某剧 (2022) [tmdbid=1]/Season 01/某剧 - S01E02.mkv" },
    ],
    new Set(["Show.S01.1080p"]),
    NOW,
  );
  const rows = listCopies();
  const dir = rows.find((c) => c.id === "dir")!;
  assert.equal(dir.status, "skipped", "目录已经腾空删掉，不能再按目录复制（目标里要是已经有 Season 01 会整个被跳过）");
  assert.match(dir.detail, /按文件分别排队复制/);
  assert.equal(dir.superseded, true, "用不着了：不给重试（重试只会等十轮再失败）");
  const pieces = rows.filter((c) => c.id !== "dir");
  assert.deepEqual(pieces.map((c) => c.name).sort(), ["某剧 - S01E01.mkv", "某剧 - S01E02.mkv"]);
  for (const c of pieces) {
    assert.equal(c.status, "pending");
    assert.equal(c.isDir, false);
    assert.equal(c.srcDir, "/tv/某剧 (2022) [tmdbid=1]/Season 01");
    assert.equal(c.dstDir, "/local/media/某剧 (2022) [tmdbid=1]/Season 01");
    assert.equal(c.deleteSource, true, "删源的意思跟着拆出来的文件走");
    assert.equal(c.nodeId, undefined, "目录的节点 id 对不上里面的文件，提交时再钉");
    assert.equal(c.holdUntil, NOW + 60_000, "照样压着，等整理那边放行");
  }
});

test("目录没腾空（里面还有整理不动的东西）：挪走的文件另起，目录待办留着复制剩下的", () => {
  saveCopies([rec({ id: "dir", srcDir: "/tv", name: "Show.S01.1080p", isDir: true, dstDir: "/local/media" })], NOW);
  rewriteCopyPaths("t1", "/tv", [], false, layout, [{ from: "Show.S01.1080p/E01.mkv", to: "某剧/Season 01/某剧 - S01E01.mkv" }], new Set(), NOW);
  const rows = listCopies();
  assert.equal(rows.find((c) => c.id === "dir")!.status, "pending");
  assert.equal(rows.find((c) => c.id !== "dir")!.name, "某剧 - S01E01.mkv");
});

test("拆出来的文件已经有一样的待办：不重复排", () => {
  saveCopies(
    [
      rec({ id: "dir", srcDir: "/tv", name: "Show", isDir: true, dstDir: "/local/media" }),
      rec({ id: "f", srcDir: "/tv/某剧/Season 01", name: "某剧 - S01E01.mkv", dstDir: "/local/media/某剧/Season 01" }),
    ],
    NOW,
  );
  rewriteCopyPaths("t1", "/tv", [], false, layout, [{ from: "Show/E01.mkv", to: "某剧/Season 01/某剧 - S01E01.mkv" }], new Set(["Show"]), NOW);
  assert.equal(listCopies().filter((c) => c.name === "某剧 - S01E01.mkv").length, 1);
});

test("等整理的复制：整理开始之前登记的放行，开始之后才登记的接着等下一次", () => {
  saveCopies(
    [
      rec({ id: "early", addedAt: NOW, holdUntil: NOW + 600_000 }),
      rec({ id: "late", name: "E02.mkv", addedAt: NOW + 5_000, holdUntil: NOW + 600_000 }),
      rec({ id: "other", taskId: "t2", addedAt: NOW, holdUntil: NOW + 600_000 }),
    ],
    NOW,
  );
  const n = releaseCopyHolds("t1", NOW + 1_000, NOW + 2_000);
  assert.equal(n, 1);
  const byId = new Map(listCopies().map((c) => [c.id, c]));
  assert.equal(byId.get("early")!.holdUntil, undefined);
  assert.equal(byId.get("late")!.holdUntil, NOW + 600_000);
  assert.equal(byId.get("other")!.holdUntil, NOW + 600_000, "别的任务不碰");
});
