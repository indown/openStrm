/**
 * 分享追更：分享目录列表、转存和通知都换成桩，直接驱动 checkFollow / tickFollows 验证状态机。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/follow/service.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo, TaskDefinition } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { getShareFollow } from "../../db/repositories/share-follows.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { HttpError } from "../../lib/http-error.js";
import { ShareApiError, type ShareAttr } from "../cloud-115/share.js";
import type { SaveSelectionOpts } from "../library/save-to-task.js";
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

let baseline: { tasks: TaskDefinition[]; accounts: AccountInfo[] };
const account: AccountInfo = { accountType: "115", name: "acc", cookie: "c" };
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "115", originPath: "tv", targetPath: "tv", strmPrefix: "/mnt" };

/** 桩分享：目录 id → 里面的条目 */
type Node = { id: string; name: string; dir?: boolean; sha1?: string };
let share: Record<string, Node[]> = {};
let listError: Error | null = null;
let listCalls: string[] = [];
let saves: SaveSelectionOpts[] = [];
let saveError: Error | null = null;
let notified: NotifyEvent[] = [];
const T0 = 1_800_000_000_000;
let now = T0;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const attr = (n: Node): ShareAttr => ({ id: n.id, name: n.name, is_dir: Boolean(n.dir), parent_id: 0, size: n.dir ? undefined : 1, sha1: n.sha1 });

function seedShare() {
  share = {
    "0": [
      { id: "f1", name: "E01.mkv", sha1: "a" },
      { id: "f2", name: "E02.mkv", sha1: "b" },
      { id: "d1", name: "Extras", dir: true },
    ],
    d1: [{ id: "f9", name: "making.mkv", sha1: "x" }],
  };
}

const subscribe = (over: Record<string, unknown> = {}) =>
  createFollow({ shareCode: "abc", receiveCode: "1234", watchCid: "0", watchPath: "The Show", scope: [""], taskId: "t1", subPath: "The Show", name: "The Show", ...over });

const events = (type: NotifyEvent["type"]) => notified.filter((e) => e.type === type);

