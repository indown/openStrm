/**
 * 复制队列：OpenList 那几个调用换成桩，逐轮驱动 tickCopies 验证两个阶段的状态机。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/copy/copy.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { patchAppSettings, readAppSettings } from "../../db/repositories/settings.js";
import { readKv, writeKv } from "../../db/repositories/life.js";
import { KEY } from "../../db/keys.js";
import { OpenlistError, type OpenlistTaskInfo } from "../openlist/client.js";
import type { NotifyEvent } from "../telegram/notify.js";
import { releaseCopyHolds } from "./queue.js";
import {
  __test_resetCopy,
  adoptLegacyCopyFollowups,
  stopCopyWatcher,
  dropCopy,
  enqueueCopy,
  getCopyWatcherStatus,
  listCopies,
  retryCopy,
  setCopyServiceDeps,
  tickCopies,
} from "./service.js";

let baseline: { accounts: AccountInfo[]; tasks: TaskDefinition[]; openlistCopy: AppSettings["openlistCopy"] };
const drive: AccountInfo = { accountType: "115", name: "acc", cookie: "c" };
const olAccount: AccountInfo = { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://ol.local" };

/** 桩的状态 */
let names: Record<string, string[]> = {};
let listError: Error | null = null;
/**
 * OpenList 父目录缓存没跟上的目录：直接列会报找不到，列过它的上一级（刷新了父目录的缓存）之后就能列了。
 * 真机撞到的：发布目录在 115 上改了名，OpenList 的父目录缓存里还是旧名字
 */
let staleDirs = new Set<string>();
/** 真的不在了的目录：怎么刷新都找不到 */
let goneDirs = new Set<string>();
/** 提交时钉网盘节点 id 的桩：字符串 = 找到了，null = 网盘上没有，Error = 接口报错 */
let pinResult: string | null | Error = "pinned";
const pinCalls: string[] = [];
const mirrorCalls: Array<{ account: string; path: string; isDir: boolean | undefined }> = [];
const listedDirs: string[] = [];
const mkdirCalls: string[] = [];
const copyCalls: Array<{ srcDir: string; dstDir: string; names: string[] }> = [];
let copyResult: OpenlistTaskInfo[] = [];
/** 想让每次提交回不同的任务时用它（按调用顺序取） */
let copyResultQueue: OpenlistTaskInfo[][] = [];
let copyError: Error | null = null;
let tasks: { undone: OpenlistTaskInfo[]; done: OpenlistTaskInfo[] } = { undone: [], done: [] };
let tasksError: Error | null = null;
const notified: NotifyEvent[] = [];
let embyRefreshes = 0;
const organized: Array<{ taskId: string; paths: string[]; trigger: string }> = [];
const removeCalls: Array<{ account: string; path: string; nodeId?: string }> = [];
let removeResult: "removed" | "missing" | "changed" | "unsupported" = "removed";
/** 网盘上某个目录里有哪些子项（删源前核对目录复制全了没有） */
let driveChildren: Record<string, string[]> = {};
/** 队列里「刚登记要晾一会」的门槛：测试里把时钟往前拨，不真等 */
let now = 1_800_000_000_000;

const olTask = (over: Partial<OpenlistTaskInfo>): OpenlistTaskInfo => ({
  id: "tid1", name: "copy [/115](/tv/某剧) to [/local](/media)", state: 1, progress: 0, error: "", endedAt: null, ...over,
});

/**
 * 登记一条，并把时钟拨过「晾一会」的窗口。
 * enqueueCopy 会把循环拉起来，这里手动驱动 tickCopies，所以马上停掉——
 * 不然真循环会插进来多跑几轮，按次数断言的用例就飘了（同 followup.itest 的 seed）
 */
async function seed(paths: string[] = ["/tv/某剧/S01/E01.mkv"], over: Partial<Parameters<typeof enqueueCopy>[0]> = {}): Promise<void> {
  enqueueCopy({ account: "acc", sources: paths, rootPath: "/tv", taskId: "t1", trigger: "monitor", ...over });
  await stopCopyWatcher();
  now += 30_000;
}

before(() => {
  baseline = { accounts: listAccounts(), tasks: listTasks(), openlistCopy: readAppSettings().openlistCopy };
  replaceAccounts([drive, olAccount]);
  setCopyServiceDeps({
    openlist: {
      listNames: async (_cfg, dir) => {
        listedDirs.push(dir);
        if (listError) throw listError;
        if (goneDirs.has(dir) || staleDirs.has(dir)) throw new OpenlistError("failed get objs: failed get dir: object not found", 500, false);
        // 列过这一级 = 刷新了它的缓存：它下面一层的子目录从此能找到了
        for (const d of [...staleDirs]) if (d.slice(0, d.lastIndexOf("/")) === dir || (dir === "/" && d.lastIndexOf("/") === 0)) staleDirs.delete(d);
        return names[dir] ?? [];
      },
      mkdir: async (_cfg, dir) => {
        mkdirCalls.push(dir);
      },
      copy: async (_cfg, srcDir, dstDir, ns) => {
        copyCalls.push({ srcDir, dstDir, names: ns });
        if (copyError) throw copyError;
        return copyResultQueue.length > 0 ? (copyResultQueue.shift() ?? []) : copyResult;
      },
      copyTasks: async () => {
        if (tasksError) throw tasksError;
        return tasks;
      },
    },
    notify: async (ev) => {
      notified.push(ev);
    },
    now: () => now,
    embyRefresh: () => {
      embyRefreshes++;
    },
    organize: (input) => {
      organized.push({ taskId: input.task.id, paths: input.paths, trigger: input.trigger });
    },
    removeSource: async (account, path, nodeId) => {
      removeCalls.push({ account, path, nodeId });
      return removeResult;
    },
    listDriveChildren: async (_account, path) => driveChildren[path] ?? [],
    resolveNodeId: async (_account, path) => {
      pinCalls.push(path);
      if (pinResult instanceof Error) throw pinResult;
      return pinResult;
    },
    removeLocalMirror: async (account, path, isDir) => {
      mirrorCalls.push({ account, path, isDir });
      return true;
    },
  });
});

