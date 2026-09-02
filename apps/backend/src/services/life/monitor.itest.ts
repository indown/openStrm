/**
 * 多账号监控的离线集成测试：拉取和「开生活事件开关」都换成本地桩，不打 115。
 *
 * 循环的第一轮在 startLifeMonitor 返回后立刻跑，第二轮要等 intervalSeconds（下限 5s），
 * 所以用例只看第一轮的结果，然后 stop（stop 会立刻叫醒等待中的循环）。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/life/monitor.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo } from "@openstrm/shared";
import { KEY } from "../../db/keys.js";
import { deleteAccount, listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { deleteKv, listRecentLifeEvents, readKv, writeKv } from "../../db/repositories/life.js";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { rememberPath } from "../cloud-115/path-resolver.js";
import type { LifeEvent, PullOptions } from "../cloud-115/life.js";
import {
  getLifeMonitorStatus,
  migrateLegacyLifeMonitorState,
  probeLifeEvents,
  resolveMonitoredAccountNames,
  setLifeMonitorDeps,
  startLifeMonitor,
  stopLifeMonitor,
} from "./monitor.js";

const baselineSettings = readAppSettings();
const baselineAccounts = listAccounts();

const acct = (name: string, cookie = `cookie-${name}`): AccountInfo => ({ accountType: "115", name, cookie });

const ev = (o: Partial<LifeEvent>): LifeEvent => ({
  id: "1", type: 2, file_category: 1, file_id: "9001", parent_id: "10",
  file_name: "ep1.mkv", file_size: 1, sha1: "", pick_code: "pc",
  update_time: 1_900_000_000, create_time: 1_900_000_000, ...o,
});

/** 桩的行为：每个账号一轮返回什么、哪次调用要炸、哪次调用要挂住直到被中止 */
let eventsFor: Record<string, LifeEvent[]> = {};
let failFor: (opts: PullOptions) => Error | null = () => null;
let hangFor: (opts: PullOptions) => boolean = () => false;
let pulls: Array<{ account: string; app: string | undefined; gate: boolean }> = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function configure(lifeMonitor: Record<string, unknown>) {
  replaceAppSettings({ ...baselineSettings, lifeMonitor });
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`等待超时：${what}`);
    await sleep(20);
  }
}

const statusOf = (name: string) => getLifeMonitorStatus().accounts.find((a) => a.name === name);

before(() => {
  replaceAccounts([acct("A"), acct("B")]);
  // 父目录预置进 path_cache：事件解析路径只查缓存，不会去打祖先链接口
  rememberPath({ fileId: "10", parentId: "0", name: "a-dir", path: "/a-dir", isDir: true, accountName: "A" });
  rememberPath({ fileId: "20", parentId: "0", name: "b-dir", path: "/b-dir", isDir: true, accountName: "B" });
  setLifeMonitorDeps({
    enable: async () => ({ ok: true, message: "已开启" }),
    pull: (opts) => {
      // 启动门禁只拉一条（maxPages 1 / firstBatchSize 1），和正式轮询区分开
      const gate = opts.maxPages === 1 && opts.firstBatchSize === 1;
      pulls.push({ account: opts.accountInfo.name, app: opts.app, gate });
      if (hangFor(opts)) {
        // 模拟 115 黑洞：请求只会在 signal 中止时结束
        return new Promise((_, reject) =>
          opts.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }),
        );
      }
      const err = failFor(opts);
      if (err) return Promise.reject(err);
      return Promise.resolve(gate ? [] : (eventsFor[opts.accountInfo.name] ?? []));
    },
  });
});

beforeEach(() => {
  eventsFor = {};
  failFor = () => null;
  hangFor = () => false;
  pulls = [];
  // 各用例之间不留游标 / 降级状态，谁也别依赖前一个用例写下的东西
  for (const name of ["A", "B"]) {
    deleteKv(KEY.lifeCursor(name));
    deleteKv(KEY.lifeAppFallback(name));
  }
  deleteKv(KEY.legacyLifeCursor);
  deleteKv(KEY.legacyLifeAppFallback);
});

after(async () => {
  await stopLifeMonitor();
  setLifeMonitorDeps(null);
  replaceAppSettings(baselineSettings);
  replaceAccounts(baselineAccounts);
});

