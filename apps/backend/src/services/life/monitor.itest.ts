/**
 * 监控循环的通用行为，用 FakeDrive 的变更队列驱动，不认任何一家网盘：
 * 拉到的事件按顺序交给 handlers 落盘、游标逐条推进、problem 事件只记 skipped、
 * 处理失败不拦住后面的事件、夸克那样的快照来源也能挂进同一条循环。
 * 115 专属的门禁 / 405 降级 / 路径还原在 sources/cloud115.itest.ts。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/life/monitor.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo, TaskDefinition } from "@openstrm/shared";
import { KEY } from "../../db/keys.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { deleteDriveSnapshots, deleteKv, listRecentLifeEvents, readKv } from "../../db/repositories/life.js";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { DATA_DIR } from "../../paths.js";
import { setDriveProviderFactory } from "../drive/registry.js";
import type { ChangeEvent } from "../drive/types.js";
import { FakeDrive } from "../../test/fake-drive.js";
import { QuarkSnapshotSource } from "./sources/quark.js";
import { getLifeMonitorStatus, probeLifeEvents, startLifeMonitor, stopLifeMonitor } from "./monitor.js";

const baseline = { settings: readAppSettings(), accounts: listAccounts(), tasks: listTasks() };
const acctA: AccountInfo = { accountType: "115", name: "A", cookie: "cookie-A" };
const acctQ: AccountInfo = { accountType: "quark", name: "Q", cookie: "cookie-Q" };
const taskA: TaskDefinition = { id: "m-a", account: "A", accountType: "115", originPath: "tv", targetPath: "monitor-itest/tv", strmPrefix: "/mnt/pan" };
const taskQ: TaskDefinition = { id: "m-q", account: "Q", accountType: "quark", originPath: "kk", targetPath: "monitor-itest/kk", strmPrefix: "/mnt/kk" };
const localRoot = path.join(DATA_DIR, "monitor-itest");

let dA: FakeDrive;
let dQ: FakeDrive;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`等待超时：${what}`);
    await sleep(20);
  }
}
const statusOf = (name: string) => getLifeMonitorStatus().accounts.find((a) => a.name === name);
const configure = (lifeMonitor: Record<string, unknown>) => replaceAppSettings({ ...baseline.settings, lifeMonitor });

let seq = 0;
const ev = (o: Partial<ChangeEvent> & Pick<ChangeEvent, "kind" | "path">): ChangeEvent => ({
  id: `e${++seq}`,
  oldPath: null,
  isDir: false,
  nodeId: `n${seq}`,
  at: 1_900_000_000 + seq,
  ...o,
});

before(() => {
  replaceAccounts([acctA, acctQ]);
  replaceTasks([taskA, taskQ]);
  replaceAppSettings({ ...baseline.settings, strmExtensions: [".mkv"], downloadExtensions: [".nfo"] });
  setDriveProviderFactory((account) => (account.name === "A" ? dA : account.name === "Q" ? dQ : null));
});

beforeEach(async () => {
  await stopLifeMonitor();
  dA = new FakeDrive("115", acctA, { changes: true });
  dQ = new FakeDrive("quark", acctQ, { changes: false });
  // 夸克没有事件流：把快照来源挂到假网盘上，走的就是线上那条路径
  Object.assign(dQ, { capabilities: { share: false, changes: true }, changes: new QuarkSnapshotSource(dQ) });
  fs.rmSync(localRoot, { recursive: true, force: true });
  for (const name of ["A", "Q"]) deleteKv(KEY.lifeCursor(name));
  deleteDriveSnapshots();
});

after(async () => {
  await stopLifeMonitor();
  setDriveProviderFactory(null);
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  fs.rmSync(localRoot, { recursive: true, force: true });
  deleteDriveSnapshots();
});

test("事件按顺序落地：新增写 strm、改名搬文件、删除清理；游标逐条推进；problem 事件只记 skipped", async () => {
  configure({ accounts: ["A"], pullMode: "latest", intervalSeconds: 5 });
  dA.tree.addDir("/tv/Show");
  dA.tree.addFile("/tv/Show/ep1.mkv");
  dA.changes!.queue.push(
    ev({ id: "c1", kind: "create", path: "/tv/Show/ep1.mkv" }),
    ev({ id: "c2", kind: "rename", path: "/tv/Show/ep1 v2.mkv", oldPath: "/tv/Show/ep1.mkv" }),
    ev({ id: "c3", kind: "create", path: "orphan.mkv", problem: "父目录 404 无法解析" }),
    ev({ id: "c4", kind: "remove", path: "/tv/Show/ep1 v2.mkv" }),
  );
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    assert.equal(statusOf("A")?.source, "fake");
    const settled = () => {
      const st = statusOf("A")?.stats;
      return !!st && st.handled + st.skipped + st.failed === 4;
    };
    await waitFor(settled, "第一轮四条都处理完");
    const st = statusOf("A")!;
    assert.equal(st.stats.events, 4);
    assert.equal(st.stats.handled, 3);
    assert.equal(st.stats.skipped, 1);
    assert.ok(!fs.existsSync(path.join(localRoot, "tv", "Show")), "改名后又删除，本地不应留下东西");
    const rows = listRecentLifeEvents(10);
    assert.deepEqual(
      rows.filter((e) => e.accountName === "A").map((e) => [e.id, e.status, e.kind]).sort(),
      [["c1", "done", "create"], ["c2", "done", "rename"], ["c3", "skipped", "create"], ["c4", "done", "remove"]],
    );
    assert.equal(rows.find((e) => e.id === "c3")?.detail, "父目录 404 无法解析");
    assert.equal(rows.find((e) => e.id === "c2")?.oldPath, "/tv/Show/ep1.mkv");
    assert.deepEqual(readKv(KEY.lifeCursor("A")), { time: 1_900_000_000 + 4, id: "c4" });
    assert.equal(getLifeMonitorStatus().db.snapshots, 0, "115 不建快照");
  } finally {
    await stopLifeMonitor();
  }
});

test("一条事件处理炸了记 failed，后面的照常处理", async () => {
  configure({ accounts: ["A"], pullMode: "latest", intervalSeconds: 5 });
  dA.tree.addDir("/tv/S");
  dA.tree.addFile("/tv/S/a.mkv");
  dA.tree.addFile("/tv/S/b.mkv");
  // 下载类文件要打直链，让直链失败
  dA.tree.addFile("/tv/S/a.nfo");
  dA.changes!.queue.push(
    ev({ id: "f1", kind: "create", path: "/tv/S/a.nfo" }),
    ev({ id: "f2", kind: "create", path: "/tv/S/b.mkv" }),
  );
  dA.beforeCall = async () => {
    if (dA.log[dA.log.length - 1]?.startsWith("downloadLink")) throw new Error("直链被风控");
  };
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    await waitFor(() => (statusOf("A")?.stats.failed ?? 0) === 1 && (statusOf("A")?.stats.handled ?? 0) === 1, "一失败一成功");
    const rows = listRecentLifeEvents(10);
    assert.equal(rows.find((e) => e.id === "f1")?.status, "failed");
    assert.match(rows.find((e) => e.id === "f1")?.detail ?? "", /直链被风控/);
    assert.equal(fs.readFileSync(path.join(localRoot, "tv", "S", "b.strm"), "utf8"), "/mnt/pan/tv/S/b.mkv");
    assert.deepEqual(readKv(KEY.lifeCursor("A")), { time: 1_900_000_000 + seq, id: "f2" }, "失败的也推进游标，不会反复重放");
  } finally {
    await stopLifeMonitor();
  }
});

test("快照来源挂进同一条循环：首轮只建快照，latest 模式不发事件；间隔按来源的下限抬高", async () => {
  configure({ accounts: ["Q"], pullMode: "latest", intervalSeconds: 5 });
  dQ.tree.addDir("/kk/Show");
  dQ.tree.addFile("/kk/Show/ep1.mkv");
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    assert.equal(statusOf("Q")?.source, "snapshot");
    await waitFor(() => (statusOf("Q")?.stats.rounds ?? 0) >= 1, "第一轮");
    assert.equal(statusOf("Q")?.stats.events, 0);
    assert.equal(getLifeMonitorStatus().db.snapshots, 1);
    assert.ok(getLifeMonitorStatus().logs.some((l) => l.includes("[Q] 启动：来源 snapshot，模式 latest，间隔 300s")), "间隔抬到 5 分钟");
    assert.ok(!fs.existsSync(path.join(localRoot, "kk")), "首轮不生成");
    assert.equal(dQ.calls.walkSubtree, 1);
  } finally {
    await stopLifeMonitor();
  }
});

test("快照来源 all 模式：首轮把现有文件全部当新增生成", async () => {
  configure({ accounts: ["Q"], pullMode: "all", intervalSeconds: 5 });
  dQ.tree.addDir("/kk/Show");
  dQ.tree.addFile("/kk/Show/ep1.mkv");
  dQ.tree.addFile("/kk/Show/ep2.mkv");
  dQ.tree.addFile("/kk/top.mkv");
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    await waitFor(() => (statusOf("Q")?.stats.handled ?? 0) === 2, "目录 + 顶层文件两条事件");
    assert.equal(fs.readFileSync(path.join(localRoot, "kk", "Show", "ep1.strm"), "utf8"), "/mnt/kk/kk/Show/ep1.mkv");
    assert.ok(fs.existsSync(path.join(localRoot, "kk", "Show", "ep2.strm")));
    assert.ok(fs.existsSync(path.join(localRoot, "kk", "top.strm")));
    const rows = listRecentLifeEvents(10).filter((e) => e.accountName === "Q");
    assert.deepEqual(rows.map((e) => e.path).sort(), ["/kk/Show", "/kk/top.mkv"], "目录只报最上层那条");
    assert.ok(rows.every((e) => e.id.startsWith("q:Q:")), "夸克事件 id 是合成的");
  } finally {
    await stopLifeMonitor();
  }
});

test("快照来源的门禁：列根目录失败 → 该账号起不来并说明原因", async () => {
  configure({ accounts: ["Q"] });
  dQ.failWith = new Error("require login");
  const r = await startLifeMonitor();
  assert.equal(r.ok, false);
  assert.match(r.message, /^Q：网盘不可用：require login，请检查 cookie$/);
  assert.equal(statusOf("Q")?.running, false);
});

test("probe 对快照来源只验 cookie，并说明它没有事件流", async () => {
  configure({ accounts: ["Q"] });
  dQ.tree.addDir("/kk");
  const r = await probeLifeEvents(5, "Q");
  assert.equal(r.ok, true);
  assert.match(r.message, /cookie 有效，根目录 1 项；这个网盘没有事件流/);
});

test("115 和夸克账号同时监控：各走各的来源", async () => {
  configure({ accounts: ["A", "Q"], pullMode: "latest", intervalSeconds: 5 });
  dA.tree.addDir("/tv");
  dA.tree.addFile("/tv/a.mkv");
  dA.changes!.queue.push(ev({ id: "x1", kind: "create", path: "/tv/a.mkv" }));
  dQ.tree.addDir("/kk");
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(r.started, ["A", "Q"]);
    await waitFor(() => (statusOf("A")?.stats.handled ?? 0) === 1 && (statusOf("Q")?.stats.rounds ?? 0) >= 1, "两边各跑完一轮");
    assert.deepEqual(getLifeMonitorStatus().accounts.map((a) => [a.name, a.source]), [["A", "fake"], ["Q", "snapshot"]]);
    assert.ok(fs.existsSync(path.join(localRoot, "tv", "a.strm")));
  } finally {
    await stopLifeMonitor();
  }
});