beforeEach(async () => {
  await __test_resetCopy();
  names = {};
  listError = null;
  staleDirs = new Set();
  goneDirs = new Set();
  pinResult = "pinned";
  pinCalls.length = 0;
  mirrorCalls.length = 0;
  listedDirs.length = 0;
  mkdirCalls.length = 0;
  copyCalls.length = 0;
  copyResult = [];
  copyResultQueue = [];
  copyError = null;
  tasks = { undone: [], done: [] };
  tasksError = null;
  notified.length = 0;
  embyRefreshes = 0;
  organized.length = 0;
  removeCalls.length = 0;
  removeResult = "removed";
  driveChildren = {};
  replaceTasks([]);
  now = 1_800_000_000_000;
  writeKv(KEY.offlineFollowups, []);
  replaceAccounts([drive, olAccount]);
  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local/media", mounts: { acc: "/115" } } });
});

after(async () => {
  await __test_resetCopy();
  setCopyServiceDeps(null);
  writeKv(KEY.offlineFollowups, []);
  replaceAccounts(baseline.accounts);
  replaceTasks(baseline.tasks);
  patchAppSettings({ openlistCopy: baseline.openlistCopy });
});

/* ------------------------------- 登记 ------------------------------- */

test("登记：算好 OpenList 目标目录，按源路径的层级摆", async () => {
  await seed(["/tv/某剧/S01/E01.mkv"]);
  const [c] = listCopies();
  assert.equal(c.account, "acc");
  assert.equal(c.srcDir, "/tv/某剧/S01");
  assert.equal(c.name, "E01.mkv");
  assert.equal(c.dstDir, "/local/media/某剧/S01", "目录层级原样搬过去，不平铺");
  assert.equal(c.stage, "waiting");
  assert.equal(c.status, "pending");
});

test("登记：没配好 / 这个账号没挂载根，都不抛也不入队", async () => {
  patchAppSettings({ openlistCopy: undefined });
  await seed();
  assert.equal(listCopies().length, 0, "没配置就当没开");

  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local/media", mounts: { 别的账号: "/x" } } });
  await seed();
  assert.equal(listCopies().length, 0, "这个账号没填挂载根");
});

test("登记：同一个来源 + 同一个目标不重复排，目标不同的两条都留", async () => {
  await seed(["/tv/某剧/S01/E01.mkv"]);
  await seed(["/tv/某剧/S01/E01.mkv"]);
  assert.equal(listCopies().length, 1);
  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E01.mkv"], dstDir: "/local/backup", trigger: "manual" });
  await stopCopyWatcher();
  assert.equal(listCopies().length, 2, "换了目标就是另一件事");
});

test("登记：刚复制完的同一条 24 小时内不重排（监控重来一轮会再报一遍）", async () => {
  await seed(["/tv/某剧/S01/E01.mkv"]);
  names = { "/115/tv/某剧/S01": ["E01.mkv"], "/local/media/某剧/S01": [] };
  copyResult = [olTask({ id: "tid1" })];
  await tickCopies();
  tasks = { undone: [], done: [olTask({ id: "tid1", state: 2, endedAt: now })] };
  await tickCopies();
  assert.equal(listCopies()[0].status, "done");

  await seed(["/tv/某剧/S01/E01.mkv"]);
  assert.equal(listCopies().length, 1, "刚办完，不重排");
});

/* ------------------------------- 阶段一：等可见、提交 ------------------------------- */

test("刚登记的先晾一会儿：同目录的兄弟文件凑一批再提交", async () => {
  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E01.mkv"], rootPath: "/tv", trigger: "monitor" });
  await stopCopyWatcher();
  names = { "/115/tv/某剧/S01": ["E01.mkv", "E02.mkv"], "/local/media/某剧/S01": [] };
  await tickCopies();
  assert.equal(copyCalls.length, 0, "刚登记就提交的话，后面的兄弟文件只能各发各的");

  now += 5_000;
  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E02.mkv"], rootPath: "/tv", trigger: "monitor" });
  await stopCopyWatcher();
  now += 30_000;
  copyResult = [olTask({ id: "a" }), olTask({ id: "b" })];
  await tickCopies();
  assert.equal(copyCalls.length, 1, "两条并成一次提交");
  assert.deepEqual([...copyCalls[0].names].sort(), ["E01.mkv", "E02.mkv"]);
  assert.deepEqual(listCopies().map((c) => c.copyTaskId).sort(), ["a", "b"], "按下标各认各的任务");
});

test("产物还没出现：等，不算失败；满 10 轮才作废", async () => {
  await seed();
  names = { "/115/tv/某剧/S01": ["别的东西"] };
  for (let i = 1; i <= 9; i++) {
    await tickCopies();
    const [c] = listCopies();
    assert.equal(c.status, "pending", `第 ${i} 轮还该在等`);
    assert.equal(c.waits, i);
  }
  await tickCopies();
  const [c] = listCopies();
  assert.equal(c.status, "failed");
  assert.match(c.detail, /始终没有出现「E01.mkv」/);
  assert.equal(copyCalls.length, 0);
});

test("源目录在 OpenList 里压根不存在：第一轮就失败，不白等 10 轮", async () => {
  await seed();
  listError = new OpenlistError("object not found", 500, false);
  await tickCopies();
  const [c] = listCopies();
  assert.equal(c.status, "failed");
  assert.match(c.detail, /检查一下账号 acc 的挂载根/);
});