test("resolveMonitoredAccountNames：accounts 优先，其次旧字段 account，都没有就全部；名字不 trim", () => {
  const pool = [{ name: "A" }, { name: "B" }];
  assert.deepEqual(resolveMonitoredAccountNames({}, pool), ["A", "B"]);
  assert.deepEqual(resolveMonitoredAccountNames({ account: "B" }, pool), ["B"], "2.1 之前的单账号配置");
  assert.deepEqual(resolveMonitoredAccountNames({ accounts: ["B"], account: "A" }, pool), ["B"], "新字段出现后旧字段不再看");
  assert.deepEqual(resolveMonitoredAccountNames({ accounts: [], account: "A" }, pool), ["A", "B"], "空数组 = 全部，旧字段还在也一样");
  assert.deepEqual(resolveMonitoredAccountNames({ accounts: ["B", "B", "", "X"] }, pool), ["B", "X"], "保序去重，不认识的名字也留着");
  assert.deepEqual(resolveMonitoredAccountNames({ accounts: [" B"] }, pool), [" B"], "账号名以账户表为准，带空格也原样比");
});

test("未启动时状态就列出配置里的每个账号，游标显示上次停的位置", () => {
  configure({ accounts: ["A", "B"] });
  writeKv(KEY.lifeCursor("B"), { fromTime: 5, fromId: "77" });
  const s = getLifeMonitorStatus();
  assert.equal(s.running, false);
  assert.deepEqual(s.accounts.map((a) => [a.name, a.running]), [["A", false], ["B", false]]);
  assert.deepEqual(statusOf("B")?.cursor, { fromTime: 5, fromId: "77" });
});

test("两个账号各跑一条循环：事件按账号落库，游标各存各的", async () => {
  configure({ accounts: ["A", "B"], pullMode: "latest", intervalSeconds: 5 });
  eventsFor = {
    A: [ev({ id: "1001", file_id: "9001", parent_id: "10", file_name: "a.mkv" })],
    B: [ev({ id: "2001", file_id: "9002", parent_id: "20", file_name: "b.mkv" })],
  };
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /账号 A、B/);
    assert.deepEqual(r.started, ["A", "B"]);
    assert.deepEqual(r.failed, []);
    await waitFor(
      () => (statusOf("A")?.stats.skipped ?? 0) === 1 && (statusOf("B")?.stats.skipped ?? 0) === 1,
      "两个账号各处理完一条事件（没有任务，跳过）",
    );

    const s = getLifeMonitorStatus();
    assert.equal(s.running, true);
    assert.deepEqual(s.accounts.map((a) => [a.name, a.running]), [["A", true], ["B", true]]);
    assert.equal(s.stats.events, 2, "合计");
    assert.ok(s.logs.some((l) => l.includes("[A] 拉到 1 条新事件")) && s.logs.some((l) => l.includes("[B] 拉到 1 条新事件")), "日志行带账号名");

    const rows = listRecentLifeEvents(10);
    assert.equal(rows.find((e) => e.id === "1001")?.accountName, "A");
    assert.equal(rows.find((e) => e.id === "2001")?.accountName, "B");

    assert.equal(readKv<{ fromId: string }>(KEY.lifeCursor("A"))?.fromId, "1001");
    assert.equal(readKv<{ fromId: string }>(KEY.lifeCursor("B"))?.fromId, "2001");
    assert.equal(readKv(KEY.legacyLifeCursor), null, "不再写不带账号名的旧键");
  } finally {
    await stopLifeMonitor();
  }
  const s = getLifeMonitorStatus();
  assert.equal(s.running, false);
  assert.ok(s.accounts.every((a) => !a.running));
});

test("一个账号起不来不影响另一个：结果标成部分启动，状态里能看到原因和上次游标", async () => {
  configure({ accounts: ["A", "B"], intervalSeconds: 5 });
  writeKv(KEY.lifeCursor("B"), { fromTime: 5, fromId: "77" });
  failFor = (opts) => (opts.accountInfo.name === "B" ? new Error("请重新登录") : null);
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(r.started, ["A"]);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0]!.name, "B");
    assert.match(r.message, /^生活事件监控已启动（账号 A）；B 未启动：115 生活事件不可用：请重新登录，请检查 cookie$/);
    assert.equal(getLifeMonitorStatus().running, true);
    assert.equal(statusOf("A")?.running, true);
    assert.equal(statusOf("B")?.running, false);
    assert.match(statusOf("B")?.lastError ?? "", /请重新登录/);
    assert.deepEqual(statusOf("B")?.cursor, { fromTime: 5, fromId: "77" }, "起不来的账号照样显示库里的游标");
  } finally {
    await stopLifeMonitor();
  }
});

