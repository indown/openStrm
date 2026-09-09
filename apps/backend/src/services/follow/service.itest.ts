/**
 * 分享追更：分享和网盘换成内存假网盘（test/fake-drive.ts），通知和时间换成桩，直接驱动 checkFollow / tickFollows 验证状态机。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/follow/service.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { getShareFollow } from "../../db/repositories/share-follows.js";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { HttpError } from "../../lib/http-error.js";
import { DATA_DIR } from "../../paths.js";
import { setDriveProviderFactory } from "../drive/registry.js";
import { FakeDrive, type FakeTree } from "../../test/fake-drive.js";
import type { NotifyEvent } from "../telegram/notify.js";
import {
  __test_resetFollows,
  checkFollow,
  createFollow,
  deleteFollow,
  FOLLOW,
  getFollowWatcherStatus,
  listFollows,
  setFollowServiceDeps,
  startFollowWatcher,
  stopFollowWatcher,
  tickFollows,
  updateFollow,
} from "./service.js";

let baseline: { tasks: TaskDefinition[]; accounts: AccountInfo[]; settings: AppSettings };
const account: AccountInfo = { accountType: "115", name: "acc", cookie: "c" };
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "115", originPath: "tv", targetPath: "tv", strmPrefix: "/mnt" };

/** 假网盘：每个用例重建；分享树里的条目带 hash（115 的样子） */
let drive: FakeDrive;
let share: FakeTree;
let notified: NotifyEvent[] = [];
const T0 = 1_800_000_000_000;
let now = T0;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const LOCAL = path.join(DATA_DIR, "tv");

function seed() {
  drive = new FakeDrive("115", account, { share: true, withHash: true });
  // 分享每页只回 2 条，顺便把翻页也走到
  drive.share!.pageSize = 2;
  // 网盘里已经有任务目录和「The Show」这一层（转存落点）
  drive.tree.addDir("/tv/The Show");
  share = drive.share!.define("abc", { title: "The Show", password: "1234" });
  share.addFile("/E01.mkv", { hash: "a" });
  share.addFile("/E02.mkv", { hash: "b" });
  share.addDir("/Extras");
  share.addFile("/Extras/making.mkv", { hash: "x" });
  for (const code of ["other", "other2", "aaa", "bbb"]) {
    const t = drive.share!.define(code, { title: code, password: "1234" });
    t.addFile("/one.mkv", { hash: `${code}-1` });
  }
  setDriveProviderFactory((a) => (a.name === "acc" ? drive : null));
}

const subscribe = (over: Record<string, unknown> = {}) =>
  createFollow({ shareCode: "abc", receiveCode: "1234", watchCid: "0", watchPath: "The Show", scope: [""], taskId: "t1", subPath: "The Show", name: "The Show", ...over });

const events = (type: NotifyEvent["type"]) => notified.filter((e) => e.type === type);
const received = () => drive.share!.calls.receive;
const inDrive = (p: string) => drive.tree.get(p) !== undefined;
const strmExists = (rel: string) => fs.existsSync(path.join(LOCAL, ...rel.split("/")));

before(() => {
  baseline = { tasks: listTasks(), accounts: listAccounts(), settings: readAppSettings() };
  replaceAccounts([account]);
  replaceTasks([task]);
  replaceAppSettings({ ...baseline.settings, strmExtensions: [".mkv"], downloadExtensions: [] });
  setFollowServiceDeps({
    notify: async (ev) => {
      notified.push(ev);
    },
    now: () => now,
    random: () => 0.5,
    gapMs: 0,
  });
});

beforeEach(async () => {
  await __test_resetFollows();
  seed();
  notified = [];
  now = T0;
  replaceTasks([task]);
  replaceAccounts([account]);
  fs.rmSync(LOCAL, { recursive: true, force: true });
});

