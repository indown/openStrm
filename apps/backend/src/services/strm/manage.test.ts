/**
 * strm 管理的本地文件操作：在临时 DATA_DIR 里造一棵树，逐个验证浏览 / 体检 / 删除 / 修正 / 重建 / 校验。
 * 碰网盘的几步走内存假网盘（test/fake-drive.ts）。用例按顺序改同一棵树，不能乱序。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/strm/manage.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import type { AccountInfo, AppSettings, StrmIssueType, TaskDefinition } from "@openstrm/shared";
import { DATA_DIR } from "../../paths.js";
import { HttpError } from "../../lib/http-error.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { releaseTaskStart, reserveTaskStart } from "../task/registry.js";
import { FakeDrive } from "../../test/fake-drive.js";
import {
  deletePaths,
  listDir,
  nestedForeignRoots,
  readStrm,
  regenerate,
  resolveManagedPath,
  rewrite,
  sameRootSiblings,
  scan,
  search,
  setStrmManageDeps,
  verify,
} from "./manage.js";

const acc: AccountInfo = { accountType: "115", name: "acc", cookie: "c" };
/** 每个用例自己造一个假网盘：tree 里放什么，listSubtree / resolvePath / listDir 就看见什么 */
const drive = () => new FakeDrive("115", acc, { notes: { verify: "115 的目录信息有几分钟缓存" } });
const main: TaskDefinition = { id: "s-main", account: "acc", accountType: "115", originPath: "tv", targetPath: "strm-test/tv", strmPrefix: "/mnt/pan" };
const nested: TaskDefinition = { id: "s-nested", account: "acc", accountType: "115", originPath: "nested", targetPath: "strm-test/tv/NestedOut", strmPrefix: "/mnt/pan" };
const sib: TaskDefinition = { id: "s-sib", account: "acc", accountType: "115", originPath: "tv2", targetPath: "strm-test/tv", strmPrefix: "/mnt/pan" };
const fresh: TaskDefinition = { id: "s-fresh", account: "acc", accountType: "115", originPath: "fresh", targetPath: "strm-test/fresh", strmPrefix: "/mnt/pan" };

const ROOT = path.join(DATA_DIR, "strm-test", "tv");
const OUTSIDE = path.join(DATA_DIR, "strm-test", "outside");
const at = (rel: string) => path.join(ROOT, ...rel.split("/"));
const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), content);
};
const exists = (rel: string) => fs.existsSync(at(rel));
const read = (rel: string) => fs.readFileSync(at(rel), "utf8");
const status = (s: number) => (e: unknown) => e instanceof HttpError && e.status === s;

function seed() {
  fs.rmSync(path.join(DATA_DIR, "strm-test"), { recursive: true, force: true });
  write("Show/Season 1/ep1.strm", "/mnt/pan/tv/Show/Season 1/ep1.mkv");
  write("Show/Season 1/ep2.strm", "/old/tv/Show/Season 1/ep2.mkv");
  write("Show/Season 1/ep2.nfo", "<nfo/>");
  write("Show/Season 1/x.part", "");
  write("Show/Season 1/Show.S01E02.strm", "/mnt/pan/tv/Show/Season 1/Show.S01E02.mkv");
  write("Show/Show.S01E02.1080p.strm", "/mnt/pan/tv/Show/Show.S01E02.1080p.mkv");
  write("Show/Show/Season 1/ep1.strm", "/mnt/pan/tv/Show/Show/Season 1/ep1.mkv");
  fs.mkdirSync(at("Empty/Deeper"), { recursive: true });
  write("Other/bad.strm", "");
  write("Other/mismatch.strm", "/mnt/pan/tv/Other/different.mkv");
  write("Sib/s.strm", "/mnt/pan/tv2/Sib/s.mkv");
  write("NestedOut/n.strm", "/mnt/pan/nested/n.mkv");
  write("Prune/only.strm", "/mnt/pan/tv/Prune/only.mkv");
  fs.mkdirSync(OUTSIDE, { recursive: true });
  fs.writeFileSync(path.join(OUTSIDE, "secret.strm"), "/mnt/pan/tv/secret.mkv");
  fs.symlinkSync(OUTSIDE, at("Link"));
}