test("所有账号都起不来 → ok=false，消息逐个列出、账号名只出现一次", async () => {
  configure({ accounts: ["A", "B"] });
  failFor = () => new Error("请重新登录");
  const r = await startLifeMonitor();
  assert.equal(r.ok, false);
  assert.equal(r.message, "A：115 生活事件不可用：请重新登录，请检查 cookie；B：115 生活事件不可用：请重新登录，请检查 cookie");
  assert.equal(getLifeMonitorStatus().running, false);
});

test("配置里的账号不存在 → 该账号启动失败，其它照常", async () => {
  configure({ accounts: ["A", "ghost"] });
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /ghost 未启动：账户页里没有这个 115 账号/);
    assert.equal(statusOf("ghost")?.running, false);
  } finally {
    await stopLifeMonitor();
  }
});

test("同一个 cookie 挂在两个账号名下只监控先出现的那个", async () => {
  replaceAccounts([acct("A"), acct("B", "cookie-A")]);
  configure({ accounts: ["A", "B"] });
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(r.started, ["A"]);
    assert.match(r.failed[0]?.message ?? "", /cookie 和账号 A 相同/);
    assert.equal(statusOf("B")?.running, false);
    assert.equal(pulls.filter((p) => p.account === "B").length, 0, "B 一次接口都不该打");
  } finally {
    await stopLifeMonitor();
    replaceAccounts([acct("A"), acct("B")]);
  }
});

test("升级迁移：旧游标/降级状态挪到当时监控的账号名下，配置写成只盯那一个账号", () => {
  writeKv(KEY.legacyLifeCursor, { fromTime: 123, fromId: "999" });
  const webUntil = Date.now() + 3_600_000;
  writeKv(KEY.legacyLifeAppFallback, { ios405Count: 0, webFallbackUntil: webUntil });
  // 旧配置：只有 account 字段
  configure({ account: "B", pullMode: "last" });

  migrateLegacyLifeMonitorState();
  assert.deepEqual(readAppSettings().lifeMonitor?.accounts, ["B"], "升级后继续只盯原来那一个");
  assert.equal(readKv(KEY.legacyLifeCursor), null, "旧键已删除");
  assert.equal(readKv(KEY.legacyLifeAppFallback), null);
  assert.deepEqual(readKv(KEY.lifeCursor("B")), { fromTime: 123, fromId: "999" });
  assert.deepEqual(readKv(KEY.lifeAppFallback("B")), { ios405Count: 0, webFallbackUntil: webUntil });
  assert.equal(readKv(KEY.lifeCursor("A")), null, "别的账号不沾");

  // 再跑一次是空转
  migrateLegacyLifeMonitorState();
  assert.deepEqual(readAppSettings().lifeMonitor?.accounts, ["B"]);
  assert.deepEqual(readKv(KEY.lifeCursor("B")), { fromTime: 123, fromId: "999" });
});

test("升级迁移：旧版没填账号就是第一个 115 账号；没用过监控的不写 accounts", () => {
  configure({ enabled: true, pullMode: "latest" });
  migrateLegacyLifeMonitorState();
  assert.deepEqual(readAppSettings().lifeMonitor?.accounts, ["A"], "enabled 过 → 按旧行为盯第一个账号");

  configure({ eventModes: ["create"] });
  migrateLegacyLifeMonitorState();
  assert.equal(readAppSettings().lifeMonitor?.accounts, undefined, "没开过、没填过账号、没有旧游标 → 保持「不选就全部」");
});

test("升级迁移后 last 模式从旧游标继续、沿用降级窗口", async () => {
  writeKv(KEY.legacyLifeCursor, { fromTime: 123, fromId: "999" });
  const webUntil = Date.now() + 3_600_000;
  writeKv(KEY.legacyLifeAppFallback, { ios405Count: 0, webFallbackUntil: webUntil });
  configure({ account: "B", pullMode: "last" });
  migrateLegacyLifeMonitorState();
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(getLifeMonitorStatus().accounts.map((a) => a.name), ["B"]);
    assert.deepEqual(statusOf("B")?.cursor, { fromTime: 123, fromId: "999" });
    assert.equal(statusOf("B")?.api, "web", "降级窗口跟着账号一起挪过来");
    assert.ok(pulls.filter((p) => p.account === "B").every((p) => p.app === "web"));
  } finally {
    await stopLifeMonitor();
  }
});