after(async () => {
  await __test_resetFollows();
  setFollowServiceDeps(null);
  setDriveProviderFactory(null);
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  fs.rmSync(LOCAL, { recursive: true, force: true });
});

test("建订阅：范围内现有的全部记进快照（递归、翻页），不转存，按间隔排下次检查", async () => {
  const s = await subscribe({ intervalMinutes: 60 });
  assert.equal(s.knownCount, 4);
  assert.equal(s.enabled, true);
  assert.equal(s.status, "idle");
  assert.equal(s.nextCheckAt, T0 + HOUR, "random 钉在 0.5，没有抖动");
  assert.deepEqual(drive.share!.log, ["list 0", "list 0@1", `list ${share.get("/Extras")!.id}`], "根目录 3 条要翻两页，Extras 一页");
  assert.equal(received(), 0);
  const full = getShareFollow(s.id)!;
  assert.deepEqual(
    full.known.map((e) => e.path).sort(),
    ["E01.mkv", "E02.mkv", "Extras", "Extras/making.mkv"],
  );
  assert.ok(full.known.every((e) => e.id), "快照带分享内的 id");
  assert.ok(!("known" in s), "summary 不带快照");
});

test("建订阅：同一分享目录 409，任务不存在 404，范围目录都找不到 400，间隔夹在上下限之间", async () => {
  await subscribe();
  await assert.rejects(subscribe(), (err: HttpError) => err.status === 409);
  await assert.rejects(subscribe({ shareCode: "other", taskId: "nope" }), (err: HttpError) => err.status === 404);
  await assert.rejects(subscribe({ shareCode: "other", scope: ["Nope"] }), (err: HttpError) => err.status === 400 && /Nope/.test(err.message));
  const s = await subscribe({ shareCode: "other2", intervalMinutes: 1 });
  assert.equal(s.intervalMinutes, FOLLOW.MIN_INTERVAL_MIN);
});

test("建订阅：分享的网盘和任务账号不同类 400", async () => {
  await assert.rejects(
    createFollow({ shareUrl: "https://pan.quark.cn/s/abcdef?pwd=1234", taskId: "t1", subPath: "x" }),
    (err: HttpError) => err.status === 400 && /夸克网盘的分享/.test(err.message),
  );
});

test("检查：没变化就只更新时间，不转存不通知", async () => {
  const s = await subscribe();
  now += HOUR;
  const { run, follow } = await checkFollow(s.id);
  assert.equal(run, null);
  assert.equal(follow.status, "idle");
  assert.equal(follow.lastCheckedAt, now);
  assert.equal(follow.nextCheckAt, now + FOLLOW.DEFAULT_INTERVAL_MIN * 60_000);
  assert.equal(received(), 0);
  assert.equal(notified.length, 0);
});

test("新集：只转存新的那条到同一位置，生成 strm，记进快照，通知", async () => {
  const s = await subscribe();
  const e3 = share.addFile("/E03.mkv", { hash: "c" });
  now += HOUR;
  const { run, follow } = await checkFollow(s.id);
  assert.equal(received(), 1);
  assert.equal(drive.share!.log.at(-1), `receive ${e3.id} -> ${drive.tree.get("/tv/The Show")!.id}`);
  assert.ok(inDrive("/tv/The Show/E03.mkv"), "转存进了任务目录下的 The Show");
  assert.ok(strmExists("The Show/E03.strm"));
  assert.equal(fs.readFileSync(path.join(LOCAL, "The Show", "E03.strm"), "utf8"), "/mnt/tv/The Show/E03.mkv");
  assert.deepEqual(run?.added, ["E03.mkv"]);
  assert.equal(run?.generated, 1);
  assert.equal(follow.lastChangeAt, now);
  assert.equal(follow.recent.length, 1);
  assert.ok(getShareFollow(s.id)!.known.some((e) => e.path === "E03.mkv"));
  const ev = events("follow-added")[0] as Extract<NotifyEvent, { type: "follow-added" }>;
  assert.deepEqual(ev.added, ["E03.mkv"]);
  assert.equal(ev.target, "tv/The Show");
  assert.equal(ev.generated, 1);
});