let baseline: { tasks: TaskDefinition[]; settings: AppSettings };

before(() => {
  baseline = { tasks: listTasks(), settings: readAppSettings() };
  replaceTasks([main, nested, sib, fresh]);
  replaceAppSettings({ ...baseline.settings, strmExtensions: [".mkv", ".mp4"], downloadExtensions: [".nfo", ".jpg"] });
  seed();
});

after(() => {
  setStrmManageDeps(null);
  replaceTasks(baseline.tasks);
  replaceAppSettings(baseline.settings);
  fs.rmSync(path.join(DATA_DIR, "strm-test"), { recursive: true, force: true });
});

test("归属：落在本任务根内的其它任务根、同根兄弟", () => {
  const all = [main, nested, sib, fresh];
  assert.deepEqual(nestedForeignRoots(main, all), ["NestedOut"]);
  assert.deepEqual(sameRootSiblings(main, all).map((t) => t.id), ["s-sib"]);
  assert.deepEqual(nestedForeignRoots(nested, all), []);
});

test("resolveManagedPath：归一化、越界 400、不存在 404", async () => {
  assert.equal((await resolveManagedPath(main, "/Show//Season 1/")).rel, "Show/Season 1");
  assert.equal((await resolveManagedPath(main, "")).full, ROOT);
  for (const bad of ["..", "a/../..", "Show/../../x", "a\0b"]) {
    await assert.rejects(resolveManagedPath(main, bad), status(400), bad);
  }
  await assert.rejects(resolveManagedPath(main, "Nope/x", { mustExist: true }), status(404));
});

test("符号链接：列表里标出来，遍历不进去，经过链接的路径写操作 400", async () => {
  const link = (await listDir(main, "")).entries.find((e) => e.name === "Link");
  assert.equal(link?.isDir, true);
  assert.equal(link?.isSymlink, true);
  assert.equal((await search(main, "secret")).hits.length, 0);
  await assert.rejects(rewrite(main, "Link/secret.strm", { dryRun: true }), (e: unknown) => status(400)(e) && /符号链接/.test((e as Error).message));
  const del = await deletePaths(main, ["Link/secret.strm"]);
  assert.equal(del.deleted, 0);
  assert.match(del.failed[0].message, /越出/);
  assert.ok(fs.existsSync(path.join(OUTSIDE, "secret.strm")));
});

test("listDir：目录在前按名字排，kind 五类，根不存在 exists=false，子目录不存在 404", async () => {
  const root = await listDir(main, "");
  assert.equal(root.exists, true);
  assert.deepEqual(root.entries.map((e) => e.name), ["Empty", "Link", "NestedOut", "Other", "Prune", "Show", "Sib"]);
  const s1 = await listDir(main, "Show/Season 1");
  assert.deepEqual(Object.fromEntries(s1.entries.map((e) => [e.name, e.kind])), {
    "Show.S01E02.strm": "strm",
    "ep1.strm": "strm",
    "ep2.nfo": "download",
    "ep2.strm": "strm",
    "x.part": "part",
  });
  const ep1 = s1.entries.find((e) => e.name === "ep1.strm")!;
  assert.ok(ep1.size > 0 && ep1.mtime > 0);
  assert.deepEqual(await listDir(fresh, ""), { path: "", exists: false, entries: [] });
  await assert.rejects(listDir(main, "Nope"), status(404));
  await assert.rejects(listDir(main, "Show/Season 1/ep1.strm"), status(400));
});

