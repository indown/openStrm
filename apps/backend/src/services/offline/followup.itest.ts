/**
 * 云下载回执循环：115 的任务列表和 strm 生成都换成桩，逐轮驱动 tickFollowups 验证状态机。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/offline/followup.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo, TaskDefinition } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { setOfflineTransport, type OfflineListPage, type OfflineTask, type OfflineTransport } from "../cloud-115/offline.js";
import type { NotifyEvent } from "../telegram/notify.js";
import {
  __test_resetOffline,
  addOfflineTasks,
  getOfflineWatcherStatus,
  listFollowups,
  setOfflineServiceDeps,
  startOfflineWatcher,
  stopOfflineWatcher,
  tickFollowups,
  type GenerateParams,
} from "./service.js";

let baseline: { tasks: TaskDefinition[]; accounts: AccountInfo[] };
const account: AccountInfo = { accountType: "115", name: "acc", cookie: "c" };
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "115", originPath: "tv", targetPath: "tv", strmPrefix: "/mnt" };

/** 每轮列表桩回什么 */
let pages: OfflineTask[][] = [[]];
let listError: Error | null = null;
const listCalls: number[] = [];
const generated: GenerateParams[] = [];
const notified: NotifyEvent[] = [];
let generateError: Error | null = null;

const row = (over: Partial<OfflineTask>): OfflineTask => ({
  infoHash: "hash0", name: "Show.S01", url: "magnet:?xt=urn:btih:one", size: 1, percent: 100, status: 2, state: "done",
  statusText: "下载成功", addTime: 1, lastUpdate: 1, leftTime: 0, peers: 0, rateDownload: 0, dirId: "999",
  resultId: "r1", resultName: "Show.S01", isDir: true, move: 1, pickCode: "pc", ...over,
});

const transport: OfflineTransport = {
  async web() { throw new Error("回执测试里不该走 web 传输层"); },
  async ssp(_acc, _ac, payload) {
    const urls = Object.keys(payload).filter((k) => k.startsWith("url[")).map((k) => String(payload[k]));
    return { state: true, data: { result: urls.map((url, i) => ({ state: true, info_hash: `hash${i}`, name: `name${i}`, url })) } };
  },
  async downPath() { return { state: true, data: [] }; },
};

async function seed(urls = "magnet:?xt=urn:btih:one", subPath = "S1") {
  const r = await addOfflineTasks({ urls, taskId: "t1", subPath });
  // addOfflineTasks 会把循环拉起来；这里手动驱动，先停掉
  await stopOfflineWatcher();
  return r;
}

before(() => {
  baseline = { tasks: listTasks(), accounts: listAccounts() };
  replaceAccounts([account]);
  replaceTasks([task]);
  setOfflineTransport(transport);
  setOfflineServiceDeps({
    resolveDirId: async () => "999",
    list: async (_acc, page): Promise<OfflineListPage> => {
      listCalls.push(page);
      if (listError) throw listError;
      const tasks = pages[page - 1] ?? [];
      return { page, pageCount: pages.length, pageSize: 30, count: 0, quota: null, total: null, tasks };
    },
    generate: async (p) => {
      generated.push(p);
      if (generateError) throw generateError;
      return { generatedCount: 3, skippedCount: 1 };
    },
    notify: async (ev) => { notified.push(ev); },
  });
});

beforeEach(async () => {
  await __test_resetOffline();
  pages = [[]];
  listError = null;
  generateError = null;
  listCalls.length = 0;
  generated.length = 0;
  notified.length = 0;
  replaceTasks([task]);
});

after(async () => {
  await __test_resetOffline();
  setOfflineTransport(null);
  setOfflineServiceDeps(null);
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
});

test("下载中：只更新说明，保持待办", async () => {
  await seed();
  pages = [[row({ state: "downloading", status: 1, percent: 42 })]];
  await tickFollowups();
  const [f] = listFollowups();
  assert.equal(f.status, "pending");
  assert.match(f.detail, /下载中 42%/);
  assert.equal(generated.length, 0);
});

test("完成（目录）：用 115 给的产物 id 生成 strm，回执 done，通知 Telegram", async () => {
  await seed();
  pages = [[row({ isDir: true, resultId: "r1", resultName: "Show.S01" })]];
  await tickFollowups();
  assert.equal(generated.length, 1);
  const g = generated[0];
  assert.equal(g.task.id, "t1");
  assert.equal(g.accountInfo.name, "acc");
  assert.equal(g.subPath, "S1");
  assert.deepEqual(g.item, { name: "Show.S01", isDir: true, cid: "r1" });
  const [f] = listFollowups();
  assert.equal(f.status, "done");
  assert.match(f.detail, /已生成 3 个 strm（跳过 1 个）/);
  assert.equal(f.name, "Show.S01", "名字用列表里的最新值");
  assert.equal(notified.length, 1);
  assert.equal(notified[0].type, "offline-done");
  assert.equal((notified[0] as { name: string }).name, "Show.S01");
  assert.equal(getOfflineWatcherStatus().pending, 0);
});