test("新目录整项转存；已知目录里的新文件落到对应子目录", async () => {
  const s = await subscribe();
  drive.tree.addDir("/tv/The Show/Extras");
  share.addFile("/Season 2/S02E01.mkv", { hash: "s21" });
  share.addFile("/Extras/bloopers.mkv", { hash: "y" });
  const { run } = await checkFollow(s.id);
  assert.equal(received(), 2);
  assert.ok(inDrive("/tv/The Show/Season 2/S02E01.mkv"), "整个新目录连同里面的文件转存");
  assert.ok(inDrive("/tv/The Show/Extras/bloopers.mkv"), "已知目录里的新文件落到对应子目录");
  assert.ok(strmExists("The Show/Season 2/S02E01.strm"), "新目录按子树生成 strm");
  assert.ok(strmExists("The Show/Extras/bloopers.strm"));
  assert.deepEqual(run?.added.sort(), ["Extras/bloopers.mkv", "Season 2"]);
  const known = getShareFollow(s.id)!.known.map((e) => e.path);
  assert.ok(known.includes("Season 2/S02E01.mkv"), "新目录里的文件随目录一起记进快照");
});

test("被替换 / 改名：只记一笔，不转存；下一轮不再重复报", async () => {
  const s = await subscribe();
  share.remove("/E01.mkv");
  share.addFile("/E01.mkv", { hash: "a2" });
  share.move("/E02.mkv", "/E02.fixed.mkv");
  const { run } = await checkFollow(s.id);
  assert.equal(received(), 0);
  assert.equal(run?.skipped.length, 2);
  assert.match(run!.skipped[0], /E01\.mkv：.*被替换/);
  assert.match(run!.skipped[1], /E02\.fixed\.mkv：改名或搬家/);
  assert.equal(notified.length, 0);
  const second = await checkFollow(s.id);
  assert.equal(second.run, null);
});

test("范围只有某几个目录：根目录的新增不管，范围目录不见了记一笔", async () => {
  share.addFile("/S1/S01E01.mkv", { hash: "s1" });
  drive.tree.addDir("/tv/The Show/S1");
  const s = await subscribe({ scope: ["S1", "Extras"] });
  assert.equal(s.knownCount, 4, "S1、S1/S01E01、Extras、Extras/making");
  share.addFile("/E03.mkv", { hash: "c" });
  share.addFile("/S1/S01E02.mkv", { hash: "s2" });
  share.remove("/Extras");
  const { run } = await checkFollow(s.id);
  assert.equal(received(), 1);
  assert.ok(inDrive("/tv/The Show/S1/S01E02.mkv"));
  assert.ok(!inDrive("/tv/The Show/E03.mkv"), "根目录的新增不在范围里");
  assert.deepEqual(run?.added, ["S1/S01E02.mkv"]);
  assert.deepEqual(run?.skipped, ["Extras：范围目录已不在分享里"]);
});

test("转存失败：记错误、退避、失败的下次再试；连续 3 次才通知", async () => {
  const s = await subscribe({ intervalMinutes: 60 });
  share.addFile("/E03.mkv", { hash: "c" });
  // 任务目录在网盘上没了：找不到落点就不能转存
  drive.tree.remove("/tv/The Show");
  now += HOUR;
  let r = await checkFollow(s.id);
  assert.equal(r.follow.status, "error");
  assert.equal(r.follow.errorStreak, 1);
  assert.match(r.follow.lastError, /\.：无法在网盘上找到保存目录：tv\/The Show/);
  assert.equal(r.follow.nextCheckAt, now + 2 * HOUR, "第一次失败等两倍间隔");
  assert.ok(!getShareFollow(s.id)!.known.some((e) => e.path === "E03.mkv"), "失败的不进快照");
  assert.equal(events("follow-failed").length, 0);

  await checkFollow(s.id);
  r = await checkFollow(s.id);
  assert.equal(r.follow.errorStreak, 3);
  assert.equal(events("follow-failed").length, 1);
  assert.equal(r.follow.recent.length, 1, "同一个错误连着来只占一条动态");

  drive.tree.addDir("/tv/The Show");
  r = await checkFollow(s.id);
  assert.equal(r.follow.status, "idle");
  assert.equal(r.follow.errorStreak, 0);
  assert.deepEqual(r.run?.added, ["E03.mkv"]);
});