test("列目录是连不上（不是「不存在」）：按重试算，3 次才作废", async () => {
  await seed();
  listError = new OpenlistError("connect ECONNREFUSED", undefined, true);
  await tickCopies();
  assert.match(listCopies()[0].detail, /稍后重试（1\/3）/);
  await tickCopies();
  await tickCopies();
  assert.equal(listCopies()[0].status, "failed");
});

test("目标里已经有同名的：跳过，不提交也不覆盖", async () => {
  await seed();
  names = { "/115/tv/某剧/S01": ["E01.mkv"], "/local/media/某剧/S01": ["E01.mkv"] };
  await tickCopies();
  const [c] = listCopies();
  assert.equal(c.status, "skipped");
  assert.match(c.detail, /已经有「E01.mkv」了/);
  assert.equal(copyCalls.length, 0);
});

test("提交前先建目标目录：/fs/copy 不会自己建", async () => {
  await seed();
  names = { "/115/tv/某剧/S01": ["E01.mkv"] };
  copyResult = [olTask({ id: "tid1" })];
  await tickCopies();
  assert.deepEqual(mkdirCalls, ["/local/media/某剧/S01"]);
  assert.deepEqual(copyCalls, [{ srcDir: "/115/tv/某剧/S01", dstDir: "/local/media/某剧/S01", names: ["E01.mkv"] }]);
  assert.equal(listCopies()[0].stage, "copying");
});

test("目标目录不同的两条不合批", async () => {
  await seed(["/tv/A/S01/E01.mkv", "/tv/B/S01/E01.mkv"]);
  names = { "/115/tv/A/S01": ["E01.mkv"], "/115/tv/B/S01": ["E01.mkv"] };
  copyResult = [olTask({ id: "x" })];
  await tickCopies();
  assert.equal(copyCalls.length, 2);
  assert.deepEqual(copyCalls.map((c) => c.dstDir).sort(), ["/local/media/A/S01", "/local/media/B/S01"]);
});

test("同存储秒完成（没有任务可盯）：直接算办完", async () => {
  await seed();
  names = { "/115/tv/某剧/S01": ["E01.mkv"] };
  copyResult = [];
  await tickCopies();
  const [c] = listCopies();
  assert.equal(c.status, "done");
  assert.deepEqual(notified.at(-1), { type: "copy-done", names: ["E01.mkv"], target: "/local/media/某剧/S01", source: "网盘监控" });
});

test("提交复制报错：重试 3 次后作废", async () => {
  await seed();
  names = { "/115/tv/某剧/S01": ["E01.mkv"] };
  copyError = new Error("OpenList /api/fs/copy 失败：HTTP 500");
  await tickCopies();
  assert.match(listCopies()[0].detail, /稍后重试（1\/3）/);
  await tickCopies();
  await tickCopies();
  const [c] = listCopies();
  assert.equal(c.status, "failed");
  assert.match(c.detail, /HTTP 500/);
});

/* ------------------------------- 阶段二：盯任务 ------------------------------- */

async function submitted(): Promise<void> {
  await seed();
  names = { "/115/tv/某剧/S01": ["E01.mkv"] };
  copyResult = [olTask({ id: "tid1" })];
  await tickCopies();
  listedDirs.length = 0;
}

test("复制中：报进度，不再列源目录", async () => {
  await submitted();
  tasks = { undone: [olTask({ id: "tid1", progress: 40 })], done: [] };
  await tickCopies();
  assert.match(listCopies()[0].detail, /OpenList 复制中 40%/);
  assert.equal(listedDirs.length, 0, "盯任务阶段不该再列目录");
});

test("父任务结束、子任务还在跑：按源路径的尾巴认出来，仍算复制中", async () => {
  await submitted();
  tasks = {
    undone: [olTask({ id: "child1", name: "copy [/115](/tv/某剧/S01/E01.mkv) to [/local](/media)", progress: 10 })],
    done: [olTask({ id: "tid1", state: 2, endedAt: now })],
  };
  await tickCopies();
  assert.equal(listCopies()[0].status, "pending");
  assert.match(listCopies()[0].detail, /OpenList 复制中 10%/);
});

test("全部结束且成功：done 并通知", async () => {
  await submitted();
  tasks = { undone: [], done: [olTask({ id: "tid1", state: 2, endedAt: now })] };
  await tickCopies();
  const [c] = listCopies();
  assert.equal(c.status, "done");
  assert.equal(c.detail, "复制完成", "目标目录界面上已经写着，说明里不再重复");
  assert.deepEqual(notified.at(-1), { type: "copy-done", names: ["E01.mkv"], target: "/local/media/某剧/S01", source: "网盘监控" });
});

test("OpenList 报失败：原文带出来并通知", async () => {
  await submitted();
  tasks = { undone: [], done: [olTask({ id: "tid1", state: 7, error: "磁盘空间不足", endedAt: now })] };
  await tickCopies();
  const [c] = listCopies();
  assert.equal(c.status, "failed");
  assert.match(c.detail, /磁盘空间不足/);
  assert.equal(notified.at(-1)?.type, "copy-failed");
});

test("done 里提交之前的陈年同名任务不算这次的", async () => {
  await submitted();
  // 名字带着这条的特征（尾巴两段），光看名字会认成自己人；只有 endedAt 早于提交时间能把它滤掉
  const stale = { id: "上次复制留下的", name: "copy [/115](/tv/某剧/S01/E01.mkv) to [/local](/media)", state: 2, endedAt: now - 3600_000 };
  tasks = { undone: [], done: [olTask(stale)] };
  await tickCopies();
  assert.equal(listCopies()[0].status, "pending", "只有陈年任务，不能当成这次的结果");
  assert.match(listCopies()[0].detail, /暂时没找到/);

  // 同一条任务，结束时间换成这次提交之后：这才是这次的结果
  tasks = { undone: [], done: [olTask({ ...stale, endedAt: now })] };
  await tickCopies();
  assert.equal(listCopies()[0].status, "done");
});

