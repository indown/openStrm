/**
 * 云下载回执循环：115 的任务列表、strm 生成、交给复制队列这三步都换成桩，
 * 逐轮驱动 tickFollowups 验证状态机。真正的复制在 services/copy 里，那边另有测试。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/offline/followup.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { patchAppSettings, readAppSettings } from "../../db/repositories/settings.js";
import { setOfflineTransport, type OfflineListPage, type OfflineTask, type OfflineTransport } from "../cloud-115/offline.js";
import type { NotifyEvent } from "../telegram/notify.js";
import type { CopyRequest } from "../copy/service.js";
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

let baseline: { tasks: TaskDefinition[]; accounts: AccountInfo[]; openlistCopy: AppSettings["openlistCopy"] };
const account: AccountInfo = { accountType: "115", name: "acc", cookie: "c" };
const olAccount: AccountInfo = { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://ol.local" };
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "115", originPath: "tv", targetPath: "tv", strmPrefix: "/mnt" };

/** 每轮列表桩回什么 */
let pages: OfflineTask[][] = [[]];
let listError: Error | null = null;
const listCalls: number[] = [];
const generated: GenerateParams[] = [];
const notified: NotifyEvent[] = [];
let generateError: Error | null = null;

/** 交给复制队列的请求 */
const copyCalls: CopyRequest[] = [];
/** 115 目录 id → 网盘绝对路径 的桩 */
let dirPaths: Record<string, string> = {};

const row = (over: Partial<OfflineTask>): OfflineTask => ({
  infoHash: "hash0", name: "Show.S01", url: "magnet:?xt=urn:btih:one", size: 1, percent: 100, status: 2, state: "done",
  statusText: "下载成功", addTime: 1, lastUpdate: 1, leftTime: 0, peers: 0, rateDownload: 0, dirId: "999",
  resultId: "r1", resultName: "Show.S01", isDir: true, move: 1, pickCode: "pc", ...over,
});

const transport: OfflineTransport = {
  async web() { throw new Error("回执测试里不该走 web 传输层"); },
  async ssp(_acc, _ac, payload) {
    const urls = Object.keys(payload).filter((k) => k.startsWith("url[")).map((k) => String(payload[k]));
    // 链接里带 "dup" 的模拟 115 的「任务已存在」：state=false 但仍回 info_hash
    const result = urls.map((url, i) =>
      url.includes("dup")
        ? { state: false, error_msg: "任务已存在", info_hash: `hash${i}`, url }
        : { state: true, info_hash: url.includes("solo") ? "hash9" : `hash${i}`, name: `name${i}`, url },
    );
    return { state: true, data: { result } };
  },
  async downPath() { return { state: true, data: [] }; },
};

async function seed(urls = "magnet:?xt=urn:btih:one", subPath = "S1") {
  const r = await addOfflineTasks({ urls, taskId: "t1", subPath });
  // addOfflineTasks 会把循环拉起来；这里手动驱动，先停掉
  await stopOfflineWatcher();
  return r;
}

/** 下载到 115 默认目录 + 勾选「复制到 OpenList」 */
async function seedCopy(urls = "magnet:?xt=urn:btih:one") {
  const r = await addOfflineTasks({ urls, copyToOpenlist: true });
  await stopOfflineWatcher();
  return r;
}

before(() => {
  baseline = { tasks: listTasks(), accounts: listAccounts(), openlistCopy: readAppSettings().openlistCopy };
  replaceAccounts([account, olAccount]);
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
      return { generatedCount: 3, skippedCount: 1, invalidNames: [] };
    },
    notify: async (ev) => { notified.push(ev); },
    enqueueCopy: (req) => { copyCalls.push(req); },
    resolveDirPath: async (_acc, cid) => dirPaths[cid] ?? null,
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
  copyCalls.length = 0;
  dirPaths = { "999": "/云下载", "5": "/别的目录" };
  replaceTasks([task]);
  replaceAccounts([account, olAccount]);
  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local/dl", mounts: { acc: "/115" } } });
});

after(async () => {
  await __test_resetOffline();
  setOfflineTransport(null);
  setOfflineServiceDeps(null);
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  patchAppSettings({ openlistCopy: baseline.openlistCopy });
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
  assert.deepEqual(g.item, { name: "Show.S01", isDir: true, id: "r1" });
  const [f] = listFollowups();
  assert.equal(f.status, "done");
  assert.match(f.detail, /已生成 3 个 strm（跳过 1 个）/);
  assert.equal(f.name, "Show.S01", "名字用列表里的最新值");
  assert.equal(notified.length, 1);
  assert.equal(notified[0].type, "offline-done");
  assert.equal((notified[0] as { name: string }).name, "Show.S01");
  assert.equal(getOfflineWatcherStatus().pending, 0);
});

