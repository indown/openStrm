/**
 * 云下载接口封装里的纯函数：链接整理、真实响应的归一化、加任务结果对齐。
 * 样本取自 2026-08 用真实账号抓到的 task_lists 响应（名字和 id 有改动）。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/cloud-115/offline.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeSspData,
  normalizeAddResults,
  normalizeOfflineListPage,
  normalizeOfflineTask,
  normalizeOfflineUrls,
  offlineErrorOf,
} from "./offline.js";

const HASH40 = "a3755bb2a0c3298653eaf597bcc73ab932b1d1a5";

test("normalizeOfflineUrls：按行拆、去空白去重，裸 info_hash 补成磁力链，不支持的协议单列", () => {
  const input = [
    "magnet:?xt=urn:btih:AAA ",
    "",
    "  magnet:?xt=urn:btih:aaa",
    "ed2k://|file|x.mkv|1|0E7FAA0EAEB2DEE85E02964F7D93E381|/",
    "https://example.com/a.mkv",
    "FTP://example.com/b.iso",
    "thunder://QUFodHRwOi8v",
    HASH40.toUpperCase(),
    "not a link",
  ].join("\n");
  const { urls, invalid } = normalizeOfflineUrls(input);
  assert.deepEqual(urls, [
    "magnet:?xt=urn:btih:AAA",
    "ed2k://|file|x.mkv|1|0E7FAA0EAEB2DEE85E02964F7D93E381|/",
    "https://example.com/a.mkv",
    "FTP://example.com/b.iso",
    `magnet:?xt=urn:btih:${HASH40}`,
  ]);
  assert.deepEqual(invalid, ["thunder://QUFodHRwOi8v", "not a link"]);
  // 数组输入等价
  assert.deepEqual(normalizeOfflineUrls(["  ", HASH40]).urls, [`magnet:?xt=urn:btih:${HASH40}`]);
});

const fileTask = {
  info_hash: "1576af16c443c3669d1d6eddd07a1bc9",
  add_time: 1787355082,
  percentDone: 100,
  size: 10495107242,
  peers: 0,
  rateDownload: 0,
  name: "Silo.S03E08.mkv",
  last_update: 1787277447,
  left_time: 0,
  file_id: "2931676988586898668",
  delete_file_id: "3500893976783750677",
  pick_code: "ak28mngiisul4h4kc",
  file_category: 1,
  move: 1,
  status: 2,
  display_status: "finished",
  status_text: "下载成功",
  url: "ed2k://|file|Silo.S03E08.mkv|10495107242|1576AF16C443C3669D1D6EDDD07A1BC9|/",
  del_path: "Silo.S03E08.mkv",
  wp_path_id: "2931676988586898668",
};

test("normalizeOfflineTask：file_id 是目标目录，产物是 delete_file_id / del_path；file_category 分文件目录", () => {
  const t = normalizeOfflineTask(fileTask);
  assert.equal(t.state, "done");
  assert.equal(t.statusText, "下载成功");
  assert.equal(t.dirId, "2931676988586898668");
  assert.equal(t.resultId, "3500893976783750677");
  assert.equal(t.resultName, "Silo.S03E08.mkv");
  assert.equal(t.isDir, false);
  assert.equal(t.percent, 100);
  assert.equal(t.size, 10495107242);
  assert.equal(t.pickCode, "ak28mngiisul4h4kc");

  const bt = normalizeOfflineTask({
    ...fileTask,
    info_hash: HASH40,
    file_id: "3117196816742397488",
    delete_file_id: "3117196816742397488",
    file_category: 0,
    name: "Captain.America.2025",
    del_path: "Captain.America.2025",
  });
  assert.equal(bt.isDir, true);
  assert.equal(bt.resultId, "3117196816742397488");
  assert.equal(bt.dirId, "2931676988586898668", "目录任务的 file_id 是产物本身，目标目录要看 wp_path_id");
});

test("normalizeOfflineTask：状态码映射，115 没给说明时兜底；move=-1 一律算失败", () => {
  assert.equal(normalizeOfflineTask({ ...fileTask, status: -1, status_text: "" }).state, "failed");
  assert.equal(normalizeOfflineTask({ ...fileTask, status: -1, status_text: "" }).statusText, "下载失败");
  assert.equal(normalizeOfflineTask({ ...fileTask, status: -1, status_text: "资源违规" }).statusText, "资源违规");
  const dl = normalizeOfflineTask({ ...fileTask, status: 1, percentDone: 42.5, status_text: undefined });
  assert.equal(dl.state, "downloading");
  assert.equal(dl.statusText, "下载中");
  assert.equal(dl.percent, 42.5);
  assert.equal(normalizeOfflineTask({ ...fileTask, status: 0 }).state, "pending");
  const odd = normalizeOfflineTask({ ...fileTask, status: 7, status_text: undefined });
  assert.equal(odd.state, "unknown");
  assert.equal(odd.statusText, "未知状态");
  const noSpace = normalizeOfflineTask({ ...fileTask, move: -1 });
  assert.equal(noSpace.state, "failed");
  assert.match(noSpace.statusText, /空间不足/);
  // 名字缺 del_path 时退回 name；percent 越界收敛
  const bare = normalizeOfflineTask({ name: "x", percentDone: 130 });
  assert.equal(bare.resultName, "x");
  assert.equal(bare.percent, 100);
  assert.equal(bare.state, "unknown");
});

test("normalizeOfflineListPage：分页与配额；没有 tasks 也不炸", () => {
  const page = normalizeOfflineListPage({ page: 2, page_count: 15, page_size: 30, count: 426, quota: 1486, total: 1500, tasks: [fileTask] });
  assert.equal(page.page, 2);
  assert.equal(page.pageCount, 15);
  assert.equal(page.count, 426);
  assert.equal(page.quota, 1486);
  assert.equal(page.total, 1500);
  assert.equal(page.tasks.length, 1);
  const empty = normalizeOfflineListPage({});
  assert.deepEqual(empty, { page: 1, pageCount: 1, pageSize: 0, count: 0, quota: null, total: null, tasks: [] });
});

test("offlineErrorOf：task_lists 没有 state 字段也算成功；errno=null 算成功；state=false / errno≠0 才是失败", () => {
  assert.equal(offlineErrorOf({ page: 1, tasks: [] }), null);
  assert.equal(offlineErrorOf({ state: true, errno: null, error: null }), null);
  assert.equal(offlineErrorOf({ state: false, error: "请先登录", errno: 99 }), "请先登录");
  assert.equal(offlineErrorOf({ state: true, errno: 10008, error_msg: "任务已存在" }), "任务已存在");
  assert.equal(offlineErrorOf({ errno: 5 }), "errno=5");
  assert.equal(offlineErrorOf(null), "115 返回了空响应");
});

test("normalizeAddResults：result 数组按 url 对齐（顺序乱了也行），单条扁平，整体失败铺到每一条", () => {
  const urls = ["u1", "u2"];
  const multi = normalizeAddResults(
    {
      state: true,
      result: [
        { state: false, errno: 10008, error_msg: "任务已存在", url: "u2" },
        { state: true, errno: 0, info_hash: "h1", name: "n1", url: "u1" },
      ],
    },
    urls,
  );
  assert.deepEqual(multi, [
    { url: "u1", ok: true, infoHash: "h1", name: "n1", message: undefined },
    { url: "u2", ok: false, infoHash: undefined, name: undefined, message: "任务已存在" },
  ]);

  const single = normalizeAddResults({ state: true, info_hash: "h", name: "n", url: "u1" }, ["u1"]);
  assert.equal(single[0].ok, true);
  assert.equal(single[0].infoHash, "h");

  const failed = normalizeAddResults({ state: false, errno: 911, error_msg: "请先验证账号" }, urls);
  assert.deepEqual(
    failed.map((r) => [r.ok, r.message]),
    [
      [false, "请先验证账号"],
      [false, "请先验证账号"],
    ],
  );
  assert.equal(normalizeAddResults({}, ["u1"])[0].message, "115 没有返回任务信息");
  // result 比 urls 短且对不上 url：多出来的那条给出说明
  const short = normalizeAddResults({ result: [{ state: true, info_hash: "h1" }] }, urls);
  assert.equal(short[0].ok, true);
  assert.equal(short[1].ok, false);
});

test("decodeSspData：密文解不开时退回明文 JSON，再不行原样返回；非字符串不动", () => {
  assert.deepEqual(decodeSspData('{"a":1}'), { a: 1 });
  assert.equal(decodeSspData("not json"), "not json");
  assert.equal(decodeSspData(undefined), undefined);
  assert.deepEqual(decodeSspData({ x: 1 }), { x: 1 });
  assert.equal(decodeSspData(""), "");
});
