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
import {
  __test_resetCopy,
  adoptLegacyCopyFollowups,
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
const listedDirs: string[] = [];
const mkdirCalls: string[] = [];
const copyCalls: Array<{ srcDir: string; dstDir: string; names: string[] }> = [];
let copyResult: OpenlistTaskInfo[] = [];
let copyError: Error | null = null;
let tasks: { undone: OpenlistTaskInfo[]; done: OpenlistTaskInfo[] } = { undone: [], done: [] };
let tasksError: Error | null = null;
const notified: NotifyEvent[] = [];
let embyRefreshes = 0;
const organized: Array<{ taskId: string; paths: string[]; trigger: string }> = [];
const removeCalls: Array<{ account: string; path: string; nodeId?: string }> = [];
let removeResult: "removed" | "missing" | "changed" | "unsupported" = "removed";
/** 队列里「刚登记要晾一会」的门槛：测试里把时钟往前拨，不真等 */
let now = 1_800_000_000_000;

const olTask = (over: Partial<OpenlistTaskInfo>): OpenlistTaskInfo => ({
  id: "tid1", name: "copy [/115](/tv/某剧) to [/local](/media)", state: 1, progress: 0, error: "", endedAt: null, ...over,
});

/** 登记一条，并把时钟拨过「晾一会」的窗口 */
function seed(paths: string[] = ["/tv/某剧/S01/E01.mkv"], over: Partial<Parameters<typeof enqueueCopy>[0]> = {}): void {
  enqueueCopy({ account: "acc", sources: paths, rootPath: "/tv", taskId: "t1", trigger: "monitor", ...over });
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
        return names[dir] ?? [];
      },
      mkdir: async (_cfg, dir) => {
        mkdirCalls.push(dir);
      },
      copy: async (_cfg, srcDir, dstDir, ns) => {
        copyCalls.push({ srcDir, dstDir, names: ns });
        if (copyError) throw copyError;
        return copyResult;
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
  });
});

