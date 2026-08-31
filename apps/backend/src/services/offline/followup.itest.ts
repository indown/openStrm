/**
 * 云下载回执循环：115 的任务列表和 strm 生成都换成桩，逐轮驱动 tickFollowups 验证状态机。
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
import type { OpenlistTaskInfo } from "../openlist/client.js";
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

/** OpenList 桩的状态 */
let olNames: string[] = [];
let olListError: Error | null = null;
const olCopyCalls: Array<{ srcDir: string; dstDir: string; name: string }> = [];
let olCopyResult: OpenlistTaskInfo | null = null;
let olCopyError: Error | null = null;
let olTasks: { undone: OpenlistTaskInfo[]; done: OpenlistTaskInfo[] } = { undone: [], done: [] };
let olTasksError: Error | null = null;

const row = (over: Partial<OfflineTask>): OfflineTask => ({
  infoHash: "hash0", name: "Show.S01", url: "magnet:?xt=urn:btih:one", size: 1, percent: 100, status: 2, state: "done",
  statusText: "下载成功", addTime: 1, lastUpdate: 1, leftTime: 0, peers: 0, rateDownload: 0, dirId: "999",
  resultId: "r1", resultName: "Show.S01", isDir: true, move: 1, pickCode: "pc", ...over,
});

const olTask = (over: Partial<OpenlistTaskInfo>): OpenlistTaskInfo => ({
  id: "tid1", name: "copy [/115](/云下载/Show.S01) to [/local](/dl)", state: 1, progress: 0, error: "", endedAt: null, ...over,
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
      return { generatedCount: 3, skippedCount: 1 };
    },
    notify: async (ev) => { notified.push(ev); },
    openlist: {
      listNames: async () => {
        if (olListError) throw olListError;
        return olNames;
      },
      copy: async (cfg, name) => {
        olCopyCalls.push({ srcDir: cfg.srcDir, dstDir: cfg.dstDir, name });
        if (olCopyError) throw olCopyError;
        return olCopyResult;
      },
      copyTasks: async () => {
        if (olTasksError) throw olTasksError;
        return olTasks;
      },
    },
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
  olNames = [];
  olListError = null;
  olCopyCalls.length = 0;
  olCopyResult = null;
  olCopyError = null;
  olTasks = { undone: [], done: [] };
  olTasksError = null;
  replaceTasks([task]);
  replaceAccounts([account, olAccount]);
  patchAppSettings({ openlistCopy: { account: "ol", srcDir: "/115/云下载", dstDir: "/local/dl" } });
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

/* ------------------------------- 复制到 OpenList ------------------------------- */

test("复制到 OpenList：没配置或指定了目录，加任务时当场拒绝", async () => {
  await assert.rejects(
    addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", dirId: "5", copyToOpenlist: true }),
    /只支持下载到 115 默认目录/,
  );
  await assert.rejects(
    addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", taskId: "t1", copyToOpenlist: true }),
    /只支持下载到 115 默认目录/,
  );
  patchAppSettings({ openlistCopy: undefined });
  await assert.rejects(addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", copyToOpenlist: true }), /还没配置好/);
  patchAppSettings({ openlistCopy: { account: "acc", srcDir: "/115/云下载", dstDir: "/local/dl" } });
  await assert.rejects(addOfflineTasks({ urls: "magnet:?xt=urn:btih:one", copyToOpenlist: true }), /不是 openlist 账号/);
  assert.equal(listFollowups().length, 0, "拒绝时不该留下任何回执");
});

test("复制回执走全程：下完 → 出现在 OpenList → 提交复制 → 盯任务到成功", async () => {
  const r = await seedCopy();
  assert.equal(r.followup, true);
  let [f] = listFollowups();
  assert.equal(f.kind, "openlist-copy");
  assert.equal(f.taskId, "");
  assert.equal(f.copyDstDir, "/local/dl");

  // 115 下完了，但 OpenList 刷新后还看不到产物：等，不算失败
  pages = [[row({})]];
  olNames = ["别的东西"];
  await tickFollowups();
  [f] = listFollowups();
  assert.equal(f.status, "pending");
  assert.match(f.detail, /等「Show.S01」出现在 OpenList（1\/10）/);
  assert.equal(olCopyCalls.length, 0);

  // 出现了：提交复制，进入盯任务阶段
  olNames = ["Show.S01"];
  olCopyResult = olTask({ id: "tid1" });
  await tickFollowups();
  [f] = listFollowups();
  assert.equal(f.status, "pending");
  assert.equal(f.copyTaskId, "tid1");
  assert.match(f.detail, /已提交 OpenList 复制/);
  assert.deepEqual(olCopyCalls, [{ srcDir: "/115/云下载", dstDir: "/local/dl", name: "Show.S01" }]);

  // 盯任务阶段不再翻 115 的列表
  listCalls.length = 0;
  olTasks = { undone: [olTask({ id: "tid1", progress: 40 })], done: [] };
  await tickFollowups();
  assert.match(listFollowups()[0].detail, /OpenList 复制中 40%/);
  assert.equal(listCalls.length, 0, "复制阶段不该再碰 115");

  // 目录复制：父任务结束了，逐文件的子任务还在 undone 里（按任务名里的产物名认）
  olTasks = {
    undone: [olTask({ id: "child1", name: "copy [/115](/云下载/Show.S01/E01.mkv) to [/local](/dl)", progress: 10 })],
    done: [olTask({ id: "tid1", state: 2, progress: 100, endedAt: Date.now() })],
  };
  await tickFollowups();
  assert.match(listFollowups()[0].detail, /OpenList 复制中 10%/);

  // 全部结束且都成功：回执 done，通知 Telegram
  olTasks = {
    undone: [],
    done: [
      olTask({ id: "tid1", state: 2, progress: 100, endedAt: Date.now() }),
      olTask({ id: "child1", name: "copy [/115](/云下载/Show.S01/E01.mkv) to [/local](/dl)", state: 2, endedAt: Date.now() }),
    ],
  };
  await tickFollowups();
  [f] = listFollowups();
  assert.equal(f.status, "done");
  assert.match(f.detail, /OpenList 已复制到 \/local\/dl/);
  assert.equal(notified.length, 1);
  assert.deepEqual(notified[0], { type: "offline-copied", name: "Show.S01", target: "/local/dl" });
  assert.equal(getOfflineWatcherStatus().pending, 0);
});

test("115 下载失败的复制回执：作废并用复制的通知文案", async () => {
  await seedCopy();
  pages = [[row({ state: "failed", status: -1, statusText: "资源违规" })]];
  await tickFollowups();
  const [f] = listFollowups();
  assert.equal(f.status, "failed");
  assert.match(f.detail, /115 下载失败：资源违规/);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].type, "offline-copy-failed");
});