test("分享失效：分享接口连续 3 次说不行 → expired 并停掉，通知一次；中途恢复就清零", async () => {
  const s = await subscribe();
  const def = drive.share!.shares.get("abc")!;
  def.gone = true;
  let r = await checkFollow(s.id);
  assert.equal(r.follow.status, "error");
  assert.equal(r.follow.enabled, true);
  assert.match(r.follow.lastError, /分享不可用：share not exist/);
  await checkFollow(s.id);
  r = await checkFollow(s.id);
  assert.equal(r.follow.status, "expired");
  assert.equal(r.follow.enabled, false);
  assert.equal(events("follow-expired").length, 1);
  assert.equal(events("follow-failed").length, 0);

  // 重新打开 + 分享恢复：状态清掉，照常检查
  def.gone = false;
  const reopened = updateFollow(s.id, { enabled: true });
  assert.equal(reopened.status, "idle");
  assert.equal(reopened.errorStreak, 0);
  assert.equal(reopened.nextCheckAt, now);
  r = await checkFollow(s.id);
  assert.equal(r.follow.status, "idle");
});

test("cookie 失效 / 封控：走账号告警，不算分享失效", async () => {
  const s = await subscribe();
  drive.failWith = new Error("登录超时，请重新登录");
  for (let i = 0; i < 3; i++) await checkFollow(s.id);
  const f = getShareFollow(s.id)!;
  assert.equal(f.status, "error");
  assert.equal(f.enabled, true, "账号的问题不该把订阅停掉");
  assert.equal(events("account-alert").length, 3, "去重在 notify 层，这里每次都发");
  assert.equal(events("follow-expired").length, 0);
});

test("网络错误：普通退避；分享目录太大：报明原因", async () => {
  const s = await subscribe({ intervalMinutes: 60 });
  drive.failWith = new Error("socket hang up");
  let r = await checkFollow(s.id);
  assert.equal(r.follow.status, "error");
  assert.equal(r.follow.lastError, "socket hang up");
  assert.equal(r.follow.nextCheckAt, now + 2 * HOUR);

  drive.failWith = null;
  for (let i = 0; i < 70; i++) share.addDir(`/Dir ${i}`);
  r = await checkFollow(s.id);
  assert.match(r.follow.lastError, /分享目录太大/);
});

test("同步任务被删：记错误，不转存", async () => {
  const s = await subscribe();
  replaceTasks([]);
  share.addFile("/E03.mkv", { hash: "c" });
  const r = await checkFollow(s.id);
  assert.equal(r.follow.status, "error");
  assert.match(r.follow.lastError, /同步任务 t1 已不存在/);
  assert.equal(received(), 0);
});

test("60 天没有新增：自动暂停并通知；有新增就从那时重新算", async () => {
  const s = await subscribe();
  now += 30 * DAY;
  share.addFile("/E03.mkv", { hash: "c" });
  let r = await checkFollow(s.id);
  assert.equal(r.follow.status, "idle");
  now += 59 * DAY;
  r = await checkFollow(s.id);
  assert.equal(r.follow.status, "idle", "距上次新增 59 天，还没到");
  now += 2 * DAY;
  r = await checkFollow(s.id);
  assert.equal(r.follow.status, "stale");
  assert.equal(r.follow.enabled, false);
  assert.equal(events("follow-stale").length, 1);
});