beforeEach(async () => {
  await __test_resetCopy();
  names = {};
  listError = null;
  listedDirs.length = 0;
  mkdirCalls.length = 0;
  copyCalls.length = 0;
  copyResult = [];
  copyError = null;
  tasks = { undone: [], done: [] };
  tasksError = null;
  notified.length = 0;
  embyRefreshes = 0;
  organized.length = 0;
  removeCalls.length = 0;
  removeResult = "removed";
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

test("登记：算好 OpenList 目标目录，按源路径的层级摆", () => {
  seed(["/tv/某剧/S01/E01.mkv"]);
  const [c] = listCopies();
  assert.equal(c.account, "acc");
  assert.equal(c.srcDir, "/tv/某剧/S01");
  assert.equal(c.name, "E01.mkv");
  assert.equal(c.dstDir, "/local/media/某剧/S01", "目录层级原样搬过去，不平铺");
  assert.equal(c.stage, "waiting");
  assert.equal(c.status, "pending");
});

test("登记：没配好 / 这个账号没挂载根，都不抛也不入队", () => {
  patchAppSettings({ openlistCopy: undefined });
  seed();
  assert.equal(listCopies().length, 0, "没配置就当没开");

  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local/media", mounts: { 别的账号: "/x" } } });
  seed();
  assert.equal(listCopies().length, 0, "这个账号没填挂载根");
});

test("登记：同一个来源 + 同一个目标不重复排，目标不同的两条都留", () => {
  seed(["/tv/某剧/S01/E01.mkv"]);
  seed(["/tv/某剧/S01/E01.mkv"]);
  assert.equal(listCopies().length, 1);
  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E01.mkv"], dstDir: "/local/backup", trigger: "manual" });
  assert.equal(listCopies().length, 2, "换了目标就是另一件事");
});

test("登记：刚复制完的同一条 24 小时内不重排（监控重来一轮会再报一遍）", async () => {
  seed(["/tv/某剧/S01/E01.mkv"]);
  names = { "/115/tv/某剧/S01": ["E01.mkv"], "/local/media/某剧/S01": [] };
  copyResult = [olTask({ id: "tid1" })];
  await tickCopies();
  tasks = { undone: [], done: [olTask({ id: "tid1", state: 2, endedAt: now })] };
  await tickCopies();
  assert.equal(listCopies()[0].status, "done");

  seed(["/tv/某剧/S01/E01.mkv"]);
  assert.equal(listCopies().length, 1, "刚办完，不重排");
});

/* ------------------------------- 阶段一：等可见、提交 ------------------------------- */

test("刚登记的先晾一会儿：同目录的兄弟文件凑一批再提交", async () => {
  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E01.mkv"], rootPath: "/tv", trigger: "monitor" });
  names = { "/115/tv/某剧/S01": ["E01.mkv", "E02.mkv"], "/local/media/某剧/S01": [] };
  await tickCopies();
  assert.equal(copyCalls.length, 0, "刚登记就提交的话，后面的兄弟文件只能各发各的");

  now += 5_000;
  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E02.mkv"], rootPath: "/tv", trigger: "monitor" });
  now += 30_000;
  copyResult = [olTask({ id: "a" }), olTask({ id: "b" })];
  await tickCopies();
  assert.equal(copyCalls.length, 1, "两条并成一次提交");
  assert.deepEqual([...copyCalls[0].names].sort(), ["E01.mkv", "E02.mkv"]);
  assert.deepEqual(listCopies().map((c) => c.copyTaskId).sort(), ["a", "b"], "按下标各认各的任务");
});

test("产物还没出现：等，不算失败；满 10 轮才作废", async () => {
  seed();
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
  seed();
  listError = new OpenlistError("object not found", 500, false);
  await tickCopies();
  const [c] = listCopies();
  assert.equal(c.status, "failed");
  assert.match(c.detail, /检查一下账号 acc 的挂载根/);
});

test("列目录是连不上（不是「不存在」）：按重试算，3 次才作废", async () => {
  seed();
  listError = new OpenlistError("connect ECONNREFUSED", undefined, true);
  await tickCopies();
  assert.match(listCopies()[0].detail, /稍后重试（1\/3）/);
  await tickCopies();
  await tickCopies();
  assert.equal(listCopies()[0].status, "failed");
});

test("目标里已经有同名的：跳过，不提交也不覆盖", async () => {
  seed();
  names = { "/115/tv/某剧/S01": ["E01.mkv"], "/local/media/某剧/S01": ["E01.mkv"] };
  await tickCopies();
  const [c] = listCopies();
  assert.equal(c.status, "skipped");
  assert.match(c.detail, /已经有「E01.mkv」了/);
  assert.equal(copyCalls.length, 0);
});

test("提交前先建目标目录：/fs/copy 不会自己建", async () => {
  seed();
  names = { "/115/tv/某剧/S01": ["E01.mkv"] };
  copyResult = [olTask({ id: "tid1" })];
  await tickCopies();
  assert.deepEqual(mkdirCalls, ["/local/media/某剧/S01"]);
  assert.deepEqual(copyCalls, [{ srcDir: "/115/tv/某剧/S01", dstDir: "/local/media/某剧/S01", names: ["E01.mkv"] }]);
  assert.equal(listCopies()[0].stage, "copying");
});

test("目标目录不同的两条不合批", async () => {
  seed(["/tv/A/S01/E01.mkv", "/tv/B/S01/E01.mkv"]);
  names = { "/115/tv/A/S01": ["E01.mkv"], "/115/tv/B/S01": ["E01.mkv"] };
  copyResult = [olTask({ id: "x" })];
  await tickCopies();
  assert.equal(copyCalls.length, 2);
  assert.deepEqual(copyCalls.map((c) => c.dstDir).sort(), ["/local/media/A/S01", "/local/media/B/S01"]);
});

test("同存储秒完成（没有任务可盯）：直接算办完", async () => {
  seed();
  names = { "/115/tv/某剧/S01": ["E01.mkv"] };
  copyResult = [];
  await tickCopies();
  const [c] = listCopies();
  assert.equal(c.status, "done");
  assert.deepEqual(notified.at(-1), { type: "copy-done", name: "E01.mkv", target: "/local/media/某剧/S01", source: "网盘监控" });
});

test("提交复制报错：重试 3 次后作废", async () => {
  seed();
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
  seed();
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
  assert.match(c.detail, /已复制到 \/local\/media\/某剧\/S01/);
  assert.deepEqual(notified.at(-1), { type: "copy-done", name: "E01.mkv", target: "/local/media/某剧/S01", source: "网盘监控" });
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
  tasks = { undone: [], done: [olTask({ id: "old", state: 2, endedAt: now - 3600_000 })] };
  await tickCopies();
  assert.equal(listCopies()[0].status, "pending", "只有陈年任务，不能当成这次的结果");
  assert.match(listCopies()[0].detail, /暂时没找到/);
});

test("任务列表里找不到：3 轮后作废；换阶段时 waits 已清零", async () => {
  seed();
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
  seed();
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

test("还在跑的不让重试；不存在的 404", () => {
  seed();
  const [c] = listCopies();
  assert.throws(() => retryCopy(c.id), /还在队列里跑/);
  assert.throws(() => retryCopy("没这个 id"), /不存在/);
  assert.throws(() => dropCopy("没这个 id"), /不存在/);
});

test("删掉：从队列里去掉", () => {
  seed();
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
  now += 30_000;
  names = { "/115/tv/某剧/S01": ["E01.mkv"], "/local/media/某剧/S01": [] };
  copyResult = [olTask({ id: "tid1" })];
  await tickCopies();
  names["/local/media/某剧/S01"] = ["E01.mkv"];
  tasks = { undone: [], done: [olTask({ id: "tid1", state: 2, endedAt: now })] };
  await tickCopies();
  assert.deepEqual(removeCalls, [{ account: "acc", path: "/tv/某剧/S01/E01.mkv", nodeId: "n1" }]);
  assert.match(listCopies()[0].detail, /网盘上那份已删/);
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
  now += 30_000;
  names = { "/115/tv/某剧/S01": ["E01.mkv"], "/local/media/某剧/S01": [] };
  copyResult = [olTask({ id: "tid1" })];
  await tickCopies();
  names["/local/media/某剧/S01"] = ["E01.mkv"];
  tasks = { undone: [], done: [olTask({ id: "tid1", state: 2, endedAt: now })] };
  await tickCopies();
  assert.match(listCopies()[0].detail, /换成了别的文件，没删/);
});

test("没开删源：一次都不调删除", async () => {
  await submitted();
  names["/local/media/某剧/S01"] = ["E01.mkv"];
  tasks = { undone: [], done: [olTask({ id: "tid1", state: 2, endedAt: now })] };
  await tickCopies();
  assert.equal(removeCalls.length, 0);
});