test("任务列表里找不到：3 轮后作废；换阶段时 waits 已清零", async () => {
  await seed();
  names = { "/115/tv/某剧/S01": ["别的东西"] };
  await tickCopies();
  assert.equal(listCopies()[0].waits, 1);
  names = { "/115/tv/某剧/S01": ["E01.mkv"] };
  copyResult = [olTask({ id: "tid1" })];
  await tickCopies();
  assert.equal(listCopies()[0].waits, 0, "进了盯任务阶段，等可见的计数清零");

  for (let i = 1; i <= 2; i++) {
    await tickCopies();
    assert.equal(listCopies()[0].status, "pending");
    assert.equal(listCopies()[0].misses, i);
  }
  await tickCopies();
  assert.equal(listCopies()[0].status, "failed");
});

test("任务列表拿不到：这一轮一个字段都不改", async () => {
  await submitted();
  const before = JSON.stringify(listCopies());
  tasksError = new Error("OpenList 连不上");
  await tickCopies();
  assert.equal(JSON.stringify(listCopies()), before);
  assert.match(getCopyWatcherStatus().lastError ?? "", /连不上/);
});

/* ------------------------------- 重试、删除、接管 ------------------------------- */

test("重试：计数清零，回到等可见那一步", async () => {
  await seed();
  names = { "/115/tv/某剧/S01": ["别的东西"] };
  for (let i = 0; i < 10; i++) await tickCopies();
  let [c] = listCopies();
  assert.equal(c.status, "failed");

  names = { "/115/tv/某剧/S01": ["E01.mkv"] };
  copyResult = [olTask({ id: "tid1" })];
  const again = retryCopy(c.id);
  assert.equal(again.status, "pending");
  assert.equal(again.waits, 0);
  now += 30_000;
  await tickCopies();
  [c] = listCopies();
  assert.equal(c.stage, "copying");
});

test("还在跑的不让重试；不存在的 404", async () => {
  await seed();
  const [c] = listCopies();
  assert.throws(() => retryCopy(c.id), /还在队列里跑/);
  assert.throws(() => retryCopy("没这个 id"), /不存在/);
  assert.throws(() => dropCopy("没这个 id"), /不存在/);
});

test("删掉：从队列里去掉", async () => {
  await seed();
  const [c] = listCopies();
  dropCopy(c.id);
  assert.equal(listCopies().length, 0);
});

test("升级：接管云下载里已经提交给 OpenList 的复制", () => {
  writeKv(KEY.offlineFollowups, [
    {
      kind: "openlist-copy", infoHash: "h1", account: "acc", taskId: "", subPath: "", name: "Show.S01",
      addedAt: now - 60_000, status: "pending", detail: "OpenList 复制中", attempts: 0, misses: 0,
      copyDstDir: "/local/dl", copyTaskId: "tid9", copySubmittedAt: now - 30_000,
    },
    {
      kind: "openlist-copy", infoHash: "h2", account: "acc", taskId: "", subPath: "", name: "还在下",
      addedAt: now, status: "pending", detail: "等待 115 下载完成", attempts: 0, misses: 0, copyDstDir: "/local/dl",
    },
  ]);
  const n = adoptLegacyCopyFollowups();
  assert.equal(n, 1, "只搬已经提交出去的那条");
  const [c] = listCopies();
  assert.equal(c.stage, "copying");
  assert.equal(c.copyTaskId, "tid9");
  assert.equal(c.dstDir, "/local/dl");
  const left = readKv<Array<{ name: string }>>(KEY.offlineFollowups) ?? [];
  assert.deepEqual(left.map((f) => f.name), ["还在下"], "还在等 115 的留在回执里，下完走新路");
});

/* ------------------------------- 复制完之后 ------------------------------- */

test("复制成功：通知 Emby 刷新", async () => {
  await submitted();
  tasks = { undone: [], done: [olTask({ id: "tid1", state: 2, endedAt: now })] };
  await tickCopies();
  assert.equal(embyRefreshes, 1);
});

test("目标落在某个 OpenList 任务的目录里：按它的策略自动整理，trigger 是 copy", async () => {
  replaceTasks([
    { id: "olt", account: "ol", accountType: "openlist", originPath: "/local/media", targetPath: "media", strmPrefix: "/mnt" },
  ]);
  await submitted();
  tasks = { undone: [], done: [olTask({ id: "tid1", state: 2, endedAt: now })] };
  await tickCopies();
  assert.deepEqual(organized, [{ taskId: "olt", paths: ["某剧/S01/E01.mkv"], trigger: "copy" }]);
});

test("目标不在任何 OpenList 任务下：不整理", async () => {
  replaceTasks([
    { id: "olt", account: "ol", accountType: "openlist", originPath: "/别处", targetPath: "media", strmPrefix: "/mnt" },
  ]);
  await submitted();
  tasks = { undone: [], done: [olTask({ id: "tid1", state: 2, endedAt: now })] };
  await tickCopies();
  assert.equal(organized.length, 0);
});

test("删源：目标里看得见才删，看不见就留着并说明", async () => {
  enqueueCopy({
    account: "acc",
    sources: [{ path: "/tv/某剧/S01/E01.mkv", nodeId: "n1" }],
    rootPath: "/tv",
    trigger: "monitor",
    deleteSource: true,
  });
  await stopCopyWatcher();
  now += 30_000;
  names = { "/115/tv/某剧/S01": ["E01.mkv"], "/local/media/某剧/S01": [] };
  copyResult = [olTask({ id: "tid1" })];
  await tickCopies();

  // 目标里还看不见：不删
  tasks = { undone: [], done: [olTask({ id: "tid1", state: 2, endedAt: now })] };
  await tickCopies();
  assert.equal(removeCalls.length, 0);
  assert.match(listCopies()[0].detail, /目标里没看到这一份，源文件没删/);
});