test("readStrm：一致 / 前缀过期 / 非 strm 400 / 过大 400 / 不存在 404", async () => {
  const ok = await readStrm(main, "Show/Season 1/ep1.strm");
  assert.equal(ok.matches, true);
  assert.equal(ok.actualRemotePath, "tv/Show/Season 1/ep1.mkv");
  assert.equal(ok.reason, undefined);
  const stale = await readStrm(main, "Show/Season 1/ep2.strm");
  assert.equal(stale.matches, false);
  assert.equal(stale.reason, "prefix-mismatch");
  assert.equal(stale.actualRemotePath, null);
  assert.equal(stale.expectedContent, "/mnt/pan/tv/Show/Season 1/ep2.mkv");
  await assert.rejects(readStrm(main, "Show/Season 1/ep2.nfo"), status(400));
  write("Other/huge.strm", "x".repeat(70 * 1024));
  await assert.rejects(readStrm(main, "Other/huge.strm"), (e: unknown) => status(400)(e) && /过大/.test((e as Error).message));
  fs.rmSync(at("Other/huge.strm"));
  await assert.rejects(readStrm(main, "Other/none.strm"), status(404));
});

test("search：不分大小写、limit 截断、别的任务的根不进", async () => {
  const r = await search(main, "EP1");
  assert.deepEqual(r.hits.map((h) => h.path).sort(), ["Show/Season 1/ep1.strm", "Show/Show/Season 1/ep1.strm"]);
  assert.equal(r.hits[0].kind, "strm");
  assert.equal(r.truncated, false);
  const one = await search(main, "ep1", 1);
  assert.equal(one.hits.length, 1);
  assert.equal(one.truncated, true);
  assert.equal((await search(main, "n.strm")).hits.length, 0, "NestedOut 是别的任务的根");
  assert.equal((await search(main, "   ")).hits.length, 0);
});

test("scan：六类问题各一例、只报最上层、跳过别的任务的根、兄弟任务的文件不算过期", async () => {
  const r = await scan(main, "");
  assert.deepEqual(r.skippedRoots, ["NestedOut"]);
  assert.equal(r.truncated, false);
  assert.equal(r.strm, 9);
  assert.equal(r.dirs, 9);
  const by = (t: StrmIssueType) => r.issues.filter((i) => i.type === t).map((i) => i.path);
  assert.deepEqual(by("nested-same-name"), ["Show/Show"]);
  assert.deepEqual(by("empty-dir"), ["Empty"]);
  assert.deepEqual(by("stale-content"), ["Show/Season 1/ep2.strm"]);
  assert.deepEqual(by("unparsable").sort(), ["Other/bad.strm", "Other/mismatch.strm"]);
  assert.deepEqual(by("leftover-part"), ["Show/Season 1/x.part"]);
  const dup = r.issues.find((i) => i.type === "duplicate-episode")!;
  assert.equal(dup.path, "Show/Season 1/Show.S01E02.strm");
  assert.deepEqual(dup.related, ["Show/Show.S01E02.1080p.strm"]);
  assert.deepEqual(r.counts, {
    "nested-same-name": 1,
    "empty-dir": 1,
    "stale-content": 1,
    unparsable: 2,
    "duplicate-episode": 1,
    "leftover-part": 1,
    "nonstandard-name": 0,
  });
  const sub = await scan(main, "Show/Season 1");
  assert.deepEqual(sub.skippedRoots, []);
  assert.equal(sub.counts["stale-content"], 1);
  assert.equal(sub.counts["nested-same-name"], 0);
  assert.deepEqual(await scan(fresh, ""), {
    files: 0,
    strm: 0,
    dirs: 0,
    truncated: false,
    skippedRoots: [],
    counts: { "nested-same-name": 0, "empty-dir": 0, "stale-content": 0, unparsable: 0, "duplicate-episode": 0, "leftover-part": 0, "nonstandard-name": 0 },
    issues: [],
  });
});

test("deletePaths：逐个处理，根 / 别的任务的根 / 不存在的进 failed，删完不清父目录", async () => {
  const r = await deletePaths(main, ["Show/Season 1/x.part", "", "NestedOut", "NestedOut/n.strm", "Nope/none", "Prune/only.strm"]);
  assert.equal(r.deleted, 2);
  assert.deepEqual(r.failed.map((f) => f.path), ["", "NestedOut", "NestedOut/n.strm", "Nope/none"]);
  assert.match(r.failed[0].message, /任务目录本身/);
  assert.match(r.failed[1].message, /s-nested/);
  assert.match(r.failed[2].message, /s-nested/);
  assert.match(r.failed[3].message, /不存在/);
  assert.equal(exists("Show/Season 1/x.part"), false);
  assert.equal(exists("Prune"), true, "删完不清父目录");
  assert.equal(exists("NestedOut/n.strm"), true);
  await assert.rejects(deletePaths(main, Array.from({ length: 501 }, (_, i) => `x${i}`)), status(400));
});