test("产物迟迟不出现在 OpenList：等满 10 轮作废", async () => {
  await seedCopy();
  pages = [[row({})]];
  olNames = [];
  for (let i = 1; i <= 9; i++) {
    await tickFollowups();
    assert.equal(listFollowups()[0].status, "pending", `第 ${i} 轮还该在等`);
  }
  await tickFollowups();
  const [f] = listFollowups();
  assert.equal(f.status, "failed");
  assert.match(f.detail, /始终没有出现「Show.S01」/);
  assert.equal(olCopyCalls.length, 0);
});

test("提交复制的接口报错：重试 3 次后作废", async () => {
  await seedCopy();
  pages = [[row({})]];
  olNames = ["Show.S01"];
  olCopyError = new Error("OpenList /api/fs/copy 失败：HTTP 500");
  await tickFollowups();
  assert.match(listFollowups()[0].detail, /稍后重试（1\/3）/);
  await tickFollowups();
  await tickFollowups();
  const [f] = listFollowups();
  assert.equal(f.status, "failed");
  assert.match(f.detail, /提交 OpenList 复制失败：OpenList \/api\/fs\/copy 失败/);
});

test("OpenList 复制任务失败：把 error 原样带出来", async () => {
  await seedCopy();
  pages = [[row({})]];
  olNames = ["Show.S01"];
  olCopyResult = olTask({ id: "tid1" });
  await tickFollowups();
  olTasks = { undone: [], done: [olTask({ id: "tid1", state: 7, error: "存储空间不足", endedAt: Date.now() })] };
  await tickFollowups();
  const [f] = listFollowups();
  assert.equal(f.status, "failed");
  assert.match(f.detail, /OpenList 复制失败：存储空间不足/);
  assert.equal(notified.at(-1)?.type, "offline-copy-failed");
});