test("删源：目标里确认看得见就删，节点 id 一起带过去核对", async () => {
  enqueueCopy({
    account: "acc",
    sources: [{ path: "/tv/某剧/S01/E01.mkv", nodeId: "n1" }],
    rootPath: "/tv",
    trigger: "monitor",
    deleteSource: true,
  });
  await stopCopyWatcher();
  now += 30_000;
  names = { "/115/tv/某剧/S01": ["E01.mkv"], "/local/media/某剧/S01": [] };
  copyResult = [olTask({ id: "tid1" })];
  await tickCopies();
  names["/local/media/某剧/S01"] = ["E01.mkv"];
  tasks = { undone: [], done: [olTask({ id: "tid1", state: 2, endedAt: now })] };
  await tickCopies();
  assert.deepEqual(removeCalls, [{ account: "acc", path: "/tv/某剧/S01/E01.mkv", nodeId: "n1" }]);
  assert.match(listCopies()[0].detail, /网盘上那份已删，本地 strm 也删了/);
  assert.deepEqual(mirrorCalls, [{ account: "acc", path: "/tv/某剧/S01/E01.mkv", isDir: undefined }], "删了网盘上那份就把本地对应的 strm 一起删掉");
});

test("删源：源路径上换成了别的文件（整理挪过）就不删", async () => {
  removeResult = "changed";
  enqueueCopy({
    account: "acc",
    sources: [{ path: "/tv/某剧/S01/E01.mkv", nodeId: "n1" }],
    rootPath: "/tv",
    trigger: "monitor",
    deleteSource: true,
  });
  await stopCopyWatcher();
  now += 30_000;
  names = { "/115/tv/某剧/S01": ["E01.mkv"], "/local/media/某剧/S01": [] };
  copyResult = [olTask({ id: "tid1" })];
  await tickCopies();
  names["/local/media/某剧/S01"] = ["E01.mkv"];
  tasks = { undone: [], done: [olTask({ id: "tid1", state: 2, endedAt: now })] };
  await tickCopies();
  assert.match(listCopies()[0].detail, /换成了别的文件，没删/);
  assert.equal(mirrorCalls.length, 0, "网盘上没删，本地也不能动");
});

test("没开删源：一次都不调删除", async () => {
  await submitted();
  names["/local/media/某剧/S01"] = ["E01.mkv"];
  tasks = { undone: [], done: [olTask({ id: "tid1", state: 2, endedAt: now })] };
  await tickCopies();
  assert.equal(removeCalls.length, 0);
});

/* ------------------------------- 评审补的那些 ------------------------------- */

test("一轮里成了好几条：通知合成一条，不是一个文件一条", async () => {
  await seed(["/tv/某剧/S01/E01.mkv", "/tv/某剧/S01/E02.mkv", "/tv/某剧/S01/E03.mkv"]);
  names = { "/115/tv/某剧/S01": ["E01.mkv", "E02.mkv", "E03.mkv"], "/local/media/某剧/S01": [] };
  copyResult = [];
  await tickCopies();
  const done = notified.filter((e) => e.type === "copy-done");
  assert.equal(done.length, 1, "三条只发一条通知");
  assert.deepEqual((done[0] as { names: string[] }).names.sort(), ["E01.mkv", "E02.mkv", "E03.mkv"]);
});

test("登记会说清楚排上没有：没配挂载根时返回原因", async () => {
  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local/media", mounts: {} } });
  const r = enqueueCopy({ account: "acc", sources: ["/tv/a.mkv"], trigger: "share" });
  assert.equal(r.queued, 0);
  assert.match(r.skipped ?? "", /挂载根/);
  const ok = () => {
    patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local/media", mounts: { acc: "/115" } } });
    return enqueueCopy({ account: "acc", sources: ["/tv/a.mkv"], trigger: "share" });
  };
  assert.equal(ok().queued, 1);
  await stopCopyWatcher();
});

test("全局目标目录空着、任务上填了：照样能排（那个是默认值，不是必填）", async () => {
  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "", mounts: { acc: "/115" } } });
  const r = enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E01.mkv"], rootPath: "/tv", dstDir: "/local/别处", trigger: "share" });
  await stopCopyWatcher();
  assert.equal(r.queued, 1);
  assert.equal(listCopies()[0].dstDir, "/local/别处/某剧/S01");
});

test("重试之后目标里还有同名的：如实报失败，不当「已经复制过」跳过", async () => {
  await seed();
  names = { "/115/tv/某剧/S01": ["E01.mkv"], "/local/media/某剧/S01": ["E01.mkv"] };
  await tickCopies();
  assert.equal(listCopies()[0].status, "skipped");

  retryCopy(listCopies()[0].id);
  await stopCopyWatcher();
  now += 30_000;
  await tickCopies();
  const [c] = listCopies();
  assert.equal(c.status, "failed");
  assert.match(c.detail, /可能是上次没复制完的残留/);
});

test("两条记录的任务名互相包含：各认各的，不抢结果", async () => {
  await seed(["/tv/某剧/S01/E01.mkv", "/tv/别的剧/S01/E01.mkv"]);
  names = {
    "/115/tv/某剧/S01": ["E01.mkv"],
    "/115/tv/别的剧/S01": ["E01.mkv"],
    "/local/media/某剧/S01": [],
    "/local/media/别的剧/S01": [],
  };
  copyResultQueue = [[olTask({ id: "tA" })], [olTask({ id: "tB" })]];
  await tickCopies();
  const idOf = (dir: string) => listCopies().find((c) => c.srcDir === dir)?.copyTaskId;
  assert.ok(idOf("/tv/某剧/S01") && idOf("/tv/别的剧/S01"), "两条各拿各的任务号");

  // 一条失败了，另一条还在跑：不能被连累
  tasks = {
    undone: [olTask({ id: idOf("/tv/别的剧/S01")!, name: "copy [/115](/tv/别的剧/S01/E01.mkv) to [/local](/media)", progress: 5 })],
    done: [olTask({ id: idOf("/tv/某剧/S01")!, name: "copy [/115](/tv/某剧/S01/E01.mkv) to [/local](/media)", state: 7, error: "炸了", endedAt: now })],
  };
  await tickCopies();
  const statusOf = (dir: string) => listCopies().find((c) => c.srcDir === dir)?.status;
  assert.equal(statusOf("/tv/某剧/S01"), "failed");
  assert.equal(statusOf("/tv/别的剧/S01"), "pending", "另一条还在跑，不能被连累");
});