test("rewrite：dryRun 只预览不落盘；apply 只改不同的；单文件；外部文件与别的根跳过；根不存在给空", async () => {
  const dry = await rewrite(main, "Show", { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.checked, 5);
  assert.equal(dry.changed, 1);
  assert.deepEqual(dry.samples, [{ path: "Show/Season 1/ep2.strm", from: "/old/tv/Show/Season 1/ep2.mkv", to: "/mnt/pan/tv/Show/Season 1/ep2.mkv" }]);
  assert.equal(read("Show/Season 1/ep2.strm"), "/old/tv/Show/Season 1/ep2.mkv", "dryRun 不落盘");

  const all = await rewrite(main, "", { dryRun: true });
  assert.equal(all.foreign, 1, "Sib/s.strm 是兄弟任务的");
  assert.deepEqual(all.skippedRoots, ["NestedOut"]);
  assert.deepEqual(all.unparsable.map((u) => `${u.path}:${u.reason}`), ["Other/bad.strm:empty", "Other/mismatch.strm:name-mismatch"]);

  const one = await rewrite(main, "Show/Season 1/ep2.strm", { dryRun: false });
  assert.equal(one.changed, 1);
  assert.equal(read("Show/Season 1/ep2.strm"), "/mnt/pan/tv/Show/Season 1/ep2.mkv");
  assert.equal((await rewrite(main, "Show/Season 1/ep2.strm", { dryRun: false })).changed, 0);
  await assert.rejects(rewrite(main, "Show/Season 1/ep2.nfo", { dryRun: true }), status(400));
  await assert.rejects(rewrite(main, "Nope", { dryRun: true }), status(404));
  assert.equal((await rewrite(fresh, "", { dryRun: true })).checked, 0);
});

test("互斥：任务在启动 / 运行中写操作 409（dryRun 不拦）；同一任务的管理操作同时只跑一个", async () => {
  assert.ok(reserveTaskStart("s-main"));
  try {
    await assert.rejects(rewrite(main, "Show", { dryRun: false }), (e: unknown) => status(409)(e) && /运行/.test((e as Error).message));
    await assert.rejects(deletePaths(main, ["Other/bad.strm"]), status(409));
    await assert.rejects(regenerate(main, drive(), "Show", { mode: "fill" }), status(409));
    assert.equal((await rewrite(main, "Show", { dryRun: true })).checked, 5);
  } finally {
    releaseTaskStart("s-main");
  }
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const slow = drive();
  slow.tree.addDir("/tv/Show");
  slow.beforeCall = () => gate;
  const running = regenerate(main, slow, "Show", { mode: "fill" });
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(deletePaths(main, ["Other/bad.strm"]), (e: unknown) => status(409)(e) && /正在进行/.test((e as Error).message));
  release();
  assert.equal((await running).remoteFiles, 0);
  assert.equal(exists("Other/bad.strm"), true);
});

test("regenerate：fill 只补缺；rebuild 覆盖 + 删多余 strm + 清空目录、附件不动；网盘目录不在 404；读取失败 500 本地不变；根 400", async () => {
  const d = drive();
  for (const f of ["Season 1/ep1.mkv", "Season 1/ep9.mkv", "Season 1/ep9.nfo"]) d.tree.addFile(`/tv/Show/${f}`);
  d.tree.addDir("/tv/Show/Extras");
  const fill = await regenerate(main, d, "Show", { mode: "fill" });
  assert.deepEqual(d.log, ["listSubtree tv/Show"]);
  assert.deepEqual(fill, { mode: "fill", remoteFiles: 2, generated: 1, skipped: 1, removed: 0 });
  assert.equal(read("Show/Season 1/ep9.strm"), "/mnt/pan/tv/Show/Season 1/ep9.mkv");
  assert.equal(exists("Show/Season 1/ep2.strm"), true, "fill 不删");
  assert.equal(exists("Show/Season 1/ep9.nfo"), false, "只生成 strm，不下载附件");

  const rebuild = await regenerate(main, d, "Show", { mode: "rebuild" });
  assert.deepEqual(rebuild, { mode: "rebuild", remoteFiles: 2, generated: 2, skipped: 0, removed: 4 });
  assert.equal(exists("Show/Show"), false, "多余 strm 删掉后空目录一并清掉");
  assert.equal(exists("Show/Season 1/ep2.strm"), false);
  assert.equal(exists("Show/Show.S01E02.1080p.strm"), false);
  assert.equal(exists("Show/Season 1/ep2.nfo"), true, "附件不动");
  assert.equal(read("Show/Season 1/ep1.strm"), "/mnt/pan/tv/Show/Season 1/ep1.mkv");

  const gone = drive();
  await assert.rejects(regenerate(main, gone, "Show", { mode: "rebuild" }), (e: unknown) => status(404)(e) && /不存在目录/.test((e as Error).message));
  gone.tree.addDir("/tv/Show");
  gone.failWith = new Error("导出超时");
  await assert.rejects(regenerate(main, gone, "Show", { mode: "rebuild" }), (e: unknown) => status(500)(e) && /导出超时/.test((e as Error).message));
  assert.equal(exists("Show/Season 1/ep9.strm"), true, "失败时本地不动");
  await assert.rejects(regenerate(main, d, "", { mode: "fill" }), status(400));
});

test("verify：按网盘父目录分组只问一次；文件缺失 / 目录没了 / 解析不出分开报；单文件；封控整体中止，普通错误只记 errors", async () => {
  seed();
  const d = drive();
  // 网盘上只有 tv/Show/Season 1/ep1.mkv：Show 目录存在但没有 1080p 那个文件，Show/Show 整个目录不在
  d.tree.addFile("/tv/Show/Season 1/ep1.mkv");
  const r = await verify(main, d, "Show");
  assert.deepEqual(
    d.log.filter((l) => l.startsWith("resolvePath ")).map((l) => l.slice("resolvePath ".length)).sort(),
    ["tv/Show", "tv/Show/Season 1", "tv/Show/Show/Season 1"],
  );
  assert.equal(r.dirs, 3);
  assert.equal(r.checked, 5);
  const missing = Object.fromEntries(r.missing.map((m) => [m.path, `${m.reason} ${m.remotePath}`]));
  assert.deepEqual(missing, {
    "Show/Season 1/Show.S01E02.strm": "file-missing tv/Show/Season 1/Show.S01E02.mkv",
    "Show/Show.S01E02.1080p.strm": "file-missing tv/Show/Show.S01E02.1080p.mkv",
    "Show/Show/Season 1/ep1.strm": "dir-missing tv/Show/Show/Season 1/ep1.mkv",
  });
  assert.deepEqual(r.unparsable, [{ path: "Show/Season 1/ep2.strm", reason: "prefix-mismatch" }]);
  assert.equal(r.note, "115 的目录信息有几分钟缓存", "提示来自 provider");
  assert.deepEqual(r.errors, []);

  const single = await verify(main, d, "Show/Season 1/ep1.strm");
  assert.equal(single.checked, 1);
  assert.equal(single.missing.length, 0);

  d.failWith = new Error("您的访问被阻断");
  await assert.rejects(verify(main, d, "Show"), (e: unknown) => status(500)(e) && /阻断/.test((e as Error).message));
  d.failWith = new Error("网络抖动");
  const soft = await verify(main, d, "Show/Season 1/ep1.strm");
  assert.deepEqual(soft.errors, [{ remoteDir: "tv/Show/Season 1", message: "网络抖动" }]);
  assert.equal(soft.missing.length, 0);
  d.failWith = null;
  assert.equal((await verify(fresh, d, "")).checked, 0, "根不存在给空");
});