before(() => {
  baseline = { tasks: listTasks(), accounts: listAccounts() };
  replaceAccounts([account]);
  replaceTasks([task]);
  setFollowServiceDeps({
    // 每页只回 2 条，顺便把翻页也走到
    listDir: async (_acc, _share, cid, offset) => {
      listCalls.push(cid);
      if (listError) throw listError;
      const all = (share[cid] ?? []).map(attr);
      return { list: all.slice(offset, offset + 2), count: all.length };
    },
    save: async (opts) => {
      saves.push(opts);
      if (saveError) throw saveError;
      return { mode: "sync", generatedCount: opts.selectedItems.length, skippedCount: 0 };
    },
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
  seedShare();
  listError = null;
  saveError = null;
  listCalls = [];
  saves = [];
  notified = [];
  now = T0;
  replaceTasks([task]);
  replaceAccounts([account]);
});

after(async () => {
  await __test_resetFollows();
  setFollowServiceDeps(null);
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
});

test("建订阅：范围内现有的全部记进快照（递归、翻页），不转存，按间隔排下次检查", async () => {
  const s = await subscribe({ intervalMinutes: 60 });
  assert.equal(s.knownCount, 4);
  assert.equal(s.enabled, true);
  assert.equal(s.status, "idle");
  assert.equal(s.nextCheckAt, T0 + HOUR, "random 钉在 0.5，没有抖动");
  assert.deepEqual(listCalls, ["0", "0", "d1"], "根目录 3 条要翻两页，Extras 一页");
  assert.equal(saves.length, 0);
  const full = getShareFollow(s.id)!;
  assert.deepEqual(
    full.known.map((e) => e.path).sort(),
    ["E01.mkv", "E02.mkv", "Extras", "Extras/making.mkv"],
  );
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

test("检查：没变化就只更新时间，不转存不通知", async () => {
  const s = await subscribe();
  now += HOUR;
  const { run, follow } = await checkFollow(s.id);
  assert.equal(run, null);
  assert.equal(follow.status, "idle");
  assert.equal(follow.lastCheckedAt, now);
  assert.equal(follow.nextCheckAt, now + FOLLOW.DEFAULT_INTERVAL_MIN * 60_000);
  assert.equal(saves.length, 0);
  assert.equal(notified.length, 0);
});

test("新集：只转存新的那条到同一位置，生成 strm，记进快照，通知", async () => {
  const s = await subscribe();
  share["0"].push({ id: "f3", name: "E03.mkv", sha1: "c" });
  now += HOUR;
  const { run, follow } = await checkFollow(s.id);
  assert.equal(saves.length, 1);
  const save = saves[0];
  assert.deepEqual(save.fileIds, ["f3"]);
  assert.deepEqual(save.selectedItems, [{ name: "E03.mkv", isDir: false }]);
  assert.equal(save.subPath, "The Show");
  assert.equal(save.mode, "sync");
  assert.equal(save.shareCode, "abc");
  assert.equal(save.task.id, "t1");
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
  share["0"].push({ id: "d2", name: "Season 2", dir: true });
  share.d2 = [{ id: "f21", name: "S02E01.mkv", sha1: "s21" }];
  share.d1.push({ id: "f10", name: "bloopers.mkv", sha1: "y" });
  const { run } = await checkFollow(s.id);
  assert.equal(saves.length, 2);
  const byParent = new Map(saves.map((sv) => [sv.subPath, sv]));
  assert.deepEqual(byParent.get("The Show")?.fileIds, ["d2"]);
  assert.deepEqual(byParent.get("The Show")?.selectedItems, [{ name: "Season 2", isDir: true }]);
  assert.deepEqual(byParent.get("The Show/Extras")?.fileIds, ["f10"]);
  assert.deepEqual(run?.added.sort(), ["Extras/bloopers.mkv", "Season 2"]);
  const known = getShareFollow(s.id)!.known.map((e) => e.path);
  assert.ok(known.includes("Season 2/S02E01.mkv"), "新目录里的文件随目录一起记进快照");
});

test("被替换 / 改名：只记一笔，不转存；下一轮不再重复报", async () => {
  const s = await subscribe();
  share["0"][0] = { id: "f1b", name: "E01.mkv", sha1: "a2" };
  share["0"][1] = { id: "f2", name: "E02.fixed.mkv", sha1: "b" };
  const { run } = await checkFollow(s.id);
  assert.equal(saves.length, 0);
  assert.equal(run?.skipped.length, 2);
  assert.match(run!.skipped[0], /E01\.mkv：.*被替换/);
  assert.match(run!.skipped[1], /E02\.fixed\.mkv：改名或搬家/);
  assert.equal(notified.length, 0);
  const second = await checkFollow(s.id);
  assert.equal(second.run, null);
});

test("范围只有某几个目录：根目录的新增不管，范围目录不见了记一笔", async () => {
  share["0"].push({ id: "d2", name: "S1", dir: true });
  share.d2 = [{ id: "f21", name: "S01E01.mkv", sha1: "s1" }];
  const s = await subscribe({ scope: ["S1", "Extras"] });
  assert.equal(s.knownCount, 4, "S1、S1/S01E01、Extras、Extras/making");
  share["0"].push({ id: "f3", name: "E03.mkv", sha1: "c" });
  share.d2.push({ id: "f22", name: "S01E02.mkv", sha1: "s2" });
  share["0"] = share["0"].filter((n) => n.name !== "Extras");
  const { run } = await checkFollow(s.id);
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].fileIds, ["f22"]);
  assert.equal(saves[0].subPath, "The Show/S1");
  assert.deepEqual(run?.added, ["S1/S01E02.mkv"]);
  assert.deepEqual(run?.skipped, ["Extras：范围目录已不在分享里"]);
});

test("转存失败：记错误、退避、失败的下次再试；连续 3 次才通知", async () => {
  const s = await subscribe({ intervalMinutes: 60 });
  share["0"].push({ id: "f3", name: "E03.mkv", sha1: "c" });
  saveError = new HttpError(400, "无法在 115 上找到保存目录：tv/The Show");
  now += HOUR;
  let r = await checkFollow(s.id);
  assert.equal(r.follow.status, "error");
  assert.equal(r.follow.errorStreak, 1);
  assert.match(r.follow.lastError, /\.：无法在 115 上找到保存目录/);
  assert.equal(r.follow.nextCheckAt, now + 2 * HOUR, "第一次失败等两倍间隔");
  assert.ok(!getShareFollow(s.id)!.known.some((e) => e.path === "E03.mkv"), "失败的不进快照");
  assert.equal(events("follow-failed").length, 0);

  await checkFollow(s.id);
  r = await checkFollow(s.id);
  assert.equal(r.follow.errorStreak, 3);
  assert.equal(events("follow-failed").length, 1);
  assert.equal(r.follow.recent.length, 1, "同一个错误连着来只占一条动态");

  saveError = null;
  r = await checkFollow(s.id);
  assert.equal(r.follow.status, "idle");
  assert.equal(r.follow.errorStreak, 0);
  assert.deepEqual(r.run?.added, ["E03.mkv"]);
});

test("分享失效：分享接口连续 3 次说不行 → expired 并停掉，通知一次；中途恢复就清零", async () => {
  const s = await subscribe();
  listError = new ShareApiError("分享已取消", 4100013);
  let r = await checkFollow(s.id);
  assert.equal(r.follow.status, "error");
  assert.equal(r.follow.enabled, true);
  assert.match(r.follow.lastError, /分享不可用：分享已取消/);
  await checkFollow(s.id);
  r = await checkFollow(s.id);
  assert.equal(r.follow.status, "expired");
  assert.equal(r.follow.enabled, false);
  assert.equal(events("follow-expired").length, 1);
  assert.equal(events("follow-failed").length, 0);

  // 重新打开 + 分享恢复：状态清掉，照常检查
  listError = null;
  const reopened = updateFollow(s.id, { enabled: true });
  assert.equal(reopened.status, "idle");
  assert.equal(reopened.errorStreak, 0);
  assert.equal(reopened.nextCheckAt, now);
  r = await checkFollow(s.id);
  assert.equal(r.follow.status, "idle");
});

test("cookie 失效 / 封控：走账号告警，不算分享失效", async () => {
  const s = await subscribe();
  listError = new ShareApiError("登录超时，请重新登录", 990001);
  for (let i = 0; i < 3; i++) await checkFollow(s.id);
  const f = getShareFollow(s.id)!;
  assert.equal(f.status, "error");
  assert.equal(f.enabled, true, "账号的问题不该把订阅停掉");
  assert.equal(events("account-alert").length, 3, "去重在 notify 层，这里每次都发");
  assert.equal(events("follow-expired").length, 0);
});

test("网络错误：普通退避；分享目录太大：报明原因", async () => {
  const s = await subscribe({ intervalMinutes: 60 });
  listError = new Error("socket hang up");
  let r = await checkFollow(s.id);
  assert.equal(r.follow.status, "error");
  assert.equal(r.follow.lastError, "socket hang up");
  assert.equal(r.follow.nextCheckAt, now + 2 * HOUR);

  listError = null;
  share["0"] = Array.from({ length: 70 }, (_, i) => ({ id: `d${i + 100}`, name: `Dir ${i}`, dir: true }));
  r = await checkFollow(s.id);
  assert.match(r.follow.lastError, /分享目录太大/);
});

test("同步任务被删：记错误，不转存", async () => {
  const s = await subscribe();
  replaceTasks([]);
  share["0"].push({ id: "f3", name: "E03.mkv", sha1: "c" });
  const r = await checkFollow(s.id);
  assert.equal(r.follow.status, "error");
  assert.match(r.follow.lastError, /同步任务 t1 已不存在/);
  assert.equal(saves.length, 0);
});

test("60 天没有新增：自动暂停并通知；有新增就从那时重新算", async () => {
  const s = await subscribe();
  now += 30 * DAY;
  share["0"].push({ id: "f3", name: "E03.mkv", sha1: "c" });
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
  now += 2 * HOUR;
  await tickFollows();
  assert.equal(listCalls.filter((c) => c === "0").length, 2, "建订阅时的两页之外没有再列");
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
  listCalls = [];
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