test("接管来的记录：不按名字乱认任务，失败了也不让重试", async () => {
  writeKv(KEY.offlineFollowups, [
    {
      kind: "openlist-copy", infoHash: "h1", account: "acc", taskId: "", subPath: "", name: "Show.S01",
      addedAt: now - 60_000, status: "pending", detail: "OpenList 复制中", attempts: 0, misses: 0,
      copyDstDir: "/local/dl", copyTaskId: "tid9", copySubmittedAt: now - 30_000,
    },
  ]);
  adoptLegacyCopyFollowups();
  await stopCopyWatcher();

  // 名字一样的别的任务不该被它认走：只认自己的任务号
  tasks = { undone: [], done: [olTask({ id: "别的任务", name: "copy [/115](/x/Show.S01) to [/y](/z)", state: 2, endedAt: now })] };
  await tickCopies();
  assert.equal(listCopies()[0].status, "pending");

  // 三轮都找不到自己的任务 → 失败；这时也不让重试（没有网盘路径，无从下手）
  await tickCopies();
  await tickCopies();
  const [c] = listCopies();
  assert.equal(c.status, "failed");
  assert.throws(() => retryCopy(c.id), /升级前接管/);
});

test("别人在这一轮里新登记的记录不会被抹掉", async () => {
  await seed(["/tv/某剧/S01/E01.mkv"]);
  names = { "/115/tv/某剧/S01": ["E01.mkv"], "/local/media/某剧/S01": [] };
  copyResult = [olTask({ id: "tid1" })];
  // 列目录的当口，监控那边又排进来一条（真实场景里两个循环就是这么交错的）：
  // tickCopies 一进去就 await，这里的登记正好落在它读队列之后、写回之前
  const tick = tickCopies();
  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S02/E01.mkv"], rootPath: "/tv", trigger: "monitor" });
  await stopCopyWatcher();
  await tick;
  assert.equal(listCopies().length, 2, "新排进来的那条还在");
});

test("删源：目录只确认名字在目标里不够，子项少了就不删", async () => {
  enqueueCopy({
    account: "acc",
    sources: [{ path: "/tv/某剧/S01", isDir: true, nodeId: "n1" }],
    rootPath: "/tv",
    trigger: "share",
    deleteSource: true,
  });
  await stopCopyWatcher();
  now += 30_000;
  names = { "/115/tv/某剧": ["S01"], "/local/media/某剧": [] };
  copyResult = [olTask({ id: "tid1" })];
  await tickCopies();
  names["/local/media/某剧"] = ["S01"];
  names["/local/media/某剧/S01"] = ["E01.mkv"]; // 目标里只搬过去一集
  driveChildren["/tv/某剧/S01"] = ["E01.mkv", "E02.mkv"]; // 源里有两集
  tasks = { undone: [], done: [olTask({ id: "tid1", state: 2, endedAt: now })] };
  await tickCopies();
  assert.equal(removeCalls.length, 0, "只搬过去一半就不能删源");
  assert.match(listCopies()[0].detail, /目标里少了 1 项/);
});

/* ------------------------------- 真机验证之后补的 ------------------------------- */

test("源目录刚在网盘上改过名（OpenList 父目录缓存还是旧的）：从挂载根往下刷新一遍，照常提交，不报「检查挂载根」", async () => {
  await seed();
  staleDirs = new Set(["/115/tv/某剧/S01"]);
  names = { "/115/tv/某剧/S01": ["E01.mkv"], "/local/media/某剧/S01": [] };
  copyResult = [olTask({ id: "tid1" })];
  await tickCopies();
  const [c] = listCopies();
  assert.equal(c.stage, "copying", c.detail);
  assert.deepEqual(listedDirs.slice(0, 5), ["/115/tv/某剧/S01", "/115", "/115/tv", "/115/tv/某剧", "/115/tv/某剧/S01"], "找不到就从挂载根逐级刷新再试一次");
  assert.equal(copyCalls.length, 1);
});

test("挂载根本身就不在 OpenList 里：第一轮失败，说清楚是挂载根", async () => {
  await seed();
  goneDirs = new Set(["/115", "/115/tv/某剧/S01"]);
  await tickCopies();
  const [c] = listCopies();
  assert.equal(c.status, "failed");
  assert.match(c.detail, /OpenList 里没有挂载根 \/115，检查一下账号 acc 的挂载根/);
});

test("挂载根在、源目录刷新完还是没有（网盘上被挪走 / 改名了）：按还没出现等，满 10 轮才失败", async () => {
  await seed();
  goneDirs = new Set(["/115/tv/某剧/S01"]);
  for (let i = 1; i <= 9; i++) {
    await tickCopies();
    const [c] = listCopies();
    assert.equal(c.status, "pending", `第 ${i} 轮还在等：整理可能正把它挪走，队列里的路径会被改写`);
    assert.match(c.detail, new RegExp(`OpenList 里还看不到 /115/tv/某剧/S01（${i}/10）`));
  }
  await tickCopies();
  const [c] = listCopies();
  assert.equal(c.status, "failed");
  assert.match(c.detail, /始终找不到 \/115\/tv\/某剧\/S01：网盘上这个目录可能被挪走或改名了/);
});