test("proapi 405 降级按账号各记各的", async () => {
  configure({ accounts: ["A", "B"], intervalSeconds: 5 });
  failFor = (opts) =>
    opts.accountInfo.name === "A" && opts.app === "ios" ? new Error("405 Method Not Allowed") : null;
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    await waitFor(
      () => (statusOf("A")?.stats.rounds ?? 0) >= 1 && (statusOf("B")?.stats.rounds ?? 0) >= 1,
      "各自跑完第一轮",
    );
    // A：门禁一次 + 第一轮一次，都是 proapi 405 → webapi 成功；门禁也走降级，不然一次 405 就起不来
    assert.deepEqual(pulls.filter((p) => p.account === "A").map((p) => p.app), ["ios", "web", "ios", "web"]);
    assert.deepEqual(pulls.filter((p) => p.account === "B").map((p) => p.app), ["ios", "ios"]);
    assert.deepEqual(readKv(KEY.lifeAppFallback("A")), { ios405Count: 2 });
    assert.equal(readKv(KEY.lifeAppFallback("B")), null, "B 没碰过 405，不该被 A 连累");
  } finally {
    await stopLifeMonitor();
  }
});

test("probe 不指定账号时把配置里的都测一遍，一个不通整体就不通；指定账号只测它", async () => {
  configure({ accounts: ["A", "B"] });
  failFor = (opts) => (opts.accountInfo.name === "B" ? new Error("cookie 失效") : null);
  const r = await probeLifeEvents(5);
  assert.equal(r.ok, false);
  assert.deepEqual(r.accounts.map((a) => [a.account, a.ok]), [["A", true], ["B", false]]);
  assert.equal(r.message, "A：拉到 0 条事件；B：cookie 失效");
  const one = await probeLifeEvents(5, "A");
  assert.equal(one.ok, true);
  assert.equal(one.message, "拉到 0 条事件");
});

test("并发两次启动共用一次，门禁只走一遍", async () => {
  configure({ accounts: ["A"] });
  const [r1, r2] = await Promise.all([startLifeMonitor(), startLifeMonitor()]);
  try {
    assert.equal(r1.ok, true, r1.message);
    assert.equal(r2.ok, true, r2.message);
    assert.equal(pulls.filter((p) => p.account === "A" && p.gate).length, 1);
  } finally {
    await stopLifeMonitor();
  }
});

test("启动刚发起就停止：启动按取消收场，不会留下循环", async () => {
  configure({ accounts: ["A"] });
  const starting = startLifeMonitor();
  const stopped = await stopLifeMonitor();
  assert.equal(stopped.message, "生活事件监控已停止");
  assert.equal((await starting).message, "启动已取消");
  assert.equal(getLifeMonitorStatus().running, false);
});

test("门禁请求卡住时停止能立刻掐断它，不用等超时", async () => {
  configure({ accounts: ["A", "B"] });
  hangFor = (opts) => opts.accountInfo.name === "A";
  const starting = startLifeMonitor();
  await waitFor(() => pulls.some((p) => p.account === "A"), "A 的门禁请求已发出");
  const t0 = Date.now();
  const stopped = await stopLifeMonitor();
  assert.ok(Date.now() - t0 < 1000, "停止不该等门禁超时");
  assert.equal(stopped.message, "生活事件监控已停止");
  const r = await starting;
  assert.equal(r.ok, false);
  assert.equal(r.message, "启动已取消");
  assert.equal(getLifeMonitorStatus().running, false);
  assert.equal(statusOf("A")?.lastError, null, "被取消不算这个账号的错");
});

test("账号被删除后它的循环自己退出，其它账号继续", async () => {
  configure({ accounts: ["A", "B"], intervalSeconds: 5 });
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    await waitFor(() => (statusOf("B")?.stats.rounds ?? 0) >= 1, "B 跑完第一轮");
    deleteAccount("B");
    // 下一轮（间隔 5s 之后）现取账号发现没了
    await waitFor(() => statusOf("B")?.running === false, "B 退出", 8000);
    assert.match(statusOf("B")?.lastError ?? "", /账号已删除/);
    assert.equal(statusOf("A")?.running, true);
  } finally {
    await stopLifeMonitor();
    replaceAccounts([acct("A"), acct("B")]);
  }
});