test("完成（单文件）：按 del_path 生成，不带产物 id", async () => {
  await seed();
  pages = [[row({ isDir: false, resultId: "f1", resultName: "ep1.mkv", name: "ep1" })]];
  await tickFollowups();
  assert.deepEqual(generated[0].item, { name: "ep1.mkv", isDir: false, id: undefined });
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
    replaceAccounts([account, olAccount]);
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

/* ------------------------------- 交给复制队列 ------------------------------- */

test("勾了复制但没配好：加任务时当场拒绝，不留回执", async () => {
  patchAppSettings({ openlistCopy: undefined });
  await assert.rejects(addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", copyToOpenlist: true }), /还没配置好/);
  patchAppSettings({ openlistCopy: { account: "acc", dstDir: "/local/dl" } });
  await assert.rejects(addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", copyToOpenlist: true }), /不是 openlist 账号/);
  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local/dl" } });
  await assert.rejects(addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", copyToOpenlist: true }), /挂载根/);
  assert.equal(listFollowups().length, 0, "拒绝时不该留下任何回执");
});

test("下到 115 默认目录：下完把产物的网盘路径交给复制队列", async () => {
  const r = await seedCopy();
  assert.equal(r.followup, true);
  let [f] = listFollowups();
  assert.equal(f.kind, "openlist-copy");
  assert.equal(f.taskId, "");
  assert.equal(f.copyDstDir, "/local/dl");

  pages = [[row({})]];
  await tickFollowups();
  [f] = listFollowups();
  assert.equal(f.status, "done");
  assert.match(f.detail, /已交给复制队列/);
  assert.equal(copyCalls.length, 1);
  assert.deepEqual(copyCalls[0], {
    account: "acc",
    sources: [{ path: "/云下载/Show.S01", isDir: true, nodeId: "r1" }],
    dstDir: "/local/dl",
    trigger: "offline",
  });
});

test("下到任意目录也能复制：不再限定 115 默认目录", async () => {
  const r = await addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", dirId: "5", copyToOpenlist: true });
  await stopOfflineWatcher();
  assert.equal(r.followup, true);
  pages = [[row({ dirId: "5" })]];
  await tickFollowups();
  assert.equal(listFollowups()[0].status, "done");
  assert.deepEqual(copyCalls[0]?.sources, [{ path: "/别的目录/Show.S01", isDir: true, nodeId: "r1" }]);
});

test("下到任务目录 + 勾复制：先生成 strm，再交给复制队列", async () => {
  await addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", taskId: "t1", subPath: "S1", copyToOpenlist: true });
  await stopOfflineWatcher();
  pages = [[row({})]];
  await tickFollowups();
  const [f] = listFollowups();
  assert.equal(f.status, "done");
  assert.match(f.detail, /已生成 3 个 strm/);
  assert.equal(generated.length, 1, "strm 照生成");
  assert.equal(copyCalls.length, 1);
  assert.deepEqual(copyCalls[0], {
    account: "acc",
    sources: [{ path: "tv/S1/Show.S01", isDir: true, nodeId: "r1" }],
    rootPath: "tv",
    taskId: "t1",
    dstDir: "/local/dl",
    deleteSource: undefined,
    trigger: "offline",
  });
});

test("加任务时选了目的子目录：交给队列时用它，不用设置里的 dstDir", async () => {
  const r = await addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", copyToOpenlist: true, copyDstDir: "/local/dl/movies/" });
  await stopOfflineWatcher();
  assert.equal(r.followup, true);
  assert.equal(listFollowups()[0].copyDstDir, "/local/dl/movies", "尾斜杠在登记时就归一化");
  pages = [[row({})]];
  await tickFollowups();
  assert.equal(copyCalls[0]?.dstDir, "/local/dl/movies");
});

test("重复提交（任务已存在）：复制回执照登并由循环接管，strm 回执不登", async () => {
  const r = await addOfflineTasks({ urls: "magnet:?xt=urn:btih:dup", copyToOpenlist: true });
  await stopOfflineWatcher();
  assert.equal(r.added, 0, "115 没接受新任务");
  assert.equal(r.followup, true, "但复制回执要登上");
  const [f] = listFollowups();
  assert.equal(f.kind, "openlist-copy");
  assert.equal(f.infoHash, "hash0");

  // 已存在的任务往往已经下完：下一轮直接交给复制队列
  pages = [[row({})]];
  await tickFollowups();
  assert.equal(copyCalls.length, 1);
  assert.equal(listFollowups()[0].status, "done");

  // strm 模式的重复不登：已存在的任务可能不在任务目录里，生成的 strm 路径会是错的
  await __test_resetOffline();
  const r2 = await addOfflineTasks({ urls: "magnet:?xt=urn:btih:dup", taskId: "t1" });
  await stopOfflineWatcher();
  assert.equal(r2.followup, false);
  assert.equal(listFollowups().length, 0);
});

test("115 下载失败的复制回执：作废并用复制的通知文案", async () => {
  await seedCopy();
  pages = [[row({ state: "failed", status: -1, statusText: "资源违规" })]];
  await tickFollowups();
  const [f] = listFollowups();
  assert.equal(f.status, "failed");
  assert.match(f.detail, /115 下载失败：资源违规/);
  assert.equal(copyCalls.length, 0, "没下成就不该交给复制队列");
  assert.equal(notified.length, 1);
  assert.equal(notified[0].type, "offline-copy-failed");
});

test("落点目录解析不出来：回执失败，不乱猜路径", async () => {
  await seedCopy();
  pages = [[row({ dirId: "不存在的目录" })]];
  await tickFollowups();
  const [f] = listFollowups();
  assert.equal(f.status, "failed");
  assert.match(f.detail, /解析不出 115 上的落点目录/);
  assert.equal(copyCalls.length, 0);
});

test("strm 回执和复制回执混在一轮里：各走各的", async () => {
  await seed("magnet:?xt=urn:btih:one");
  await addOfflineTasks({ urls: "magnet:?xt=urn:btih:solo", copyToOpenlist: true });
  await stopOfflineWatcher();
  assert.equal(listFollowups().length, 2);

  pages = [[row({ infoHash: "hash0" }), row({ infoHash: "hash9", name: "Other" })]];
  await tickFollowups();
  const done = listFollowups().filter((f) => f.status === "done");
  assert.equal(done.length, 2, "两条都办完了");
  assert.equal(generated.length, 1, "只有 strm 那条生成了 strm");
  assert.equal(copyCalls.length, 1, "只有复制那条进了队列");
});