test("完成（单文件）：按 del_path 生成，不带 cid", async () => {
  await seed();
  pages = [[row({ isDir: false, resultId: "f1", resultName: "ep1.mkv", name: "ep1" })]];
  await tickFollowups();
  assert.deepEqual(generated[0].item, { name: "ep1.mkv", isDir: false, cid: undefined });
});

test("115 报失败：回执 failed 并带上 115 的说法，不生成", async () => {
  await seed();
  pages = [[row({ state: "failed", status: -1, statusText: "资源违规" })]];
  await tickFollowups();
  const [f] = listFollowups();
  assert.equal(f.status, "failed");
  assert.match(f.detail, /115 下载失败：资源违规/);
  assert.equal(generated.length, 0);
});

test("列表里连续 3 轮找不到：当作被删了", async () => {
  await seed();
  pages = [[row({ infoHash: "someone-else" })]];
  await tickFollowups();
  assert.equal(listFollowups()[0].status, "pending");
  assert.match(listFollowups()[0].detail, /1\/3/);
  await tickFollowups();
  await tickFollowups();
  assert.equal(listFollowups()[0].status, "failed");
  assert.match(listFollowups()[0].detail, /不在 115 的云下载列表/);
});

test("翻页：第一页没有就翻下一页，找齐就停；最多 5 页", async () => {
  await seed("magnet:?xt=urn:btih:one\nmagnet:?xt=urn:btih:two");
  pages = [[row({ infoHash: "x" })], [row({ infoHash: "hash1", isDir: false, resultName: "b.mkv" })], [row({ infoHash: "hash0" })]];
  await tickFollowups();
  assert.deepEqual(listCalls, [1, 2, 3]);
  assert.deepEqual(listFollowups().map((f) => f.status), ["done", "done"]);

  await __test_resetOffline();
  await seed();
  listCalls.length = 0;
  pages = Array.from({ length: 8 }, () => [row({ infoHash: "nope" })]);
  await tickFollowups();
  assert.deepEqual(listCalls, [1, 2, 3, 4, 5]);
});

test("生成 strm 失败：重试 3 次后作废，中间保持待办并写明原因", async () => {
  await seed();
  pages = [[row({})]];
  generateError = new Error("导出目录树超时");
  await tickFollowups();
  let [f] = listFollowups();
  assert.equal(f.status, "pending");
  assert.equal(f.attempts, 1);
  assert.match(f.detail, /稍后重试（1\/3）：导出目录树超时/);
  await tickFollowups();
  await tickFollowups();
  [f] = listFollowups();
  assert.equal(f.status, "failed");
  assert.match(f.detail, /生成 strm 失败：导出目录树超时/);
  assert.equal(generated.length, 3);
});

test("列表拿不到：这一轮什么都不改，状态里记下错误", async () => {
  await seed();
  listError = new Error("115 接口返回 405");
  await tickFollowups();
  const [f] = listFollowups();
  assert.equal(f.status, "pending");
  assert.equal(f.misses, 0, "拿不到列表不算「找不到」");
  assert.equal(getOfflineWatcherStatus().lastError, "115 接口返回 405");
});

test("同步任务已被删：回执 failed", async () => {
  await seed();
  replaceTasks([]);
  pages = [[row({})]];
  await tickFollowups();
  assert.match(listFollowups()[0].detail, /同步任务 t1 已不存在/);
  assert.equal(generated.length, 0);
});

test("账号没了：这个账号的回执全部作废", async () => {
  await seed();
  replaceAccounts([]);
  try {
    await tickFollowups();
    assert.equal(listFollowups()[0].status, "failed");
    assert.match(listFollowups()[0].detail, /账号 acc/);
  } finally {
    replaceAccounts([account]);
  }
});

test("循环的启停：没待办不起；有待办才起；兑现完自己停", async () => {
  startOfflineWatcher();
  assert.equal(getOfflineWatcherStatus().running, false);
  await addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", taskId: "t1" });
  assert.equal(getOfflineWatcherStatus().running, true);
  await stopOfflineWatcher();
  assert.equal(getOfflineWatcherStatus().running, false);
  pages = [[row({})]];
  await tickFollowups();
  startOfflineWatcher();
  assert.equal(getOfflineWatcherStatus().running, false, "都兑现了就不该再起");
});