test("目录待办和它里面的文件待办同时在队列里：目录先等里面的复制完，然后按「目标里已有」跳过，不会两个任务写同一个文件", async () => {
  enqueueCopy({ account: "acc", sources: [{ path: "/tv/某剧", isDir: true }], rootPath: "/tv", taskId: "t1", trigger: "monitor" });
  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E01.mkv"], rootPath: "/tv", taskId: "t1", trigger: "follow" });
  await stopCopyWatcher();
  now += 30_000;
  names = { "/115/tv": ["某剧"], "/115/tv/某剧/S01": ["E01.mkv"], "/local/media": [], "/local/media/某剧/S01": [] };
  copyResult = [olTask({ id: "f1" })];
  await tickCopies();
  const dir = () => listCopies().find((c) => c.name === "某剧")!;
  const file = () => listCopies().find((c) => c.name === "E01.mkv")!;
  assert.equal(copyCalls.length, 1, "只提交了文件");
  assert.deepEqual(copyCalls[0].names, ["E01.mkv"]);
  assert.equal(dir().stage, "waiting");
  assert.match(dir().detail, /等目录里的 1 个条目先复制完/);
  assert.equal(dir().waits, 0, "压着不算等待轮数");

  // 文件复制完了，目标里已经有这个目录
  tasks = { undone: [], done: [olTask({ id: "f1", state: 2, endedAt: now })] };
  names["/local/media"] = ["某剧"];
  await tickCopies();
  assert.equal(file().status, "done");
  await tickCopies();
  assert.equal(dir().status, "skipped");
  assert.equal(copyCalls.length, 1, "目录没再提交一次");
});

test("外面的目录已经提交在复制：里面新来的文件等它复制完再看", async () => {
  enqueueCopy({ account: "acc", sources: [{ path: "/tv/某剧", isDir: true }], rootPath: "/tv", taskId: "t1", trigger: "monitor" });
  await stopCopyWatcher();
  now += 30_000;
  names = { "/115/tv": ["某剧"], "/local/media": [] };
  copyResult = [olTask({ id: "d1", name: "copy [/115](/tv/某剧) to [/local](/media)" })];
  await tickCopies();
  assert.equal(listCopies()[0].stage, "copying");

  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E02.mkv"], rootPath: "/tv", taskId: "t1", trigger: "follow" });
  await stopCopyWatcher();
  now += 30_000;
  tasks = { undone: [olTask({ id: "d1", name: "copy [/115](/tv/某剧) to [/local](/media)" })], done: [] };
  names["/115/tv/某剧/S01"] = ["E02.mkv"];
  await tickCopies();
  const inner = listCopies().find((c) => c.name === "E02.mkv")!;
  assert.equal(inner.stage, "waiting");
  assert.match(inner.detail, /等上层目录「某剧」先复制完/);
  assert.equal(copyCalls.length, 1);
});

test("任务开着会直接执行的自动整理：先压着不提交，整理办完放行", async () => {
  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E01.mkv"], rootPath: "/tv", taskId: "t1", trigger: "share", holdForOrganize: true });
  await stopCopyWatcher();
  now += 30_000;
  names = { "/115/tv/某剧/S01": ["E01.mkv"], "/local/media/某剧/S01": [] };
  copyResult = [olTask({ id: "tid1" })];
  await tickCopies();
  assert.equal(copyCalls.length, 0, "整理还没办完，先不复制");
  assert.match(listCopies()[0].detail, /等自动整理先在网盘上改完名再复制/);

  assert.equal(releaseCopyHolds("t1", now, now), 1);
  await tickCopies();
  assert.equal(copyCalls.length, 1);
});

test("等整理有兜底：整理一直没回来（建 run 失败之类），到时间照样复制", async () => {
  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E01.mkv"], rootPath: "/tv", taskId: "t1", trigger: "share", holdForOrganize: true });
  await stopCopyWatcher();
  names = { "/115/tv/某剧/S01": ["E01.mkv"], "/local/media/某剧/S01": [] };
  copyResult = [olTask({ id: "tid1" })];
  now += 9 * 60_000;
  await tickCopies();
  assert.equal(copyCalls.length, 0);
  now += 2 * 60_000;
  await tickCopies();
  assert.equal(copyCalls.length, 1);
});

test("要删源又没带节点 id（追更、115 转存）：提交时钉住，删之前按它核对", async () => {
  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E01.mkv"], rootPath: "/tv", trigger: "follow", deleteSource: true });
  await stopCopyWatcher();
  now += 30_000;
  names = { "/115/tv/某剧/S01": ["E01.mkv"], "/local/media/某剧/S01": [] };
  copyResult = [olTask({ id: "tid1" })];
  pinResult = "n42";
  await tickCopies();
  assert.deepEqual(pinCalls, ["/tv/某剧/S01/E01.mkv"]);
  assert.equal(listCopies()[0].nodeId, "n42");
  names["/local/media/某剧/S01"] = ["E01.mkv"];
  tasks = { undone: [], done: [olTask({ id: "tid1", state: 2, endedAt: now })] };
  await tickCopies();
  assert.deepEqual(removeCalls, [{ account: "acc", path: "/tv/某剧/S01/E01.mkv", nodeId: "n42" }]);
});

test("提交时网盘上找不到这个节点：照样复制，但复制完不删源并说明原因", async () => {
  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E01.mkv"], rootPath: "/tv", trigger: "follow", deleteSource: true });
  await stopCopyWatcher();
  now += 30_000;
  names = { "/115/tv/某剧/S01": ["E01.mkv"], "/local/media/某剧/S01": [] };
  copyResult = [olTask({ id: "tid1" })];
  pinResult = null;
  await tickCopies();
  assert.equal(copyCalls.length, 1);
  names["/local/media/某剧/S01"] = ["E01.mkv"];
  tasks = { undone: [], done: [olTask({ id: "tid1", state: 2, endedAt: now })] };
  await tickCopies();
  const [c] = listCopies();
  assert.equal(c.status, "done");
  assert.equal(removeCalls.length, 0);
  assert.match(c.detail, /核对不了，源文件没删/);
});