test("改设置：间隔从上次检查算起；关掉就不到期；改任务要存在", async () => {
  const s = await subscribe({ intervalMinutes: 360 });
  const shorter = updateFollow(s.id, { intervalMinutes: 60 });
  assert.equal(shorter.nextCheckAt, T0 + HOUR);
  const off = updateFollow(s.id, { enabled: false });
  assert.equal(off.enabled, false);
  const listed = drive.share!.calls.list;
  now += 2 * HOUR;
  await tickFollows();
  assert.equal(drive.share!.calls.list, listed, "建订阅时列的之外没有再列");
  assert.throws(() => updateFollow(s.id, { taskId: "nope" }), (err: HttpError) => err.status === 404);
  const renamed = updateFollow(s.id, { name: "  ", subPath: " a / b " });
  assert.equal(renamed.name, "The Show", "空名字不覆盖");
  assert.equal(renamed.subPath, "a/b");
});

test("循环：只跑到期的，按顺序；没开着的订阅就不起，建了就起，全关就停", async () => {
  startFollowWatcher();
  assert.equal(getFollowWatcherStatus().running, false);
  const a = await subscribe({ shareCode: "aaa", intervalMinutes: 60 });
  assert.equal(getFollowWatcherStatus().running, true);
  await stopFollowWatcher();
  const b = await subscribe({ shareCode: "bbb", intervalMinutes: 120 });
  await stopFollowWatcher();
  now += 61 * 60_000;
  await tickFollows();
  assert.equal(getShareFollow(a.id)!.lastCheckedAt, now, "a 到期了");
  assert.equal(getShareFollow(b.id)!.lastCheckedAt, T0, "b 还没到");
  assert.equal(getFollowWatcherStatus().lastTickAt, now);
  updateFollow(a.id, { enabled: false });
  updateFollow(b.id, { enabled: false });
  startFollowWatcher();
  assert.equal(getFollowWatcherStatus().running, false, "全关了就不起");
});

test("列表和删除", async () => {
  const s = await subscribe();
  const { follows, watcher } = listFollows();
  assert.equal(follows.length, 1);
  assert.equal(follows[0].knownCount, 4);
  assert.equal(typeof watcher.running, "boolean");
  deleteFollow(s.id);
  assert.equal(listFollows().follows.length, 0);
  assert.throws(() => deleteFollow(s.id), (err: HttpError) => err.status === 404);
});

test("服务端更新信号（夸克）：说没更新就不列目录；连续 3 次后照常列一遍；上一轮有转存失败也不信", async () => {
  const s = await subscribe();
  const fake = drive.share!;
  const listBefore = fake.calls.list;
  fake.updateSignal = "none";
  share.addFile("/E03.mkv", { hash: "c" });
  for (let i = 0; i < 3; i++) {
    now += HOUR;
    const { run, follow } = await checkFollow(s.id);
    assert.equal(run, null);
    assert.equal(follow.status, "idle");
    assert.equal(follow.lastCheckedAt, now);
    assert.equal(follow.nextCheckAt, now + FOLLOW.DEFAULT_INTERVAL_MIN * 60_000);
  }
  assert.equal(fake.calls.list, listBefore, "三轮都信了信号，没列目录");
  assert.equal(fake.calls.updates, 3);
  assert.equal(received(), 0);

  // 第四轮信不过了：照常列，发现新集
  now += HOUR;
  const fourth = await checkFollow(s.id);
  assert.deepEqual(fourth.run?.added, ["E03.mkv"]);
  assert.equal(received(), 1);
  // 信不过的那轮根本不问信号；列过一遍后信任重新计数：又能跳过
  assert.equal(fake.calls.updates, 3);
  now += HOUR;
  assert.equal((await checkFollow(s.id)).run, null);
  assert.equal(fake.calls.updates, 4);

  // 说有 / 认不出：照常列
  fake.updateSignal = "some";
  share.addFile("/E04.mkv", { hash: "d" });
  now += HOUR;
  assert.deepEqual((await checkFollow(s.id)).run?.added, ["E04.mkv"]);
  fake.updateSignal = "unknown";
  share.addFile("/E05.mkv", { hash: "e" });
  now += HOUR;
  assert.deepEqual((await checkFollow(s.id)).run?.added, ["E05.mkv"]);

  // 上一轮转存失败（落点目录没了）→ 即使信号说没更新，也要列目录把失败的再试一次
  drive.tree.remove("/tv/The Show");
  share.addFile("/E06.mkv", { hash: "f" });
  now += HOUR;
  const failedRun = await checkFollow(s.id);
  assert.equal(failedRun.follow.status, "error");
  assert.equal(failedRun.follow.errorStreak, 1);
  drive.tree.addDir("/tv/The Show");
  fake.updateSignal = "none";
  const updatesBefore = fake.calls.updates;
  now += HOUR;
  const retry = await checkFollow(s.id);
  assert.equal(fake.calls.updates, updatesBefore, "有失败在身就不问信号");
  assert.deepEqual(retry.run?.added, ["E06.mkv"]);
  assert.equal(retry.follow.errorStreak, 0);
});