test("done 列表里提交之前的陈年同名任务不算这次的", async () => {
  await seedCopy();
  pages = [[row({})]];
  olNames = ["Show.S01"];
  olCopyResult = olTask({ id: "tid1" });
  await tickFollowups();
  olTasks = {
    undone: [],
    done: [
      olTask({ id: "old", state: 7, error: "上个月失败的", endedAt: Date.now() - 3600_000 }),
      olTask({ id: "tid1", state: 2, endedAt: Date.now() }),
    ],
  };
  await tickFollowups();
  assert.equal(listFollowups()[0].status, "done", "旧任务的失败不该影响这次");
});

test("复制任务列表拿不到：这一轮不动，下轮再来", async () => {
  await seedCopy();
  pages = [[row({})]];
  olNames = ["Show.S01"];
  olCopyResult = olTask({ id: "tid1" });
  await tickFollowups();
  olTasksError = new Error("connect ECONNREFUSED");
  await tickFollowups();
  const [f] = listFollowups();
  assert.equal(f.status, "pending");
  assert.equal(f.misses, 0);
  assert.equal(getOfflineWatcherStatus().lastError, "connect ECONNREFUSED");
});

test("复制任务从 OpenList 的列表里消失：3 轮后作废", async () => {
  await seedCopy();
  pages = [[row({})]];
  olNames = ["Show.S01"];
  olCopyResult = olTask({ id: "tid1" });
  await tickFollowups();
  olTasks = { undone: [], done: [] };
  await tickFollowups();
  assert.match(listFollowups()[0].detail, /暂时没找到这次复制（1\/3）/);
  await tickFollowups();
  await tickFollowups();
  const [f] = listFollowups();
  assert.equal(f.status, "failed");
  assert.match(f.detail, /找不到这次复制/);
});

test("strm 回执和复制回执混在一轮里：各走各的", async () => {
  // ssp 桩按每次调用里的顺序编号：先加两条复制（hash0、hash1），再按任务目录加一条（hash0）。
  // hash0 的复制回执被后来的 strm 回执覆盖（同 account+infoHash 只留最新），hash1 保持复制
  await seedCopy("magnet:?xt=urn:btih:one\nmagnet:?xt=urn:btih:two");
  await seed("magnet:?xt=urn:btih:one");
  pages = [[row({ infoHash: "hash0" }), row({ infoHash: "hash1", resultName: "Movie.2026", isDir: false, resultId: "f2" })]];
  olNames = ["Movie.2026"];
  olCopyResult = olTask({ id: "tid9" });
  await tickFollowups();

  const rows = listFollowups();
  assert.equal(rows.length, 2);
  const strm = rows.find((f) => (f.kind ?? "strm") === "strm")!;
  const copy = rows.find((f) => f.kind === "openlist-copy")!;
  assert.equal(strm.infoHash, "hash0");
  assert.equal(strm.status, "done", "strm 回执照常生成");
  assert.equal(generated.length, 1);
  assert.equal(copy.infoHash, "hash1");
  assert.equal(copy.copyTaskId, "tid9", "复制回执照常提交");
  assert.deepEqual(olCopyCalls, [{ srcDir: "/115/云下载", dstDir: "/local/dl", name: "Movie.2026" }]);
});