test("钉节点时网盘接口报错：这一轮不提交，按重试算", async () => {
  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E01.mkv"], rootPath: "/tv", trigger: "follow", deleteSource: true });
  await stopCopyWatcher();
  now += 30_000;
  names = { "/115/tv/某剧/S01": ["E01.mkv"], "/local/media/某剧/S01": [] };
  pinResult = new Error("ECONNRESET");
  await tickCopies();
  assert.equal(copyCalls.length, 0);
  assert.match(listCopies()[0].detail, /核对网盘上的源文件失败，稍后重试（1\/3）/);
});

test("一轮办完的落在好几个目录：通知里写第一个目录再说一共几个", async () => {
  await seed(["/tv/某剧/S01/E01.mkv", "/tv/某剧/S02/E01.mkv"]);
  names = { "/115/tv/某剧/S01": ["E01.mkv"], "/115/tv/某剧/S02": ["E01.mkv"] };
  copyResult = [];
  await tickCopies();
  const done = notified.filter((e) => e.type === "copy-done") as Array<{ target: string }>;
  assert.equal(done.length, 1);
  assert.match(done[0].target, /^\/local\/media\/某剧\/S0[12] 等 2 个目录$/);
});

/* ------------------------------- 同类型的多个账号 ------------------------------- */

/** 第二个 115 账号，OpenList 里挂在 /115-b */
function withSecond115(): void {
  replaceAccounts([drive, { accountType: "115", name: "acc2", cookie: "c2" }, olAccount]);
  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local/media", mounts: { acc: "/115", acc2: "/115-b" } } });
}

test("两个 115 账号：各按自己的挂载根找源目录，分开提交", async () => {
  withSecond115();
  enqueueCopy({ account: "acc", sources: ["/tv/A/E01.mkv"], rootPath: "/tv", trigger: "monitor" });
  enqueueCopy({ account: "acc2", sources: ["/剧集/B/E01.mkv"], rootPath: "/剧集", trigger: "monitor" });
  await stopCopyWatcher();
  now += 30_000;
  names = { "/115/tv/A": ["E01.mkv"], "/115-b/剧集/B": ["E01.mkv"] };
  copyResultQueue = [[olTask({ id: "a" })], [olTask({ id: "b" })]];
  await tickCopies();
  assert.deepEqual(
    copyCalls.map((c) => [c.srcDir, c.dstDir]).sort(),
    [
      ["/115-b/剧集/B", "/local/media/B"],
      ["/115/tv/A", "/local/media/A"],
    ],
  );
  assert.ok(listCopies().every((c) => c.stage === "copying"));
});

test("两个账号里有同一集、目标又是同一个：只提交一份，另一份等它复制完再按「目标里已有」跳过", async () => {
  withSecond115();
  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E01.mkv"], rootPath: "/tv", trigger: "follow" });
  enqueueCopy({ account: "acc2", sources: ["/tv/某剧/S01/E01.mkv"], rootPath: "/tv", trigger: "follow" });
  await stopCopyWatcher();
  now += 30_000;
  names = { "/115/tv/某剧/S01": ["E01.mkv"], "/115-b/tv/某剧/S01": ["E01.mkv"], "/local/media/某剧/S01": [] };
  copyResult = [olTask({ id: "t1" })];
  await tickCopies();
  assert.equal(copyCalls.length, 1, "两份一起提交就是两个 OpenList 任务写同一个文件");
  const first = listCopies().find((c) => c.stage === "copying")!;
  const second = listCopies().find((c) => c.stage === "waiting")!;
  assert.match(second.detail, new RegExp(`等另一份同名的先复制完（账号 ${first.account} 的 /tv/某剧/S01/E01.mkv）`));

  // 还在复制：另一份接着等
  tasks = { undone: [olTask({ id: "t1", progress: 50 })], done: [] };
  await tickCopies();
  assert.equal(copyCalls.length, 1);

  // 复制完了，目标里有了：另一份按「已存在」跳过，不再提交
  names["/local/media/某剧/S01"] = ["E01.mkv"];
  tasks = { undone: [], done: [olTask({ id: "t1", state: 2, endedAt: now })] };
  await tickCopies();
  await tickCopies();
  assert.equal(copyCalls.length, 1);
  const byId = new Map(listCopies().map((c) => [c.id, c]));
  assert.equal(byId.get(first.id)?.status, "done");
  assert.equal(byId.get(second.id)?.status, "skipped");
});

test("同一个目标在复制的那份失败了：另一份接着提交", async () => {
  withSecond115();
  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E01.mkv"], rootPath: "/tv", trigger: "follow" });
  enqueueCopy({ account: "acc2", sources: ["/tv/某剧/S01/E01.mkv"], rootPath: "/tv", trigger: "follow" });
  await stopCopyWatcher();
  now += 30_000;
  names = { "/115/tv/某剧/S01": ["E01.mkv"], "/115-b/tv/某剧/S01": ["E01.mkv"], "/local/media/某剧/S01": [] };
  copyResultQueue = [[olTask({ id: "t1" })], [olTask({ id: "t2" })]];
  await tickCopies();
  const first = listCopies().find((c) => c.stage === "copying")!;
  tasks = { undone: [], done: [olTask({ id: "t1", state: 7, error: "磁盘空间不足", endedAt: now })] };
  await tickCopies();
  await tickCopies();
  assert.equal(copyCalls.length, 2, "先提交的那份失败了，目标还空着，另一份要顶上");
  assert.notEqual(copyCalls[1].srcDir, copyCalls[0].srcDir);
  assert.equal(listCopies().find((c) => c.id === first.id)?.status, "failed");
});