test("分享里名字带 / 的条目：建订阅和检查都跳过它，不当成子目录去转存，也不算错误", async () => {
  drive.share!.listHook = (dirId, entries) => (dirId === "0" ? [...entries, { id: "weird", name: "part 1/2.mkv", isDir: false, token: "tok-weird" }] : entries);
  const s = await subscribe();
  assert.ok(!getShareFollow(s.id)!.known.some((e) => e.path.includes("part 1")), "快照里没有它");
  now += HOUR;
  const { run, follow } = await checkFollow(s.id);
  assert.equal(run, null);
  assert.equal(follow.status, "idle");
  assert.equal(follow.errorStreak, 0);
  assert.equal(received(), 0);
});

test("改订阅的任务：换到别的网盘类型的任务 400，同类的可以", async () => {
  const quarkAccount: AccountInfo = { accountType: "quark", name: "qacc", cookie: "c" };
  const quarkTask: TaskDefinition = { id: "tq", account: "qacc", accountType: "quark", originPath: "kk", targetPath: "kk", strmPrefix: "/mnt" };
  const sibling: TaskDefinition = { ...task, id: "t1b", targetPath: "tv-b" };
  const quarkDrive = new FakeDrive("quark", quarkAccount, { share: true });
  replaceAccounts([account, quarkAccount]);
  replaceTasks([task, sibling, quarkTask]);
  setDriveProviderFactory((a) => (a.name === "acc" ? drive : a.name === "qacc" ? quarkDrive : null));
  const s = await subscribe();
  await assert.rejects(
    async () => updateFollow(s.id, { taskId: "tq" }),
    (e: unknown) => e instanceof HttpError && e.status === 400 && /不能换到 夸克网盘/.test(e.message),
  );
  assert.equal(updateFollow(s.id, { taskId: "t1b" }).taskId, "t1b");
});

test("同一分享在同一账号上还有别的订阅：服务端信号不信，照常列目录", async () => {
  const s1 = await subscribe();
  const extras = share.get("/Extras")!;
  const s2 = await subscribe({ watchCid: extras.id, watchPath: "Extras", subPath: "The Show/Extras", name: "Extras" });
  const fake = drive.share!;
  fake.updateSignal = "none";
  share.addFile("/E03.mkv", { hash: "c" });
  const updatesBefore = fake.calls.updates;
  now += HOUR;
  const { run } = await checkFollow(s1.id);
  assert.deepEqual(run?.added, ["E03.mkv"], "没信信号，列目录发现了新集");
  assert.equal(fake.calls.updates, updatesBefore, "根本没问信号");
  assert.ok(s2.id);
});
