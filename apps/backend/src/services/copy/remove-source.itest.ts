/**
 * 复制完删源，走真的 Provider（FakeDrive），不打桩。
 * copy.itest 把 removeSource / listDriveChildren 换成了桩，这条不可逆的路子只有这里覆盖：
 * 整理把文件挪走之后不能删错、目录没复制全不能删、删的是不是那个节点。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/copy/remove-source.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { patchAppSettings, readAppSettings } from "../../db/repositories/settings.js";
import { setDriveProviderFactory } from "../drive/registry.js";
import { FakeDrive } from "../../test/fake-drive.js";
import type { OpenlistTaskInfo } from "../openlist/client.js";
import { __test_resetCopy, enqueueCopy, listCopies, setCopyServiceDeps, stopCopyWatcher, tickCopies } from "./service.js";

let baseline: { accounts: AccountInfo[]; tasks: TaskDefinition[]; openlistCopy: AppSettings["openlistCopy"] };
const account: AccountInfo = { accountType: "115", name: "acc", cookie: "c" };
const olAccount: AccountInfo = { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://ol.local" };
const drive = new FakeDrive("115", account);

/** OpenList 那一侧仍然是桩：这条测试关心的是网盘那一侧 */
let names: Record<string, string[]> = {};
/** 复制跑完之后目标目录变成什么样（提交前目标必须是空的，不然会被当成「复制过了」跳过） */
let afterCopy: Record<string, string[]> = {};
let now = 1_800_000_000_000;

const olTask = (over: Partial<OpenlistTaskInfo> = {}): OpenlistTaskInfo => ({
  id: "tid1", name: "copy", state: 2, progress: 100, error: "", endedAt: now, ...over,
});

/** 登记 → 提交 → 报完成，一路跑到删源那一步 */
async function copyThrough(source: { path: string; isDir?: boolean; nodeId?: string }): Promise<void> {
  enqueueCopy({ account: "acc", sources: [source], rootPath: "/tv", taskId: "t1", trigger: "monitor", deleteSource: true });
  await stopCopyWatcher();
  now += 30_000;
  await tickCopies(); // 阶段一：源在 OpenList 里可见 → 提交
  await tickCopies(); // 阶段二：任务已结束 → done → 删源
}

before(() => {
  baseline = { accounts: listAccounts(), tasks: listTasks(), openlistCopy: readAppSettings().openlistCopy };
  replaceAccounts([account, olAccount]);
  replaceTasks([]);
  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local/media", mounts: { acc: "/115" } } });
  setDriveProviderFactory((a) => (a.name === "acc" ? drive : null));
  setCopyServiceDeps({
    openlist: {
      listNames: async (_cfg, dir) => names[dir] ?? [],
      mkdir: async () => {},
      copy: async () => {
        Object.assign(names, afterCopy);
        return [olTask({ state: 1, endedAt: null })];
      },
      copyTasks: async () => ({ undone: [], done: [olTask()] }),
    },
    notify: async () => {},
    now: () => now,
    embyRefresh: () => {},
    organize: () => {},
    // removeSource / listDriveChildren 故意不给：就是要跑真的那两个
  });
});

beforeEach(async () => {
  await __test_resetCopy();
  drive.tree.nodes.clear();
  drive.calls.remove = 0;
  drive.log.length = 0;
  names = {};
  afterCopy = {};
});

after(async () => {
  await __test_resetCopy();
  setCopyServiceDeps(null);
  setDriveProviderFactory(null);
  replaceAccounts(baseline.accounts);
  replaceTasks(baseline.tasks);
  patchAppSettings({ openlistCopy: baseline.openlistCopy });
});

test("文件复制完：网盘上那份真的删掉了", async () => {
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  names = { "/115/tv/某剧/S01": ["E01.mkv"] };
  afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };

  await copyThrough({ path: "/tv/某剧/S01/E01.mkv" });

  const [c] = listCopies();
  assert.equal(c.status, "done");
  assert.match(c.detail, /网盘上那份已删/);
  assert.equal(drive.tree.get("/tv/某剧/S01/E01.mkv"), undefined, "源文件该没了");
});

test("整理把同名文件换成了另一个：nodeId 对不上就不删", async () => {
  const node = drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  names = { "/115/tv/某剧/S01": ["E01.mkv"] };
  afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };

  // 登记时记下的是这个 id，复制期间整理把它挪走、原地又出现了一个同名的
  drive.tree.remove("/tv/某剧/S01/E01.mkv");
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");

  await copyThrough({ path: "/tv/某剧/S01/E01.mkv", nodeId: node.id });

  assert.match(listCopies()[0].detail, /换成了别的文件，没删/);
  assert.ok(drive.tree.get("/tv/某剧/S01/E01.mkv"), "换过的那份不能删");
  assert.equal(drive.calls.remove, 0);
});

test("源已经不在原处：什么都不删", async () => {
  names = { "/115/tv/某剧/S01": ["E01.mkv"] };
  afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };
  await copyThrough({ path: "/tv/某剧/S01/E01.mkv" });
  assert.match(listCopies()[0].detail, /已不在原处，没删/);
  assert.equal(drive.calls.remove, 0);
});

test("目录只复制了一半：一层子项对不上就不删", async () => {
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  drive.tree.addFile("/tv/某剧/S01/E02.mkv");
  names = { "/115/tv/某剧": ["S01"] };
  // E02 还没搬过去
  afterCopy = { "/local/media/某剧": ["S01"], "/local/media/某剧/S01": ["E01.mkv"] };

  await copyThrough({ path: "/tv/某剧/S01", isDir: true });

  assert.match(listCopies()[0].detail, /目标里少了 1 项/);
  assert.ok(drive.tree.get("/tv/某剧/S01/E02.mkv"), "没复制全的目录一个都不能删");
  assert.equal(drive.calls.remove, 0);
});

test("目录复制全了：整个目录删掉", async () => {
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  drive.tree.addFile("/tv/某剧/S01/E02.mkv");
  names = { "/115/tv/某剧": ["S01"] };
  afterCopy = { "/local/media/某剧": ["S01"], "/local/media/某剧/S01": ["E01.mkv", "E02.mkv"] };

  await copyThrough({ path: "/tv/某剧/S01", isDir: true });

  assert.match(listCopies()[0].detail, /网盘上那份已删/);
  assert.equal(drive.tree.get("/tv/某剧/S01"), undefined);
});

test("网盘删不了（报错）：复制仍然算成功，只在说明里写一句", async () => {
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  names = { "/115/tv/某剧/S01": ["E01.mkv"] };
  afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };
  drive.failWriteOn = (op) => (op === "remove" ? new Error("回收站满了") : null);

  try {
    await copyThrough({ path: "/tv/某剧/S01/E01.mkv" });
  } finally {
    drive.failWriteOn = null;
  }

  const [c] = listCopies();
  assert.equal(c.status, "done", "复制本身成了，删源失败不该翻案");
  assert.match(c.detail, /删源失败：回收站满了/);
});

test("没开删源开关：一个网盘写操作都不做", async () => {
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  names = { "/115/tv/某剧/S01": ["E01.mkv"] };
  afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };

  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E01.mkv"], rootPath: "/tv", trigger: "monitor" });
  await stopCopyWatcher();
  now += 30_000;
  await tickCopies();
  await tickCopies();

  assert.equal(listCopies()[0].status, "done");
  assert.ok(drive.tree.get("/tv/某剧/S01/E01.mkv"), "没开开关就别碰源文件");
  assert.equal(drive.calls.remove, 0);
});
