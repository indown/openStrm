/**
 * 用本地 openlist 桩把 startTask 整条跑通：拉目录树、建 strm、下载附件、写执行历史；
 * 第二次跑没有变化就是 "no files to download"；并发启动同一任务只能进去一个
 * （以前 running 表在拉完目录树之后才登记，这几百毫秒到几分钟的窗口挡不住第二次）。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/task/runner.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { deleteTask, insertTask, updateTask } from "../../db/repositories/tasks.js";
import { deleteTaskExecution, getTaskExecution, getTaskHistory } from "../task-history.js";
import { clearRateLimiters } from "../download/rate-limited.js";
import { cancelRunningTask, isTaskRunning } from "./registry.js";
import { startTask } from "./runner.js";

const TASK = "runner-itest";
const ORIGIN = "/media/Show";
/** 单文件失败的用例用另一棵树：一个 nfo 的直链 404 */
const ORIGIN_PARTIAL = "/media/Partial";
let listDelayMs = 0;
let listCalls = 0;
let holdRaw = false;
let emptyRemote = false;
let rawRequests = 0;
const held = new Set<http.ServerResponse>();

// ---- 假 openlist ----
const tree: Record<string, Array<{ name: string; is_dir: boolean }>> = {
  [ORIGIN]: [{ name: "S1", is_dir: true }],
  [`${ORIGIN}/S1`]: [
    { name: "ep1.mkv", is_dir: false },
    { name: "ep1.nfo", is_dir: false },
  ],
  [ORIGIN_PARTIAL]: [
    { name: "ep1.mkv", is_dir: false },
    { name: "ep1.nfo", is_dir: false },
    { name: "missing.nfo", is_dir: false },
  ],
};
const server = http.createServer((req, res) => {
  const json = (body: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === "/api/auth/login") return json({ code: 200, data: { token: "tok" } });
    if (req.url === "/api/fs/list") {
      listCalls++;
      const content = emptyRemote ? [] : (tree[body.path as string] ?? []);
      setTimeout(() => json({ code: 200, data: { content } }), listDelayMs);
      return;
    }
    if (req.url === "/api/fs/get") return json({ code: 200, data: { raw_url: `${base}/raw${body.path}` } });
    if (req.url?.startsWith("/raw/")) {
      rawRequests++;
      if (req.url.endsWith("/missing.nfo")) {
        res.writeHead(404);
        return res.end("gone");
      }
      if (holdRaw) {
        // 发一点就挂住，模拟正在进行的大文件下载
        res.writeHead(200, { "content-type": "text/plain", "content-length": "1000" });
        res.write("partial");
        held.add(res);
        res.on("close", () => held.delete(res));
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(`content of ${req.url}`);
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const baseline = { settings: readAppSettings(), accounts: listAccounts() };
const outDir = path.join(process.env.DATA_DIR!, TASK);

async function waitFor(cond: () => boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

before(() => {
  replaceAppSettings({ ...baseline.settings, strmExtensions: [".mkv"], downloadExtensions: [".nfo"] });
  replaceAccounts([{ accountType: "openlist", name: "ol", account: "u", password: "p", url: base }]);
  insertTask({
    id: TASK,
    account: "ol",
    accountType: "openlist",
    originPath: ORIGIN,
    targetPath: `${TASK}/out`,
    strmPrefix: "http://strm.local",
  });
});

after(async () => {
  await waitFor(() => !isTaskRunning(TASK), "任务结束", 5000).catch(() => {});
  deleteTask(TASK);
  for (const h of getTaskHistory(TASK)) deleteTaskExecution(h.id);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  fs.rmSync(outDir, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

test("整条跑通：strm 落盘、附件下载、历史记完成", async () => {
  const res = await startTask(TASK);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.message, "2 files to download");
  await waitFor(() => !isTaskRunning(TASK), "任务结束");

  const strm = fs.readFileSync(path.join(outDir, "out/S1/ep1.strm"), "utf8");
  assert.ok(strm.startsWith("http://strm.local"), strm);
  assert.ok(strm.endsWith(`${ORIGIN}/S1/ep1.mkv`), strm);
  assert.equal(fs.readFileSync(path.join(outDir, "out/S1/ep1.nfo"), "utf8"), `content of /raw${ORIGIN}/S1/ep1.nfo`);

  await waitFor(() => getTaskHistory(TASK)[0]?.status === "completed", "历史标完成");
  const [h] = getTaskHistory(TASK);
  assert.equal(h.summary.totalFiles, 2);
  assert.equal(h.summary.downloadedFiles, 2);
});

test("再跑一次没有变化：no files to download，不新建执行记录", async () => {
  const before = getTaskHistory(TASK).length;
  const res = await startTask(TASK);
  assert.equal(res.status, 200);
  assert.equal(res.body.message, "no files to download");
  assert.equal(getTaskHistory(TASK).length, before);
});

test("并发启动同一任务：拉目录树期间第二次进来必须 409", async () => {
  fs.rmSync(outDir, { recursive: true, force: true }); // 让它有活干，否则跑不出 running 状态
  listDelayMs = 300;
  listCalls = 0;
  try {
    const [a, b] = await Promise.all([startTask(TASK), startTask(TASK)]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], `两次结果：${JSON.stringify([a, b])}`);
    assert.equal(listCalls, 2, "只应拉一次目录树（两级目录各一次），第二次启动在拉之前就被挡下");
  } finally {
    listDelayMs = 0;
  }
  await waitFor(() => !isTaskRunning(TASK), "任务结束");
  assert.equal(getTaskHistory(TASK).filter((h) => h.status === "completed").length, 2);
});

test("removeExtraFiles：本地多出来的文件和空目录被删掉，远端仍有的不动", async () => {
  updateTask(TASK, { removeExtraFiles: true });
  fs.writeFileSync(path.join(outDir, "out/S1/stray.strm"), "x");
  fs.mkdirSync(path.join(outDir, "out/Empty/Deeper"), { recursive: true });
  try {
    const res = await startTask(TASK);
    assert.equal(res.status, 200);
    assert.equal(res.body.message, "no files to download", "远端没新文件，只做清理");
    assert.equal(fs.existsSync(path.join(outDir, "out/S1/stray.strm")), false);
    assert.equal(fs.existsSync(path.join(outDir, "out/Empty")), false, "顶层空目录整个删掉");
    assert.ok(fs.existsSync(path.join(outDir, "out/S1/ep1.strm")), "远端仍有的不能被删");
    assert.ok(fs.existsSync(path.join(outDir, "out/S1/ep1.nfo")));
  } finally {
    updateTask(TASK, { removeExtraFiles: false });
  }
});

test("removeExtraFiles：远端目录为空时拒绝清理本地（多半是导出失败），并在响应里说明", async () => {
  updateTask(TASK, { removeExtraFiles: true });
  emptyRemote = true;
  try {
    const res = await startTask(TASK);
    assert.equal(res.status, 200);
    assert.equal(res.body.message, "no files to download");
    assert.match(String(res.body.warning), /远端目录为空.*已跳过清理/);
    assert.ok(fs.existsSync(path.join(outDir, "out/S1/ep1.strm")), "本地库不能被清空");
    assert.ok(fs.existsSync(path.join(outDir, "out/S1/ep1.nfo")));
  } finally {
    emptyRemote = false;
    updateTask(TASK, { removeExtraFiles: false });
  }
});

test("取消：进行中的下载被中止且不留半截文件，排队的不再发请求，历史标 cancelled", async () => {
  fs.rmSync(outDir, { recursive: true, force: true });
  tree[`${ORIGIN}/S1`].push({ name: "ep2.nfo", is_dir: false }, { name: "ep3.nfo", is_dir: false });
  // 下载并发 1：一个挂在半路，另外两个排在限流器队列里
  replaceAppSettings({
    ...readAppSettings(),
    download: { linkMaxPerSecond: 10, linkMaxConcurrent: 2, downloadMaxConcurrent: 1 },
  });
  clearRateLimiters();
  holdRaw = true;
  rawRequests = 0;
  try {
    const res = await startTask(TASK);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await waitFor(() => rawRequests === 1 && held.size === 1, "第一个下载挂上");

    assert.equal(cancelRunningTask(TASK, "测试取消"), true);
    assert.equal(isTaskRunning(TASK), false);
    await waitFor(() => held.size === 0, "服务端看到下载连接被掐断");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(rawRequests, 1, "排队的两个不该再发请求");

    const left = fs.readdirSync(path.join(outDir, "out/S1"));
    assert.ok(!left.some((n) => n.endsWith(".part")), `半截文件要删掉，实际剩下 ${left.join(",")}`);
    assert.ok(!left.some((n) => n.endsWith(".nfo")), `没下完的不能顶着正式文件名，实际剩下 ${left.join(",")}`);

    const [h] = getTaskHistory(TASK);
    assert.equal(h.status, "cancelled");
    assert.equal(h.summary.errorMessage, "测试取消");
    assert.equal(cancelRunningTask(TASK), false, "已经取消的再取消返回 false");
  } finally {
    holdRaw = false;
    for (const r of held) r.destroy();
    tree[`${ORIGIN}/S1`].length = 2;
    replaceAppSettings({ ...readAppSettings(), download: baseline.settings.download });
    clearRateLimiters();
  }
});

test("起不来也进历史：账号不存在 → 500，历史里有一条 failed 并写明原因", async () => {
  const id = `${TASK}-noacc`;
  insertTask({ id, account: "ghost", accountType: "openlist", originPath: ORIGIN, targetPath: `${TASK}/noacc`, strmPrefix: "x" });
  try {
    const res = await startTask(id);
    assert.equal(res.status, 500);
    const [h] = getTaskHistory(id);
    assert.ok(h, "启动阶段失败也要留一条执行记录");
    assert.equal(h.status, "failed");
    assert.match(h.summary.errorMessage ?? "", /账号不存在：ghost/);
    assert.ok(h.endTime, "记录应已结束，不能挂着 running");
    assert.equal(isTaskRunning(id), false);
  } finally {
    for (const h of getTaskHistory(id)) deleteTaskExecution(h.id);
    deleteTask(id);
  }
});

test("单个文件下载失败不拖死任务：其余照常完成，历史记 failed 并写明是哪个文件", async () => {
  const id = `${TASK}-partial`;
  insertTask({ id, account: "ol", accountType: "openlist", originPath: ORIGIN_PARTIAL, targetPath: `${TASK}/partial`, strmPrefix: "http://strm.local" });
  const dir = path.join(process.env.DATA_DIR!, TASK, "partial");
  try {
    const res = await startTask(id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.message, "3 files to download");
    await waitFor(() => !isTaskRunning(id), "任务结束");
    assert.ok(fs.existsSync(path.join(dir, "ep1.strm")), "strm 照常生成");
    assert.equal(fs.readFileSync(path.join(dir, "ep1.nfo"), "utf8"), `content of /raw${ORIGIN_PARTIAL}/ep1.nfo`, "其它下载照常完成");
    assert.ok(!fs.existsSync(path.join(dir, "missing.nfo")) && !fs.existsSync(path.join(dir, "missing.nfo.part")), "失败的文件不留半截");

    await waitFor(() => getTaskHistory(id)[0]?.status !== "running", "历史收尾");
    const [h] = getTaskHistory(id);
    assert.equal(h.status, "failed");
    assert.equal(h.summary.totalFiles, 3);
    assert.equal(h.summary.downloadedFiles, 2, "完成数记真实值，不再是 0");
    assert.equal(h.summary.failedFiles, 1);
    assert.match(h.summary.errorMessage ?? "", /1 个文件失败：missing\.nfo/);

    // 历史里的事件行：开始事件、带文件名的失败事件、带结论的结束事件
    const lines = getTaskExecution(h.id)!.logs.map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.start === true && l.total === 3 && l.strmTotal === 1 && l.downloadTotal === 2), "第一行是开始事件");
    assert.ok(lines.some((l) => l.filePath === "missing.nfo" && l.kind === "download" && typeof l.error === "string"), "失败事件带文件名");
    const done = lines.find((l) => l.done === true);
    assert.equal(done?.status, "failed");
    assert.equal(done?.finished, 2);
    assert.equal(done?.failed, 1);
  } finally {
    for (const h of getTaskHistory(id)) deleteTaskExecution(h.id);
    deleteTask(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("不存在的任务 404", async () => {
  assert.equal((await startTask("nope")).status, 404);
});
